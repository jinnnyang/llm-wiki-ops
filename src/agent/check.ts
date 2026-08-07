/**
 * agent/check.ts — wiki verification agent.
 *
 * Design doc: §4.5 (check.ts)
 *
 * Independent agent loop that verifies subgraph content:
 * - Factually wrong → purge (mark invalidated)
 * - True but uncertain → flag for research
 * - Correct → leave alone
 *
 * Design decision: check is an independent agent loop, not code orchestration,
 * because the boundary between "true but uncertain" and "false" is fuzzy
 * and LLM judges it better than if/else.
 */

import { runAgent, type AgentResult } from "./loop.js"
import { McpClient } from "./mcp.js"
import { createLocalTools, type LocalToolRegistry } from "./tools.js"
import { resolveLlmConfig, type LlmConfig, type ToolDefinition } from "./openai.js"
import { join } from "node:path"

const CHECK_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wiki.get_stats",
      description: "Get wiki statistics.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.read_graph",
      description: "Read a subgraph. Use center+k, type, tag, or query filters.",
      parameters: {
        type: "object",
        properties: {
          center: { type: "string" },
          k: { type: "number" },
          type: { type: "string" },
          tag: { type: "string" },
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.get_node",
      description: "Get full content of a single node by slug.",
      parameters: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.get_edges",
      description: "Get edges for a node.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          k: { type: "number" },
          limit: { type: "number" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.update_node",
      description: "Update a node. Use status='invalidated' to mark factually wrong nodes. Set checked to today after verifying; set as_of when facts change. WARNING: content is a WHOLE-PAGE replacement, not a patch — read the page first (wiki.get_node), then pass the complete updated body including all existing content.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string" },
          superseded_by: { type: "string" },
          as_of: { type: "string", description: "Fact clock YYYY-MM-DD: reset to the date the NEW fact became true" },
          checked: { type: "string", description: "Verification clock YYYY-MM-DD: set to today after verifying" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.delete_node",
      description: "Permanently delete a node. Use only for clearly erroneous content.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          dangling_refs: { type: "string", enum: ["strikethrough", "plain-text", "remove"] },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.add_node",
      description: "Create a new node (e.g. a correction or clarification).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          related: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.add_edge",
      description: "Add an edge between two nodes.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          context: { type: "string" },
          relation: { type: "string", description: "Edge type (recommended: is_a, instance_of, causes, contradicts, explains, superseded_by, related)" },
        },
        required: ["source", "target"],
      },
    },
  },
]

const CHECK_SYSTEM_PROMPT = `You are a wiki verification agent. Your job is to verify the factual accuracy of wiki content.

## Mission
Given a verification scope (query), read the relevant subgraph and verify each node's content.

## Judgment Framework
For each node, classify as:
1. **CORRECT** — content is factually accurate. Leave it alone.
2. **UNCERTAIN** — content may be true but you cannot verify it, or it's outdated but not clearly wrong. Flag it: add a tag "needs-verification" and note what's uncertain.
3. **WRONG** — content is factually incorrect. Mark as invalidated (status="invalidated") with a note explaining what's wrong. If there's a correct replacement, set superseded_by.

## Verification Clock (checked / as_of)

- After verifying a node, ALWAYS set checked to today's date via update_node — even when the verdict is CORRECT. checked is the verification clock that drives the freshness scheduler; a node you verified but didn't stamp will be re-checked unnecessarily.
- When a fact has CHANGED (old value wrong, new value known): correct the content in place, set as_of to the date the NEW fact became true, set checked to today, and append a change record to the node:
  "## 变更记录" section with an entry like:
  "### YYYY-MM-DD <short change summary>" / "- 旧：<old>（as_of <old date>）→ 新：<new>（as_of <new date>）" / "- 原因：<why>" / "- 来源：<source>"
- Reserve status="invalidated" for facts that are simply wrong with no replacement. Changed facts get corrected in place (resetting as_of restarts the freshness backoff automatically).

## Rules
- Read node content (get_node) before judging — never judge by title alone.
- When marking a node as wrong, append a note to its content explaining the error before setting status="invalidated".
- Do NOT delete nodes unless they are clearly erroneous AND have no value (e.g. spam, test data).
- Prefer marking invalidated over deleting — invalidated nodes preserve history.
- For uncertain nodes, add the tag "needs-verification" rather than invalidating.
- The wiki may have 1000+ nodes. Use read_graph with filters to navigate.

## Output
End with a verification report table: slug | title | verdict | reason.`

export interface CheckOptions {
  wikiRoot: string
  query: string
  maxIterations?: number
  timeoutMs?: number
  verbose?: boolean
  dryRun?: boolean
  llmConfig?: LlmConfig
  searchServers?: Array<{
    name: string
    transport: "stdio" | "http"
    command?: string
    args?: string[]
    url?: string
  }>
}

export async function runCheck(options: CheckOptions): Promise<AgentResult> {
  const llmConfig = options.llmConfig ?? resolveLlmConfig()
  const mcp = new McpClient()

  try {
    await mcp.connect({
      name: "wiki",
      transport: "stdio",
      command: "node",
      args: [join(import.meta.dirname, "..", "mcp", "index.js")],
      env: { SELECTED_WIKI: options.wikiRoot, WIKI_AGENT: "check" },
    })

    for (const server of options.searchServers ?? []) {
      await mcp.connect(server)
    }

    const localTools: LocalToolRegistry = createLocalTools(options.wikiRoot, { webSearch: true })

    const today = new Date().toISOString().slice(0, 10)
    const userMessage = `Verification scope: "${options.query}"
Wiki root: ${options.wikiRoot}
Today's date: ${today}

Read the subgraph related to this query. Verify each node's factual accuracy. Classify each as CORRECT, UNCERTAIN, or WRONG. Take appropriate action for UNCERTAIN and WRONG nodes.`

    const result = await runAgent(
      {
        systemPrompt: CHECK_SYSTEM_PROMPT,
        tools: CHECK_TOOLS,
        maxIterations: options.maxIterations ?? 30,
        timeoutMs: options.timeoutMs ?? 600_000,
        llmConfig,
        dryRun: options.dryRun,
      },
      userMessage,
      mcp,
      localTools,
      "check",
      options.wikiRoot,
    )

    return result
  } finally {
    await mcp.closeAll()
  }
}
