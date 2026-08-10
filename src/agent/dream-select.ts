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
  /**
   * Weights for computeForgettability. Separate from salienceWeights because the
   * two questions disagree on sign: `overdue` is positive in both, but it means
   * "go re-verify this" for salience and "nobody has maintained this" here.
   */
  forgetWeights: { unread: number; unneeded: number; stale: number; stage: number }
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
  /**
   * Sampling temperature (§5.8). Default 0.5 — a conventional middle setting,
   * NOT derived from certainty.
   *
   * Deriving it was tried and rejected on evidence. certainty controls the graph
   * walk, and the first version made it drive the sampler too, on the theory that
   * near-greedy 0.1 was why five dream pages came out as five instances of one
   * sentence shape. A live run at 1.9 refuted the theory in the worst way: the
   * agent managed 4 tool calls, wrote ZERO dream pages, and emitted a report with
   * broken syntax, invented tokens (`4-qinjin=real`), malformed wikilinks
   * (`[[外汇||natural]]`) and claims about a page it never created.
   *
   * The reason is structural: dream page prose travels INSIDE write_file's
   * arguments, so prose sampling and JSON sampling are the same distribution.
   * Any temperature loose enough to shake up the writing also destroys the tool
   * calls that do the writing. Creativity is not in the sampling noise — the one
   * genuinely inventive page this project produced (the courtship-display lens)
   * came out at 0.1, driven by an external framing that forced a structural
   * displacement. That is the lever; temperature is not.
   */
  temperature: number
  /**
   * Conclusion-round temperature. Kept low on purpose: the report states what
   * the dream actually did, and a hot sampler there invents operations that
   * never happened.
   */
  tempConclusion: number
  /**
   * Score multiplier per compression stage. Already-compressed nodes are worth
   * revisiting less often — without this a skeleton node keeps ranking as prime
   * material and gets re-compressed every single dream.
   */
  compressionDamping: Record<string, number>
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
  forgetWeights: { unread: 0.35, unneeded: 0.3, stale: 0.2, stage: 0.15 },
  pressureWeights: {
    created: 1,
    updated: 0.5,
    hypothesis: 2,
    contradicts: 3,
    overdue: 1,
    daysSinceLastDream: 1,
  },
  pressureThreshold: 10,
  temperature: 0.5,
  tempConclusion: 0.2,
  // active/absent = full weight; each compression step halves the pull.
  compressionDamping: { active: 1, condensed: 0.5, skeleton: 0.25 },
}

