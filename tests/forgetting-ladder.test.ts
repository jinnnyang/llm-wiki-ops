/**
 * The forgetting ladder, end to end, on a real wiki — no model.
 *
 * WHY THIS FILE EXISTS
 *
 * skeleton → delete_node never fired in any live dream for weeks, and the reason
 * was never visible in a unit test: compressing a node pushed it OFF the
 * forgetting list, so nothing ever reached the end of the ladder. The mechanism:
 *
 *   1. the forgetting score reads staleness from the freshness scan
 *   2. the freshness scan's fallback reference clock is `updated`
 *   3. node-ops bumps `updated` on every write
 *   4. therefore a compression reset its own node's staleness to zero
 *
 * Measured on the real wiki before the fix: 阿里-alibaba was 413 days overdue and
 * ranked #1 most forgettable; one compression dropped it out of the due list
 * entirely and it fell to #16, below the 10-row cutoff the model ever sees. Every
 * unit test passed throughout — the bug lived in the seam between three
 * components, each individually correct.
 *
 * So these tests exercise the real seam: real pages on disk, real writes through
 * WikiGraph, real prepareDream. The model is the only thing left out, because the
 * property under test is what pure code HANDS the model. Whether it then deletes
 * is its judgement (and it did, on the third look, in a live run).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { WikiGraph } from "../src/index.js"
import { prepareDream } from "../src/agent/dream.js"
import { computeForgettability } from "../src/agent/dream-select.js"
import { scanFreshness } from "../src/core/freshness.js"

/** How many rows of the forgetting table renderContext puts in the prompt. */
const VISIBLE_ROWS = 10

let root: string

/**
 * A wiki with one long-neglected, unreferenced node plus enough filler that the
 * visible cutoff is a real constraint rather than a formality.
 */
async function makeWiki(fillerCount: number): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-ladder-"))
  const conceptsDir = path.join(root, "wiki", "concepts")
  await fs.mkdir(conceptsDir, { recursive: true })

  const page = (slug: string, asOf: string, body: string) =>
    fs.writeFile(
      path.join(conceptsDir, `${slug}.md`),
      `---\ntype: concept\ntitle: "${slug}"\ncreated: "${asOf}"\nupdated: "${asOf}"\nas_of: "${asOf}"\n---\n\n# ${slug}\n\n${body}\n`,
      "utf8",
    )

  // The candidate: old facts, nobody linking to it, nobody maintaining it.
  await page("abandoned", "2024-01-01", "A page nobody references and nobody has revisited.")

  // Filler that is stale too, so `abandoned` has to actually out-rank it rather
  // than win by being the only row.
  for (let i = 0; i < fillerCount; i++) {
    await page(`filler-${String(i).padStart(2, "0")}`, "2024-06-01", `Filler ${i}.`)
  }

  await fs.writeFile(
    path.join(root, "wiki", "index.md"),
    `---\ntype: overview\ntitle: Index\ncreated: "2024-01-01"\nupdated: "2024-01-01"\n---\n\n# Index\n`,
    "utf8",
  )
}

