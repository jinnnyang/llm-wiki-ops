/**
 * Local edit_file tool: exact match, whitespace-tolerant fallback,
 * uniqueness checks in both exact and normalized space.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { createLocalTools, type LocalToolRegistry } from "../src/agent/tools.js"

let tmpDir: string
let registry: LocalToolRegistry

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-edit-"))
  registry = createLocalTools(tmpDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writePage(content: string): Promise<string> {
  await fs.writeFile(path.join(tmpDir, "page.md"), content, "utf-8")
  return "page.md"
}

async function readPage(): Promise<string> {
  return fs.readFile(path.join(tmpDir, "page.md"), "utf-8")
}

describe("edit_file", () => {
  it("exact unique match replaces", async () => {
    const p = await writePage("line1\ntarget line\nline3\n")
    const r = await registry.execute("edit_file", {
      path: p,
      old_string: "target line",
      new_string: "REPLACED",
    })
    expect(r.isError).toBeFalsy()
    expect(await readPage()).toBe("line1\nREPLACED\nline3\n")
  })

  it("exact non-unique match errors and leaves file untouched", async () => {
    const p = await writePage("dup\ndup\n")
    const r = await registry.execute("edit_file", {
      path: p,
      old_string: "dup",
      new_string: "X",
    })
    expect(r.isError).toBe(true)
    expect(r.content).toContain("multiple locations")
    expect(await readPage()).toBe("dup\ndup\n")
  })

  it("whitespace-tolerant fallback matches when indentation differs", async () => {
    const p = await writePage("line1\n    target line\nline3\n")
    const r = await registry.execute("edit_file", {
      path: p,
      // tab vs spaces: exact substring fails, normalized match succeeds
      old_string: "\ttarget line",
      new_string: "REPLACED",
    })
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain("whitespace-tolerant")
    expect(await readPage()).toBe("line1\nREPLACED\nline3\n")
  })

  it("whitespace-tolerant fallback rejects non-unique normalized matches", async () => {
    const content = "first\n  dup\nmid\n    dup\nend\n"
    const p = await writePage(content)
    // old_string matches neither line exactly, but both after trim
    const r = await registry.execute("edit_file", {
      path: p,
      old_string: "  dup  ",
      new_string: "X",
    })
    expect(r.isError).toBe(true)
    expect(r.content).toContain("multiple locations")
    expect(await readPage()).toBe(content) // untouched
  })

  it("whitespace-tolerant fallback replaces at the correct position", async () => {
    // Multi-line old_string whose indentation differs; verify the edit
    // lands on the matched lines and surrounding content survives.
    const p = await writePage("head\n  alpha\n  beta\ntail\n")
    const r = await registry.execute("edit_file", {
      path: p,
      old_string: "alpha\nbeta", // no leading spaces in old_string
      new_string: "gamma",
    })
    expect(r.isError).toBeFalsy()
    expect(await readPage()).toBe("head\ngamma\ntail\n")
  })

  it("not found errors", async () => {
    const p = await writePage("only this\n")
    const r = await registry.execute("edit_file", {
      path: p,
      old_string: "absent text",
      new_string: "X",
    })
    expect(r.isError).toBe(true)
    expect(r.content).toContain("not found")
  })

  it("whitespace-only old_string errors", async () => {
    const content = "a\nb\n"
    const p = await writePage(content)
    const r = await registry.execute("edit_file", {
      path: p,
      old_string: "   \n  ",
      new_string: "X",
    })
    expect(r.isError).toBe(true)
    expect(await readPage()).toBe(content)
  })

  it("rejects paths outside the sandbox", async () => {
    const r = await registry.execute("edit_file", {
      path: "../outside.md",
      old_string: "a",
      new_string: "b",
    })
    expect(r.isError).toBe(true)
  })
})
