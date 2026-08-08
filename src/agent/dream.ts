/**
 * agent/dream.ts — the dream agent.
 *
 * Design doc: dream.md (§5 selection, §6 compression, §7 dream pages, §8 CLI,
 * §9 tools and prompt).
 *
 * What it does: while nobody is asking questions, walk the graph semi-randomly,
 * look for connections nobody wrote down, and let unused knowledge decay. New
 * insights land in wiki/dreams/ as first-class `dream` pages carrying an
 * UNVERIFIED banner — never smuggled into existing node bodies as fact.
 *
 * The selection machinery is pure code in dream-select.ts; this file wires it
 * to the model and injects the raw numbers into the prompt. The agent may
 * overrule any ranking: constraints are shown, not enforced (a mirror, not a
 * bridle).
 */

import { join, relative, resolve, isAbsolute } from "node:path"
import * as fs from "node:fs/promises"

import { runAgent, type AgentResult } from "./loop.js"
import { McpClient } from "./mcp.js"
import { createLocalTools, type LocalToolRegistry } from "./tools.js"
import { resolveLlmConfig, type LlmConfig, type ToolDefinition } from "./openai.js"
import { scanWiki, buildGraphFromPages, type ScannedPage } from "../core/graph-builder.js"
import { scanFreshnessFromPages } from "../core/freshness.js"
import { computeUsageStats, type NodeUsage } from "../core/usage.js"
import {
  resolveTuning,
  computePressure,
  computeSalience,
  buildDreamScenes,
  buildWalkAdjacency,
  collectOpenThreads,
  readLastJournalEntry,
  appendJournalEntry,
  pEdgeFor,
  epsilonFor,
  seedCountFor,
  type DreamTuning,
  type PressureReport,
  type SalienceEntry,
  type DreamScene,
  type OpenThreads,
} from "./dream-select.js"

// ── Options (design: dream.md §8.1) ─────────────────────────────────

/**
 * Dream parameters. Nothing is hardcoded: every knob is a field here, so a
 * library consumer can override it (the minimum inheritance point). CLI flags
 * expose only the user-facing subset and pass straight through.
 */
export interface DreamOptions extends Partial<DreamTuning> {
  wikiRoot: string
  /** Optional positional theme; undefined = free dream. */
  theme?: string
  /**
   * Where dream pages live. Default wiki/dreams/. MUST stay inside the wiki/
   * subtree — scanWiki only walks <wikiRoot>/wiki, and a dream page the graph
   * cannot see can never be verified.
   */
  dreamsDir?: string
  /** Dream depth. More iterations = a deeper, longer dream. Default 50. */
  maxIterations?: number
  timeoutMs?: number
  dryRun?: boolean
  /** --pressure: report the pressure reading and exit without dreaming. */
  pressureOnly?: boolean
  llmConfig?: LlmConfig
}

/** Default location of dream pages, relative to wikiRoot. */
export const DEFAULT_DREAMS_DIR = "wiki/dreams"

export interface DreamResult extends AgentResult {
  pressure: PressureReport
  /** Present unless pressureOnly. */
  scenes?: DreamScene[]
  candidates?: SalienceEntry[]
  threads?: OpenThreads
  seed?: string
}

// ── Tools (design: dream.md §9) ─────────────────────────────────────

const DREAM_READ_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wiki.get_stats",
      description: "Wiki statistics: node/edge totals, type distribution, top tags, largest neighborhoods.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.read_graph",
      description:
        "Read a subgraph. ALWAYS filter (center+k, type, tag, or query) — never pull the whole graph. Your dream scenes are already center+k walks.",
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
      description: "Full content of one node by slug.",
      parameters: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.get_edges",
      description: "Edges for a node. k=1 gives inbound/outbound; k>1 walks BFS with depth.",
      parameters: {
        type: "object",
        properties: { slug: { type: "string" }, k: { type: "number" }, limit: { type: "number" } },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.metrics",
      description: "Graph health metrics: topology, hubs, components, source overlap, type balance.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.scan_freshness",
      description: "Nodes due for fact-checking, sorted by how overdue they are.",
      parameters: {
        type: "object",
        properties: { today: { type: "string" }, upcoming_days: { type: "number" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.usage_stats",
      description:
        "Access statistics: per-node read/write counts by actor. top = what the wiki actually pays attention to; bottom = what has been forgotten (includes never-touched nodes).",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number" },
          top: { type: "number" },
          bottom: { type: "number" },
          actor: { type: "string" },
        },
        required: [],
      },
    },
  },
]

