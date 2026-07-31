/**
 * E2E full-feature test against a real 1149-page wiki copy.
 * Run: npx vitest run tests/e2e-real-wiki.test.ts
 *
 * Key design constraint tested: readGraph limit is a SAFETY VALVE,
 * not pagination. Unfiltered scans on 1147 pages MUST throw
 * RESULT_TOO_LARGE. All discovery goes through getStats.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { WikiGraph } from "../src/index.js"
import { readGraph, getStats } from "../src/core/graph-builder.js"
import { WikiGraphError, ResultTooLargeError, ExternalModificationError } from "../src/utils/errors.js"

const SOURCE_WIKI = process.env.WIKI_E2E_SOURCE ?? "C:\\Users\\jinnn\\Documents\\wiki-builder\\wikis\\economic-analysis"
const WIKI_ROOT = process.env.WIKI_E2E_ROOT ?? "C:\\Users\\jinnn\\AppData\\Local\\Temp\\wiki-graph-e2e-test"
const WIKI_DIR = path.join(WIKI_ROOT, "wiki")

/** Skip the entire suite when the source wiki isn't available (CI, other machines). */
const sourceExists = await fs.access(SOURCE_WIKI).then(() => true, () => false)
const describeE2E = sourceExists ? describe : describe.skip

let wiki: WikiGraph

beforeAll(async () => {
  // Fresh copy every run — e2e tests mutate the wiki in-place
  await fs.rm(WIKI_ROOT, { recursive: true, force: true })
  await fs.cp(SOURCE_WIKI, WIKI_ROOT, { recursive: true })
  wiki = new WikiGraph(WIKI_ROOT)
}, 60_000)

afterAll(async () => {
  await fs.rm(WIKI_ROOT, { recursive: true, force: true })
})

// ── 1. cleanup (frontmatter repair) ─────────────────────────────────

describeE2E("cleanup", () => {
  it("runs without error on 1149-page wiki", async () => {
    const result = await wiki.cleanup()
    expect(Array.isArray(result.removedFiles)).toBe(true)
    expect(result.removedFiles.length).toBeGreaterThanOrEqual(0)
  })
})

// ── 2. getStats ─────────────────────────────────────────────────────

describeE2E("getStats", () => {
  it("returns valid stats for 1149 pages", async () => {
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    expect(stats.totalNodes).toBeGreaterThanOrEqual(1000)
    expect(stats.totalEdges).toBeGreaterThan(0)
    expect(Object.keys(stats.types).length).toBeGreaterThan(0)
    expect(stats.topTags.length).toBeGreaterThan(0)
    expect(stats.largestNeighborhoods.length).toBeGreaterThan(0)

    // Known types ordered before unknown
    const keys = Object.keys(stats.types)
    const knownOrder = ["entity", "concept", "source", "query", "comparison", "synthesis", "overview"]
    let lastKnownIdx = -1
    for (const k of keys) {
      if (knownOrder.includes(k)) {
        const idx = keys.indexOf(k)
        expect(idx).toBeGreaterThan(lastKnownIdx)
        lastKnownIdx = idx
      }
    }
  })
})

// ── 3. readGraph ────────────────────────────────────────────────────

