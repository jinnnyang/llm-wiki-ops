/**
 * tests/agent-wikilink-check.test.ts — dangling-wikilink warning on local writes.
 *
 * buildGraphFromPages silently skips a wikilink whose target does not exist
 * (graph-builder.ts): no edge, no warning. For a dream page that is a real loss,
 * because the links ARE its provenance record — a mistyped slug means the
 * reasoning the page documents never reaches the graph and can never be
 * verified. A live dream wrote `[[外需强劲]]` for the page actually slugged
 * `外需强劲内需冷静` and nothing anywhere reported it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import { createLocalTools, findDanglingWikilinks, type LocalToolRegistry } from "../src/agent/tools.js"

let root: string
let registry: LocalToolRegistry

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-links-"))
  await fs.mkdir(path.join(root, "wiki", "concepts"), { recursive: true })
  await fs.mkdir(path.join(root, "wiki", "dreams"), { recursive: true })
  await fs.writeFile(path.join(root, "wiki", "concepts", "外需强劲内需冷静.md"), "# a\n", "utf-8")
  await fs.writeFile(path.join(root, "wiki", "concepts", "自然指数.md"), "# b\n", "utf-8")
  await fs.writeFile(path.join(root, "wiki", "index.md"), "# Wiki Index\n", "utf-8")
  registry = createLocalTools(root)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const write = (rel: string, content: string) => registry.execute("write_file", { path: rel, content })

describe("findDanglingWikilinks", () => {
  const known = new Set(["外需强劲内需冷静", "自然指数"])

  it("flags a truncated slug that looks plausible", () => {
    expect(findDanglingWikilinks("see [[外需强劲]] here", known)).toEqual(["外需强劲"])
  })

  it("passes a link that resolves", () => {
    expect(findDanglingWikilinks("see [[外需强劲内需冷静]]", known)).toEqual([])
  })

  it("resolves a link carrying a directory prefix", () => {
    // index.md uses the [[entities/三菱]] form; the graph keys on the basename.
    expect(findDanglingWikilinks("[[concepts/自然指数]]", known)).toEqual([])
  })

  it("handles the alias form", () => {
    expect(findDanglingWikilinks("[[自然指数|Nature Index]]", known)).toEqual([])
    expect(findDanglingWikilinks("[[自然指標|Nature Index]]", known)).toEqual(["自然指標"])
  })

  it("ignores links inside code blocks and inline code", () => {
    // extractWikilinks already strips these; asserted here so the write-path
    // warning can never fire on a documentation example.
    const txt = "```\n[[not-a-link]]\n```\nand `[[also-not]]` inline\n"
    expect(findDanglingWikilinks(txt, known)).toEqual([])
  })

  it("reports each distinct bad target once", () => {
    expect(findDanglingWikilinks("[[ghost]] [[ghost]] [[ghost]]", known)).toEqual(["ghost"])
  })

  it("matches case-insensitively, like the graph does", () => {
    // A live dream wrote [[lcm公司]] and [[国家ai产业投资基金]] for pages slugged
    // LCM公司 / 国家AI产业投资基金. normalizeSlug lowercases on both sides, so the
    // graph resolves these — warning about them would be a false positive that
    // sends the agent chasing a non-bug.
    const cased = new Set(["lcm公司", "国家ai产业投资基金"])
    expect(findDanglingWikilinks("[[LCM公司]] and [[国家AI产业投资基金]]", cased)).toEqual([])
  })
})

describe("write_file wikilink warning", () => {
  it("warns about a dangling link but still writes the file", async () => {
    const r = await write("wiki/dreams/d.md", "body [[外需强劲]] end\n")

    expect(r.isError).toBeFalsy()
    expect(r.content).toContain("Written")
    expect(r.content).toContain("[[外需强劲]]")
    expect(r.content).toContain("NO graph edge")
    // The write must land: the prose can be right even when a slug is wrong.
    expect(await fs.readFile(path.join(root, "wiki", "dreams", "d.md"), "utf-8")).toContain("[[外需强劲]]")
  })

  it("stays silent when every link resolves", async () => {
    const r = await write("wiki/dreams/ok.md", "[[外需强劲内需冷静]] and [[自然指数]]\n")
    expect(r.isError).toBeFalsy()
    expect(r.content).not.toContain("WARNING")
  })

  it("sees a page created earlier in the same run", async () => {
    // The slug set is rebuilt per call, so a link to a page this dream just
    // wrote must not be reported as dangling.
    await write("wiki/dreams/first.md", "seed\n")
    const r = await write("wiki/dreams/second.md", "see [[first]]\n")
    expect(r.content).not.toContain("WARNING")
  })

  it("does not warn on a non-markdown write", async () => {
    const r = await write("wiki/dreams/notes.txt", "[[whatever]]\n")
    expect(r.isError).toBeFalsy()
    expect(r.content).not.toContain("WARNING")
  })

  it("never treats index.md or log.md as link targets", async () => {
    // Infrastructure filenames are skipped by the graph scanner, so linking to
    // them is dangling by definition.
    const r = await write("wiki/dreams/d.md", "[[index]]\n")
    expect(r.content).toContain("WARNING")
  })
})

describe("edit_file wikilink warning", () => {
  it("warns when an edit introduces a dangling link", async () => {
    await write("wiki/dreams/d.md", "original [[自然指数]]\n")
    const r = await registry.execute("edit_file", {
      path: "wiki/dreams/d.md",
      old_string: "[[自然指数]]",
      new_string: "[[自然指標]]",
    })
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain("[[自然指標]]")
  })

  it("warns about a link elsewhere in the file, not just the edited fragment", async () => {
    // The check reads the file back, so a pre-existing bad link surfaces on the
    // next edit rather than staying invisible forever.
    await write("wiki/dreams/d.md", "keep [[ghost]]\nline to change\n")
    const r = await registry.execute("edit_file", {
      path: "wiki/dreams/d.md",
      old_string: "line to change",
      new_string: "changed",
    })
    expect(r.content).toContain("[[ghost]]")
  })

  it("adds nothing when the edit fails", async () => {
    await write("wiki/dreams/d.md", "content [[ghost]]\n")
    const r = await registry.execute("edit_file", {
      path: "wiki/dreams/d.md",
      old_string: "not present anywhere",
      new_string: "x",
    })
    expect(r.isError).toBe(true)
    expect(r.content).not.toContain("WARNING")
  })
})