/**
 * Write tools (real-execution mode only).
 *
 * No add_node: its schema cannot carry a dream page's theme/compression fields,
 * so dream pages are written with the local file tools instead. No rename_node:
 * knowledge nodes are not renamed by a dream, and dream pages are only created
 * or deleted, never renamed.
 */
const DREAM_WRITE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wiki.add_edge",
      description:
        "Link two nodes. Use relation to type the edge (causes, contradicts, supports, …) and context to quote the evidence.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          relation: { type: "string" },
          context: { type: "string" },
        },
        required: ["source", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.remove_edge",
      description: "Remove an edge that the dream has shown to be spurious.",
      parameters: {
        type: "object",
        properties: { source: { type: "string" }, target: { type: "string" } },
        required: ["source", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki.update_node",
      description:
        "Update a node. This is the compression primitive: pass compression=condensed|skeleton together with the rewritten content. At most ONE level down per dream.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string" },
          content: { type: "string" },
          compression: {
            type: "string",
            description: "active | condensed | skeleton — the node's compression stage",
          },
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
      description:
        "Delete a node: the terminal compression stage, and how a worthless dream page is cleaned up. Transactional — dangling wikilinks, related[] entries and index.md are repaired.",
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
      name: "wiki.rebuild_index",
      description:
        "Rebuild index.md. Run this ONCE at the end if you created or deleted dream pages with the local file tools (those bypass index maintenance).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
]

// ── Prompt (design: dream.md §7, §9) ────────────────────────────────

const DREAM_SYSTEM_PROMPT = `You are the dream agent of a wiki knowledge graph. You run while nobody is asking questions — this is offline consolidation, not question answering.

Biological dreaming does three things, and so do you:
1. **Replay** — revisit what was recently active, and what has been forgotten.
2. **Recombine** — put nodes side by side that normally never meet, and check whether a real relation exists.
3. **Forget** — let knowledge nobody uses decay, one step at a time.

## What you are given (pure-code, computed before you woke up)
- **Pressure reading**: how much the wiki needs a dream, broken into components. A number for you to interpret, not an order.
- **Dream scenes**: seeded random walks. Each scene is a set of nodes that ended up together, some via real edges, some via teleport. A teleport means "these two are far apart in the graph" — that is exactly where a non-obvious connection might hide.
- **Salience table**: raw components per node (usage, in-degree, overdue days, days since last check). Rankings are suggestions. Overrule them when the content says otherwise.
- **Open threads**: unresolved hypotheses, contradicts edges, needs-verification pages, and threads carried over from the previous dream. Carried threads come first — an unresolved thread must not be quietly dropped.

## The three-valued verdict — this is the core discipline
For every candidate connection in a scene, decide one of exactly three things:
- **REAL** — the relation holds and is supported by the node contents. Write it: add_edge with relation and an evidence quote in context.
- **NOT REAL** — it looked interesting but the contents do not support it. Say so in your report and move on. A dream that rules things out is a successful dream.
- **UNCERTAIN** — plausible, cannot be settled from what is in the wiki. This is the interesting case: write it as a dream page (below). Do NOT add an edge for a hunch.

Never inflate an UNCERTAIN into a REAL because it would make a better story. The wiki is a knowledge graph, not a novel.

## Dream pages — where new insight goes
Insight from a dream NEVER gets edited into an existing node's body as if it were established fact. It goes into its own page under the dreams directory, with type: dream.

Write dream pages with the local file tools (write_file / edit_file), not add_node — add_node cannot carry the dream frontmatter. Frontmatter for a dream page:

\`\`\`
---
title: <short, readable>
type: dream
created: <today>
updated: <today>
theme: <the thread this dream followed>
description: <one machine-readable line: what was noticed>
compression: active
---
\`\`\`

Body rules:
- Open with the banner: \`> **UNVERIFIED DREAM** — generated by offline recombination. Not established knowledge.\`
- Link every node you drew on with wikilinks: [[slug]]. Those links ARE the provenance record — they become graph edges automatically, so no separate source field is needed.
- State what you noticed, why the scene made you notice it, and what would settle the question. A dream page that names a testable check is worth ten that muse.
- No as_of. A dream is not a fact with a date; the freshness scanner deliberately skips dream pages.

Do NOT create index.md or log.md inside the dreams directory — those filenames are infrastructure and the graph scanner skips them.

## Forgetting — progressive compression
Knowledge nobody reads should get shorter, not vanish. Compress with update_node, passing the compression field:
- \`active\` (default, full body) → \`condensed\` (core claims + key facts; drop examples, narration, redundant quotes; keep all edges) → \`skeleton\` (one-line summary + an index of what was there: section names, edge list, source slugs; body under ~300 characters) → delete_node.
- **At most one level down per dream, per node.** Forgetting is gradual; that is the whole point.
- NEVER compress: source pages (they are the evidence base) or overview pages (they are the map).
- Only delete a node that is already \`skeleton\` AND still looks worthless on this second look. When in doubt, leave it at skeleton and let the next dream decide.
- Dream pages are the exception to gradual decay: they are cheap and disposable, so a worthless one may be compressed several levels or deleted in one go.

## Budget discipline
You are told your iteration and time budget up front and will NOT be reminded. Watch it yourself. A shallow dream with a complete report beats a deep one that dies with nothing written. Stop exploring in time to write the report.

## Report (your final message, the deliverable)
- **Scenes**: for each, what was in it and what you concluded (REAL / NOT REAL / UNCERTAIN).
- **Connections written**: edges added, with the relation and why.
- **Dream pages created**: path + the question each one raises.
- **Compression**: which nodes moved down a level, and why they deserved it.
- **Threads still open**: anything you could not settle — these carry to the next dream.

Report accuracy is not optional. The scene list at the top of your instructions is your ground truth: report exactly that many scenes and refer to them by number. Never claim you were given zero scenes, or that the graph was "too small to walk", when scenes are listed — if you worked from them (you did), say so. A report that misdescribes its own inputs is worse than a short one, because the next dream reads it.`

// ── Runner ──────────────────────────────────────────────────────────

/**
 * Validate the dreams directory and return it relative to wikiRoot.
 *
 * Hard constraint: it must sit inside <wikiRoot>/wiki. scanWiki only walks that
 * subtree, so a dream page outside it is invisible to the graph — no edges, no
 * verification, no closing the loop.
 */
export function resolveDreamsDir(wikiRoot: string, dreamsDir?: string): string {
  const requested = dreamsDir ?? DEFAULT_DREAMS_DIR
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(wikiRoot, requested)
  const wikiSubtree = resolve(wikiRoot, "wiki")
  const rel = relative(wikiSubtree, abs)

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `dreamsDir must stay inside <wikiRoot>/wiki (got "${requested}"). ` +
        `scanWiki only scans the wiki/ subtree, so dream pages outside it would be invisible to the graph and could never be verified.`,
    )
  }
  return relative(resolve(wikiRoot), abs).replace(/\\/g, "/")
}

