/**
 * tests/dream-select.test.ts — the pure-code half of the dream agent.
 *
 * Covers what a dream's quality actually rests on: pressure baselines, the
 * salience components (including the self-pollution guard), seeded-walk
 * determinism, teleportation, journal round-trips, and the dreams-dir
 * containment rule.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import type { ScannedPage } from "../src/core/graph-builder.js"
import type { Graph } from "../src/types.js"
import type { NodeUsage } from "../src/core/usage.js"
import {
  DREAM_DEFAULTS,
  resolveTuning,
  pEdgeFor,
  seedCountFor,
  epsilonFor,
  computePressure,
  computeSalience,
  buildDreamScenes,
  buildWalkAdjacency,
  collectOpenThreads,
  isHypothesisPage,
  countContradictsEdges,
  makeRng,
  daysBetween,
  readLastJournalEntry,
  appendJournalEntry,
  journalPath,
} from "../src/agent/dream-select.js"
import { resolveDreamsDir, DEFAULT_DREAMS_DIR } from "../src/agent/dream.js"

// ── Fixtures ────────────────────────────────────────────────────────

function page(over: Partial<ScannedPage> & { slug: string }): ScannedPage {
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    type: over.type ?? "concept",
    tags: over.tags ?? [],
    related: over.related ?? [],
    sources: over.sources ?? [],
    created: over.created ?? "2026-01-01",
    updated: over.updated ?? "2026-01-01",
    as_of: over.as_of,
    checked: over.checked,
    content: over.content ?? "body",
    path: over.path ?? `wiki/concepts/${over.slug}.md`,
    ...over,
  } as ScannedPage
}

function graphOf(edges: Array<[string, string]>): Graph {
  return {
    nodes: [],
    edges: edges.map(([source, target]) => ({ source, target })),
  } as unknown as Graph
}

function usageOf(entries: Record<string, number>): Map<string, NodeUsage> {
  return new Map(
    Object.entries(entries).map(([slug, reads]) => [
      slug,
      { slug, reads, writes: 0, byActor: {}, lastTs: "" },
    ]),
  )
}

// ── Tuning derivation (§8.1) ────────────────────────────────────────

describe("tuning derivation", () => {
  it("resolveTuning keeps sibling defaults when one nested field is overridden", () => {
    const t = resolveTuning({ salienceWeights: { usage30: 0.9 } as never })
    expect(t.salienceWeights.usage30).toBe(0.9)
    expect(t.salienceWeights.inDegree).toBe(DREAM_DEFAULTS.salienceWeights.inDegree)
    expect(t.pressureThreshold).toBe(DREAM_DEFAULTS.pressureThreshold)
  })

  it("certainty drives p_edge from 0.4 (roaming) to 0.9 (hugging the graph)", () => {
    expect(pEdgeFor(resolveTuning({ certainty: 0 }))).toBeCloseTo(0.4)
    expect(pEdgeFor(resolveTuning({ certainty: 0.5 }))).toBeCloseTo(0.65)
    expect(pEdgeFor(resolveTuning({ certainty: 1 }))).toBeCloseTo(0.9)
  })

  it("lower certainty widens the dream: more seeds, higher epsilon floor", () => {
    expect(seedCountFor(resolveTuning({ certainty: 0 }))).toBeGreaterThan(
      seedCountFor(resolveTuning({ certainty: 1 })),
    )
    expect(epsilonFor(resolveTuning({ certainty: 0 }))).toBeGreaterThan(
      epsilonFor(resolveTuning({ certainty: 1 })),
    )
  })

  it("clamps certainty outside 0..1 instead of producing a nonsense probability", () => {
    expect(pEdgeFor(resolveTuning({ certainty: 5 }))).toBeLessThanOrEqual(1)
    expect(pEdgeFor(resolveTuning({ certainty: -3 }))).toBeGreaterThanOrEqual(0)
  })

  it("survives a NaN certainty instead of silently producing zero scenes", () => {
    // Regression: NaN certainty made seedCountFor return NaN, the seed loop ran
    // zero times, and the dream came back with no scenes at all — a silent
    // failure found only by running the agent for real.
    const t = resolveTuning({ certainty: NaN })
    expect(seedCountFor(t)).toBeGreaterThan(0)
    expect(Number.isFinite(epsilonFor(t))).toBe(true)
    expect(Number.isFinite(pEdgeFor(t))).toBe(true)
  })

  it("always walks at least one seed, even with a degenerate seed range", () => {
    expect(seedCountFor(resolveTuning({ seedCountRange: [0, 0] }))).toBeGreaterThanOrEqual(1)
  })
})

// ── Pressure (§5.2) ─────────────────────────────────────────────────

describe("computePressure", () => {
  const tuning = resolveTuning()

  it("counts new and updated relative to the last dream, not a rolling window", () => {
    const pages = [
      page({ slug: "old", created: "2026-01-01", updated: "2026-01-01" }),
      page({ slug: "fresh", created: "2026-08-05", updated: "2026-08-05" }),
      page({ slug: "touched", created: "2026-01-01", updated: "2026-08-06" }),
    ]
    const r = computePressure(
      { pages, overdueCount: 0, lastDreamDate: "2026-08-01", today: "2026-08-07" },
      tuning,
    )
    const get = (n: string) => r.components.find((c) => c.name === n)!
    expect(get("new pages").count).toBe(1) // fresh
    expect(get("updated pages").count).toBe(1) // touched, not double-counted as new
    expect(r.since).toBe("2026-08-01")
  })

  it("treats every page as new on a wiki that has never dreamt", () => {
    const pages = [page({ slug: "a" }), page({ slug: "b" })]
    const r = computePressure(
      { pages, overdueCount: 0, lastDreamDate: null, today: "2026-08-07" },
      tuning,
    )
    expect(r.components.find((c) => c.name === "new pages")!.count).toBe(2)
    expect(r.since).toBeNull()
  })

  it("accumulates pressure from days since the last dream (idle wikis drift up)", () => {
    const pages = [page({ slug: "a" })]
    const soon = computePressure(
      { pages, overdueCount: 0, lastDreamDate: "2026-08-06", today: "2026-08-07" },
      tuning,
    )
    const later = computePressure(
      { pages, overdueCount: 0, lastDreamDate: "2026-07-07", today: "2026-08-07" },
      tuning,
    )
    expect(later.score).toBeGreaterThan(soon.score)
  })

  it("suggestDream flips at the threshold and stays a suggestion", () => {
    const pages = Array.from({ length: 20 }, (_, i) => page({ slug: `n${i}`, created: "2026-08-05" }))
    const r = computePressure(
      { pages, overdueCount: 0, lastDreamDate: "2026-08-01", today: "2026-08-02" },
      resolveTuning({ pressureThreshold: 10 }),
    )
    expect(r.score).toBeGreaterThanOrEqual(10)
    expect(r.suggestDream).toBe(true)
  })

  it("weights are visible in the report, so the reading can be audited", () => {
    const r = computePressure(
      { pages: [], overdueCount: 3, lastDreamDate: "2026-08-01", today: "2026-08-01" },
      tuning,
    )
    const overdue = r.components.find((c) => c.name === "freshness overdue")!
    expect(overdue).toMatchObject({ count: 3, weight: 1, contribution: 3 })
  })
})

// ── Open-thread detection (§5.5) ────────────────────────────────────

describe("thread detection", () => {
  it("finds hypothesis pages by body scan — the reason agent marks status in the body", () => {
    expect(isHypothesisPage(page({ slug: "a", content: "Epistemic status: hypothesis\nmore" }))).toBe(true)
    expect(isHypothesisPage(page({ slug: "b", content: "status:  HYPOTHESIS" }))).toBe(true)
    expect(isHypothesisPage(page({ slug: "c", content: "an established finding" }))).toBe(false)
  })

  it("counts only contradicts relations among typed related entries", () => {
    const pages = [
      page({ slug: "a", related: [{ slug: "b", relation: "contradicts" }, { slug: "c", relation: "supports" }] }),
      page({ slug: "b", related: ["plain-string-link"] }),
    ]
    expect(countContradictsEdges(pages)).toBe(1)
  })

  it("carries unresolved threads from the previous journal entry first", () => {
    const pages = [
      page({ slug: "h", content: "status: hypothesis" }),
      page({ slug: "v", tags: ["needs-verification"] }),
    ]
    const threads = collectOpenThreads(pages, {
      date: "2026-08-01",
      seed: "20260801",
      threads_carried: ["hypothesis:older"],
    })
    expect(threads.carried).toEqual(["hypothesis:older"])
    expect(threads.hypothesisPages).toEqual(["h"])
    expect(threads.needsVerification).toEqual(["v"])
  })
})

// ── Salience (§5.3) ─────────────────────────────────────────────────

describe("computeSalience", () => {
  const tuning = resolveTuning()

  it("ranks a hub that is read often above an isolated unread node", () => {
    const pages = [page({ slug: "hub" }), page({ slug: "lonely" })]
    const s = computeSalience(
      {
        pages,
        graph: graphOf([["a", "hub"], ["b", "hub"]]),
        usage: usageOf({ hub: 10 }),
        overdueDays: new Map(),
        today: "2026-08-07",
      },
      tuning,
    )
    expect(s[0].slug).toBe("hub")
    expect(s.find((e) => e.slug === "hub")!.inDegree).toBe(2)
  })

  it("uses the checked clock, not updated — otherwise compressing feeds itself", () => {
    // Both pages were just written (updated today). Only one was ever checked.
    const pages = [
      page({ slug: "compressed-by-dream", updated: "2026-08-07" }),
      page({ slug: "recently-checked", updated: "2026-08-07", checked: "2026-08-07" }),
    ]
    const s = computeSalience(
      {
        pages,
        graph: graphOf([]),
        usage: usageOf({}),
        overdueDays: new Map(),
        today: "2026-08-07",
      },
      tuning,
    )
    const dreamed = s.find((e) => e.slug === "compressed-by-dream")!
    const checked = s.find((e) => e.slug === "recently-checked")!

    // A fresh check means "someone just looked at it" → low touch score.
    expect(checked.daysSinceChecked).toBe(0)
    // Never checked must NOT read as fresh just because a write bumped updated.
    expect(dreamed.daysSinceChecked).toBeNull()
    expect(dreamed.score).toBeGreaterThan(checked.score)
  })

  it("rewards overdue nodes — stale but important is exactly dream material", () => {
    const pages = [page({ slug: "stale" }), page({ slug: "current" })]
    const s = computeSalience(
      {
        pages,
        graph: graphOf([]),
        usage: usageOf({}),
        overdueDays: new Map([["stale", 90]]),
        today: "2026-08-07",
      },
      tuning,
    )
    expect(s[0].slug).toBe("stale")
  })

  it("is deterministic: equal inputs give the same order", () => {
    const pages = [page({ slug: "b" }), page({ slug: "a" })]
    const input = {
      pages,
      graph: graphOf([]),
      usage: usageOf({}),
      overdueDays: new Map(),
      today: "2026-08-07",
    }
    expect(computeSalience(input, tuning).map((s) => s.slug)).toEqual(
      computeSalience(input, tuning).map((s) => s.slug),
    )
  })
})

// ── Random activation (§5.4) ────────────────────────────────────────

describe("dream scenes", () => {
  const salience = ["a", "b", "c", "d", "e", "f", "g", "h"].map((slug, i) => ({
    slug,
    title: slug,
    type: "concept",
    score: 1 - i * 0.1,
    usage30: 0,
    inDegree: 0,
    overdueDays: 0,
    daysSinceChecked: null,
  }))
  const adjacency = buildWalkAdjacency(graphOf([["a", "b"], ["b", "c"], ["d", "e"]]))

  it("same seed reproduces the same dream", () => {
    const t = resolveTuning()
    const one = buildDreamScenes(salience, adjacency, t, "20260807")
    const two = buildDreamScenes(salience, adjacency, t, "20260807")
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
  })

  it("different seeds give different dreams", () => {
    const t = resolveTuning()
    const a = buildDreamScenes(salience, adjacency, t, "20260807")
    const b = buildDreamScenes(salience, adjacency, t, "20260808")
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it("never repeats a node inside one scene", () => {
    const scenes = buildDreamScenes(salience, adjacency, resolveTuning(), "20260807")
    for (const scene of scenes) {
      expect(new Set(scene.nodes).size).toBe(scene.nodes.length)
    }
  })

  it("low certainty teleports — that IS the noise injection, no extra tool", () => {
    const scenes = buildDreamScenes(salience, adjacency, resolveTuning({ certainty: 0 }), "20260807")
    const hops = scenes.flatMap((s) => s.hops)
    expect(hops.some((h) => h.via === "teleport")).toBe(true)
  })

  it("high certainty follows real edges when they exist", () => {
    const dense = buildWalkAdjacency(
      graphOf([["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"], ["e", "f"], ["f", "g"], ["g", "h"], ["a", "h"]]),
    )
    const scenes = buildDreamScenes(salience, dense, resolveTuning({ certainty: 1 }), "20260807")
    const hops = scenes.flatMap((s) => s.hops)
    expect(hops.filter((h) => h.via === "edge").length).toBeGreaterThan(hops.filter((h) => h.via === "teleport").length)
  })

  it("respects the hop range", () => {
    const t = resolveTuning({ walkHopRange: [2, 4] })
    for (const scene of buildDreamScenes(salience, adjacency, t, "20260807")) {
      expect(scene.nodes.length).toBeGreaterThanOrEqual(2) // seed + ≥1 hop
      expect(scene.nodes.length).toBeLessThanOrEqual(5) // seed + ≤4 hops
    }
  })

  it("returns nothing on an empty wiki instead of throwing", () => {
    expect(buildDreamScenes([], new Map(), resolveTuning(), "20260807")).toEqual([])
  })

  it("handles a wiki with fewer pages than the seed count", () => {
    const tiny = salience.slice(0, 2)
    const scenes = buildDreamScenes(tiny, new Map(), resolveTuning(), "20260807")
    expect(scenes.length).toBeLessThanOrEqual(2)
  })

  it("mulberry32 rng stays inside [0,1)", () => {
    const rng = makeRng("20260807")
    for (let i = 0; i < 200; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

// ── Journal (§5.1) ──────────────────────────────────────────────────

describe("journal", () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-dream-"))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it("returns null on a wiki that has never dreamt", async () => {
    expect(await readLastJournalEntry(root)).toBeNull()
  })

  it("appends and reads back the last entry", async () => {
    await appendJournalEntry(root, { date: "2026-08-01", seed: "20260801" })
    await appendJournalEntry(root, { date: "2026-08-07", seed: "20260807", threads_carried: ["x"] })

    const last = await readLastJournalEntry(root)
    expect(last).toMatchObject({ date: "2026-08-07", threads_carried: ["x"] })

    // Append-only: history is kept, not overwritten.
    const raw = await fs.readFile(journalPath(root), "utf8")
    expect(raw.trim().split("\n")).toHaveLength(2)
  })

  it("falls back to the previous line when the last one is torn", async () => {
    await appendJournalEntry(root, { date: "2026-08-01", seed: "20260801" })
    await fs.appendFile(journalPath(root), '{"date":"2026-08-0', "utf8")

    expect(await readLastJournalEntry(root)).toMatchObject({ date: "2026-08-01" })
  })

  it("lives outside wiki/ so it never pollutes the graph", () => {
    expect(journalPath(root)).toContain(".llm-wiki-ops")
    expect(journalPath(root)).not.toContain(`${path.sep}wiki${path.sep}`)
  })
})

// ── dreamsDir containment (§8.1) ────────────────────────────────────

describe("resolveDreamsDir", () => {
  const root = process.platform === "win32" ? "C:\\wiki-root" : "/wiki-root"

  it("defaults to wiki/dreams", () => {
    expect(resolveDreamsDir(root)).toBe(DEFAULT_DREAMS_DIR)
  })

  it("accepts any location inside the wiki subtree", () => {
    expect(resolveDreamsDir(root, "wiki/nested/dreams")).toBe("wiki/nested/dreams")
  })

  it("rejects a directory outside wiki/ — the graph could never see it", () => {
    // scanWiki only walks <wikiRoot>/wiki, so a dream page outside it has no
    // edges and can never be verified: the whole loop breaks.
    expect(() => resolveDreamsDir(root, "dreams")).toThrow(/inside <wikiRoot>\/wiki/)
    expect(() => resolveDreamsDir(root, "../escape")).toThrow(/inside <wikiRoot>\/wiki/)
  })
})

// ── Helpers ─────────────────────────────────────────────────────────

describe("daysBetween", () => {
  it("counts whole days and clamps negatives to zero", () => {
    expect(daysBetween("2026-08-01", "2026-08-07")).toBe(6)
    expect(daysBetween("2026-08-07", "2026-08-01")).toBe(0)
    expect(daysBetween("2026-08-07", "2026-08-07")).toBe(0)
  })

  it("returns 0 for unparseable input instead of NaN", () => {
    expect(daysBetween("not-a-date", "2026-08-07")).toBe(0)
  })
})
