/**
 * agent/dream-select.ts — the pure-code half of the dream agent.
 *
 * Design: dream.md §5. Everything here is deterministic given (pages, usage
 * stats, seed): journal I/O, pressure scoring, salience ranking, and the
 * seeded random walk that assembles dream scenes.
 *
 * Split from dream.ts on purpose: this file has no LLM and no MCP, so the
 * selection mechanism is unit-testable without a model. The agent half only
 * consumes what these functions produce and injects the raw numbers into the
 * prompt — the model may overrule any ranking (a mirror, not a bridle).
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"

import type { ScannedPage } from "../core/graph-builder.js"
import type { Graph, RelatedEntry } from "../types.js"
import type { NodeUsage } from "../core/usage.js"

// ── Options (design: dream.md §8.1) ─────────────────────────────────

/**
 * Every dream parameter lives here — nothing is hardcoded deeper in the code.
 * Library consumers override any field (the inheritance point); CLI flags are
 * a pass-through for the user-facing subset only.
 */
export interface DreamTuning {
  /** 0..1 — how tightly the dream sticks to its theme. Default 0.5. */
  certainty: number
  /** Seed count range, scaled down by certainty. Default [5, 8]. */
  seedCountRange: [number, number]
  /** Hops per walk. Default [2, 4]. */
  walkHopRange: [number, number]
  /** Minimum selection weight for zero-salience nodes. Default 0.05. */
  epsilonFloor: number
  /** p_edge = pEdgeBase + pEdgeCertaintyCoef × certainty. Defaults 0.4 / 0.5. */
  pEdgeBase: number
  pEdgeCertaintyCoef: number
  salienceWeights: { usage30: number; inDegree: number; overdue: number; touch: number }
  pressureWeights: {
    created: number
    updated: number
    hypothesis: number
    contradicts: number
    overdue: number
    daysSinceLastDream: number
  }
  /** Suggest dreaming at or above this score. Default 10. */
  pressureThreshold: number
}

/** Defaults in one place, so overriding one field never loses the others. */
export const DREAM_DEFAULTS: DreamTuning = {
  certainty: 0.5,
  seedCountRange: [5, 8],
  walkHopRange: [2, 4],
  epsilonFloor: 0.05,
  pEdgeBase: 0.4,
  pEdgeCertaintyCoef: 0.5,
  salienceWeights: { usage30: 0.35, inDegree: 0.25, overdue: 0.2, touch: 0.2 },
  pressureWeights: {
    created: 1,
    updated: 0.5,
    hypothesis: 2,
    contradicts: 3,
    overdue: 1,
    daysSinceLastDream: 1,
  },
  pressureThreshold: 10,
}

export function resolveTuning(overrides?: Partial<DreamTuning>): DreamTuning {
  return {
    ...DREAM_DEFAULTS,
    ...overrides,
    salienceWeights: { ...DREAM_DEFAULTS.salienceWeights, ...overrides?.salienceWeights },
    pressureWeights: { ...DREAM_DEFAULTS.pressureWeights, ...overrides?.pressureWeights },
  }
}

/**
 * Probability of following a real edge instead of teleporting (§5.4).
 * c=1 → 0.9 (hug the graph structure); c=0 → 0.4 (teleport often, so distant
 * nodes share a scene). Teleportation *is* the noise injection — no extra tool.
 */
export function pEdgeFor(t: DreamTuning): number {
  return clamp01(t.pEdgeBase + t.pEdgeCertaintyCoef * clamp01(t.certainty))
}

/** Lower certainty → more seeds and a higher epsilon floor: a wider dream. */
export function seedCountFor(t: DreamTuning): number {
  const [lo, hi] = t.seedCountRange
  const n = Math.round(hi - (hi - lo) * clamp01(t.certainty))
  // Always walk at least one seed: a dream with zero scenes is not a dream.
  return Number.isFinite(n) && n > 0 ? n : Math.max(1, lo)
}

export function epsilonFor(t: DreamTuning): number {
  // Halve the floor at full certainty, double it at zero.
  return t.epsilonFloor * (2 - clamp01(t.certainty))
}

