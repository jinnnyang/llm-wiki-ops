/**
 * Resident in-memory graph (design: resident-graph.md) regression tests.
 *
 * Covers the §8 test plan:
 * - lazy init (cold build reads every file once, warm reads read zero)
 * - read-your-writes after addNode / cascade rename
 * - trustWindowMs=0 trusts memory (external edits invisible until release)
 * - trust window expiry → revalidation sees external edits
 * - dry-run never rebuilds or corrupts state
 * - releaseResident / cleanup release state (next read cold-rebuilds)
 * - write-before-any-read cold-builds correctly
 *
 * Non-resident regression is covered by the entire existing suite
 * (resident defaults to false); one explicit contrast test below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"

// Wrap readFileClean (the function scanWiki actually calls) with a counting
// mock — node:fs/promises exports can't be spied on in ESM.
vi.mock("../src/io/fs-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/io/fs-helpers.js")>()
  return { ...actual, readFileClean: vi.fn(actual.readFileClean) }
})

import { readFileClean } from "../src/io/fs-helpers.js"
import { clearScanCache } from "../src/core/graph-builder.js"
import { createFixtureWiki, type FixtureWiki } from "./helpers.js"
import { WikiGraph } from "../src/index.js"

const readCount = () => (readFileClean as ReturnType<typeof vi.fn>).mock.calls.length
const resetReadCount = () => (readFileClean as ReturnType<typeof vi.fn>).mockClear()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let fixture: FixtureWiki

beforeEach(async () => {
  fixture = await createFixtureWiki()
  clearScanCache()
  resetReadCount()
})

afterEach(async () => {
  clearScanCache()
  await fixture.cleanup()
})

describe("resident graph", () => {
  it("lazy init: constructor reads nothing, cold build reads all files, warm reads read zero", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 0 })
    expect(readCount()).toBe(0) // constructor does NOT touch the filesystem

    const page = await wiki.getNode("nvidia")
    expect(page?.title).toBe("英伟达 (NVIDIA)")
    expect(readCount()).toBeGreaterThan(10) // cold build read every page once

    // Warm reads: pure memory, zero file reads
    resetReadCount()
    expect((await wiki.getNode("tsmc"))?.slug).toBe("tsmc")
    expect((await wiki.getEdges("nvidia")).inbound.length).toBeGreaterThan(0)
    expect((await wiki.getStats()).totalNodes).toBeGreaterThan(10)
    expect((await wiki.readGraph({ type: "entity" })).nodes.length).toBeGreaterThan(0)
    expect((await wiki.scanFreshness()).due.length).toBeGreaterThan(0)
    expect(readCount()).toBe(0)
  })

  it("read-your-writes: addNode visible immediately (no revalidation needed)", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 0 })
    const before = await wiki.getStats() // cold build

    await wiki.addNode({
      title: "AMD",
      type: "entity",
      content: "GPU competitor.\n\n## 相关\n\n- [[nvidia]]",
    })

    expect((await wiki.getNode("amd"))?.title).toBe("AMD")
    expect((await wiki.getStats()).totalNodes).toBe(before.totalNodes + 1)
    // content wikilink auto-synced → edge exists in memory graph
    const edges = await wiki.getEdges("nvidia")
    expect(edges.inbound.some((e) => e.source === "amd")).toBe(true)
  })

  it("cascade write: renameNode refreshes slug index and edges", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 0 })
    const before = await wiki.getStats()

    await wiki.renameNode("nvidia", "nvda")

    expect(await wiki.getNode("nvidia")).toBeNull()
    const renamed = await wiki.getNode("nvda")
    expect(renamed?.title).toBe("英伟达 (NVIDIA)")
    // hbm's [[nvidia]] wikilink was cascaded to [[nvda]] → edge follows
    const edges = await wiki.getEdges("nvda")
    expect(edges.inbound.some((e) => e.source === "hbm")).toBe(true)
    expect((await wiki.getStats()).totalNodes).toBe(before.totalNodes)
  })

  it("trustWindowMs=0: external edits invisible until releaseResident", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 0 })
    expect(await wiki.getNode("kv-cache")).toBeTruthy()

    const file = path.join(fixture.wikiDir, "concepts", "kv-cache.md")
    await fs.writeFile(file, (await fs.readFile(file, "utf-8")) + "\nexternally edited\n")

    // Memory is trusted — stale content served
    expect((await wiki.getNode("kv-cache"))?.content).not.toContain("externally edited")

    wiki.releaseResident()
    expect((await wiki.getNode("kv-cache"))?.content).toContain("externally edited")
  })

  it("trust window expiry: revalidation picks up external edits", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 50 })
    await wiki.getNode("kv-cache") // cold build

    const file = path.join(fixture.wikiDir, "concepts", "kv-cache.md")
    await fs.writeFile(file, (await fs.readFile(file, "utf-8")) + "\nwindow edit\n")

    // Within the window: stale
    expect((await wiki.getNode("kv-cache"))?.content).not.toContain("window edit")

    await sleep(80)
    expect((await wiki.getNode("kv-cache"))?.content).toContain("window edit")
  })

  it("dry-run write never rebuilds or corrupts state", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 0 })
    const before = await wiki.getStats()

    await wiki.addNode({ title: "Ghost Node", dryRun: true })

    expect(await wiki.getNode("ghost-node")).toBeNull()
    expect((await wiki.getStats()).totalNodes).toBe(before.totalNodes)
  })

  it("releaseResident: next read cold-rebuilds from disk", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 0 })
    await wiki.getNode("nvidia")
    resetReadCount()
    await wiki.getNode("nvidia")
    expect(readCount()).toBe(0) // warm

    wiki.releaseResident()
    expect((await wiki.getNode("nvidia"))?.slug).toBe("nvidia")
    expect(readCount()).toBeGreaterThan(10) // cold rebuild
  })

  it("cleanup releases resident state (next read cold-rebuilds)", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 0 })
    await wiki.getNode("nvidia")
    resetReadCount()

    await wiki.cleanup()
    expect((await wiki.getNode("nvidia"))?.slug).toBe("nvidia")
    expect(readCount()).toBeGreaterThan(10)
  })

  it("write before any read: next read cold-builds including the write", async () => {
    const wiki = new WikiGraph(fixture.root, { resident: true, trustWindowMs: 0 })
    await wiki.addNode({ title: "First Write", type: "concept", content: "body" })

    expect((await wiki.getNode("first-write"))?.title).toBe("First Write")
  })

  it("non-resident contrast: external edit visible on next read (A′ revalidates)", async () => {
    const wiki = new WikiGraph(fixture.root) // resident defaults to false
    expect(wiki.resident).toBe(false)
    await wiki.getNode("kv-cache")

    const file = path.join(fixture.wikiDir, "concepts", "kv-cache.md")
    await fs.writeFile(file, (await fs.readFile(file, "utf-8")) + "\nfresh edit\n")

    expect((await wiki.getNode("kv-cache"))?.content).toContain("fresh edit")
  })
})