/** The forgetting table as renderContext builds it: same filter, same rank, same cutoff. */
async function forgettingTable() {
  const prep = await prepareDream({ wikiRoot: root })
  const ranked = computeForgettability(
    prep.salience.filter(
      (s) => s.type !== "source" && s.type !== "overview" && s.type !== "dream",
    ),
    prep.tuning,
  ).filter((s) => s.usage30 === 0)
  return {
    all: ranked,
    visible: ranked.slice(0, VISIBLE_ROWS),
    rankOf: (slug: string) => ranked.findIndex((s) => s.slug === slug) + 1,
  }
}

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe("forgetting ladder survives its own writes", () => {
  beforeEach(async () => {
    await makeWiki(20)
  })

  it("a compressed node stays visible in the forgetting table", async () => {
    // THE regression. Before the fix this node left the table entirely, so the
    // ladder's second step disabled its third and nothing was ever deleted.
    const wiki = new WikiGraph(root, { maintainLog: false })

    const before = await forgettingTable()
    expect(before.rankOf("abandoned")).toBeGreaterThan(0)
    expect(before.rankOf("abandoned")).toBeLessThanOrEqual(VISIBLE_ROWS)

    await wiki.updateNode("abandoned", {
      content: "# abandoned\n\nOne-line core claim.",
      compression: "condensed",
    })

    const after = await forgettingTable()
    expect(after.rankOf("abandoned")).toBeGreaterThan(0) // still in the pool at all
    expect(after.rankOf("abandoned")).toBeLessThanOrEqual(VISIBLE_ROWS) // still shown to the model
  })

  it("each rung raises the score, so the ladder pulls forward instead of stalling", async () => {
    // Progress down the ladder must make a node MORE forgettable, otherwise it
    // parks at condensed forever — which is what the live runs did.
    const wiki = new WikiGraph(root, { maintainLog: false })
    const scoreOf = async () =>
      (await forgettingTable()).all.find((s) => s.slug === "abandoned")!.forgetScore

    const active = await scoreOf()
    await wiki.updateNode("abandoned", { content: "# a\n\nCore.", compression: "condensed" })
    const condensed = await scoreOf()
    await wiki.updateNode("abandoned", { content: "# a\n\nBones.", compression: "skeleton" })
    const skeleton = await scoreOf()

    expect(condensed).toBeGreaterThan(active)
    expect(skeleton).toBeGreaterThan(condensed)
  })

  it("staleness is not reset by a write, but IS reset by a real verification", async () => {
    // The distinction the fix rests on: `updated` moves on any write and must not
    // count as maintenance; `checked` means somebody actually verified the node,
    // which legitimately restarts the clock.
    const wiki = new WikiGraph(root, { maintainLog: false })
    const staleness = async () =>
      (await forgettingTable()).all.find((s) => s.slug === "abandoned")!.overdueDays

    const initial = await staleness()
    expect(initial).toBeGreaterThan(300)

    await wiki.updateNode("abandoned", { content: "# a\n\nRewritten.", compression: "condensed" })
    expect(await staleness()).toBe(initial) // a write is not maintenance

    await wiki.updateNode("abandoned", { checked: new Date().toISOString().slice(0, 10) })
    expect(await staleness()).toBe(0) // a verification is
  })

  it("the check agent's schedule is untouched by the neglect clock", async () => {
    // The fix must not make the check agent stop re-verifying rewritten pages:
    // for check, a content change IS a reason to look again. Same wiki, two
    // clocks, deliberately different answers.
    const wiki = new WikiGraph(root, { maintainLog: false })
    await wiki.updateNode("abandoned", { content: "# a\n\nRewritten today." })

    const wikiDir = path.join(root, "wiki")
    const checkClock = await scanFreshness(wikiDir, root)
    const neglectClock = await scanFreshness(wikiDir, root, { ignoreUpdatedClock: true })

    // check: the rewrite reset the schedule, so it is no longer overdue.
    expect(checkClock.due.map((e) => e.slug)).not.toContain("abandoned")
    // forgetting: still neglected, because nobody verified anything.
    expect(neglectClock.due.map((e) => e.slug)).toContain("abandoned")
  })
})

describe("forgetting table cutoff", () => {
  it("a node just past the visible rows cannot be acted on — the cutoff is real", async () => {
    // Documents why rank matters and not just pool membership: the model only ever
    // sees VISIBLE_ROWS rows, so "in the pool at rank 16" is indistinguishable
    // from absent. This is exactly how the original bug hid.
    await makeWiki(40)
    const table = await forgettingTable()

    expect(table.all.length).toBeGreaterThan(VISIBLE_ROWS)
    expect(table.visible).toHaveLength(VISIBLE_ROWS)
    for (const row of table.visible) {
      expect(table.all.indexOf(row)).toBeLessThan(VISIBLE_ROWS)
    }
  })
})