function clamp01(n: number): number {
  // NaN must not propagate: a NaN certainty turns seedCount into NaN, which
  // makes the seed loop run zero times and silently produces a dream with no
  // scenes at all. Observed in a live run where the CLI passed through an
  // unparseable --certainty. Fall back to the default instead of failing quietly.
  if (!Number.isFinite(n)) return DREAM_DEFAULTS.certainty
  return Math.max(0, Math.min(1, n))
}

// ── Journal (design: dream.md §5.1) ─────────────────────────────────

export interface JournalEntry {
  date: string
  seed: string
  pressure?: PressureReport
  /**
   * The scenes actually injected, recorded from the pure-code walk rather than
   * from the model's report — a model may misdescribe its own inputs.
   */
  scenes?: Array<{ nodes: string[]; hops: Array<{ from: string; to: string; via: "edge" | "teleport" }> }>
  candidates?: Array<{ slug: string; salience: number; usage30: number; inDegree: number; overdueDays: number }>
  /** Threads left unresolved by this dream — next dream revisits them first. */
  threads_carried?: string[]
  changes?: unknown[]
  report?: string
}

/** <wikiRoot>/.llm-wiki-ops/dreams/journal.jsonl */
export function journalPath(wikiRoot: string): string {
  return path.join(wikiRoot, ".llm-wiki-ops", "dreams", "journal.jsonl")
}

/**
 * Last journal line — all the state a dream needs (§5.1).
 * Returns null on a wiki that has never dreamt.
 */
export async function readLastJournalEntry(wikiRoot: string): Promise<JournalEntry | null> {
  let raw: string
  try {
    raw = await fs.readFile(journalPath(wikiRoot), "utf8")
  } catch {
    return null
  }
  const lines = raw.split("\n").filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as JournalEntry
    } catch {
      // Torn line from an interrupted append — try the one before it.
    }
  }
  return null
}

/** Append one line. The journal is append-only: history is the point. */
export async function appendJournalEntry(wikiRoot: string, entry: JournalEntry): Promise<void> {
  const file = journalPath(wikiRoot)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8")
}

// ── Pressure (design: dream.md §5.2) ────────────────────────────────

export interface PressureReport {
  score: number
  threshold: number
  suggestDream: boolean
  /** Baseline for "new"/"updated" — the previous dream's date, or null. */
  since: string | null
  components: Array<{ name: string; count: number; weight: number; contribution: number }>
}

export interface PressureInput {
  pages: ScannedPage[]
  /** Nodes past their freshness due date. */
  overdueCount: number
  /** Previous dream's date (journal), or null when there is none. */
  lastDreamDate: string | null
  today: string
}

/**
 * Score how much the wiki needs a dream. Pure recomputation, no stored state
 * beyond the journal's last date (freshness.ts style).
 *
 * All counts are relative to the last dream — not a rolling 7/30-day window,
 * which would need state the journal does not keep.
 */
export function computePressure(input: PressureInput, tuning: DreamTuning): PressureReport {
  const { pages, overdueCount, lastDreamDate, today } = input
  const w = tuning.pressureWeights

  const isNew = (p: ScannedPage) => !!lastDreamDate && p.created > lastDreamDate
  const created = lastDreamDate ? pages.filter(isNew).length : pages.length
  const updated = lastDreamDate
    ? pages.filter((p) => p.updated > lastDreamDate && !isNew(p)).length
    : 0

  const hypothesis = countHypothesisPages(pages)
  const contradicts = countContradictsEdges(pages)
  const daysSince = lastDreamDate ? daysBetween(lastDreamDate, today) : 0

  const components = [
    { name: "new pages", count: created, weight: w.created },
    { name: "updated pages", count: updated, weight: w.updated },
    { name: "hypothesis pages", count: hypothesis, weight: w.hypothesis },
    { name: "contradicts edges", count: contradicts, weight: w.contradicts },
    { name: "freshness overdue", count: overdueCount, weight: w.overdue },
    { name: "days since last dream", count: daysSince, weight: w.daysSinceLastDream },
  ].map((c) => ({ ...c, contribution: c.count * c.weight }))

  const score = round2(components.reduce((sum, c) => sum + c.contribution, 0))

  return {
    score,
    threshold: tuning.pressureThreshold,
    suggestDream: score >= tuning.pressureThreshold,
    since: lastDreamDate,
    components,
  }
}

