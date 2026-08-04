/**
 * scanWiki file-level cache (scancache A′) regression tests.
 *
 * Invariants under test:
 * 1. Hit: second scan reads zero files, returns identical pages
 * 2. External edit: mtime/size change forces exactly one re-read
 * 3. Add/remove: page set tracks the filesystem
 * 4. Read-your-writes: addNode visible to readGraph immediately
 *    (write path never touches the cache; mtime bump does the work)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

// Wrap readFileClean (the function scanWiki actually calls) with a
// counting mock — node:fs/promises exports can't be spied on in ESM.
vi.mock("../src/io/fs-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/io/fs-helpers.js")>()
  return { ...actual, readFileClean: vi.fn(actual.readFileClean) }
})

import { scanWiki, clearScanCache } from "../src/core/graph-builder.js"
import { readFileClean } from "../src/io/fs-helpers.js"
import { createFixtureWiki, type FixtureWiki } from "./helpers.js"
import { WikiGraph } from "../src/index.js"

const readCount = () => (readFileClean as ReturnType<typeof vi.fn>).mock.calls.length
const resetReadCount = () => (readFileClean as ReturnType<typeof vi.fn>).mockClear()

let root: string
let wikiDir: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-scancache-"))
  wikiDir = path.join(root, "wiki")
  await fs.mkdir(path.join(wikiDir, "entities"), { recursive: true })
  clearScanCache()
})

afterEach(async () => {
  clearScanCache()
  await fs.rm(root, { recursive: true, force: true })
})

async function writePage(name: string, title: string): Promise<string> {
  const p = path.join(wikiDir, "entities", `${name}.md`)
  await fs.writeFile(
    p,
    `---\ntype: entity\ntitle: "${title}"\ncreated: "2025-01-01"\nupdated: "2025-01-01"\n---\n\n# ${title}\n\nBody of ${name}.\n`,
    "utf-8",
  )
  return p
}

describe("scanWiki cache", () => {
  it("hit: second scan performs zero file reads and returns identical pages", async () => {
    await writePage("alpha", "Alpha")
    await writePage("beta", "Beta")

    const first = await scanWiki(wikiDir, root)
    expect(first).toHaveLength(2)

    resetReadCount()
    const second = await scanWiki(wikiDir, root)

    expect(readCount()).toBe(0)
    expect(second).toEqual(first)
  })

  it("external edit invalidates exactly the changed file", async () => {
    const p = await writePage("alpha", "Alpha")
    await writePage("beta", "Beta")

    await scanWiki(wikiDir, root) // prime

    // Edit one file externally (different size guarantees mtime-or-size trip)
    await fs.writeFile(p, `---\ntype: entity\ntitle: "Alpha v2"\n---\n\nEdited body.\n`, "utf-8")

    resetReadCount()
    const pages = await scanWiki(wikiDir, root)

    expect(readCount()).toBe(1)
    const alpha = pages.find((x) => x.slug === "alpha")
    expect(alpha!.title).toBe("Alpha v2")
    expect(alpha!.content).toContain("Edited body.")
  })

  it("add/remove: page set tracks the filesystem", async () => {
    await writePage("alpha", "Alpha")
    await scanWiki(wikiDir, root)

    // Add
    await writePage("gamma", "Gamma")
    const afterAdd = await scanWiki(wikiDir, root)
    expect(afterAdd.map((p) => p.slug).sort()).toEqual(["alpha", "gamma"])

    // Remove
    await fs.unlink(path.join(wikiDir, "entities", "alpha.md"))
    const afterRemove = await scanWiki(wikiDir, root)
    expect(afterRemove.map((p) => p.slug)).toEqual(["gamma"])

    // Re-adding the same name works (stale entry was evicted)
    await writePage("alpha", "Alpha reborn")
    const afterReAdd = await scanWiki(wikiDir, root)
    expect(afterReAdd.find((p) => p.slug === "alpha")!.title).toBe("Alpha reborn")
  })

  it("clearScanCache(wikiDir) drops only that wiki", async () => {
    await writePage("alpha", "Alpha")
    await scanWiki(wikiDir, root)

    clearScanCache(wikiDir)

    resetReadCount()
    await scanWiki(wikiDir, root)
    expect(readCount()).toBe(1) // re-read after clear
  })

  it("multiple wikis stay isolated", async () => {
    await writePage("alpha", "Alpha")
    await scanWiki(wikiDir, root)

    // Second wiki, same page name, different title
    const root2 = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-scancache2-"))
    const wikiDir2 = path.join(root2, "wiki")
    await fs.mkdir(path.join(wikiDir2, "entities"), { recursive: true })
    await fs.writeFile(
      path.join(wikiDir2, "entities", "alpha.md"),
      `---\ntype: entity\ntitle: "Other Alpha"\n---\n\nOther body.\n`,
      "utf-8",
    )

    const pages2 = await scanWiki(wikiDir2, root2)
    expect(pages2.find((p) => p.slug === "alpha")!.title).toBe("Other Alpha")

    // First wiki unaffected
    const pages1 = await scanWiki(wikiDir, root)
    expect(pages1.find((p) => p.slug === "alpha")!.title).toBe("Alpha")

    await fs.rm(root2, { recursive: true, force: true })
  })
})

describe("read-your-writes through WikiGraph", () => {
  let fixture: FixtureWiki
  let wiki: WikiGraph

  beforeEach(async () => {
    fixture = await createFixtureWiki()
    wiki = new WikiGraph(fixture.root)
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it("addNode is immediately visible to readGraph and getNode", async () => {
    // Prime the cache with a full read
    await wiki.readGraph({ limit: 500 })

    await wiki.addNode({ title: "Cache Probe", type: "entity", content: "Probe body." })

    const page = await wiki.getNode("cache-probe")
    expect(page).not.toBeNull()
    expect(page!.title).toBe("Cache Probe")

    const graph = await wiki.readGraph({ limit: 500 })
    expect(graph.nodes.some((n) => n.slug === "cache-probe")).toBe(true)
  })

  it("updateNode is immediately visible (no stale cache hit)", async () => {
    await wiki.getNode("asml") // prime

    await wiki.updateNode("asml", { title: "ASML Holding" })

    const page = await wiki.getNode("asml")
    expect(page!.title).toBe("ASML Holding")
  })

  it("renameNode cascade + eviction visible immediately", async () => {
    await wiki.readGraph({ limit: 500 }) // prime

    await wiki.renameNode("asml", "asml-holding")

    expect(await wiki.getNode("asml")).toBeNull()
    const renamed = await wiki.getNode("asml-holding")
    expect(renamed).not.toBeNull()

    // Referring page's related[] rewritten (cached entry invalidated by mtime)
    const semi = await wiki.getNode("semiconductor-outlook")
    expect(semi!.related).toContain("asml-holding")
  })
})
