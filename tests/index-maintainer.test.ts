/**
 * tests/index-maintainer.test.ts — index.md generation and rebuild.
 *
 * The load-bearing property here is IDEMPOTENCE: rebuilding an index from its
 * own output must not change it. rebuildIndexPreservingCustom keeps sections a
 * human added, which means it has to tell generated sections from custom ones —
 * and if that classification is wrong for even one page type, every rebuild
 * duplicates that type's section and index.md grows without bound.
 */

import { describe, it, expect } from "vitest"

import {
  generateIndexContent,
  rebuildIndexPreservingCustom,
} from "../src/core/index-maintainer.js"
import { KNOWN_TYPE_ORDER, type GraphNode, type PageType } from "../src/types.js"

function node(slug: string, type: PageType): GraphNode {
  return {
    slug,
    title: slug.toUpperCase(),
    type,
    tags: [],
    related: [],
    sources: [],
    created: "2026-01-01",
    updated: "2026-01-01",
    path: `wiki/${type}s/${slug}.md`,
  }
}

/** One node per known type — the shape a real wiki reaches once dream runs. */
const allTypes: GraphNode[] = KNOWN_TYPE_ORDER.map((t, i) => node(`n${i}`, t))

describe("rebuildIndexPreservingCustom", () => {
  it("is idempotent: rebuilding from its own output changes nothing", () => {
    const first = generateIndexContent(allTypes)
    const second = rebuildIndexPreservingCustom(first, allTypes)
    const third = rebuildIndexPreservingCustom(second, allTypes)

    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it("never duplicates a section heading for ANY known type", () => {
    // The `dream` regression: typeHeading emitted "## Dreams" while the
    // KNOWN_HEADINGS allow-list was hand-written and missing it, so the
    // generated Dreams section was misread as a custom section and re-appended.
    // Each rebuild added one more (1 → 2 → 3 …), and the dream agent calls
    // rebuild_index at the end of every run. Asserting per-type instead of just
    // for `dream` means a new page type cannot silently reintroduce this.
    let content = generateIndexContent(allTypes)
    for (let round = 0; round < 3; round++) {
      content = rebuildIndexPreservingCustom(content, allTypes)
      const headings = content.match(/^## .+$/gm) ?? []
      const counts = new Map<string, number>()
      for (const h of headings) counts.set(h, (counts.get(h) ?? 0) + 1)
      const duplicated = [...counts.entries()].filter(([, n]) => n > 1)
      expect(duplicated, `round ${round + 1} duplicated: ${JSON.stringify(duplicated)}`).toEqual([])
    }
  })

  it("lists every node exactly once after repeated rebuilds", () => {
    let content = generateIndexContent(allTypes)
    for (let i = 0; i < 3; i++) content = rebuildIndexPreservingCustom(content, allTypes)

    for (const n of allTypes) {
      const hits = content.match(new RegExp(`\\[\\[${n.slug}\\]\\]`, "g")) ?? []
      expect(hits.length, `${n.slug} (${n.type}) appeared ${hits.length}×`).toBe(1)
    }
  })

  it("still preserves a genuinely custom section, exactly once", () => {
    // The feature this function exists for must survive the fix.
    const generated = generateIndexContent(allTypes)
    const withCustom = `${generated}\n## My Reading Queue\n\n- [[n0]] — revisit\n`

    let content = rebuildIndexPreservingCustom(withCustom, allTypes)
    expect(content).toContain("## My Reading Queue")
    expect(content).toContain("- [[n0]] — revisit")

    // And it must not multiply either.
    content = rebuildIndexPreservingCustom(content, allTypes)
    expect((content.match(/^## My Reading Queue$/gm) ?? []).length).toBe(1)
  })

  it("reaches a fixed point with a custom section — no blank-line creep", () => {
    // A real wiki's index.md ends with a custom section followed by blank lines
    // (this one came from wiki-builder's "## Recently Updated"). The captured
    // section kept its own trailing newlines and a "\n" was appended on top, so
    // the file grew one line per rebuild — 1382 → 1383 → 1384 … unbounded, and
    // the dream agent rebuilds nightly. Trailing whitespace is exactly where
    // idempotence bugs hide, so assert on the bytes.
    const generated = generateIndexContent(allTypes)
    const withCustom = `${generated}\n## Recently Updated\n\n- [[n0]] — today\n\n\n`

    const first = rebuildIndexPreservingCustom(withCustom, allTypes)
    const second = rebuildIndexPreservingCustom(first, allTypes)
    const third = rebuildIndexPreservingCustom(second, allTypes)

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(first).toContain("## Recently Updated")
    expect(first.endsWith("\n")).toBe(true)
    expect(/\n{3,}$/.test(first)).toBe(false)
  })

  it("drops a custom heading whose body is only blank lines", () => {
    // Such a section carries no information; re-emitting it is what fed the
    // blank-line creep above.
    const generated = generateIndexContent(allTypes)
    const first = rebuildIndexPreservingCustom(`${generated}\n## Empty Section\n\n\n`, allTypes)
    const second = rebuildIndexPreservingCustom(first, allTypes)
    expect(second).toBe(first)
  })

  it("routes an unknown type into ## Other without duplicating it", () => {
    const nodes = [...allTypes, node("weird", "sketch" as PageType)]
    let content = generateIndexContent(nodes)
    content = rebuildIndexPreservingCustom(content, nodes)
    content = rebuildIndexPreservingCustom(content, nodes)

    expect((content.match(/^## Other$/gm) ?? []).length).toBe(1)
    expect((content.match(/\[\[weird\]\]/g) ?? []).length).toBe(1)
  })
})