/**
 * Pages carrying an unresolved abduction hypothesis.
 *
 * The reason agent records epistemic status in the page *body* ("status:
 * hypothesis"), keeping frontmatter status for the lifecycle — see the reason
 * prompt's metadata discipline. read_graph's query filter only matches
 * title/slug, so a body scan is the only way to see these.
 */
export function countHypothesisPages(pages: ScannedPage[]): number {
  return pages.filter(isHypothesisPage).length
}

export function isHypothesisPage(page: ScannedPage): boolean {
  return /status:\s*hypothesis/i.test(page.content)
}

/** Typed related[] entries whose relation is "contradicts" (§5.5). */
export function countContradictsEdges(pages: ScannedPage[]): number {
  let n = 0
  for (const page of pages) {
    for (const rel of page.related) {
      if (relationOf(rel) === "contradicts") n++
    }
  }
  return n
}

function relationOf(entry: RelatedEntry): string | undefined {
  return typeof entry === "string" ? undefined : entry.relation
}

// ── Salience (design: dream.md §5.3) ────────────────────────────────

export interface SalienceInput {
  pages: ScannedPage[]
  graph: Graph
  /** Per-node usage over the stats window, keyed by slug. */
  usage: Map<string, NodeUsage>
  /** Overdue days per slug from the freshness scan. */
  overdueDays: Map<string, number>
  today: string
}

export interface SalienceEntry {
  slug: string
  title: string
  type: string
  score: number
  usage30: number
  inDegree: number
  overdueDays: number
  /** Days since the node was last fact-checked; null when never checked. */
  daysSinceChecked: number | null
}

/**
 * Rank nodes by how much attention they deserve in a dream.
 *
 * The score only drives sampling order and weights — never a cutoff. Raw
 * components go into the prompt so the model can overrule the ranking.
 */
export function computeSalience(input: SalienceInput, tuning: DreamTuning): SalienceEntry[] {
  const { pages, graph, usage, overdueDays, today } = input
  const w = tuning.salienceWeights

  const inDegree = new Map<string, number>()
  for (const edge of graph.edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  }

  const raw = pages.map((page) => {
    const u = usage.get(page.slug)
    const usage30 = (u?.reads ?? 0) + (u?.writes ?? 0)
    return {
      slug: page.slug,
      title: page.title,
      type: String(page.type),
      usage30,
      inDegree: inDegree.get(page.slug) ?? 0,
      overdueDays: overdueDays.get(page.slug) ?? 0,
      // Verification clock, NOT updated: node-ops bumps updated on every write,
      // so a dream that compresses a node would make it look freshly touched
      // and thus more dream-worthy — a self-feeding loop (§5.3).
      daysSinceChecked: page.checked ? daysBetween(page.checked, today) : null,
    }
  })

  const maxUsage = Math.max(1, ...raw.map((r) => r.usage30))
  const maxInDeg = Math.max(1, ...raw.map((r) => r.inDegree))
  const maxOverdue = Math.max(1, ...raw.map((r) => r.overdueDays))
  const maxChecked = Math.max(1, ...raw.map((r) => r.daysSinceChecked ?? 0))

  return raw
    .map((r) => ({
      ...r,
      score: round2(
        w.usage30 * (r.usage30 / maxUsage) +
          w.inDegree * (r.inDegree / maxInDeg) +
          w.overdue * (r.overdueDays / maxOverdue) +
          // Long-unchecked nodes score higher: nobody has looked at them lately.
          w.touch * ((r.daysSinceChecked ?? maxChecked) / maxChecked),
      ),
    }))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
}

// ── Random activation (design: dream.md §5.4) ───────────────────────

export interface DreamScene {
  /** Slugs visited, in walk order. The first is the seed. */
  nodes: string[]
  /** How each hop was reached — for the report and for debugging the walk. */
  hops: Array<{ from: string; to: string; via: "edge" | "teleport" }>
}

/**
 * Date-seeded PRNG (mulberry32): same day → same dream, so a run can be
 * reproduced from the seed recorded in the journal.
 */