/** Today's date as both an ISO day and a journal seed. */
function todayAndSeed(): { today: string; seed: string } {
  const today = new Date().toISOString().slice(0, 10)
  return { today, seed: today.replace(/-/g, "") }
}

/**
 * The cheap half: pressure only.
 *
 * Needs pages + freshness + the journal's last entry, and nothing else — no
 * usage-log aggregation (a 30-file read), no salience, no walks. This is what
 * `--pressure` actually runs, so the CLI's "no model call" promise also means
 * "not much work".
 */
export async function preparePressure(options: DreamOptions): Promise<{
  tuning: DreamTuning
  pressure: PressureReport
  pages: ScannedPage[]
  freshness: ReturnType<typeof scanFreshnessFromPages>
  lastEntry: Awaited<ReturnType<typeof readLastJournalEntry>>
  today: string
  seed: string
  pageCount: number
}> {
  const tuning = resolveTuning(options)
  const { today, seed } = todayAndSeed()
  const wikiDir = join(options.wikiRoot, "wiki")

  const pages = await scanWiki(wikiDir, options.wikiRoot)
  const freshness = scanFreshnessFromPages(pages, { today })
  const lastEntry = await readLastJournalEntry(options.wikiRoot)

  const pressure = computePressure(
    {
      pages,
      overdueCount: freshness.due.length,
      lastDreamDate: lastEntry?.date ?? null,
      today,
    },
    tuning,
  )

  return { tuning, pressure, pages, freshness, lastEntry, today, seed, pageCount: pages.length }
}