export function resolveTuning(overrides?: Partial<DreamTuning>): DreamTuning {
  return {
    ...DREAM_DEFAULTS,
    ...overrides,
    salienceWeights: { ...DREAM_DEFAULTS.salienceWeights, ...overrides?.salienceWeights },
    pressureWeights: { ...DREAM_DEFAULTS.pressureWeights, ...overrides?.pressureWeights },
    compressionDamping: { ...DREAM_DEFAULTS.compressionDamping, ...overrides?.compressionDamping },
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

/**
 * How forgettable a node is, as its own score (§6.6).
 *
 * Salience answers "who deserves attention", and the decay list originally just
 * took the bottom of that ranking. That is wrong, and a live wiki exposed it:
 * `overdue` carries POSITIVE weight in salience (a long-unverified node needs
 * revisiting), so a node 393 days overdue with zero reads and zero inbound edges
 * scored 0.400 — higher than an ordinary 12-day-old node with 2 inbound edges at
 * 0.210. The most forgettable material was sorted furthest from the forgetting
 * list. Worse, 567 nodes tied at 0.21 and the "ranking" degenerated into
 * alphabetical order.
 *
 * Forgettability is a different question with a different sign on nearly every
 * term:
 * - reads: none at all is the core signal.
 * - inbound edges: what depends on this node. High in-degree means load-bearing,
 *   so it counts AGAINST forgetting. Out-degree is deliberately ignored —
 *   pointing at 中国 says nothing about whether anything needs you.
 * - staleness: long past its reference clock counts FOR forgetting here, the
 *   opposite of its role in salience.
 * - stage: already compressed means the ladder has judged it once already, so it
 *   is a natural next step rather than a fresh victim.
 */
export function computeForgettability(
  entries: SalienceEntry[],
  tuning: DreamTuning,
): Array<SalienceEntry & { forgetScore: number }> {
  const maxIn = Math.max(1, ...entries.map((e) => e.inDegree))
  const maxOverdue = Math.max(1, ...entries.map((e) => e.overdueDays))
  const w = tuning.forgetWeights

  return entries
    .map((e) => {
      const unread = e.usage30 === 0 ? 1 : 1 / (1 + e.usage30)
      const unneeded = 1 - e.inDegree / maxIn
      const stale = Math.min(1, e.overdueDays / maxOverdue)
      const stageBonus =
        e.compression === "skeleton" ? 1 : e.compression === "condensed" ? 0.5 : 0
      const forgetScore = round3(
        w.unread * unread + w.unneeded * unneeded + w.stale * stale + w.stage * stageBonus,
      )
      return { ...e, forgetScore }
    })
    .sort((a, b) => b.forgetScore - a.forgetScore || a.slug.localeCompare(b.slug))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function epsilonFor(t: DreamTuning): number {
  // Halve the floor at full certainty, double it at zero.
  return t.epsilonFloor * (2 - clamp01(t.certainty))
}

/**
 * Sampling temperature for this dream (§5.8).
 *
 * A flat tunable, deliberately NOT a function of certainty. certainty governs the
 * graph walk — how far the material roams — and that mapping is sound. Wiring it
 * to the sampler as well was tried and refuted by a live run: see the DreamTuning
 * doc for the 1.9 collapse. Clamped to the OpenAI-compatible 0..2 range so an
 * out-of-range override cannot produce a rejected request mid-run.
 */
export function temperatureFor(t: DreamTuning): number {
  return clampTemp(t.temperature)
}

/** Conclusion-round temperature, clamped to the API's accepted range. */
export function conclusionTemperatureFor(t: DreamTuning): number {
  return clampTemp(t.tempConclusion)
}

function clampTemp(n: number): number {
  if (!Number.isFinite(n)) return DREAM_DEFAULTS.temperature
  return Math.max(0, Math.min(2, n))
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
  scenes?: Array<{ nodes: string[]; hops: Array<{ from: string; to: string; via: "edge" | "teleport" | "dead-end" }> }>
  candidates?: Array<{ slug: string; salience: number; usage30: number; inDegree: number; overdueDays: number }>
  /** Threads left unresolved by this dream — next dream revisits them first. */
  threads_carried?: string[]
  /**
   * Slugs this dream wrote to itself. The next dream subtracts them from its
   * new/updated pressure counts (§5.2) — a dream's own compression writes are
   * not evidence that the wiki needs dreaming.
   */
  touched_slugs?: string[]
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
 *
 * Reads from the tail rather than loading the file: each entry embeds the full
 * model report plus scenes and candidates, so a year of nightly dreaming is a
 * multi-megabyte file and slurping all of it to get one line gets worse every
 * day. The journal itself stays append-only — history is the point — this only
 * changes how the newest line is found.
 */
export async function readLastJournalEntry(wikiRoot: string): Promise<JournalEntry | null> {
  const file = journalPath(wikiRoot)

  let handle: fs.FileHandle
  try {
    handle = await fs.open(file, "r")
  } catch {
    return null
  }

  try {
    const { size } = await handle.stat()
    if (size === 0) return null

    // Grow the window until a parseable line turns up: entries are usually a few
    // KB, but a long report can exceed any fixed guess.
    let window = 64 * 1024
    while (true) {
      const length = Math.min(window, size)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)

      const text = buffer.toString("utf8")
      // A partial first line is possible unless the whole file is in the window.
      const lines = (length < size ? text.slice(text.indexOf("\n") + 1) : text)
        .split("\n")
        .filter((l) => l.trim())

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(lines[i]) as JournalEntry
        } catch {
          // Torn line from an interrupted append — try the one before it.
        }
      }

      if (length >= size) return null // whole file scanned, nothing parseable
      window *= 4
    }
  } finally {
    await handle.close()
  }
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
  /**
   * Slugs the previous dream wrote itself (journal `touched_slugs`).
   *
   * Excluded from the new/updated counts. Without this, a dream that compresses
   * six knowledge nodes hands the next run six updated-pages — dream more, score
   * higher, "should" dream more. Note this is NOT the same guard as the
   * `type !== "dream"` filter below: that one drops the dream's own *pages*,
   * while compression rewrites ordinary *knowledge* pages, which stay in scope.
   *
   * The date comparison alone used to hide this: `updated > lastDreamDate` is
   * strictly greater, and compression writes normally land on the journal's own
   * date, so the counts came out right by coincidence. A dream that starts at
   * 23:50 UTC and writes at 00:05 breaks that coincidence — journal date 08-07,
   * `updated` 08-08 — and the free points reappear. Slug identity holds either
   * way.
   */
  lastDreamTouchedSlugs?: string[]
}

/**
 * Score how much the wiki needs a dream. Pure recomputation, no stored state
 * beyond the journal's last date (freshness.ts style).
 *
 * All counts are relative to the last dream — not a rolling 7/30-day window,
 * which would need state the journal does not keep.
 */
export function computePressure(input: PressureInput, tuning: DreamTuning): PressureReport {
  const { pages, overdueCount, lastDreamDate, today, lastDreamTouchedSlugs } = input
  const w = tuning.pressureWeights

  // The dream's OWN output must not raise its own pressure. Two separate
  // exclusions are needed, because a dream produces two kinds of writes:
  //
  //   1. New dream pages, carrying that night's created date → filtered by type.
  //   2. Compression rewrites of ordinary knowledge pages, which bump `updated`
  //      unconditionally (node-ops.ts) → filtered by slug identity, below.
  //
  // Fourth instance of this loop shape, after usage stats (excludeActor), the
  // touch clock (checked, not updated), and dream pages by type. Freshness
  // already excludes dreams by type, so overdueCount arrives clean.
  const touched = new Set(lastDreamTouchedSlugs ?? [])
  const knowledge = pages.filter((p) => p.type !== "dream" && !touched.has(p.slug))

  const isNew = (p: ScannedPage) => !!lastDreamDate && p.created > lastDreamDate
  const created = lastDreamDate ? knowledge.filter(isNew).length : knowledge.length
  const updated = lastDreamDate
    ? knowledge.filter((p) => p.updated > lastDreamDate && !isNew(p)).length
    : 0

  const hypothesis = countHypothesisPages(knowledge)
  const contradicts = countContradictsEdges(knowledge)
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
  /**
   * Outbound edges. Reported because a live dream mistook them for evidence of
   * load-bearing-ness: it refused to compress 战争钨 as "referenced by 稀土全产业链
   * and 中美关系现状" when those were nodes it POINTED AT. Its only inbound edge
   * came from a dream page. Showing both directions makes the distinction
   * checkable instead of guessable.
   */
  outDegree: number
  overdueDays: number
  /** Days since the node was last fact-checked; null when never checked. */
  daysSinceChecked: number | null
  /** Current compression stage; undefined means never compressed (active). */
  compression?: string
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
  const outDegree = new Map<string, number>()
  for (const edge of graph.edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1)
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
      outDegree: outDegree.get(page.slug) ?? 0,
      overdueDays: overdueDays.get(page.slug) ?? 0,
      // Verification clock, NOT updated: node-ops bumps updated on every write,
      // so a dream that compresses a node would make it look freshly touched
      // and thus more dream-worthy — a self-feeding loop (§5.3).
      daysSinceChecked: page.checked ? daysBetween(page.checked, today) : null,
      compression: page.compression,
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
        (w.usage30 * (r.usage30 / maxUsage) +
          w.inDegree * (r.inDegree / maxInDeg) +
          w.overdue * (r.overdueDays / maxOverdue) +
          // Long-unchecked nodes score higher: nobody has looked at them lately.
          w.touch * ((r.daysSinceChecked ?? maxChecked) / maxChecked)) *
          // Damp what has already decayed, so a skeleton node is not re-picked
          // and re-compressed every dream (the compression stage is now readable
          // from frontmatter — before, this loop was open).
          (tuning.compressionDamping[r.compression ?? "active"] ?? 1),
      ),
    }))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
}

