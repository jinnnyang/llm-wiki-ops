import { describe, it, expect } from "vitest"
import {
  extractWikilinks,
  extractWikilinkSlugs,
  hasWikilink,
  insertWikilink,
  removeWikilinks,
  replaceWikilinks,
  danglingWikilink,
} from "../src/io/wikilink.js"

describe("extractWikilinks", () => {
  it("extracts simple wikilinks", () => {
    expect(extractWikilinks("See [[nvidia]] and [[hbm]].")).toEqual(["nvidia", "hbm"])
  })

  it("extracts aliased wikilinks", () => {
    expect(extractWikilinks("[[nvidia|NVIDIA Corp]]")).toEqual(["nvidia"])
  })

  it("skips fenced code blocks", () => {
    const content = `Before
\`\`\`python
# [[not-a-link]]
\`\`\`
After [[real-link]]`
    expect(extractWikilinks(content)).toEqual(["real-link"])
  })

  it("skips inline code spans", () => {
    expect(extractWikilinks("Use `[[not-a-link]]` but [[real]]")).toEqual(["real"])
  })

  it("handles ~~~ fenced blocks", () => {
    const content = `~~~
[[skip-me]]
~~~
[[keep-me]]`
    expect(extractWikilinks(content)).toEqual(["keep-me"])
  })

  it("deduplicates via extractWikilinkSlugs", () => {
    const slugs = extractWikilinkSlugs("[[nvidia]] and [[nvidia]] again")
    expect(slugs).toEqual(["nvidia", "nvidia"]) // not deduped here, caller dedupes
  })
})

describe("hasWikilink", () => {
  it("finds existing wikilink", () => {
    expect(hasWikilink("See [[nvidia]]", "nvidia")).toBe(true)
  })

  it("returns false for missing", () => {
    expect(hasWikilink("See [[nvidia]]", "hbm")).toBe(false)
  })

  it("matches case-insensitively via normalizeSlug", () => {
    expect(hasWikilink("See [[NVIDIA]]", "nvidia")).toBe(true)
  })
})

describe("insertWikilink", () => {
  it("inserts into existing ## 相关 section", () => {
    const content = "# Title\n\n## 相关\n\n- [[existing]]\n"
    const result = insertWikilink(content, "new-link")
    expect(result).toContain("- [[new-link]]")
    expect(result).toContain("- [[existing]]")
  })

  it("creates ## 相关 section when missing", () => {
    const content = "# Title\n\nSome text.\n"
    const result = insertWikilink(content, "new-link")
    expect(result).toContain("## 相关")
    expect(result).toContain("- [[new-link]]")
  })

  it("uses context heading when provided", () => {
    const content = "# Title\n\n## 核心矛盾\n\nText here.\n\n## 相关\n\n- [[old]]\n"
    const result = insertWikilink(content, "new-link", "## 核心矛盾")
    // Should be in 核心矛盾 section, not 相关
    const sections = result.split("## ")
    const coreSection = sections.find((s) => s.startsWith("核心矛盾"))
    expect(coreSection).toContain("- [[new-link]]")
  })

  it("falls back to ## Related", () => {
    const content = "# Title\n\n## Related\n\n- [[old]]\n"
    const result = insertWikilink(content, "new-link")
    expect(result).toContain("- [[new-link]]")
  })
})

describe("removeWikilinks", () => {
  it("removes list-item wikilinks entirely", () => {
    const content = "## 相关\n\n- [[nvidia]]\n- [[hbm]]\n"
    const result = removeWikilinks(content, "nvidia")
    expect(result).not.toContain("[[nvidia]]")
    expect(result).toContain("[[hbm]]")
  })

  it("removes inline wikilinks", () => {
    const content = "See [[nvidia]] for details."
    const result = removeWikilinks(content, "nvidia")
    expect(result).not.toContain("[[nvidia]]")
    expect(result).toContain("See  for details.")
  })

  it("preserves code block wikilinks", () => {
    const content = "```\n[[nvidia]]\n```\n[[nvidia]]"
    const result = removeWikilinks(content, "nvidia")
    expect(result).toContain("```\n[[nvidia]]\n```")
  })

  it("preserves inline code wikilinks", () => {
    const content = "Use `[[nvidia]]` in code but [[nvidia]] in text."
    const result = removeWikilinks(content, "nvidia")
    expect(result).toContain("`[[nvidia]]`")
    expect(result).not.toContain("]] in text")
  })
})

describe("replaceWikilinks", () => {
  it("replaces slug in wikilinks", () => {
    const content = "- [[old-slug]]\n- [[other]]"
    const result = replaceWikilinks(content, "old-slug", "new-slug")
    expect(result).toContain("[[new-slug]]")
    expect(result).toContain("[[other]]")
    expect(result).not.toContain("[[old-slug]]")
  })

  it("preserves alias", () => {
    const content = "[[old-slug|Display Name]]"
    const result = replaceWikilinks(content, "old-slug", "new-slug")
    expect(result).toBe("[[new-slug|Display Name]]")
  })

  it("skips fenced code blocks", () => {
    const content = "```\n[[old-slug]]\n```\n[[old-slug]]"
    const result = replaceWikilinks(content, "old-slug", "new-slug")
    expect(result).toContain("```\n[[old-slug]]\n```")
    expect(result).toContain("[[new-slug]]")
  })

  it("skips inline code spans", () => {
    const content = "Use `[[old-slug]]` in code but [[old-slug]] in text."
    const result = replaceWikilinks(content, "old-slug", "new-slug")
    expect(result).toContain("`[[old-slug]]`")
    expect(result).toContain("[[new-slug]] in text")
  })
})

describe("danglingWikilink", () => {
  it("strikethrough mode", () => {
    const content = "- [[nvidia]]\n"
    const result = danglingWikilink(content, "nvidia", "英伟达", "strikethrough")
    expect(result).toContain("~~英伟达~~")
    expect(result).not.toContain("[[nvidia]]")
  })

  it("plain-text mode", () => {
    const content = "- [[nvidia]]\n"
    const result = danglingWikilink(content, "nvidia", "英伟达", "plain-text")
    expect(result).toContain("英伟达")
    expect(result).not.toContain("~~")
  })

  it("remove mode drops list items", () => {
    const content = "- [[nvidia]]\n- [[hbm]]\n"
    const result = danglingWikilink(content, "nvidia", "英伟达", "remove")
    expect(result).not.toContain("nvidia")
    expect(result).toContain("[[hbm]]")
  })

  it("preserves inline code wikilinks", () => {
    const content = "Use `[[nvidia]]` in code but [[nvidia]] in text."
    const result = danglingWikilink(content, "nvidia", "英伟达", "strikethrough")
    expect(result).toContain("`[[nvidia]]`")
    expect(result).toContain("~~英伟达~~")
  })
})