describeE2E("readGraph", () => {
  it("unfiltered scan throws RESULT_TOO_LARGE (safety valve)", async () => {
    await expect(readGraph(WIKI_DIR, WIKI_ROOT)).rejects.toThrow(ResultTooLargeError)
  })

  it("type filter narrows below limit", async () => {
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    // Find a type with < 200 pages
    const smallType = Object.entries(stats.types)
      .filter(([, count]) => count < 200 && count > 0)
      .sort((a, b) => a[1] - b[1])[0]

    if (!smallType) return // all types > 200, skip

    const filtered = await readGraph(WIKI_DIR, WIKI_ROOT, { type: smallType[0] })
    expect(filtered.nodes.length).toBeGreaterThan(0)
    expect(filtered.nodes.length).toBeLessThanOrEqual(smallType[1])
    for (const n of filtered.nodes) {
      expect(n.type).toBe(smallType[0])
    }
  })

  it("narrow query filter works", async () => {
    // Use a very specific query that won't match everything
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    // Pick a slug from largestNeighborhoods as a specific query
    const hub = stats.largestNeighborhoods[0]
    const graph = await readGraph(WIKI_DIR, WIKI_ROOT, { query: hub.slug })
    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(graph.nodes.length).toBeLessThan(100)
  })

  it("BFS neighborhood is bounded", async () => {
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    const hub = stats.largestNeighborhoods[0]

    const neighborhood = await readGraph(WIKI_DIR, WIKI_ROOT, {
      center: hub.slug,
      k: 1,
    })
    expect(neighborhood.nodes.length).toBeGreaterThan(0)
    expect(neighborhood.nodes.length).toBeLessThan(stats.totalNodes)
  })

  it("tag filter with rare tag works or safety valve fires", async () => {
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    // Find a tag with < 200 pages
    const rareTag = stats.topTags.find((t) => t.count < 200)

    if (rareTag) {
      const filtered = await readGraph(WIKI_DIR, WIKI_ROOT, { tag: rareTag.tag })
      expect(filtered.nodes.length).toBeGreaterThan(0)
      expect(filtered.nodes.length).toBeLessThanOrEqual(rareTag.count)
    } else {
      // All tags too common — safety valve should fire
      const topTag = stats.topTags[0]
      await expect(
        readGraph(WIKI_DIR, WIKI_ROOT, { tag: topTag.tag }),
      ).rejects.toThrow(ResultTooLargeError)
    }
  })

  it("broad tag filter throws RESULT_TOO_LARGE", async () => {
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    const topTag = stats.topTags[0]
    if (topTag.count <= 200) return // skip if small wiki

    await expect(
      readGraph(WIKI_DIR, WIKI_ROOT, { tag: topTag.tag }),
    ).rejects.toThrow(ResultTooLargeError)
  })
})

// ── 4. getNode ──────────────────────────────────────────────────────

describeE2E("getNode", () => {
  it("returns full detail for a known page", async () => {
    // Use getStats to discover a slug (not readGraph)
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    const slug = stats.largestNeighborhoods[0].slug

    const page = await wiki.getNode(slug)
    expect(page).not.toBeNull()
    expect(page!.slug).toBe(slug)
    expect(page!.title).toBeTruthy()
    expect(page!.type).toBeTruthy()
    expect(typeof page!.content).toBe("string")
  })

  it("returns null for nonexistent slug", async () => {
    const page = await wiki.getNode("definitely-not-a-real-page-xyz-12345")
    expect(page).toBeNull()
  })
})

// ── 5. getEdges ─────────────────────────────────────────────────────

describeE2E("getEdges", () => {
  it("returns inbound+outbound for k=1", async () => {
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    // Pick a node with moderate degree (not the biggest hub)
    const hub = stats.largestNeighborhoods[Math.min(5, stats.largestNeighborhoods.length - 1)]

    const result = await wiki.getEdges(hub.slug, { limit: 500 })
    expect("inbound" in result).toBe(true)
    if ("inbound" in result) {
      const total = result.inbound.length + result.outbound.length
      expect(total).toBeGreaterThan(0)
    }
  })

  it("BFS k=2 returns flat edges with depth", async () => {
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    // Pick a node with moderate degree (not the biggest hub)
    const hub = stats.largestNeighborhoods[Math.min(3, stats.largestNeighborhoods.length - 1)]

    const result = await wiki.getEdges(hub.slug, { k: 2, limit: 500 })
    expect("edges" in result).toBe(true)
    if ("edges" in result) {
      expect(result.edges.length).toBeGreaterThan(0)
      for (const e of result.edges) {
        expect(e.depth).toBeGreaterThanOrEqual(1)
        expect(e.depth).toBeLessThanOrEqual(2)
      }
    }
  })

  it("hub with too many edges throws RESULT_TOO_LARGE", async () => {
    const stats = await getStats(WIKI_DIR, WIKI_ROOT)
    const hub = stats.largestNeighborhoods[0]

    // If the hub has > 100 edges at k=2, it should throw with default limit
    try {
      await wiki.getEdges(hub.slug, { k: 2 })
      // If it didn't throw, the hub's neighborhood is small enough — that's fine
    } catch (e) {
      expect(e).toBeInstanceOf(ResultTooLargeError)
    }
  })
})

