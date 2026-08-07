/**
 * Typed edges: relation stored in frontmatter related[] (wikilinks stay untyped),
 * graph-builder surfaces relation on GraphEdge, addEdge upgrades without downgrading.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createFixtureWiki, type FixtureWiki } from "./helpers.js"
import { WikiGraph } from "../src/index.js"
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

describe("addEdge with relation", () => {
  it("writes typed related entry, wikilink stays untyped", async () => {
    const result = await wiki.addEdge("asml", "openai", { relation: "causes" })

    expect(result.created).toBe(true)
    expect(result.relationAfter).toBe("causes")

    const page = await wiki.getNode("asml")
    expect(page!.content).toContain("[[openai]]") // body link untyped
    expect(page!.related).toEqual([{ slug: "openai", relation: "causes" }])
  })

  it("normalizes relation to lowercase", async () => {
    const result = await wiki.addEdge("asml", "openai", { relation: " Causes " })
    expect(result.relationAfter).toBe("causes")
  })

  it("no relation → plain string entry (backward compatible)", async () => {
    const result = await wiki.addEdge("asml", "openai")
    expect(result.created).toBe(true)

    const page = await wiki.getNode("asml")
    expect(page!.related).toContain("openai") // plain string
  })

  it("upgrades untyped entry to typed", async () => {
    // nvidia → hbm exists untyped
    const result = await wiki.addEdge("nvidia", "hbm", { relation: "causes" })

    expect(result.created).toBe(true)
    expect(result.relationBefore).toBeUndefined()
    expect(result.relationAfter).toBe("causes")

    const page = await wiki.getNode("nvidia")
    expect(page!.related).toEqual(
      expect.arrayContaining([{ slug: "hbm", relation: "causes" }]),
    )
  })

  it("typed entry never downgrades to untyped", async () => {
    await wiki.addEdge("asml", "openai", { relation: "causes" })
    const result = await wiki.addEdge("asml", "openai") // no relation this time

    expect(result.created).toBe(false) // pure no-op
    expect(result.relationAfter).toBe("causes") // relation preserved

    const page = await wiki.getNode("asml")
    expect(page!.related).toEqual([{ slug: "openai", relation: "causes" }])
  })

  it("changing relation type rewrites in place", async () => {
    await wiki.addEdge("asml", "openai", { relation: "causes" })
    const result = await wiki.addEdge("asml", "openai", { relation: "explains" })

    expect(result.created).toBe(true) // relation change counts as a write
    expect(result.relationBefore).toBe("causes")
    expect(result.relationAfter).toBe("explains")

    const page = await wiki.getNode("asml")
    expect(page!.related).toEqual([{ slug: "openai", relation: "explains" }])
  })

  it("self-loop ignores relation (no related entry)", async () => {
    const result = await wiki.addEdge("nvidia", "nvidia", { relation: "is_a" })
    expect(result.created).toBe(true)
    expect(result.relationAfter).toBeUndefined()

    const page = await wiki.getNode("nvidia")
    expect(page!.related).not.toEqual(
      expect.arrayContaining([{ slug: "nvidia", relation: "is_a" }]),
    )
  })
})

describe("graph-builder surfaces relation", () => {
  it("typed related entry → GraphEdge.relation", async () => {
    await wiki.addEdge("asml", "openai", { relation: "contradicts" })

    const { outbound } = (await wiki.getEdges("asml")) as {
      inbound: never[]
      outbound: Array<{ target: string; relation?: string }>
    }
    const edge = outbound.find((e) => e.target === "openai")
    expect(edge?.relation).toBe("contradicts")
  })

  it("untyped edge → relation undefined", async () => {
    const { outbound } = (await wiki.getEdges("nvidia")) as {
      inbound: never[]
      outbound: Array<{ target: string; relation?: string }>
    }
    const edge = outbound.find((e) => e.target === "hbm")
    expect(edge?.relation).toBeUndefined()
  })
})

describe("frontmatter round-trip", () => {
  it("mixed plain + typed entries survive read/write", async () => {
    const pagePath = path.join(fixture.wikiDir, "concepts", "mixed-related.md")
    await fs.writeFile(
      pagePath,
      `---
type: concept
title: "Mixed Related"
created: "2025-01-01"
updated: "2025-01-01"
related:
  - nvidia
  - slug: hbm
    relation: causes
---

# Mixed Related
`,
      "utf-8",
    )

    const page = await wiki.getNode("mixed-related")
    expect(page!.related).toEqual(["nvidia", { slug: "hbm", relation: "causes" }])

    // Writing another edge preserves both existing entries
    await wiki.addEdge("mixed-related", "asml", { relation: "explains" })
    const after = await wiki.getNode("mixed-related")
    expect(after!.related).toEqual([
      "nvidia",
      { slug: "hbm", relation: "causes" },
      { slug: "asml", relation: "explains" },
    ])
  })
})
