/**
 * tests/dream-select.test.ts — the pure-code half of the dream agent.
 *
 * Covers what a dream's quality actually rests on: pressure baselines, the
 * salience components (including the self-pollution guard), seeded-walk
 * determinism, teleportation, journal round-trips, and the dreams-dir
 * containment rule.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
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
  findThemeMatches,
  isHypothesisPage,
  countContradictsEdges,
  makeRng,
  daysBetween,
  readLastJournalEntry,
  appendJournalEntry,
  journalPath,
} from "../src/agent/dream-select.js"
import { resolveDreamsDir, DEFAULT_DREAMS_DIR, extractTouchedSlugs } from "../src/agent/dream.js"
import { normalizeCompression } from "../src/types.js"

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

  it("ignores the dream's own pages — output must not raise its own pressure", () => {
    // Third instance of this loop shape (after usage stats and the touch clock):
    // dream pages written last night carry that night's created date, so five of
    // them would hand the next run five free points. Dream more → score higher →
    // "should" dream more.
    const pages = [
      page({ slug: "kb", created: "2026-07-01", updated: "2026-07-01" }),
      ...[1, 2, 3, 4, 5].map((i) =>
        page({ slug: `dream-${i}`, type: "dream", created: "2026-08-01", updated: "2026-08-01" }),
      ),
    ]
    const r = computePressure(
      { pages, overdueCount: 0, lastDreamDate: "2026-07-31", today: "2026-08-02" },
      tuning,
    )
    expect(r.components.find((c) => c.name === "new pages")!.count).toBe(0)
    expect(r.components.find((c) => c.name === "updated pages")!.count).toBe(0)
  })

  it("ignores knowledge pages the previous dream compressed itself", () => {
    // Fourth instance of the same loop shape, and the one the type filter above
    // does NOT catch: compression rewrites ordinary knowledge pages, so they stay
    // in scope and their bumped `updated` reads as fresh activity.
    //
    // The date comparison hid this: `updated > lastDreamDate` is strictly
    // greater, and compression normally lands on the journal's own date. A dream
    // that starts 23:50 UTC and writes 00:05 breaks the coincidence — journal
    // date 08-07, updated 08-08 — and six compressions become six free points.
    const compressed = [1, 2, 3, 4, 5, 6].map((i) =>
      page({ slug: `kb-${i}`, created: "2026-01-01", updated: "2026-08-08", compression: "condensed" }),
    )

    const naive = computePressure(
      { pages: compressed, overdueCount: 0, lastDreamDate: "2026-08-07", today: "2026-08-09" },
      tuning,
    )
    // Without the slug exclusion the free points are real, not hypothetical.
    expect(naive.components.find((c) => c.name === "updated pages")!.count).toBe(6)

    const guarded = computePressure(
      {
        pages: compressed,
        overdueCount: 0,
        lastDreamDate: "2026-08-07",
        lastDreamTouchedSlugs: compressed.map((p) => p.slug),
        today: "2026-08-09",
      },
      tuning,
    )
    expect(guarded.components.find((c) => c.name === "updated pages")!.count).toBe(0)
    expect(guarded.components.find((c) => c.name === "new pages")!.count).toBe(0)
  })

  it("still counts pages a human edited after the dream touched them", () => {
    // The exclusion is per-slug and lasts exactly one dream. A node the dream
    // compressed last night and a human rewrote this morning is genuine activity;
    // it must not be permanently invisible to pressure.
    const pages = [
      page({ slug: "kb-1", created: "2026-01-01", updated: "2026-08-08" }),
      page({ slug: "kb-2", created: "2026-01-01", updated: "2026-08-08" }),
    ]
    const r = computePressure(
      {
        pages,
        overdueCount: 0,
        lastDreamDate: "2026-08-07",
        lastDreamTouchedSlugs: ["kb-1"], // only kb-1 was the dream's own write
        today: "2026-08-09",
      },
      tuning,
    )
    expect(r.components.find((c) => c.name === "updated pages")!.count).toBe(1)
  })

  it("counts only knowledge pages on a first-ever dream", () => {
    const pages = [
      page({ slug: "a" }),
      page({ slug: "b" }),
      page({ slug: "d", type: "dream" }),
    ]
    const r = computePressure(
      { pages, overdueCount: 0, lastDreamDate: null, today: "2026-08-07" },
      tuning,
    )
    expect(r.components.find((c) => c.name === "new pages")!.count).toBe(2)
  })

  it("ignores hypothesis markers and contradicts edges inside dream pages", () => {
    const pages = [
      page({ slug: "d", type: "dream", content: "status: hypothesis", related: [{ slug: "x", relation: "contradicts" }] }),
    ]
    const r = computePressure(
      { pages, overdueCount: 0, lastDreamDate: "2026-08-01", today: "2026-08-02" },
      tuning,
    )
    expect(r.components.find((c) => c.name === "hypothesis pages")!.count).toBe(0)
    expect(r.components.find((c) => c.name === "contradicts edges")!.count).toBe(0)
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

  it("carries a thread whose subject still exists, and revisits it first", () => {
    const pages = [
      page({ slug: "h", content: "status: hypothesis" }),
      page({ slug: "v", tags: ["needs-verification"] }),
    ]
    const threads = collectOpenThreads(pages, {
      date: "2026-08-01",
      seed: "20260801",
      threads_carried: ["hypothesis:h"],
    })
    expect(threads.carried).toEqual(["hypothesis:h"])
    expect(threads.hypothesisPages).toEqual(["h"])
    expect(threads.needsVerification).toEqual(["v"])
  })

  it("prunes carried threads whose subject is gone — no ghosts in the prompt", () => {
    // Verdicts live in prose and can't be parsed reliably, but a thread's
    // SUBJECT is observable state: if the hypothesis page no longer says
    // hypothesis (or is deleted), the thread is settled either way. Without
    // this the carry list only grows and eventually dominates the prompt.
    const pages = [page({ slug: "h", content: "now an established finding" })]
    const threads = collectOpenThreads(pages, {
      date: "2026-08-01",
      seed: "20260801",
      threads_carried: [
        "hypothesis:h", // page exists but marker is gone → prune
        "hypothesis:deleted-page", // page gone → prune
        "needs-verification:v", // tag gone → prune
        "contradicts:a→b", // edge gone → prune
      ],
    })
    expect(threads.carried).toEqual([])
  })

  it("keeps a carried thread of unrecognised shape rather than losing a lead", () => {
    const threads = collectOpenThreads([], {
      date: "2026-08-01",
      seed: "20260801",
      threads_carried: ["some-freeform-note-from-a-future-version"],
    })
    expect(threads.carried).toEqual(["some-freeform-note-from-a-future-version"])
  })

  it("keeps unprefixed legacy entries — cannot be told from a future marker", () => {
    // Documented decision, not an oversight: the first journal format wrote bare
    // slugs, and a bare slug is shape-identical to a free-form marker a later
    // version might introduce. Pruning by shape would risk dropping live leads,
    // so both are carried; pre-release journals age out on their own.
    const threads = collectOpenThreads([], {
      date: "2026-08-01",
      seed: "20260801",
      threads_carried: ["legacy-bare-slug", "some-future-marker"],
    })
    expect(threads.carried).toEqual(["legacy-bare-slug", "some-future-marker"])
  })

  it("keeps a carried contradicts thread while the edge is still there", () => {
    const pages = [page({ slug: "a", related: [{ slug: "b", relation: "contradicts" }] })]
    const threads = collectOpenThreads(pages, {
      date: "2026-08-01",
      seed: "20260801",
      threads_carried: ["contradicts:a→b"],
    })
    expect(threads.carried).toEqual(["contradicts:a→b"])
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

  it("damps already-compressed nodes so a skeleton isn't re-compressed forever", () => {
    // Without damping a skeleton node keeps ranking as prime material and gets
    // picked every dream — the forgetting loop never terminates.
    const pages = [
      page({ slug: "active-node" }),
      page({ slug: "condensed-node", compression: "condensed" }),
      page({ slug: "skeleton-node", compression: "skeleton" }),
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
    const score = (slug: string) => s.find((e) => e.slug === slug)!.score
    expect(score("active-node")).toBeGreaterThan(score("condensed-node"))
    expect(score("condensed-node")).toBeGreaterThan(score("skeleton-node"))
  })

  it("surfaces the compression stage so the agent can see it", () => {
    const s = computeSalience(
      {
        pages: [page({ slug: "x", compression: "skeleton" }), page({ slug: "y" })],
        graph: graphOf([]),
        usage: usageOf({}),
        overdueDays: new Map(),
        today: "2026-08-07",
      },
      tuning,
    )
    expect(s.find((e) => e.slug === "x")!.compression).toBe("skeleton")
    expect(s.find((e) => e.slug === "y")!.compression).toBeUndefined()
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

  it("labels a forced jump dead-end, not teleport", () => {
    // The prompt tells the model teleport means "far apart on purpose". A hop
    // taken only because there was no unvisited neighbour carries no such
    // meaning and must not be over-interpreted.
    const isolated = new Map<string, string[]>() // no edges at all
    const scenes = buildDreamScenes(salience, isolated, resolveTuning({ certainty: 1 }), "20260807")
    const hops = scenes.flatMap((s) => s.hops)
    expect(hops.length).toBeGreaterThan(0)
    // No edges exist, so no hop can be an edge hop.
    expect(hops.some((h) => h.via === "edge")).toBe(false)
    // p_edge is 0.9 at certainty=1, so most hops wanted an edge and found none
    // → dead-end. The remaining ~10% chose to jump → genuine teleport.
    expect(hops.some((h) => h.via === "dead-end")).toBe(true)
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

  it("finds the last entry without reading the whole file", async () => {
    // Each entry embeds the full model report, so a year of nightly dreams is a
    // multi-megabyte file. Reading all of it to get one line gets worse daily.
    for (let i = 0; i < 40; i++) {
      await appendJournalEntry(root, {
        date: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`,
        seed: `seed-${i}`,
        report: "R".repeat(20_000), // fat entries, like a real report
      })
    }
    await appendJournalEntry(root, { date: "2026-08-07", seed: "final", threads_carried: ["x"] })

    const size = (await fs.stat(journalPath(root))).size
    expect(size).toBeGreaterThan(800_000) // well past any single read window

    const last = await readLastJournalEntry(root)
    expect(last).toMatchObject({ date: "2026-08-07", seed: "final", threads_carried: ["x"] })
  })

  it("finds the last good entry when the tail is torn, even in a large file", async () => {
    for (let i = 0; i < 30; i++) {
      await appendJournalEntry(root, { date: "2026-06-01", seed: `s${i}`, report: "R".repeat(20_000) })
    }
    await appendJournalEntry(root, { date: "2026-08-07", seed: "good" })
    await fs.appendFile(journalPath(root), '{"date":"2026-08-08","seed":"tor', "utf8")

    expect(await readLastJournalEntry(root)).toMatchObject({ seed: "good" })
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

describe("findThemeMatches", () => {
  const pages = [
    page({ slug: "稀土出口管制", title: "稀土出口管制", tags: ["稀土", "贸易"] }),
    page({ slug: "重稀土矿源", title: "重稀土矿源" }),
    page({ slug: "章鱼能源", title: "章鱼能源 (Octopus Energy)" }),
    page({ slug: "土地财政退场", title: "土地财政退场" }),
    page({ slug: "quantum-computing-race", title: "Quantum Computing Race" }),
  ]

  it("finds a theme the wiki genuinely covers", () => {
    const m = findThemeMatches(pages, "稀土")
    expect(m.count).toBe(2)
    expect(m.hasPurchase).toBe(true)
    expect(m.slugs).toContain("稀土出口管制")
  })

  it("reports no purchase for a theme the wiki knows nothing about", () => {
    const m = findThemeMatches(pages, "quantum entanglement")
    // "quantum" hits the Latin page; "entanglement" does not. One page is a
    // coincidence, not coverage.
    expect(m.hasPurchase).toBe(false)
  })

  it("treats a lone bigram collision as no purchase, not as coverage", () => {
    // The live failure: on a 1150-page economics wiki the theme
    // 深海章鱼的求偶仪式 matched exactly one page — 章鱼能源, i.e. Octopus Energy.
    // Counting that as a thread to follow would suppress the guidance written
    // for precisely this case.
    const m = findThemeMatches(pages, "深海章鱼的求偶仪式")
    expect(m.count).toBe(1)
    expect(m.slugs).toEqual(["章鱼能源"])
    expect(m.hasPurchase).toBe(false)
  })

  it("does not match on single CJK characters", () => {
    // "海" alone would hit 海峡/航海/海外 and manufacture false coverage for a
    // theme the graph has nothing on — bigrams are the minimum unit.
    const sea = [page({ slug: "霍尔木兹海峡通行权", title: "霍尔木兹海峡通行权" })]
    expect(findThemeMatches(sea, "深海章鱼").count).toBe(0)
  })

  it("matches tags, not just slug and title", () => {
    expect(findThemeMatches(pages, "贸易").count).toBe(1)
  })

  it("returns no purchase for a theme with no usable terms", () => {
    const m = findThemeMatches(pages, "!!! ???")
    expect(m.count).toBe(0)
    expect(m.hasPurchase).toBe(false)
  })

  it("caps the example slug list but keeps the full count", () => {
    const many = Array.from({ length: 20 }, (_, i) => page({ slug: `稀土-${i}` }))
    const m = findThemeMatches(many, "稀土", 3)
    expect(m.count).toBe(20)
    expect(m.slugs).toHaveLength(3)
  })
})

describe("extractTouchedSlugs", () => {
  const call = (over: Partial<{ tool: string; args: Record<string, unknown>; error: string }>) => ({
    iteration: 1,
    tool: over.tool ?? "wiki.update_node",
    args: over.args ?? {},
    result: null,
    error: over.error,
    durationMs: 1,
  })

  it("collects slugs from the write ops that bump `updated`", () => {
    const slugs = extractTouchedSlugs([
      call({ tool: "wiki.update_node", args: { slug: "compressed-a", compression: "condensed" } }),
      call({ tool: "wiki.delete_node", args: { slug: "gone" } }),
      call({ tool: "wiki.rename_node", args: { old_slug: "before", new_slug: "after" } }),
    ])
    expect(slugs.sort()).toEqual(["after", "before", "compressed-a", "gone"])
  })

  it("ignores reads and edge ops — they do not bump `updated` on a page", () => {
    // add_edge writes to related[] but the pressure counters key off created and
    // updated, and edges have their own component. Only page rewrites matter here.
    expect(
      extractTouchedSlugs([
        call({ tool: "wiki.get_node", args: { slug: "just-read" } }),
        call({ tool: "wiki.read_graph", args: {} }),
        call({ tool: "wiki.add_edge", args: { source: "a", target: "b" } }),
      ]),
    ).toEqual([])
  })

  it("skips failed calls — nothing was written", () => {
    expect(
      extractTouchedSlugs([
        call({ tool: "wiki.update_node", args: { slug: "failed" }, error: "CONFLICT" }),
      ]),
    ).toEqual([])
  })

  it("dedupes a slug written more than once", () => {
    expect(
      extractTouchedSlugs([
        call({ args: { slug: "twice" } }),
        call({ args: { slug: "twice", tags: ["x"] } }),
      ]),
    ).toEqual(["twice"])
  })

  it("tolerates a bare tool name without the server prefix", () => {
    // resolveToolName restores dropped prefixes, but a log written before that
    // ran (or from a local tool) can still carry the bare form.
    expect(extractTouchedSlugs([call({ tool: "update_node", args: { slug: "bare" } })])).toEqual([
      "bare",
    ])
  })
})

// ── Helpers ─────────────────────────────────────────────────────────

describe("normalizeCompression", () => {
  it("accepts the three real stages", () => {
    expect(normalizeCompression("active")).toBe("active")
    expect(normalizeCompression("condensed")).toBe("condensed")
    expect(normalizeCompression("skeleton")).toBe("skeleton")
  })

  it("trims and case-folds, so a typo doesn't escape damping", () => {
    // The damping table is keyed by exact stage, so "SKELETON " used to fall back
    // to full weight — letting a node dodge decay and get re-compressed forever.
    expect(normalizeCompression(" Skeleton ")).toBe("skeleton")
    expect(normalizeCompression("CONDENSED")).toBe("condensed")
  })

  it("treats an unknown value as active rather than storing it verbatim", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(normalizeCompression("SKELETON!!")).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it("ignores empty and non-string input", () => {
    expect(normalizeCompression("")).toBeUndefined()
    expect(normalizeCompression("   ")).toBeUndefined()
    expect(normalizeCompression(undefined)).toBeUndefined()
    expect(normalizeCompression(42)).toBeUndefined()
  })
})

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