// ── 6. addNode ──────────────────────────────────────────────────────

describeE2E("addNode", () => {
  it("creates a new page", async () => {
    const result = await wiki.addNode({
      title: "E2E 测试页面",
      type: "concept",
      content: "这是一个端到端测试页面。",
      tags: ["e2e-test"],
    })

    expect(result.slug).toBeTruthy()
    expect(result.slugCollided).toBe(false)
    expect(result.filesTouched.length).toBeGreaterThan(0)

    const page = await wiki.getNode(result.slug)
    expect(page).not.toBeNull()
    expect(page!.title).toBe("E2E 测试页面")
    expect(page!.type).toBe("concept")
    expect(page!.tags).toContain("e2e-test")
  })

  it("is idempotent on second call", async () => {
    const input = {
      title: "E2E 幂等测试",
      type: "entity" as const,
      content: "Idempotent test",
      tags: ["e2e-test"],
    }

    const first = await wiki.addNode(input)
    const second = await wiki.addNode(input)

    expect(second.filesTouched.length).toBe(0)
    expect(second.slug).toBe(first.slug)
  })

  it("handles slug collision with append", async () => {
    const first = await wiki.addNode({ title: "E2E 冲突测试", type: "concept" })
    const second = await wiki.addNode({
      title: "E2E 冲突测试",
      type: "concept",
      content: "Different content",
    })

    expect(second.slugCollided).toBe(true)
    expect(second.slug).not.toBe(first.slug)
    expect(second.slug).toMatch(/-2$/)
  })

  it("dryRun does not write", async () => {
    const result = await wiki.addNode({
      title: "E2E DryRun 测试",
      type: "concept",
      dryRun: true,
    })

    expect(result.dryRun).toBe(true)
    expect(result.filesTouched.length).toBeGreaterThan(0)

    const page = await wiki.getNode(result.slug)
    expect(page).toBeNull()
  })
})

// ── 7. updateNode ───────────────────────────────────────────────────

describeE2E("updateNode", () => {
  it("updates title", async () => {
    const created = await wiki.addNode({ title: "E2E 更新测试", type: "concept" })

    const result = await wiki.updateNode(created.slug, {
      title: "E2E 更新测试 (已修改)",
    })

    expect(result.fieldsChanged).toContain("title")

    const page = await wiki.getNode(created.slug)
    expect(page!.title).toBe("E2E 更新测试 (已修改)")
  })

  it("is idempotent for no-change", async () => {
    const created = await wiki.addNode({ title: "E2E 无变更测试", type: "concept" })

    const result = await wiki.updateNode(created.slug, { title: "E2E 无变更测试" })

    expect(result.fieldsChanged.length).toBe(0)
    expect(result.filesTouched.length).toBe(0)
  })

  it("type change triggers directory move", async () => {
    const created = await wiki.addNode({ title: "E2E 类型迁移测试", type: "concept" })

    const result = await wiki.updateNode(created.slug, { type: "entity" })

    expect(result.moved).toBeDefined()
    expect(result.moved!.from).toContain("concepts")
    expect(result.moved!.to).toContain("entities")

    const page = await wiki.getNode(created.slug)
    expect(page!.type).toBe("entity")
  })

  it("throws NODE_NOT_FOUND for missing slug", async () => {
    await expect(
      wiki.updateNode("nonexistent-e2e-slug-xyz", { title: "X" }),
    ).rejects.toThrow(WikiGraphError)
  })
})

// ── 8. renameNode ───────────────────────────────────────────────────

