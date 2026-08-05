/**
 * MCP default wiki resolution chain (design: resident-graph.md §11).
 *
 *   --wiki <path-or-slug>  >  SELECTED_WIKI env  >  WIKI_ROOT env (deprecated)  >  none
 *
 * Pure functions only (src/mcp/resolve.ts) — no process.exit, so the whole
 * chain is unit-testable. Slug resolution reuses the CLI's resolver so
 * "same shell, CLI works, MCP works" (§11.2).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import { resolveDefaultWikiRoot } from "../src/mcp/resolve.js"
import { resolveWikiPath, getWikisRoot } from "../src/cli/wiki-resolve.js"

let base: string

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-mcpresolve-"))
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

/** A valid wiki needs wiki/ + raw/ + wiki/index.md (isValidWiki). */
async function makeValidWiki(name: string): Promise<string> {
  const root = path.join(base, name)
  await fs.mkdir(path.join(root, "wiki"), { recursive: true })
  await fs.mkdir(path.join(root, "raw"), { recursive: true })
  await fs.writeFile(path.join(root, "wiki", "index.md"), "# Index\n", "utf-8")
  return root
}

describe("resolveDefaultWikiRoot", () => {
  it("nothing configured: no root, no warning", () => {
    const r = resolveDefaultWikiRoot(undefined, {})
    expect(r.root).toBeUndefined()
    expect(r.warning).toBeUndefined()
  })

  it("--wiki path wins over everything", async () => {
    const a = await makeValidWiki("a")
    const b = await makeValidWiki("b")
    const r = resolveDefaultWikiRoot(a, { SELECTED_WIKI: b, WIKI_ROOT: b })
    expect(r.root).toBe(a)
    expect(r.warning).toBeUndefined()
  })

  it("SELECTED_WIKI path used when no --wiki", async () => {
    const b = await makeValidWiki("b")
    const r = resolveDefaultWikiRoot(undefined, { SELECTED_WIKI: b })
    expect(r.root).toBe(b)
    expect(r.warning).toBeUndefined()
  })

  it("SELECTED_WIKI slug resolves against WIKIS_ROOT", async () => {
    const wikisRoot = path.join(base, "wikis")
    await fs.mkdir(wikisRoot, { recursive: true })
    const wikiDir = await makeValidWiki("wikis/my-wiki")
    const r = resolveDefaultWikiRoot(undefined, {
      SELECTED_WIKI: "my-wiki",
      WIKIS_ROOT: wikisRoot,
    })
    expect(r.root).toBe(wikiDir)
  })

  it("SELECTED_WIKI beats WIKI_ROOT and suppresses the deprecation warning", async () => {
    const sel = await makeValidWiki("sel")
    const old = await makeValidWiki("old")
    const r = resolveDefaultWikiRoot(undefined, { SELECTED_WIKI: sel, WIKI_ROOT: old })
    expect(r.root).toBe(sel)
    expect(r.warning).toBeUndefined()
  })

  it("WIKI_ROOT alone: still works, with deprecation warning", async () => {
    const old = await makeValidWiki("old")
    const r = resolveDefaultWikiRoot(undefined, { WIKI_ROOT: old })
    expect(r.root).toBe(old)
    expect(r.warning).toContain("WIKI_ROOT is deprecated")
    expect(r.warning).toContain("SELECTED_WIKI")
  })

  it("invalid wiki value falls back to resolve() so validate() gives the canonical error", async () => {
    const missing = path.join(base, "nope")
    const r = resolveDefaultWikiRoot(missing, {})
    expect(r.root).toBe(path.resolve(missing))
  })
})

describe("resolveWikiPath (pure CLI/MCP shared resolver)", () => {
  it("slug without WIKIS_ROOT: error, no process.exit", () => {
    const r = resolveWikiPath("some-slug", null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("WIKIS_ROOT")
  })

  it("slug with WIKIS_ROOT but missing wiki: error", async () => {
    const wikisRoot = path.join(base, "wikis")
    await fs.mkdir(wikisRoot, { recursive: true })
    const r = resolveWikiPath("ghost", wikisRoot)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("not a valid wiki")
  })

  it("full path to a valid wiki: ok", async () => {
    const w = await makeValidWiki("w")
    const r = resolveWikiPath(w, null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe(w)
  })
})

describe("getWikisRoot", () => {
  it("unset / invalid dir → null; valid dir → path", async () => {
    expect(getWikisRoot({})).toBeNull()
    expect(getWikisRoot({ WIKIS_ROOT: path.join(base, "missing") })).toBeNull()
    const dir = path.join(base, "wikis")
    await fs.mkdir(dir, { recursive: true })
    expect(getWikisRoot({ WIKIS_ROOT: dir })).toBe(dir)
  })
})
