import { describe, it, expect } from "vitest"
import { titleToSlug, normalizeSlug, slugStartsWithDigit } from "../src/utils/slug.js"
import { InvalidSlugError } from "../src/utils/errors.js"

describe("titleToSlug", () => {
  it("converts simple English title", () => {
    expect(titleToSlug("Hello World")).toBe("hello-world")
  })

  it("preserves CJK characters", () => {
    expect(titleToSlug("AI基建周期")).toBe("ai基建周期")
  })

  it("applies NFKC normalization (fullwidth → ASCII)", () => {
    expect(titleToSlug("Ｈｅｌｌｏ")).toBe("hello")
    expect(titleToSlug("（テスト）")).toBe("テスト")
  })

  it("collapses multiple hyphens", () => {
    expect(titleToSlug("a -- b --- c")).toBe("a-b-c")
  })

  it("trims leading/trailing hyphens", () => {
    expect(titleToSlug("-hello-")).toBe("hello")
  })

  it("removes special characters via whitelist", () => {
    expect(titleToSlug("hello@world!")).toBe("helloworld")
    expect(titleToSlug("a/b\\c")).toBe("abc")
  })

  it("handles mixed CJK + English", () => {
    expect(titleToSlug("英伟达 (NVIDIA)")).toBe("英伟达-nvidia")
  })

  it("throws InvalidSlugError for empty result", () => {
    expect(() => titleToSlug("@#$%")).toThrow(InvalidSlugError)
    expect(() => titleToSlug("")).toThrow(InvalidSlugError)
  })

  it("throws InvalidSlugError for Windows reserved names", () => {
    for (const name of ["con", "prn", "aux", "nul", "com1", "lpt9"]) {
      expect(() => titleToSlug(name)).toThrow(InvalidSlugError)
    }
  })

  it("does not reject reserved-name substrings", () => {
    expect(titleToSlug("console")).toBe("console")
    expect(titleToSlug("auxiliary")).toBe("auxiliary")
  })
})

describe("normalizeSlug", () => {
  it("applies NFKC + lowercase", () => {
    expect(normalizeSlug("Ｈｅｌｌｏ")).toBe("hello")
    expect(normalizeSlug("ABC")).toBe("abc")
  })
})

describe("slugStartsWithDigit", () => {
  it("detects digit-starting slugs", () => {
    expect(slugStartsWithDigit("123abc")).toBe(true)
    expect(slugStartsWithDigit("abc123")).toBe(false)
    expect(slugStartsWithDigit("１２３")).toBe(true) // fullwidth digit after NFKC
  })
})