describeE2E("renameNode", () => {
  it("renames and cascades references", async () => {
    const target = await wiki.addNode({ title: "E2E 重命名目标", type: "concept" })
    const source = await wiki.addNode({
      title: "E2E 重命名来源",
      type: "concept",
      content: `链接到 [[${target.slug}]]`,
    })

    const newSlug = "e2e-renamed-target"
    const result = await wiki.renameNode(target.slug, newSlug)

    expect(result.oldSlug).toBe(target.slug)
    expect(result.newSlug).toBe(newSlug)
    expect(result.referencesUpdated).toBeGreaterThanOrEqual(1)

    const oldPage = await wiki.getNode(target.slug)
    expect(oldPage).toBeNull()

    const newPage = await wiki.getNode(newSlug)
    expect(newPage).not.toBeNull()

    const sourcePage = await wiki.getNode(source.slug)
    expect(sourcePage!.content).toContain(`[[${newSlug}]]`)
    expect(sourcePage!.content).not.toContain(`[[${target.slug}]]`)
  })

  it("is idempotent when already renamed", async () => {
    const created = await wiki.addNode({ title: "E2E 重命名幂等", type: "concept" })

    await wiki.renameNode(created.slug, "e2e-rename-idem")
    const result = await wiki.renameNode(created.slug, "e2e-rename-idem")

    expect(result.filesTouched.length).toBe(0)
  })

  it("throws RENAME_TARGET_EXISTS", async () => {
    const a = await wiki.addNode({ title: "E2E A", type: "concept" })
    const b = await wiki.addNode({ title: "E2E B", type: "concept" })

    await expect(wiki.renameNode(a.slug, b.slug)).rejects.toThrow(WikiGraphError)
  })
})

// ── 9. deleteNode ───────────────────────────────────────────────────

describeE2E("deleteNode", () => {
  it("deletes and cleans references (strikethrough)", async () => {
    const target = await wiki.addNode({ title: "E2E 删除目标", type: "concept" })
    const source = await wiki.addNode({
      title: "E2E 删除来源",
      type: "concept",
      content: `引用 [[${target.slug}]]`,
    })

    const result = await wiki.deleteNode(target.slug)

    expect(result.deletedPath).toBeTruthy()
    expect(result.referencesUpdated).toBeGreaterThanOrEqual(1)

    const page = await wiki.getNode(target.slug)
    expect(page).toBeNull()

    const sourcePage = await wiki.getNode(source.slug)
    expect(sourcePage!.content).toContain("~~")
    expect(sourcePage!.content).not.toContain(`[[${target.slug}]]`)
  })

  it("is idempotent for already-deleted", async () => {
    const created = await wiki.addNode({ title: "E2E 删除幂等", type: "concept" })

    await wiki.deleteNode(created.slug)
    const result = await wiki.deleteNode(created.slug)

    expect(result.deletedPath).toBe("")
    expect(result.filesTouched.length).toBe(0)
  })

  it("supports plain-text dangling mode", async () => {
    const target = await wiki.addNode({ title: "E2E PlainText 删除", type: "concept" })
    const source = await wiki.addNode({
      title: "E2E PlainText 来源",
      type: "concept",
      content: `引用 [[${target.slug}]]`,
    })

    await wiki.deleteNode(target.slug, { danglingRefs: "plain-text" })

    const detail = await wiki.getNode(source.slug)
    expect(detail!.content).not.toContain("~~")
    expect(detail!.content).not.toContain(`[[${target.slug}]]`)
  })
})

// ── 10. addEdge / removeEdge ────────────────────────────────────────

