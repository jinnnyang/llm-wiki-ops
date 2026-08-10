/**
 * tests/dream-citation.test.ts — wake-side agents must know dream pages are not evidence.
 *
 * Design: dream.md §7.3. Dream pages are first-class graph nodes on purpose, so
 * that check can pull them in and settle them. The cost is that they come back
 * from ordinary reads: a live query for "钨" on a 1150-page wiki returned 5 nodes,
 * one of which was `type: dream`, listed beside three established concept nodes
 * with only the type field to distinguish it. Before this, none of the three
 * wake-side prompts mentioned UNVERIFIED — nothing stopped an agent from citing a
 * dream's speculation as fact and writing it into a new node.
 *
 * These tests guard the wiring (every wake-side prompt carries the block, the
 * block says the load-bearing things) rather than exact phrasing, which should
 * stay free to improve.
 */

import { describe, it, expect } from "vitest"

import { DREAM_CITATION_DISCIPLINE } from "../src/agent/dream-citation.js"
import { REASON_SYSTEM_PROMPT } from "../src/agent/reason.js"
import { RESEARCH_SYSTEM_PROMPT } from "../src/agent/research.js"
import { CHECK_SYSTEM_PROMPT } from "../src/agent/check.js"

const WAKE_SIDE: Array<[string, string]> = [
  ["reason", REASON_SYSTEM_PROMPT],
  ["research", RESEARCH_SYSTEM_PROMPT],
  ["check", CHECK_SYSTEM_PROMPT],
]

describe("DREAM_CITATION_DISCIPLINE content", () => {
  it("names both ways a dream page can be recognised", () => {
    // An agent that cannot identify one cannot apply any rule about it.
    expect(DREAM_CITATION_DISCIPLINE).toContain("type: dream")
    expect(DREAM_CITATION_DISCIPLINE).toContain("UNVERIFIED DREAM")
  })

  it("forbids citing a dream as support or as a source", () => {
    const text = DREAM_CITATION_DISCIPLINE.toLowerCase()
    expect(text).toContain("never cite")
    expect(text).toContain("never use one as a source")
  })

  it("redirects to the underlying nodes instead of only forbidding", () => {
    // A pure prohibition would make agents ignore dreams entirely, which breaks
    // the verification loop dreams exist for. The rule has to say what TO do.
    expect(DREAM_CITATION_DISCIPLINE).toContain("wikilinks")
    expect(DREAM_CITATION_DISCIPLINE.toLowerCase()).toContain("lead worth investigating")
  })

  it("warns that ordinary reads do not filter dreams out", () => {
    // The trap is silence: read_graph's type filter is opt-in, so an agent that
    // never asked for dreams still gets them.
    expect(DREAM_CITATION_DISCIPLINE).toContain("read_graph")
    expect(DREAM_CITATION_DISCIPLINE).toContain("do not filter")
  })
})

describe("wake-side prompts carry the discipline", () => {
  it.each(WAKE_SIDE)("%s embeds the shared block verbatim", (_name, prompt) => {
    // Verbatim, not paraphrased: three hand-maintained copies would drift apart,
    // the same reason KNOWN_HEADINGS derives from KNOWN_TYPE_ORDER.
    expect(prompt).toContain(DREAM_CITATION_DISCIPLINE)
  })

  it.each(WAKE_SIDE)("%s still ends with its own output instruction", (_name, prompt) => {
    // The block is inserted BEFORE the closing section — the last thing an agent
    // reads must remain "here is what to produce", not a caveat about dreams.
    const tail = prompt.trim().slice(-400).toLowerCase()
    expect(tail).toMatch(/report|summary|output/)
    expect(prompt.trim().endsWith(DREAM_CITATION_DISCIPLINE.trim())).toBe(false)
  })

  it("uses one shared constant, so the three cannot diverge", () => {
    const [, reason] = WAKE_SIDE[0]!
    const [, research] = WAKE_SIDE[1]!
    const [, check] = WAKE_SIDE[2]!
    const extract = (p: string) => {
      const i = p.indexOf("## Dream pages are NOT evidence")
      return p.slice(i, i + DREAM_CITATION_DISCIPLINE.length)
    }
    expect(extract(reason)).toBe(extract(research))
    expect(extract(research)).toBe(extract(check))
  })
})

describe("the dream agent itself is NOT given this block", () => {
  it("keeps the discipline on the wake side only", async () => {
    // dream WRITES these pages and must treat its own output as material, not as
    // something to refuse. Handing it the wake-side rule would be incoherent.
    const { DREAM_SYSTEM_PROMPT } = (await import("../src/agent/dream.js")) as unknown as {
      DREAM_SYSTEM_PROMPT?: string
    }
    if (DREAM_SYSTEM_PROMPT) {
      expect(DREAM_SYSTEM_PROMPT).not.toContain(DREAM_CITATION_DISCIPLINE)
    }
  })
})
