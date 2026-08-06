/**
 * agent/purge.ts — wiki purge agent.
 *
 * Design doc: §4.5 (purge.ts)
 *
 * Three execution paths:
 * 1. --stale-before DATE: pure code, scanWiki full traversal, filter by updated date
 * 2. --slugs a,b,c: pure code, directly mark/delete
 * 3. --query "...": LLM agent, two-step confirm (--report then --apply)
 *
 * Default: mark invalidated (status: invalidated + superseded_by), NOT delete.
 * --hard-delete: actually delete via delete_node.
 */

import { WikiGraph } from "../index.js"
import { scanWiki } from "../core/graph-builder.js"
import { runAgent, type AgentConfig, type AgentResult } from "./loop.js"
import { McpClient } from "./mcp.js"
import { createLocalTools, type LocalToolRegistry } from "./tools.js"
import { resolveLlmConfig, type LlmConfig, type ToolDefinition } from "./openai.js"
import { join } from "node:path"

// ── Pure code paths (no LLM) ────────────────────────────────────────

export interface PurgeByDateOptions {
  wikiRoot: string
  staleBefore: string // YYYY-MM-DD
  hardDelete?: boolean
  dryRun?: boolean
}

export interface PurgeByDateResult {
  affected: Array<{ slug: string; title: string; updated: string; action: string }>
  totalScanned: number
}

/**
 * Pure code: scan all nodes, filter by updated < staleBefore, batch mark/delete.
 * Uses scanWiki directly (not readGraph) to avoid the 500-node limit.
 */
export async function purgeByDate(options: PurgeByDateOptions): Promise<PurgeByDateResult> {
  const wiki = new WikiGraph(options.wikiRoot)
  const wikiDir = join(options.wikiRoot, "wiki")
  const pages = await scanWiki(wikiDir, options.wikiRoot)

  const affected: PurgeByDateResult["affected"] = []

  for (const page of pages) {
    if (!page.updated || page.updated >= options.staleBefore) continue

    if (options.hardDelete) {
      await wiki.deleteNode(page.slug, { dryRun: options.dryRun })
      affected.push({ slug: page.slug, title: page.title, updated: page.updated, action: "deleted" })
    } else {
      await wiki.updateNode(page.slug, {
        status: "invalidated",
        dryRun: options.dryRun,
      })
      affected.push({ slug: page.slug, title: page.title, updated: page.updated, action: "invalidated" })
    }
  }

  return { affected, totalScanned: pages.length }
}

export interface PurgeBySlugsOptions {
  wikiRoot: string
  slugs: string[]
  hardDelete?: boolean
  supersededBy?: string
  dryRun?: boolean
}

export interface PurgeBySlugsResult {
  affected: Array<{ slug: string; action: string }>
  notFound: string[]
}

/** Pure code: directly mark/delete specified slugs. */
export async function purgeBySlugs(options: PurgeBySlugsOptions): Promise<PurgeBySlugsResult> {
  const wiki = new WikiGraph(options.wikiRoot)
  const affected: PurgeBySlugsResult["affected"] = []
  const notFound: string[] = []

  for (const slug of options.slugs) {
    const node = await wiki.getNode(slug)
    if (!node) {
      notFound.push(slug)
      continue
    }

    if (options.hardDelete) {
      await wiki.deleteNode(slug, { dryRun: options.dryRun })
      affected.push({ slug, action: "deleted" })
    } else {
      await wiki.updateNode(slug, {
        status: "invalidated",
        superseded_by: options.supersededBy,
        dryRun: options.dryRun,
      })
      affected.push({ slug, action: "invalidated" })
    }
  }

  return { affected, notFound }
}

// ── LLM agent path (--query mode) ───────────────────────────────────

const PURGE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wiki.get_stats",
      description: "Get wiki statistics: total nodes, edges, type distribution, top tags.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.read_graph",
      description: "Read a subgraph. Use center+k, type, tag, or query filters to avoid RESULT_TOO_LARGE.",
      parameters: {
        type: "object",
        properties: {
          center: { type: "string", description: "Center node slug for BFS" },
          k: { type: "number", description: "BFS depth (1-5)" },
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
      name: "wiki.update_node",
      description: "Update a node. Use status='invalidated' and superseded_by to mark outdated nodes. WARNING: content is a WHOLE-PAGE replacement, not a patch — read the page first (wiki.get_node), then pass the complete updated body including all existing content.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          status: { type: "string", description: "'active' or 'invalidated'" },
          superseded_by: { type: "string", description: "Slug of replacement node" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.delete_node",
      description: "Permanently delete a node. Only use when hard-delete is explicitly requested.",
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
]

const PURGE_SYSTEM_PROMPT = `You are a wiki maintenance agent specializing in purging outdated or irrelevant content.

## Mission
Evaluate nodes in the wiki and mark outdated/irrelevant ones as invalidated.

## Rules
- DEFAULT behavior: mark nodes as invalidated using update_node with status="invalidated". Do NOT delete unless explicitly told to hard-delete.
- When invalidating, set superseded_by if there is a replacement node.
- Read node content (get_node) before making judgments — never judge by title alone.
- Provide clear reasons for each decision in your final summary.
- A node is a candidate for purging if:
  - Its content is factually outdated (superseded by newer information)
  - It duplicates another node
  - It is too vague/generic to be useful
  - It was created in error
- Do NOT purge nodes that are merely incomplete — those are candidates for research, not purge.
- The wiki may have 1000+ nodes. Use read_graph with filters (center+k, type, tag, query) to navigate. Never call read_graph without filters.

## Output
End with a summary table: slug | title | action | reason.`

export interface PurgeQueryOptions {
  wikiRoot: string
  query: string
  mode: "report" | "apply"
  hardDelete?: boolean
  maxIterations?: number
  timeoutMs?: number
  verbose?: boolean
  dryRun?: boolean
  llmConfig?: LlmConfig
}

/** LLM-based purge: read content, evaluate, mark/delete. */
export async function runPurgeAgent(options: PurgeQueryOptions): Promise<AgentResult> {
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

    const localTools: LocalToolRegistry = createLocalTools(options.wikiRoot)

    const modeInstruction = options.mode === "report"
      ? "MODE: REPORT ONLY. List candidates with reasons but do NOT call update_node or delete_node. Just output your analysis."
      : `MODE: APPLY. Mark candidates as invalidated (or delete if hard-delete is requested).${options.hardDelete ? " HARD DELETE is enabled — use delete_node for confirmed candidates." : " Use update_node with status='invalidated', NOT delete_node."}`

    const userMessage = `Purge query: "${options.query}"
Wiki root: ${options.wikiRoot}
${modeInstruction}

Find nodes related to this query, read their content, and evaluate whether they should be purged.`

    const tools = options.mode === "report"
      ? PURGE_TOOLS.filter((t) => !["wiki.update_node", "wiki.delete_node"].includes(t.function.name))
      : PURGE_TOOLS

    const result = await runAgent(
      {
        systemPrompt: PURGE_SYSTEM_PROMPT,
        tools,
        maxIterations: options.maxIterations ?? 30,
        timeoutMs: options.timeoutMs ?? 600_000,
        llmConfig,
        dryRun: options.dryRun,
      },
      userMessage,
      mcp,
      localTools,
      "purge",
      options.wikiRoot,
    )

    return result
  } finally {
    await mcp.closeAll()
  }
}
