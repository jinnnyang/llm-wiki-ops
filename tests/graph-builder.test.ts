import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createFixtureWiki, type FixtureWiki } from "./helpers.js"
import { readGraph, getNode, getEdges, getStats } from "../src/core/graph-builder.js"
import { ResultTooLargeError } from "../src/utils/errors.js"

let fixture: FixtureWiki

beforeAll(async () => {
  fixture = await createFixtureWiki()
})

afterAll(async () => {
  await fixture.cleanup()
})

describe("readGraph", () => {
  it("scans all pages (15+ nodes)", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root)
    expect(graph.nodes.length).toBeGreaterThanOrEqual(15)
    expect(graph.edges.length).toBeGreaterThan(0)
  })

  it("skips index.md and log.md", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root)
    const slugs = graph.nodes.map((n) => n.slug)
    expect(slugs).not.toContain("index")
    expect(slugs).not.toContain("log")
  })

  it("filters by type", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root, { type: "entity" })
    expect(graph.nodes.length).toBeGreaterThanOrEqual(4)
    for (const node of graph.nodes) {
      expect(node.type).toBe("entity")
    }
  })

  it("filters by tag", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root, { tag: "AI" })
    expect(graph.nodes.length).toBeGreaterThan(0)
    for (const node of graph.nodes) {
      expect(node.tags.map((t) => t.toLowerCase())).toContain("ai")
    }
  })

  it("filters by query substring", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root, { query: "nvidia" })
    expect(graph.nodes.length).toBeGreaterThan(0)
    for (const node of graph.nodes) {
      const match =
        node.title.toLowerCase().includes("nvidia") || node.slug.includes("nvidia")
      expect(match).toBe(true)
    }
  })

  it("BFS neighborhood with center + k", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root, {
      center: "nvidia",
      k: 1,
    })
    const slugs = new Set(graph.nodes.map((n) => n.slug))
    expect(slugs.has("nvidia")).toBe(true)
    // nvidia is connected to hbm, ai基建周期, tsmc, etc.
    expect(graph.nodes.length).toBeGreaterThan(1)
    expect(graph.nodes.length).toBeLessThan(15) // not the whole wiki
  })

  it("throws RESULT_TOO_LARGE when over limit", async () => {
    await expect(
      readGraph(fixture.wikiDir, fixture.root, { limit: 2 }),
    ).rejects.toThrow(ResultTooLargeError)
  })

  it("infers type from directory when frontmatter missing", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root)
    const barePage = graph.nodes.find((n) => n.slug === "bare-page")
    expect(barePage).toBeDefined()
    expect(barePage!.type).toBe("concept") // in concepts/ dir
  })

  it("handles dirty related data ([[wikilink]] in related[])", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root)
    const dirty = graph.nodes.find((n) => n.slug === "dirty-data")
    expect(dirty).toBeDefined()
    // related should be cleaned: "[[nvidia]]" → "nvidia"
    expect(dirty!.related).toContain("nvidia")
    expect(dirty!.related).not.toContain("[[nvidia]]")
  })

  it("skips wikilinks inside code blocks", async () => {
    const graph = await readGraph(fixture.wikiDir, fixture.root)
    const kvCache = graph.nodes.find((n) => n.slug === "kv-cache")
    expect(kvCache).toBeDefined()
    // Should NOT have edges to "这不是wikilink" or "也不是"
    const kvEdges = graph.edges.filter(
      (e) => e.source === "kv-cache" || e.target === "kv-cache",
    )
    for (const edge of kvEdges) {
      expect(edge.target).not.toContain("这不是")
      expect(edge.source).not.toContain("也不是")
    }
  })
})

describe("getNode", () => {
  it("returns full page detail", async () => {
    const page = await getNode(fixture.wikiDir, fixture.root, "nvidia")
    expect(page).not.toBeNull()
    expect(page!.title).toBe("英伟达 (NVIDIA)")
    expect(page!.type).toBe("entity")
    expect(page!.tags).toContain("半导体")
    expect(page!.content).toContain("GPU 龙头")
  })

  it("returns null for missing slug", async () => {
    const page = await getNode(fixture.wikiDir, fixture.root, "nonexistent")
    expect(page).toBeNull()
  })

  it("handles NFKC slug lookup", async () => {
    // The file is ｔｅｓｔ-ｎｆｋｃ.md (fullwidth), normalized slug = test-nfkc
    const page = await getNode(fixture.wikiDir, fixture.root, "test-nfkc")
    expect(page).not.toBeNull()
    expect(page!.title).toBe("Ｔｅｓｔ ＮＦＫＣ")
  })
})

describe("getEdges", () => {
  it("returns inbound + outbound for k=1", async () => {
    const result = await getEdges(fixture.wikiDir, fixture.root, "nvidia")
    expect("inbound" in result).toBe(true)
    if ("inbound" in result) {
      expect(result.inbound.length).toBeGreaterThan(0)
      expect(result.outbound.length).toBeGreaterThan(0)
    }
  })

  it("returns flat edges with depth for k>1", async () => {
    const result = await getEdges(fixture.wikiDir, fixture.root, "nvidia", { k: 2 })
    expect("edges" in result).toBe(true)
    if ("edges" in result) {
      expect(result.edges.length).toBeGreaterThan(0)
      for (const edge of result.edges) {
        expect(edge.depth).toBeGreaterThanOrEqual(1)
        expect(edge.depth).toBeLessThanOrEqual(2)
      }
    }
  })
})

describe("getStats", () => {
  it("returns correct structure", async () => {
    const stats = await getStats(fixture.wikiDir, fixture.root)
    expect(stats.totalNodes).toBeGreaterThanOrEqual(15)
    expect(stats.totalEdges).toBeGreaterThan(0)
    expect(stats.types).toHaveProperty("entity")
    expect(stats.types).toHaveProperty("concept")
    expect(stats.topTags.length).toBeGreaterThan(0)
    expect(stats.largestNeighborhoods.length).toBeGreaterThan(0)
  })

  it("orders known types before unknown", async () => {
    const stats = await getStats(fixture.wikiDir, fixture.root)
    const typeKeys = Object.keys(stats.types)
    const entityIdx = typeKeys.indexOf("entity")
    const conceptIdx = typeKeys.indexOf("concept")
    expect(entityIdx).toBeLessThan(conceptIdx)
  })
})