export function makeRng(seed: string): () => number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Weighted pick without replacement; weights get an epsilon floor first. */
function weightedPick(
  entries: Array<{ slug: string; score: number }>,
  epsilon: number,
  rng: () => number,
): string | null {
  if (entries.length === 0) return null
  const weights = entries.map((e) => Math.max(epsilon, e.score))
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < entries.length; i++) {
    r -= weights[i]
    if (r <= 0) return entries[i].slug
  }
  return entries[entries.length - 1].slug
}

/**
 * Build dream scenes: pick seeds by weighted-random salience, then walk 2–4
 * hops, following a real edge with probability p_edge and otherwise teleporting
 * to another weighted-random node.
 *
 * Teleportation is what lets far-apart nodes share a scene — the whole point of
 * the exercise, and the reason no separate noise-injection tool is needed.
 */
export function buildDreamScenes(
  salience: SalienceEntry[],
  adjacency: Map<string, string[]>,
  tuning: DreamTuning,
  seed: string,
): DreamScene[] {
  if (salience.length === 0) return []

  const rng = makeRng(seed)
  const epsilon = epsilonFor(tuning)
  const pEdge = pEdgeFor(tuning)
  const seedCount = Math.min(seedCountFor(tuning), salience.length)
  const [hopLo, hopHi] = tuning.walkHopRange

  const pool = salience.map((s) => ({ slug: s.slug, score: s.score }))
  const scenes: DreamScene[] = []
  const usedSeeds = new Set<string>()

  for (let i = 0; i < seedCount; i++) {
    const available = pool.filter((p) => !usedSeeds.has(p.slug))
    const start = weightedPick(available, epsilon, rng)
    if (!start) break
    usedSeeds.add(start)

    const nodes = [start]
    const hops: DreamScene["hops"] = []
    const hopCount = hopLo + Math.floor(rng() * (hopHi - hopLo + 1))

    let current = start
    for (let h = 0; h < hopCount; h++) {
      const neighbours = (adjacency.get(current) ?? []).filter((n) => !nodes.includes(n))
      const takeEdge = neighbours.length > 0 && rng() < pEdge

      let next: string | null
      if (takeEdge) {
        next = neighbours[Math.floor(rng() * neighbours.length)]
      } else {
        next = weightedPick(
          pool.filter((p) => !nodes.includes(p.slug)),
          epsilon,
          rng,
        )
      }
      if (!next) break

      hops.push({ from: current, to: next, via: takeEdge ? "edge" : "teleport" })
      nodes.push(next)
      current = next
    }

    scenes.push({ nodes, hops })
  }

  return scenes
}

/** Undirected adjacency (slug → neighbour slugs) for the walk. */
export function buildWalkAdjacency(graph: Graph): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  const push = (from: string, to: string) => {
    const list = adj.get(from)
    if (list) {
      if (!list.includes(to)) list.push(to)
    } else {
      adj.set(from, [to])
    }
  }
  for (const edge of graph.edges) {
    push(edge.source, edge.target)
    push(edge.target, edge.source)
  }
  return adj
}

// ── Open threads (design: dream.md §5.5) ────────────────────────────

export interface OpenThreads {
  /** Pages whose body carries an unresolved hypothesis. */
  hypothesisPages: string[]
  /** "a→b" pairs linked by a contradicts relation. */
  contradictsEdges: string[]
  /** Pages tagged needs-verification by the check agent. */
  needsVerification: string[]
  /** Threads the previous dream did not resolve — revisit these first. */
  carried: string[]
}

/**
 * Collect loose ends for the dream to pick up (the system's answer to
 * dream-lag). Carried threads come first: an unresolved thread should not be
 * silently dropped just because a later dream found something shinier.
 */
export function collectOpenThreads(
  pages: ScannedPage[],
  lastEntry: JournalEntry | null,
): OpenThreads {
  const contradictsEdges: string[] = []
  for (const page of pages) {
    for (const rel of page.related) {
      if (typeof rel !== "string" && rel.relation === "contradicts") {
        contradictsEdges.push(`${page.slug}→${rel.slug}`)
      }
    }
  }

  return {
    hypothesisPages: pages.filter(isHypothesisPage).map((p) => p.slug),
    contradictsEdges,
    needsVerification: pages.filter((p) => p.tags.includes("needs-verification")).map((p) => p.slug),
    carried: lastEntry?.threads_carried ?? [],
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Whole days from an ISO date to another; negative clamps to 0. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
