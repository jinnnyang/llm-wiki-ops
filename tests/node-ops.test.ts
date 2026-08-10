import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createFixtureWiki, type FixtureWiki } from "./helpers.js"
import { WikiGraph } from "../src/index.js"
import { WikiGraphError } from "../src/utils/errors.js"
import * as fs from "node:fs/promises"
import * as path from "node:path"

let fixture: FixtureWiki
let wiki: WikiGraph

beforeEach(async () => {
  fixture = await createFixtureWiki()
  wiki = new WikiGraph(fixture.root, { maintainLog: false })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("addNode", () => {
  it("creates a new page with correct frontmatter", async () => {
    const result = await wiki.addNode({
      title: "AMD",
      type: "entity",
      content: "GPU competitor.",
      tags: ["半导体"],
    })

    expect(result.slug).toBe("amd")
    expect(result.slugCollided).toBe(false)
    expect(result.filesTouched.length).toBeGreaterThan(0)

    // Verify file exists
    const pagePath = path.join(fixture.wikiDir, "entities", "amd.md")
    const content = await fs.readFile(pagePath, "utf-8")
    expect(content).toContain("type: entity")
    expect(content).toContain("title: AMD")
    expect(content).toContain("GPU competitor.")
  })

  it("auto-syncs content wikilinks into related", async () => {
    const result = await wiki.addNode({
      title: "Test Sync",
      type: "concept",
      content: "Related to [[nvidia]] and [[hbm]].",
    })

    expect(result.danglingRelated).toEqual([]) // nvidia and hbm exist

    const page = await wiki.getNode("test-sync")
    expect(page!.related).toContain("nvidia")
    expect(page!.related).toContain("hbm")
  })

  it("reports dangling related for nonexistent targets", async () => {
    const result = await wiki.addNode({
      title: "Dangling Test",
      type: "concept",
      related: ["nonexistent-page"],
    })

    expect(result.danglingRelated).toContain("nonexistent-page")
  })

  it("handles slug collision with append strategy", async () => {
    const result = await wiki.addNode({
      title: "NVIDIA", // collides with existing nvidia.md
      type: "entity",
      content: "Different content",
    })

    expect(result.slugCollided).toBe(true)
    expect(result.slug).toBe("nvidia-2")
  })

  it("throws on slug collision with error strategy", async () => {
    await expect(
      wiki.addNode({
        title: "NVIDIA",
        type: "entity",
        onSlugConflict: "error",
      }),
    ).rejects.toThrow(WikiGraphError)
  })

  it("is idempotent for identical input", async () => {
    const input = {
      title: "Idempotent Test",
      type: "concept" as const,
      content: "Same content",
      tags: ["test"],
    }

    const first = await wiki.addNode(input)
    const second = await wiki.addNode(input)

    expect(second.filesTouched.length).toBe(0) // no-op
    expect(second.slug).toBe(first.slug)
  })

  it("sets sourcesWarning for source type", async () => {
    const result = await wiki.addNode({
      title: "Test Source",
      type: "source",
    })
    expect(result.sourcesWarning).toBe(true)
  })

  it("updates index.md", async () => {
    await wiki.addNode({ title: "Index Test", type: "entity" })

    const indexContent = await fs.readFile(
      path.join(fixture.wikiDir, "index.md"),
      "utf-8",
    )
    expect(indexContent).toContain("[[index-test]]")
  })

  it("dryRun does not write files", async () => {
    const result = await wiki.addNode({
      title: "Dry Run Test",
      type: "entity",
      dryRun: true,
    })

    expect(result.dryRun).toBe(true)
    expect(result.filesTouched.length).toBeGreaterThan(0)

    // File should NOT exist
    const pagePath = path.join(fixture.wikiDir, "entities", "dry-run-test.md")
    await expect(fs.access(pagePath)).rejects.toThrow()
  })
})

describe("updateNode", () => {
  it("updates title and bumps updated date", async () => {
    const result = await wiki.updateNode("asml", { title: "ASML Holding" })

    expect(result.fieldsChanged).toContain("title")

    const page = await wiki.getNode("asml")
    expect(page!.title).toBe("ASML Holding")
  })

  it("is idempotent for no-change patch", async () => {
    const page = await wiki.getNode("asml")
    const result = await wiki.updateNode("asml", { title: page!.title })

    expect(result.fieldsChanged.length).toBe(0)
    expect(result.filesTouched.length).toBe(0)
  })

  it("triggers directory move on type change", async () => {
    const result = await wiki.updateNode("asml", { type: "concept" })

    expect(result.moved).toBeDefined()
    expect(result.moved!.from).toContain("entities")
    expect(result.moved!.to).toContain("concepts")

    // Old file gone, new file exists
    const oldPath = path.join(fixture.wikiDir, "entities", "asml.md")
    const newPath = path.join(fixture.wikiDir, "concepts", "asml.md")
    await expect(fs.access(oldPath)).rejects.toThrow()
    await expect(fs.access(newPath)).resolves.toBeUndefined()
  })

  it("throws NODE_NOT_FOUND for missing slug", async () => {
    await expect(wiki.updateNode("nonexistent", { title: "X" })).rejects.toThrow(
      WikiGraphError,
    )
  })
})

describe("renameNode", () => {
  it("renames file and updates all references", async () => {
    const result = await wiki.renameNode("asml", "asml-holding")

    expect(result.oldSlug).toBe("asml")
    expect(result.newSlug).toBe("asml-holding")
    expect(result.referencesUpdated).toBeGreaterThan(0)

    // New file exists
    const page = await wiki.getNode("asml-holding")
    expect(page).not.toBeNull()

    // Old file gone
    const oldPage = await wiki.getNode("asml")
    expect(oldPage).toBeNull()

    // References updated in other pages
    const semi = await wiki.getNode("semiconductor-outlook")
    expect(semi!.content).toContain("[[asml-holding]]")
    expect(semi!.content).not.toContain("[[asml]]")
  })

  it("is idempotent when already renamed", async () => {
    await wiki.renameNode("asml", "asml-new")
    const result = await wiki.renameNode("asml", "asml-new")

    expect(result.filesTouched.length).toBe(0) // no-op
  })

  it("throws RENAME_TARGET_EXISTS when target taken", async () => {
    await expect(wiki.renameNode("asml", "nvidia")).rejects.toThrow(WikiGraphError)
  })

  it("cascade rewrite does NOT bump updated on referring pages", async () => {
    // semiconductor-outlook has related: ["hbm", "asml"], updated: 2025-05-01
    await wiki.renameNode("asml", "asml-holding")

    const semi = await wiki.getNode("semiconductor-outlook")
    expect(semi!.related).toContain("asml-holding") // related[] rewritten
    expect(semi!.related).not.toContain("asml")
    // Mechanical rewrite must not touch the freshness clock
    expect(semi!.updated).toBe("2025-05-01")

    // The renamed node itself IS a fact change — its own updated is bumped
    const renamed = await wiki.getNode("asml-holding")
    expect(renamed!.updated).not.toBe("2025-03-01")
  })
})

describe("deleteNode", () => {
  it("deletes page and cleans references (strikethrough)", async () => {
    const result = await wiki.deleteNode("asml")

    expect(result.deletedPath).toContain("asml.md")
    expect(result.referencesUpdated).toBeGreaterThan(0)

    // Page gone
    const page = await wiki.getNode("asml")
    expect(page).toBeNull()

    // References cleaned with strikethrough
    const semi = await wiki.getNode("semiconductor-outlook")
    expect(semi!.content).toContain("~~ASML~~")
    expect(semi!.content).not.toContain("[[asml]]")
  })

  it("is idempotent for already-deleted node", async () => {
    await wiki.deleteNode("asml")
    const result = await wiki.deleteNode("asml")

    expect(result.deletedPath).toBe("")
    expect(result.filesTouched.length).toBe(0)
  })

  it("supports plain-text dangling mode", async () => {
    await wiki.deleteNode("asml", { danglingRefs: "plain-text" })

    const semi = await wiki.getNode("semiconductor-outlook")
    expect(semi!.content).toContain("ASML")
    expect(semi!.content).not.toContain("~~")
  })

  it("supports remove dangling mode", async () => {
    await wiki.deleteNode("asml", { danglingRefs: "remove" })

    const semi = await wiki.getNode("semiconductor-outlook")
    expect(semi!.content).not.toContain("asml")
    expect(semi!.content).not.toContain("ASML")
  })

  it("removes from index.md", async () => {
    await wiki.deleteNode("asml")

    const indexContent = await fs.readFile(
      path.join(fixture.wikiDir, "index.md"),
      "utf-8",
    )
    expect(indexContent).not.toContain("[[asml]]")
  })

  it("cascade cleanup does NOT bump updated on referring pages", async () => {
    // semiconductor-outlook has related: ["hbm", "asml"], updated: 2025-05-01
    await wiki.deleteNode("asml")

    const semi = await wiki.getNode("semiconductor-outlook")
    expect(semi!.related).not.toContain("asml") // related[] entry removed
    expect(semi!.updated).toBe("2025-05-01") // freshness clock untouched
  })
})

describe("rebuildIndex", () => {
  it("rebuilds index preserving custom sections", async () => {
    const result = await wiki.rebuildIndex()

    expect(result.entriesWritten).toBeGreaterThanOrEqual(15)

    const indexContent = await fs.readFile(
      path.join(fixture.wikiDir, "index.md"),
      "utf-8",
    )

    // Known sections present
    expect(indexContent).toContain("## Entities")
    expect(indexContent).toContain("## Concepts")

    // Custom section preserved
    expect(indexContent).toContain("## Custom Notes")
    expect(indexContent).toContain("This is a custom section")
  })
})

describe("updateNode content H1 handling", () => {
  // node-ops.ts prepends `# ${fm.title}` when replacing content. An agent that
  // read the page before rewriting it echoes the existing heading back, and the
  // unconditional prepend then produced two identical H1s — observed on a real
  // compressed node (战争钨) after the dream agent returned the body it had just
  // read. update_node is the compression primitive, so every compression passed
  // through this path.
  const read = async (slug: string) =>
    fs.readFile(path.join(fixture.root, "wiki", "entities", `${slug}.md`), "utf-8")

  it("does not stack a second H1 when content already starts with one", async () => {
    const { slug } = await wiki.addNode({ title: "AMD", type: "entity", content: "Original." })
    await wiki.updateNode(slug, { content: "# AMD\n\nCondensed body." })

    const text = await read(slug)
    expect(text.match(/^# /gm)?.length).toBe(1)
    expect(text).toContain("Condensed body.")
  })

  it("still adds the H1 when content has none", async () => {
    const { slug } = await wiki.addNode({ title: "AMD", type: "entity", content: "Original." })
    await wiki.updateNode(slug, { content: "Just a body, no heading." })

    const text = await read(slug)
    expect(text).toContain("# AMD")
    expect(text.match(/^# /gm)?.length).toBe(1)
  })

  it("keeps a heading that differs from the title, without adding another", async () => {
    // A rewrite may legitimately retitle the body; stacking a second heading on
    // top of it is never the right answer.
    const { slug } = await wiki.addNode({ title: "AMD", type: "entity", content: "Original." })
    await wiki.updateNode(slug, { content: "# AMD (condensed)\n\nBody." })

    const text = await read(slug)
    expect(text).toContain("# AMD (condensed)")
    expect(text.match(/^# /gm)?.length).toBe(1)
  })

  it("is not fooled by leading blank lines before the H1", async () => {
    const { slug } = await wiki.addNode({ title: "AMD", type: "entity", content: "Original." })
    await wiki.updateNode(slug, { content: "\n\n# AMD\n\nBody." })

    const text = await read(slug)
    expect(text.match(/^# /gm)?.length).toBe(1)
  })

  it("does not treat an H2 as an existing top heading", async () => {
    // `## Section` is not a title — the page still needs its H1.
    const { slug } = await wiki.addNode({ title: "AMD", type: "entity", content: "Original." })
    await wiki.updateNode(slug, { content: "## Details\n\nBody." })

    const text = await read(slug)
    expect(text).toContain("# AMD")
    expect(text).toContain("## Details")
  })
})
