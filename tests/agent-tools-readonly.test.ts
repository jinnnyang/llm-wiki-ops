/**
 * createLocalTools readOnly mode: write tools are hidden from the
 * definitions and refused at execute time (defense in depth).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { createLocalTools, type LocalToolRegistry } from "../src/agent/tools.js"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-readonly-"))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function toolNames(registry: LocalToolRegistry): string[] {
  return registry.definitions.map((d) => d.function.name)
}

describe("createLocalTools readOnly", () => {
  it("exposes write_file/edit_file by default", () => {
    const registry = createLocalTools(tmpDir)
    expect(toolNames(registry)).toContain("write_file")
    expect(toolNames(registry)).toContain("edit_file")
  })

  it("hides write_file/edit_file in readOnly mode but keeps read tools", () => {
    const registry = createLocalTools(tmpDir, { readOnly: true })
    const names = toolNames(registry)
    expect(names).not.toContain("write_file")
    expect(names).not.toContain("edit_file")
    expect(names).toContain("read_file")
    expect(names).toContain("list_directory")
  })

  it("refuses write_file at execute time even if hallucinated", async () => {
    const registry = createLocalTools(tmpDir, { readOnly: true })
    const r = await registry.execute("write_file", { path: "evil.md", content: "x" })
    expect(r.isError).toBe(true)
    expect(r.content).toContain("read-only")
    await expect(fs.access(path.join(tmpDir, "evil.md"))).rejects.toThrow()
  })

  it("refuses edit_file at execute time and leaves the file untouched", async () => {
    await fs.writeFile(path.join(tmpDir, "page.md"), "original\n")
    const registry = createLocalTools(tmpDir, { readOnly: true })
    const r = await registry.execute("edit_file", {
      path: "page.md",
      old_string: "original",
      new_string: "changed",
    })
    expect(r.isError).toBe(true)
    expect(await fs.readFile(path.join(tmpDir, "page.md"), "utf-8")).toBe("original\n")
  })

  it("readOnly does not leak write tools even alongside webSearch", () => {
    const registry = createLocalTools(tmpDir, { webSearch: true, readOnly: true })
    expect(toolNames(registry)).not.toContain("write_file")
    expect(toolNames(registry)).not.toContain("edit_file")
  })
})
