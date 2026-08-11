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
import { scanWiki, type ScannedPage } from "../core/graph-builder.js"
import { runAgent, type AgentConfig, type AgentResult } from "./loop.js"
import { McpClient } from "./mcp.js"
import { resolveMcpServerPath } from "./mcp-server-path.js"
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
  affected: Array<{
    slug: string
    title: string
    /** The staleness clock actually compared, not necessarily `updated`. */
    updated: string
    /** Which field that clock came from, so a dry-run report is auditable. */
    clockSource: "checked" | "updated" | "as_of"
    action: string
  }>
  totalScanned: number
  /**
   * Pages skipped for having neither `checked` nor `as_of`. Not an error, but it
   * must be visible: a wiki whose pages carry no fact clocks would otherwise look
   * like a wiki with nothing stale in it.
   */
  skippedNoClock: number
}

/**
 * The staleness clock for purge: `checked ?? as_of`, NOT `updated`.
 *
 * purge asks "has anyone maintained this?", and `updated` cannot answer it because
 * node-ops bumps it on every write — including a dream's compression writes, which
 * are the opposite of maintenance.
 *
 * Measured before this fix, two pages equally stale at 2024-01-01:
 *
 *   untouched-stale   active    updated=2024-01-01  → PURGED
 *   compressed-stale  skeleton  updated=2026-08-11  → INVISIBLE TO PURGE
 *
 * A dream compressed the second one to a hollow skeleton, which bumped `updated`
 * to today, and purge then read it as fresh. The node whose content had actually
 * decayed away was the one that escaped cleanup — exactly backwards. Compression
 * was granting nodes immunity from purge.
 *
 * `as_of` is the honest fallback: it says when the facts were true, and only a
 * deliberate fact revision moves it. `checked` still wins when present, because a
 * real verification IS maintenance.
 *
 * Same reasoning as ScanFreshnessOptions.ignoreUpdatedClock; both are the
 * "neglect" question rather than the "needs re-verifying" question.
 */
function stalenessClock(page: ScannedPage): { date: string; source: "checked" | "as_of" } | null {
  if (page.checked) return { date: page.checked, source: "checked" }
  if (page.as_of) return { date: page.as_of, source: "as_of" }
  return null
}

/**
 * Pure code: scan all nodes, filter by staleness clock < staleBefore, batch mark/delete.
 * Uses scanWiki directly (not readGraph) to avoid the 500-node limit.
 */
export async function purgeByDate(options: PurgeByDateOptions): Promise<PurgeByDateResult> {
  const wiki = new WikiGraph(options.wikiRoot, { actor: "purge" })
  const wikiDir = join(options.wikiRoot, "wiki")
  const pages = await scanWiki(wikiDir, options.wikiRoot)

  const affected: PurgeByDateResult["affected"] = []
  /** Pages with no honest staleness clock — reported, never guessed at. */
  let noClock = 0

  for (const page of pages) {
    const clock = stalenessClock(page)
    if (clock === null) {
      // No `checked` and no `as_of`. `updated` is the only date left and it is not
      // trustworthy here (see stalenessClock), so this page is skipped rather than
      // purged on a clock that a dream's compression could have set. Surfaced in
      // the result so a silent no-op is distinguishable from "nothing was stale".
      noClock++
      continue
    }
    if (clock.date >= options.staleBefore) continue

    if (options.hardDelete) {
      await wiki.deleteNode(page.slug, { dryRun: options.dryRun })
      affected.push({
        slug: page.slug,
        title: page.title,
        updated: clock.date,
        clockSource: clock.source,
        action: "deleted",
      })
    } else {
      await wiki.updateNode(page.slug, {
        status: "invalidated",
        dryRun: options.dryRun,
      })
      affected.push({
        slug: page.slug,
        title: page.title,
        updated: clock.date,
        clockSource: clock.source,
        action: "invalidated",
      })
    }
  }

  return { affected, totalScanned: pages.length, skippedNoClock: noClock }
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
  const wiki = new WikiGraph(options.wikiRoot, { actor: "purge" })
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
      args: [resolveMcpServerPath()],
      env: { SELECTED_WIKI: options.wikiRoot, WIKI_AGENT: "purge" },
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
