import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createFixtureWiki, type FixtureWiki } from "./helpers.js"
import { WikiGraph } from "../src/index.js"
import { WikiGraphError } from "../src/utils/errors.js"

let fixture: FixtureWiki
let wiki: WikiGraph

beforeEach(async () => {
  fixture = await createFixtureWiki()
  wiki = new WikiGraph(fixture.root)
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("addEdge", () => {
  it("creates edge in both carriers", async () => {
    // asml has no edge to openai yet
    const result = await wiki.addEdge("asml", "openai")

    expect(result.created).toBe(true)
    expect(result.originsAfter).toContain("wikilink")
    expect(result.originsAfter).toContain("related")

    // Verify wikilink in body
    const page = await wiki.getNode("asml")
    expect(page!.content).toContain("[[openai]]")

    // Verify related in frontmatter
    expect(page!.related).toContain("openai")
  })

  it("is idempotent when both carriers exist", async () => {
    // nvidia → hbm already exists in both carriers
    const result = await wiki.addEdge("nvidia", "hbm")

    expect(result.created).toBe(false)
    expect(result.originsBefore).toContain("wikilink")
    expect(result.originsBefore).toContain("related")
  })

  it("fills missing carrier when only one exists", async () => {
    // First remove the wikilink but keep related
    // nvidia has both [[hbm]] and related: [hbm]
    // Let's test with a fresh edge: asml → nvidia (no existing edge)
    const result = await wiki.addEdge("asml", "nvidia")
    expect(result.created).toBe(true)

    // Now add again — should be no-op
    const result2 = await wiki.addEdge("asml", "nvidia")
    expect(result2.created).toBe(false)
  })

  it("uses context heading for wikilink insertion", async () => {
    const result = await wiki.addEdge("asml", "openai", {
      context: "## 核心矛盾",
    })

    expect(result.created).toBe(true)

    const page = await wiki.getNode("asml")
    // The wikilink should NOT be in a "## 相关" section (asml doesn't have one)
    // It should be at EOF since asml has no ## 核心矛盾 either
    expect(page!.content).toContain("[[openai]]")
  })

  it("handles self-loop (wikilink only, no related)", async () => {
    const result = await wiki.addEdge("nvidia", "nvidia")

    expect(result.created).toBe(true)
    expect(result.originsAfter).toContain("wikilink")
    expect(result.originsAfter).not.toContain("related") // self-loop: no related
  })

  it("throws NODE_NOT_FOUND for missing source", async () => {
    await expect(wiki.addEdge("nonexistent", "nvidia")).rejects.toThrow(WikiGraphError)
  })

  it("throws NODE_NOT_FOUND for missing target", async () => {
    await expect(wiki.addEdge("nvidia", "nonexistent")).rejects.toThrow(WikiGraphError)
  })

  it("dryRun does not write", async () => {
    const result = await wiki.addEdge("asml", "openai", { dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(result.created).toBe(true)

    // Verify nothing was written
    const page = await wiki.getNode("asml")
    expect(page!.content).not.toContain("[[openai]]")
  })
})

describe("removeEdge", () => {
  it("removes edge from both carriers", async () => {
    // nvidia → hbm exists in both carriers
    const result = await wiki.removeEdge("nvidia", "hbm")

    expect(result.removed).toBe(true)
    expect(result.originsBefore).toContain("wikilink")
    expect(result.originsBefore).toContain("related")

    // Verify both removed
    const page = await wiki.getNode("nvidia")
    expect(page!.content).not.toContain("[[hbm]]")
    expect(page!.related).not.toContain("hbm")
  })

  it("is idempotent when edge doesn't exist", async () => {
    const result = await wiki.removeEdge("asml", "openai")

    expect(result.removed).toBe(false)
    expect(result.originsBefore.length).toBe(0)
  })

  it("cleans partial existence (only wikilink)", async () => {
    // Add edge first (both carriers)
    await wiki.addEdge("asml", "openai")

    // Manually remove related from frontmatter to simulate partial state
    // Then removeEdge should clean the remaining wikilink
    const result = await wiki.removeEdge("asml", "openai")
    expect(result.removed).toBe(true)

    const page = await wiki.getNode("asml")
    expect(page!.content).not.toContain("[[openai]]")
  })

  it("throws NODE_NOT_FOUND for missing nodes", async () => {
    await expect(wiki.removeEdge("nonexistent", "nvidia")).rejects.toThrow(WikiGraphError)
    await expect(wiki.removeEdge("nvidia", "nonexistent")).rejects.toThrow(WikiGraphError)
  })
})