/**
 * Everything a full dream needs, without an LLM: pressure, salience, scenes,
 * and open threads. Builds on preparePressure.
 */
export async function prepareDream(options: DreamOptions): Promise<{
  tuning: DreamTuning
  pressure: PressureReport
  salience: SalienceEntry[]
  scenes: DreamScene[]
  threads: OpenThreads
  seed: string
  today: string
  pageCount: number
}> {
  const { tuning, pressure, pages, freshness, lastEntry, today, seed } =
    await preparePressure(options)
  const graph = buildGraphFromPages(pages)
  const overdueDays = new Map(freshness.due.map((e) => [e.slug, e.overdueDays]))

  // Usage stats drive the salience "attention" component (§5.3).
  const stats = await computeUsageStats(options.wikiRoot, {
    days: 30,
    topN: Number.MAX_SAFE_INTEGER,
    bottomN: 0,
    allSlugs: pages.map((p) => p.slug),
    // Exclude the dream's own reads. Every node a dream inspects is logged with
    // actor "dream"; counting those would inflate tomorrow's salience for
    // exactly the nodes this dream already looked at.
    excludeActor: "dream",
  })
  const usage = new Map<string, NodeUsage>(stats.top.map((u) => [u.slug, u]))

  const salience = computeSalience({ pages, graph, usage, overdueDays, today }, tuning)
  const scenes = buildDreamScenes(salience, buildWalkAdjacency(graph), tuning, seed)
  const threads = collectOpenThreads(pages, lastEntry)

  return { tuning, pressure, salience, scenes, threads, seed, today, pageCount: pages.length }
}

