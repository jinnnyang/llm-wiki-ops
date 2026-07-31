/**
 * Tests for metrics module: topology, source-overlap, type-edges, type-balance.
 * Pure functions — no filesystem needed.
 */

import { describe, it, expect } from "vitest"
import type { Graph, GraphNode, GraphEdge } from "../src/types.js"
import { computeTopology } from "../src/metrics/topology.js"
import { computeSourceOverlap } from "../src/metrics/source-overlap.js"
import { computeTypeEdges } from "../src/metrics/type-edges.js"
import { computeTypeBalance } from "../src/metrics/type-balance.js"
import { computeMetrics } from "../src/metrics/index.js"

// ── Helpers ─────────────────────────────────────────────────────────

function node(slug: string, type = "entity", sources: string[] = []): GraphNode {
  return {
    slug,
    title: slug,
    type,
    tags: [],
    related: [],
    sources,
    created: "2025-01-01",
    updated: "2025-01-01",
    path: `wiki/entities/${slug}.md`,
  }
}

function edge(source: string, target: string): GraphEdge {
  return { source, target, origins: ["wikilink"] }
}

// ── Topology ────────────────────────────────────────────────────────

describe("computeTopology", () => {
  it("empty graph", () => {
    const t = computeTopology({ nodes: [], edges: [] })
    expect(t.nodeCount).toBe(0)
    expect(t.edgeCount).toBe(0)
    expect(t.degree.isolated).toBe(0)
    expect(t.hubs).toEqual([])
    expect(t.components.count).toBe(0)
  })

  it("single isolated node", () => {
    const t = computeTopology({ nodes: [node("a")], edges: [] })
    expect(t.nodeCount).toBe(1)
    expect(t.degree.mean).toBe(0)
    expect(t.degree.isolated).toBe(1)
    expect(t.components.count).toBe(1)
    expect(t.components.largestSize).toBe(1)
    expect(t.components.fragmentationIndex).toBe(0)
  })

  it("chain a→b→c: degrees and components", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b"), edge("b", "c")],
    }
    const t = computeTopology(g)
    expect(t.edgeCount).toBe(2)
    expect(t.degree.mean).toBeCloseTo(4 / 3, 1)
    expect(t.degree.max).toBe(2) // b has in+out = 2
    expect(t.degree.isolated).toBe(0)
    expect(t.components.count).toBe(1)
    expect(t.components.largestRatio).toBe(1)
  })

  it("two disconnected components", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [edge("a", "b"), edge("c", "d")],
    }
    const t = computeTopology(g)
    expect(t.components.count).toBe(2)
    expect(t.components.largestSize).toBe(2)
    expect(t.components.largestRatio).toBe(0.5)
    expect(t.components.fragmentationIndex).toBe(0.5)
  })

  it("hub detection: star graph", () => {
    // hub connected to 10 leaves
    const nodes = [node("hub"), ...Array.from({ length: 10 }, (_, i) => node(`leaf${i}`))]
    const edges = Array.from({ length: 10 }, (_, i) => edge("hub", `leaf${i}`))
    const t = computeTopology({ nodes, edges })
    expect(t.hubs.length).toBeGreaterThanOrEqual(1)
    expect(t.hubs[0].slug).toBe("hub")
    expect(t.hubs[0].outDegree).toBe(10)
    expect(t.hubs[0].totalDegree).toBe(10)
  })

  it("small components listed", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c"), node("d"), node("e"), node("f")],
      edges: [edge("a", "b"), edge("c", "d"), edge("e", "f")],
    }
    const t = computeTopology(g)
    // All components have size 2 < 5
    expect(t.components.smallComponents.length).toBe(3)
    expect(t.components.smallComponents[0].size).toBe(2)
  })
})

// ── Source Overlap ──────────────────────────────────────────────────