// ── Random activation (design: dream.md §5.4) ───────────────────────

export interface DreamScene {
  /** Slugs visited, in walk order. The first is the seed. */
  nodes: string[]
  /**
   * How each hop was reached. "teleport" means a real jump chosen against p_edge
   * (the interesting case: far-apart nodes deliberately put together);
   * "dead-end" means there simply was no unvisited neighbour, which carries no
   * such meaning and must not be over-interpreted.
   */
  hops: Array<{ from: string; to: string; via: "edge" | "teleport" | "dead-end" }>
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
      const wantsEdge = rng() < pEdge
      const takeEdge = neighbours.length > 0 && wantsEdge

      let next: string | null
      let via: "edge" | "teleport" | "dead-end"
      if (takeEdge) {
        next = neighbours[Math.floor(rng() * neighbours.length)]
        via = "edge"
      } else {
        next = weightedPick(
          pool.filter((p) => !nodes.includes(p.slug)),
          epsilon,
          rng,
        )
        // Distinguish a chosen jump from a forced one: only the former means
        // "these two are far apart and I put them together on purpose".
        via = wantsEdge && neighbours.length === 0 ? "dead-end" : "teleport"
      }
      if (!next) break

      hops.push({ from: current, to: next, via })
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

  const hypothesisPages = pages.filter(isHypothesisPage).map((p) => p.slug)
  const needsVerification = pages
    .filter((p) => p.tags.includes("needs-verification"))
    .map((p) => p.slug)

  return {
    hypothesisPages,
    contradictsEdges,
    needsVerification,
    carried: pruneCarriedThreads(lastEntry?.threads_carried ?? [], {
      hypothesisPages,
      contradictsEdges,
      needsVerification,
    }),
  }
}