/** Render the pure-code findings as the prompt's context block. */
function renderContext(
  prep: Awaited<ReturnType<typeof prepareDream>>,
  options: DreamOptions,
  dreamsDir: string,
): string {
  const { tuning, pressure, salience, scenes, threads } = prep
  const lines: string[] = []

  // Scenes come FIRST and loudly: they are the working material, not trivia.
  // Buried further down (after pressure and salience) a model will skim past
  // them and report "no scenes were provided" while re-deriving the same
  // insight by hand — observed in the first live run.
  lines.push(`# YOUR DREAM MATERIAL: ${scenes.length} scenes`)
  lines.push("")
  lines.push(
    `These are seeded random walks through the graph — the nodes that ended up together in this dream. Work through them one by one; they are the reason you are awake. "⇢teleport⇢" means the two nodes are NOT connected in the graph and were put side by side on purpose: that is where a connection nobody wrote down is most likely to hide. "·dead-end·" just means the previous node had no unvisited neighbour, so read nothing into that pairing.`,
  )
  lines.push("")
  scenes.forEach((scene, i) => {
    const walk = scene.hops.length
      ? scene.nodes[0] +
        scene.hops
          .map((h) => `${h.via === "edge" ? " —edge→ " : h.via === "teleport" ? " ⇢teleport⇢ " : " ·dead-end· "}${h.to}`)
          .join("")
      : scene.nodes[0]
    lines.push(`**Scene ${i + 1}:** ${walk}`)
  })
  if (scenes.length === 0) {
    lines.push(
      `(none — the wiki is empty or has too few pages to walk. Fall back to the salience table below.)`,
    )
  }

  lines.push("", "---", "")
  lines.push(`Wiki root: ${options.wikiRoot}`)
  lines.push(`Dreams directory: ${dreamsDir}/`)
  lines.push(`Today: ${prep.today}`)
  lines.push(`Dream seed: ${prep.seed} (same seed → same scenes; recorded in the journal)`)
  lines.push(
    options.theme
      ? `Theme: "${options.theme}" — follow this thread.`
      : `Theme: none — free dream. Let the scenes decide.`,
  )
  lines.push(
    `Certainty: ${tuning.certainty} → p_edge ${pEdgeFor(tuning).toFixed(2)} (${Math.round(pEdgeFor(tuning) * 100)}% of hops follow real edges, the rest teleport), ${seedCountFor(tuning)} seeds, epsilon floor ${epsilonFor(tuning).toFixed(3)}`,
  )

  lines.push("", `## Pressure: ${pressure.score} (threshold ${pressure.threshold})`)
  lines.push(
    pressure.since
      ? `Counts are relative to the last dream on ${pressure.since}.`
      : `No previous dream — this is the first one, so "new pages" counts everything.`,
  )
  for (const c of pressure.components) {
    lines.push(`- ${c.name}: ${c.count} × ${c.weight} = ${c.contribution}`)
  }

  lines.push("", `## Salience (top 20 of ${salience.length}; raw components, overrule freely)`)
  lines.push(`| slug | score | usage30 | inDeg | overdue | days since check | compression |`)
  lines.push(`|---|---|---|---|---|---|---|`)
  for (const s of salience.slice(0, 20)) {
    lines.push(
      `| ${s.slug} | ${s.score} | ${s.usage30} | ${s.inDegree} | ${s.overdueDays} | ${s.daysSinceChecked ?? "never"} | ${s.compression ?? "active"} |`,
    )
  }
  lines.push("")
  lines.push(
    `The compression column is the node's CURRENT stage — check it before compressing anything. active → condensed → skeleton → delete, at most one step per dream. Only a node already at \`skeleton\` may be deleted. Scores are already damped by stage, so a skeleton node ranking low is expected, not an oversight.`,
  )

  const forgotten = salience.filter((s) => s.usage30 === 0).slice(0, 10)
  if (forgotten.length) {
    lines.push(
      "",
      `## Never touched in the last 30 days (${forgotten.length} shown) — candidates for both replay and forgetting`,
    )
    lines.push(forgotten.map((s) => s.slug).join(", "))
  }

  lines.push("", "## Open threads")
  if (threads.carried.length) {
    lines.push(`- Carried from last dream (revisit FIRST): ${threads.carried.join(", ")}`)
  }
  if (threads.hypothesisPages.length) {
    lines.push(`- Unresolved hypotheses: ${threads.hypothesisPages.join(", ")}`)
  }
  if (threads.contradictsEdges.length) {
    lines.push(`- Contradicts edges: ${threads.contradictsEdges.join(", ")}`)
  }
  if (threads.needsVerification.length) {
    lines.push(`- Tagged needs-verification: ${threads.needsVerification.join(", ")}`)
  }
  if (
    !threads.carried.length &&
    !threads.hypothesisPages.length &&
    !threads.contradictsEdges.length &&
    !threads.needsVerification.length
  ) {
    lines.push("- None. Nothing is pending; the scenes are yours to explore.")
  }

  return lines.join("\n")
}

/**
 * Run a dream.
 *
 * With pressureOnly the pure-code pressure reading is returned and no model is
 * invoked — that is the `--pressure` path.
 */