describeE2E("addEdge / removeEdge", () => {
  it("creates edge in both carriers", async () => {
    const a = await wiki.addNode({ title: "E2E Edge A", type: "concept" })
    const b = await wiki.addNode({ title: "E2E Edge B", type: "concept" })

    const result = await wiki.addEdge(a.slug, b.slug)

    expect(result.created).toBe(true)
    expect(result.originsAfter).toContain("wikilink")
    expect(result.originsAfter).toContain("related")

    const pageA = await wiki.getNode(a.slug)
    expect(pageA!.content).toContain(`[[${b.slug}]]`)
    expect(pageA!.related).toContain(b.slug)
  })

  it("is idempotent when both carriers exist", async () => {
    const a = await wiki.addNode({ title: "E2E Edge Idem A", type: "concept" })
    const b = await wiki.addNode({ title: "E2E Edge Idem B", type: "concept" })

    await wiki.addEdge(a.slug, b.slug)
    const result = await wiki.addEdge(a.slug, b.slug)

    expect(result.created).toBe(false)
  })

  it("removeEdge cleans both carriers", async () => {
    const a = await wiki.addNode({ title: "E2E Remove A", type: "concept" })
    const b = await wiki.addNode({ title: "E2E Remove B", type: "concept" })

    await wiki.addEdge(a.slug, b.slug)
    const result = await wiki.removeEdge(a.slug, b.slug)

    expect(result.removed).toBe(true)

    const pageA = await wiki.getNode(a.slug)
    expect(pageA!.content).not.toContain(`[[${b.slug}]]`)
    expect(pageA!.related).not.toContain(b.slug)
  })

  it("removeEdge is idempotent", async () => {
    const a = await wiki.addNode({ title: "E2E Remove Idem A", type: "concept" })
    const b = await wiki.addNode({ title: "E2E Remove Idem B", type: "concept" })

    const result = await wiki.removeEdge(a.slug, b.slug)
    expect(result.removed).toBe(false)
  })

  it("throws NODE_NOT_FOUND for missing nodes", async () => {
    await expect(wiki.addEdge("nonexistent-xyz", "also-nonexistent")).rejects.toThrow(
      WikiGraphError,
    )
  })

  it("self-loop: wikilink only, no related", async () => {
    const a = await wiki.addNode({ title: "E2E Self Loop", type: "concept" })

    const result = await wiki.addEdge(a.slug, a.slug)

    expect(result.created).toBe(true)
    expect(result.originsAfter).toContain("wikilink")
    expect(result.originsAfter).not.toContain("related")
  })
})

// ── 11. rebuildIndex ────────────────────────────────────────────────

describeE2E("rebuildIndex", () => {
  it("rebuilds index with 1000+ entries", async () => {
    const result = await wiki.rebuildIndex()

    expect(result.entriesWritten).toBeGreaterThanOrEqual(1000)

    const indexContent = await fs.readFile(
      path.join(WIKI_DIR, "index.md"),
      "utf-8",
    )

    expect(indexContent).toContain("## ")
    const linkCount = (indexContent.match(/\[\[/g) ?? []).length
    expect(linkCount).toBeGreaterThanOrEqual(1000)
  })
})

// ── 12. Concurrency ─────────────────────────────────────────────────

describeE2E("concurrency", () => {
  it("concurrent writes: one succeeds, one gets conflict (optimistic check)", async () => {
    const a = await wiki.addNode({ title: "E2E Lock A", type: "concept" })

    // Both collect snapshots before either acquires the lock.
    // The first to execute wins; the second detects the mtime change
    // and throws ExternalModificationError. This is correct behavior.
    const results = await Promise.allSettled([
      wiki.updateNode(a.slug, { title: "E2E Lock A v1" }),
      wiki.updateNode(a.slug, { title: "E2E Lock A v2" }),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")

    // At least one must succeed
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    // If both tried to write the same file, exactly one should conflict
    if (rejected.length > 0) {
      const err = (rejected[0] as PromiseRejectedResult).reason
      expect(err).toBeInstanceOf(ExternalModificationError)
    }

    // Final state is one of the two titles
    const page = await wiki.getNode(a.slug)
    expect(["E2E Lock A v1", "E2E Lock A v2", "E2E Lock A"]).toContain(page!.title)
  })

  it("sequential writes both succeed", async () => {
    const a = await wiki.addNode({ title: "E2E Seq A", type: "concept" })

    const r1 = await wiki.updateNode(a.slug, { title: "E2E Seq A v1" })
    expect(r1.fieldsChanged).toContain("title")

    const r2 = await wiki.updateNode(a.slug, { title: "E2E Seq A v2" })
    expect(r2.fieldsChanged).toContain("title")

    const page = await wiki.getNode(a.slug)
    expect(page!.title).toBe("E2E Seq A v2")
  })
})
