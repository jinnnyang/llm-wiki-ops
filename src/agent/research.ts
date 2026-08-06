/**
 * agent/research.ts — wiki research agent.
 *
 * Design doc: §4.5 (research.ts)
 *
 * Reads a subgraph, searches for supplementary information,
 * updates stale nodes (noting source + date + reason), adds new nodes/edges.
 */

import { runAgent, type AgentResult } from "./loop.js"
import { McpClient } from "./mcp.js"
import { createLocalTools, type LocalToolRegistry } from "./tools.js"
import { resolveLlmConfig, type LlmConfig, type ToolDefinition } from "./openai.js"
import { join } from "node:path"

const RESEARCH_TOOLS: ToolDefinition[] = [
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
      description: "Get edges for a node. k=1 returns inbound/outbound; k>1 returns BFS edges with depth.",
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
      name: "wiki.scan_freshness",
      description: "Pure-code scan (zero LLM): list nodes due for fact-checking per the exponential-backoff schedule (checked clock, as_of-based interval). Use this FIRST when the query is about staleness — it tells you exactly which nodes are overdue, sorted by overdueDays desc.",
      parameters: {
        type: "object",
        properties: {
          today: { type: "string", description: "Override today YYYY-MM-DD (default: current UTC date)" },
          upcoming_days: { type: "number", description: "Also return nodes due within this many days" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.update_node",
      description: "Update a node's attributes. WARNING: content is a WHOLE-PAGE replacement, not a patch — read the page first (wiki.get_node), then pass the complete updated body including all existing content. When a fact changes, reset as_of to the new fact's effective date (restarts its freshness backoff) and set checked to today.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          related: { type: "array", items: { type: "string" } },
          sources: { type: "array", items: { type: "string" } },
          status: { type: "string", description: "'active' (default) or 'invalidated'" },
          superseded_by: { type: "string", description: "Slug of replacement node (when status=invalidated)" },
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
      name: "wiki.add_node",
      description: "Create a new node.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          related: { type: "array", items: { type: "string" } },
          sources: { type: "array", items: { type: "string" } },
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
        },
        required: ["source", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.rename_node",
      description: "Rename a node's slug. Updates all references.",
      parameters: {
        type: "object",
        properties: {
          old_slug: { type: "string" },
          new_slug: { type: "string" },
        },
        required: ["old_slug", "new_slug"],
      },
    },
  },
]

const RESEARCH_SYSTEM_PROMPT = `You are a wiki research agent. Your job is to enrich and update the wiki with new information.

## Mission
Given a research query, explore the existing wiki subgraph, identify gaps or stale information, and update/create nodes to fill them.

## Rules
- When updating a node, ALWAYS note WHY you updated it. Append a section like:
  > **Updated YYYY-MM-DD**: <reason>. Source: <URL or reference>.
- When a fact changes, reset as_of to the new fact's effective date (this restarts its freshness backoff) and set checked to today.
- If the query is about staleness/refresh, call wiki.scan_freshness FIRST to get the due-for-checking list instead of scanning by hand.
- Add new nodes only for genuinely new concepts/entities not already covered.
- Do NOT duplicate existing nodes — check with read_graph/get_node first.
- Use add_edge to connect new information to the existing graph.
- Use sources[] to record where information came from.
- The wiki may have 1000+ nodes. Use read_graph with filters to navigate. Never call read_graph without filters.
- Prefer updating existing nodes over creating new ones when the topic overlaps.
- If web_search is available, use it to find current information, verify facts, or fill knowledge gaps. Always cite the source URL.
- If web_search is NOT available, do not fabricate external sources — skip external corroboration, judge on wiki evidence alone, and note in the summary that external verification was unavailable.

## Output
End with a summary: what you updated, what you created, what gaps remain.`

export interface ResearchOptions {
  wikiRoot: string
  query: string
  maxIterations?: number
  timeoutMs?: number
  verbose?: boolean
  dryRun?: boolean
  llmConfig?: LlmConfig
  /** Additional MCP servers for search (e.g. web search, tavily) */
  searchServers?: Array<{
    name: string
    transport: "stdio" | "http"
    command?: string
    args?: string[]
    url?: string
  }>
}

export async function runResearch(options: ResearchOptions): Promise<AgentResult> {
  const llmConfig = options.llmConfig ?? resolveLlmConfig()
  const mcp = new McpClient()

  try {
    await mcp.connect({
      name: "wiki",
      transport: "stdio",
      command: "node",
      args: [join(import.meta.dirname, "..", "mcp", "index.js")],
      env: { SELECTED_WIKI: options.wikiRoot },
    })

    // Add optional search servers
    for (const server of options.searchServers ?? []) {
      await mcp.connect(server)
    }

    const localTools: LocalToolRegistry = createLocalTools(options.wikiRoot, { webSearch: true })

    const today = new Date().toISOString().slice(0, 10)
    const userMessage = `Research query: "${options.query}"
Wiki root: ${options.wikiRoot}
Today's date: ${today}

Explore the wiki subgraph related to this query. Identify stale or missing information. Update existing nodes and create new ones as needed. Always cite sources and dates when updating.`

    const result = await runAgent(
      {
        systemPrompt: RESEARCH_SYSTEM_PROMPT,
        tools: RESEARCH_TOOLS,
        maxIterations: options.maxIterations ?? 30,
        timeoutMs: options.timeoutMs ?? 600_000,
        llmConfig,
        dryRun: options.dryRun,
        conclusion: {
          // The deliverable is the update/creation summary, already written
          // as the final message — don't bury it under a 300-word round.
          skipIfDeliverable: true,
          // Fallback when the final message is too thin to be the summary:
          // reconstruct it from the tool log, no word cap.
          prompt:
            "You have finished your research work. Write the most complete summary you can from everything you found and did: which nodes you updated (and why), which nodes/edges you created, and what gaps remain. Include the sources and dates you recorded. No word limit. No tool calls. Write in the same language as the user's query.",
        },
      },
      userMessage,
      mcp,
      localTools,
      "research",
      options.wikiRoot,
    )

    return result
  } finally {
    await mcp.closeAll()
  }
}
