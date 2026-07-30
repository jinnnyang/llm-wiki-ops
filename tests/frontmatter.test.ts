import { describe, it, expect } from "vitest"
import { parseFrontmatter, serializeFrontmatter } from "../src/io/frontmatter.js"

describe("parseFrontmatter", () => {
  it("parses standard frontmatter", () => {
    const input = `---
type: concept
title: "Test"
tags: ["a", "b"]
---

# Body
`
    const { frontmatter, body } = parseFrontmatter(input)
    expect(frontmatter).not.toBeNull()
    expect(frontmatter!.type).toBe("concept")
    expect(frontmatter!.title).toBe("Test")
    expect(frontmatter!.tags).toEqual(["a", "b"])
    expect(body.trim()).toBe("# Body")
  })

  it("returns null frontmatter for no-frontmatter content", () => {
    const input = "# Just a heading\n\nSome text."
    const { frontmatter, body } = parseFrontmatter(input)
    expect(frontmatter).toBeNull()
    expect(body).toBe(input)
  })

  it("repairs non-anchored frontmatter (junk prefix)", () => {
    const input = `Some junk line
Another junk line
---
type: entity
title: "Recovered"
---

# Body
`
    const { frontmatter, body } = parseFrontmatter(input)
    expect(frontmatter).not.toBeNull()
    expect(frontmatter!.type).toBe("entity")
    expect(frontmatter!.title).toBe("Recovered")
    expect(body.trim()).toBe("# Body")
  })

  it("repairs code-fence-wrapped frontmatter", () => {
    const input = '```yaml\n---\ntype: concept\ntitle: "Fenced"\n---\n```\n\n# Body\n'
    const { frontmatter, body } = parseFrontmatter(input)
    expect(frontmatter).not.toBeNull()
    expect(frontmatter!.type).toBe("concept")
    expect(body.trim()).toBe("# Body")
  })

  it("repairs wikilink-list in related field", () => {
    const input = `---
type: concept
title: "Dirty"
related: [[nvidia]], [[hbm]], [[tsmc]]
---

# Body
`
    const { frontmatter } = parseFrontmatter(input)
    expect(frontmatter).not.toBeNull()
    expect(frontmatter!.related).toEqual(["[[nvidia]]", "[[hbm]]", "[[tsmc]]"])
  })

  it("handles Date values in frontmatter", () => {
    const input = `---
created: 2025-01-15
---

Body
`
    const { frontmatter } = parseFrontmatter(input)
    expect(frontmatter!.created).toBe("2025-01-15")
  })

  it("preserves rawBlock for reconstruction", () => {
    const input = `---
type: entity
---

Body
`
    const { rawBlock } = parseFrontmatter(input)
    expect(rawBlock).toContain("---")
    expect(rawBlock).toContain("type: entity")
  })
})

describe("serializeFrontmatter", () => {
  it("round-trips basic frontmatter", () => {
    const fm = { type: "concept", title: "Test", tags: ["a", "b"] }
    const serialized = serializeFrontmatter(fm)
    expect(serialized).toContain("---")
    expect(serialized).toContain("type: concept")
    expect(serialized).toContain("title: Test")

    const { frontmatter } = parseFrontmatter(serialized + "\nBody")
    expect(frontmatter!.type).toBe("concept")
    expect(frontmatter!.tags).toEqual(["a", "b"])
  })
})