describe("computeSourceOverlap", () => {
  it("no sources", () => {
    const g: Graph = { nodes: [node("a"), node("b")], edges: [] }
    const s = computeSourceOverlap(g)
    expect(s.pagesWithSources).toBe(0)
    expect(s.pagesWithoutSources).toBe(2)
    expect(s.uniqueSources).toBe(0)
    expect(s.duplicateClusters).toEqual([])
  })

  it("duplicate cluster: same source set", () => {
    const g: Graph = {
      nodes: [
        node("a", "entity", ["https://reuters.com/article-1"]),
        node("b", "entity", ["https://reuters.com/article-1"]),
        node("c", "entity", ["https://bloomberg.com/article-2"]),
      ],
      edges: [],
    }
    const s = computeSourceOverlap(g)
    expect(s.pagesWithSources).toBe(3)
    expect(s.uniqueSources).toBe(2)
    expect(s.duplicateClusters.length).toBe(1)
    expect(s.duplicateClusters[0].pages.map((p) => p.slug).sort()).toEqual(["a", "b"])
  })

  it("over-extracted source: 3+ pages", () => {
    const src = "https://example.com/mega-article"
    const g: Graph = {
      nodes: [node("a", "entity", [src]), node("b", "entity", [src]), node("c", "entity", [src])],
      edges: [],
    }
    const s = computeSourceOverlap(g)
    expect(s.overExtractedSources.length).toBe(1)
    expect(s.overExtractedSources[0].pageCount).toBe(3)
  })

  it("top sources sorted by page count", () => {
    const g: Graph = {
      nodes: [
        node("a", "entity", ["s1", "s2"]),
        node("b", "entity", ["s1"]),
        node("c", "entity", ["s2"]),
      ],
      edges: [],
    }
    const s = computeSourceOverlap(g)
    expect(s.topSources[0].source).toBe("s1")
    expect(s.topSources[0].pageCount).toBe(2)
  })
})

// ── Type Edges ──────────────────────────────────────────────────────

describe("computeTypeEdges", () => {
  it("empty graph", () => {
    const te = computeTypeEdges({ nodes: [], edges: [] })
    expect(te.types).toEqual([])
    expect(te.counts).toEqual([])
  })

  it("cross-type matrix", () => {
    const g: Graph = {
      nodes: [node("e1", "entity"), node("c1", "concept"), node("e2", "entity")],
      edges: [edge("e1", "c1"), edge("e1", "e2"), edge("c1", "e1")],
    }
    const te = computeTypeEdges(g)
    // entity has 2 outgoing, concept has 1
    expect(te.types).toContain("entity")
    expect(te.types).toContain("concept")

    const ei = te.types.indexOf("entity")
    const ci = te.types.indexOf("concept")
    // entity→entity: 1, entity→concept: 1
    expect(te.counts[ei][ei]).toBe(1)
    expect(te.counts[ei][ci]).toBe(1)
    // concept→entity: 1
    expect(te.counts[ci][ei]).toBe(1)
    // ratios: entity row sums to 1
    expect(te.ratios[ei].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 2)
  })
})

// ── Type Balance ────────────────────────────────────────────────────

describe("computeTypeBalance", () => {
  it("empty graph", () => {
    const tb = computeTypeBalance({ nodes: [], edges: [] })
    expect(tb.total).toBe(0)
    expect(tb.dominant).toBeNull()
    expect(tb.emptyKnownTypes.length).toBe(7) // all known types empty
  })

  it("distribution and dominant", () => {
    const g: Graph = {
      nodes: [node("e1", "entity"), node("e2", "entity"), node("c1", "concept")],
      edges: [],
    }
    const tb = computeTypeBalance(g)
    expect(tb.total).toBe(3)
    expect(tb.dominant!.type).toBe("entity")
    expect(tb.dominant!.count).toBe(2)
    expect(tb.distribution[0].type).toBe("entity")
    expect(tb.distribution[0].ratio).toBeCloseTo(0.667, 2)
  })

  it("empty known types detected", () => {
    const g: Graph = {
      nodes: [node("e1", "entity")],
      edges: [],
    }
    const tb = computeTypeBalance(g)
    expect(tb.emptyKnownTypes).toContain("concept")
    expect(tb.emptyKnownTypes).toContain("source")
    expect(tb.emptyKnownTypes).not.toContain("entity")
  })
})

// ── Unified computeMetrics ──────────────────────────────────────────

describe("computeMetrics", () => {
  it("returns all four sections", () => {
    const g: Graph = {
      nodes: [node("a", "entity", ["s1"]), node("b", "concept", ["s1"])],
      edges: [edge("a", "b")],
    }
    const m = computeMetrics(g)
    expect(m.topology.nodeCount).toBe(2)
    expect(m.sourceOverlap.pagesWithSources).toBe(2)
    expect(m.typeEdges.types.length).toBe(2)
    expect(m.typeBalance.total).toBe(2)
  })
})