/**
 * Drop carried threads that no longer exist in the wiki.
 *
 * Verdicts are only stated in prose, which is unreliable to parse — but a
 * thread's *subject* is observable state. A hypothesis whose page is gone or no
 * longer carries the marker is settled or deleted either way; likewise a
 * contradicts edge that has been removed. Without this the carry list only ever
 * grows and eventually dominates the prompt with ghosts.
 *
 * Unprefixed entries are NOT pruned (a deliberate call, see the keep branch):
 * the first journal format wrote bare slugs, and those are indistinguishable
 * from a marker some future version might add. Conservative carry beats losing
 * a live lead.
 */
export function pruneCarriedThreads(
  carried: string[],
  live: { hypothesisPages: string[]; contradictsEdges: string[]; needsVerification: string[] },
): string[] {
  const hyp = new Set(live.hypothesisPages)
  const edges = new Set(live.contradictsEdges)
  const needs = new Set(live.needsVerification)

  return carried.filter((thread) => {
    if (thread.startsWith("hypothesis:")) return hyp.has(thread.slice("hypothesis:".length))
    if (thread.startsWith("needs-verification:")) return needs.has(thread.slice("needs-verification:".length))
    if (thread.startsWith("contradicts:")) return edges.has(thread.slice("contradicts:".length))

    // Anything else is kept. That includes legacy bare slugs from the very first
    // journal format (pre-prefix): they can't be told apart from a marker a
    // future version might introduce — both are free-form strings — and dropping
    // a live lead is worse than carrying a stale one. Decided rather than
    // overlooked. Note these do NOT age out on their own: nothing prunes an
    // unprefixed entry, so a pre-release journal carries them forever. Harmless
    // in practice (`.llm-wiki-ops/` is gitignored, so only a local journal can
    // have them) but if one ever clutters the prompt, edit the journal by hand.
    return true
  })
}

// ── Helpers ─────────────────────────────────────────────────────────

// ── Theme matching (design: dream.md §5.6) ──────────────────────────

/**
 * Search terms for a theme string.
 *
 * Latin words of 3+ chars, plus CJK bigrams — Chinese has no spaces, so
 * "深海章鱼的求偶仪式" has to be cut somewhere and 2-grams are the cheapest cut
 * that still discriminates. Single CJK chars are deliberately NOT used: "海"
 * alone would match 海峡/航海/海外 and report a hit for a theme the graph knows
 * nothing about, which is the exact failure this function exists to detect.
 */
export function themeTerms(theme: string): string[] {
  const terms = new Set<string>()

  for (const word of theme.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    // Latin only: a CJK run has no word boundaries to have found here.
    if (word.length >= 3 && !/[\u4e00-\u9fff]/.test(word)) terms.add(word)
  }

  for (const run of theme.replace(/[^\u4e00-\u9fff]+/g, " ").split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2))
  }

  return [...terms]
}

/** Below this many matching pages, a theme has no real thread to follow. */
export const THEME_PURCHASE_MIN = 2

export interface ThemeMatch {
  /** How many pages the theme touches at all. */
  count: number
  /** A few example slugs, for the prompt. */
  slugs: string[]
  /**
   * Whether there is enough material to actually follow the theme.
   *
   * Not simply `count > 0`: on a 1150-page economics wiki the theme
   * "深海章鱼的求偶仪式" matched exactly one page — 章鱼能源, the UK energy
   * retailer Octopus Energy. A bigram collision like that is not purchase on the
   * theme, and treating it as one would suppress the zero-case guidance for the
   * very case that needs it. A lone hit is reported to the model but does not
   * count as a thread to follow.
   */
  hasPurchase: boolean
}

/**
 * How much material the graph actually holds on a theme.
 *
 * Matched against slug/title/tags only, never the body: a passing mention deep
 * in one page is not "the graph has material on this". The count goes into the
 * prompt so a zero is VISIBLE to the model instead of silently producing a dream
 * that ignores the theme it was given (observed: theme "深海章鱼的求偶仪式" on an
 * economics wiki produced 7 pages of economics and never mentioned the theme,
 * with no hint to the user that the theme found no purchase).
 */
export function findThemeMatches(
  pages: ScannedPage[],
  theme: string,
  limit = 6,
): ThemeMatch {
  const terms = themeTerms(theme)
  if (terms.length === 0) return { count: 0, slugs: [], hasPurchase: false }

  const slugs: string[] = []
  let count = 0
  for (const page of pages) {
    const haystack = `${page.slug} ${page.title} ${page.tags.join(" ")}`.toLowerCase()
    if (terms.some((t) => haystack.includes(t))) {
      count++
      if (slugs.length < limit) slugs.push(page.slug)
    }
  }
  return { count, slugs, hasPurchase: count >= THEME_PURCHASE_MIN }
}

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