export async function runDream(options: DreamOptions): Promise<DreamResult> {
  const dreamsDir = resolveDreamsDir(options.wikiRoot, options.dreamsDir)

  if (options.pressureOnly) {
    // Cheap path: pressure only, no usage aggregation, no salience, no walks,
    // no model.
    const cheap = await preparePressure(options)
    const message = renderPressureOnly(cheap.pressure, cheap.pageCount)
    return {
      status: "completed",
      iterations: 0,
      messages: [],
      toolCalls: [],
      finalMessage: message,
      runReport: {
        command: "dream",
        wikiRoot: options.wikiRoot,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        operations: [],
        changes: [],
      },
      pressure: cheap.pressure,
    }
  }

  const prep = await prepareDream(options)

  const llmConfig = options.llmConfig ?? resolveLlmConfig()
  const mcp = new McpClient()

  // Create the dreams directory up front so list_directory works from the first
  // iteration and the agent never hits a confusing ENOENT on a fresh wiki. The
  // local write tool also creates parents on demand. Skipped for dry-run: a
  // preview must not leave anything on disk.
  if (!options.dryRun) {
    await fs.mkdir(join(options.wikiRoot, dreamsDir), { recursive: true })
  }

  try {
    await mcp.connect({
      name: "wiki",
      transport: "stdio",
      command: "node",
      args: [join(import.meta.dirname, "..", "mcp", "index.js")],
      env: { SELECTED_WIKI: options.wikiRoot, WIKI_AGENT: "dream" },
    })

    // Local file tools, write-scoped to the dreams directory: the dream agent
    // owns that directory outright and must not touch anything else by hand.
    const localTools: LocalToolRegistry = createLocalTools(options.wikiRoot, {
      writeScope: dreamsDir,
    })

    const maxIterations = options.maxIterations ?? 50
    const timeoutMs = options.timeoutMs ?? 600_000
    const timeoutMin = Math.round(timeoutMs / 60_000)

    const userMessage = `${renderContext(prep, options, dreamsDir)}

Budget: at most ${maxIterations} tool-call iterations and ${timeoutMin} minutes. You will NOT be reminded — pace yourself and leave room to write the report.

Dream now. Start from the ${prep.scenes.length} scenes above — read the nodes in each one, give every candidate connection a three-valued verdict, record what you find, and let what nobody uses decay one step.`

    const result = await runAgent(
      {
        systemPrompt: DREAM_SYSTEM_PROMPT,
        tools: [...DREAM_READ_TOOLS, ...DREAM_WRITE_TOOLS],
        maxIterations,
        timeoutMs,
        llmConfig,
        dryRun: options.dryRun,
        conclusion: {
          // The report already is the final message — don't bury it.
          skipIfDeliverable: true,
          prompt:
            "Write the dream report now: scenes and verdicts, connections written, dream pages created, compression applied, and threads still open.",
        },
      },
      userMessage,
      mcp,
      localTools,
      "dream",
      options.wikiRoot,
    )

    // Record the dream so the next one knows where this one stopped (§5.1).
    if (!options.dryRun) {
      await appendJournalEntry(options.wikiRoot, {
        date: prep.today,
        seed: prep.seed,
        pressure: prep.pressure,
        // Scenes are recorded from the pure-code walk, never from the model's
        // prose. Models have been observed reporting "0 scenes" while actually
        // working from them; the journal must carry what was really injected.
        scenes: prep.scenes.map((s) => ({ nodes: s.nodes, hops: s.hops })),
        candidates: prep.salience.slice(0, 20).map((s) => ({
          slug: s.slug,
          salience: s.score,
          usage30: s.usage30,
          inDegree: s.inDegree,
          overdueDays: s.overdueDays,
        })),
        // Conservative carry: a thread is only closed once a dream has actually
        // ruled on it. Parsing verdicts out of prose is unreliable, so nothing
        // is dropped automatically — better to dream about it twice than lose it.
        threads_carried: [
          ...prep.threads.carried,
          ...prep.threads.hypothesisPages.map((s) => `hypothesis:${s}`),
          ...prep.threads.contradictsEdges.map((e) => `contradicts:${e}`),
          ...prep.threads.needsVerification.map((s) => `needs-verification:${s}`),
        ].filter((v, i, arr) => arr.indexOf(v) === i),
        report: result.finalMessage,
      })
    }

    return {
      ...result,
      pressure: prep.pressure,
      scenes: prep.scenes,
      candidates: prep.salience.slice(0, 20),
      threads: prep.threads,
      seed: prep.seed,
    }
  } finally {
    await mcp.closeAll()
  }
}

function renderPressureOnly(pressure: PressureReport, pageCount: number): string {
  const lines = [
    `Dream pressure: ${pressure.score} (threshold ${pressure.threshold})`,
    pressure.suggestDream
      ? `→ Suggest dreaming (a suggestion, not a gate).`
      : `→ No dream needed yet.`,
    "",
    pressure.since
      ? `Counted since the last dream on ${pressure.since}:`
      : `No previous dream recorded — everything counts as new:`,
  ]
  for (const c of pressure.components) {
    lines.push(`  ${c.name.padEnd(24)} ${String(c.count).padStart(5)} × ${c.weight} = ${c.contribution}`)
  }
  lines.push("", `Wiki size: ${pageCount} pages.`)
  return lines.join("\n")
}
