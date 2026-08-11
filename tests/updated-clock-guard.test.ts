/**
 * A behavioural guard on the `updated` field, aimed at the NEXT person.
 *
 * `updated` is bumped on every write. Reading it as "has anyone maintained this
 * node?" has produced the same bug six times, in both directions:
 *
 *   1. usage stats — a dream's own reads counted as attention (fixed: excludeActor)
 *   2. salience touch clock — compression looked like a touch (fixed: use checked)
 *   3. pressure, dream pages — a dream's own pages counted as new (fixed: by type)
 *   4. pressure, compression writes — counted as updated pages (fixed: touched_slugs)
 *   5. the forgetting ladder — compressing a node reset its staleness, so it fell
 *      off the forgetting list and skeleton → delete was unreachable
 *   6. purge — a compressed skeleton looked freshly maintained and went INVISIBLE
 *      to `purge --stale-before`; the most decayed nodes escaped cleanup
 *
 * types.ts now documents this on the field itself, but a comment cannot fail CI.
 * This file can. It asserts the PROPERTY the comment describes: for every code path
 * that answers a neglect question, an ordinary write must not change the answer.
 *
 * Not a lint rule banning the identifier — `updated` has legitimate readers (the
 * check agent's re-verification schedule, activity feeds, display). The test
 * targets meaning, not spelling.
 */
import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { WikiGraph } from "../src/index.js"
import { scanFreshness } from "../src/core/freshness.js"
import { purgeByDate } from "../src/agent/purge.js"
import { prepareDream } from "../src/agent/dream.js"

let root: string

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

/** One long-neglected page: old facts, never verified, plus filler for ranking. */
async function makeWiki(): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-clock-"))
  const dir = path.join(root, "wiki", "concepts")
  await fs.mkdir(dir, { recursive: true })

  const page = (slug: string) =>
    fs.writeFile(
      path.join(dir, `${slug}.md`),
      `---\ntype: concept\ntitle: "${slug}"\ncreated: "2024-01-01"\nupdated: "2024-01-01"\nas_of: "2024-01-01"\n---\n\n# ${slug}\n\nBody with a [[neighbour]] link.\n`,
      "utf8",
    )

  await page("neglected")
  await page("neighbour")
  for (let i = 0; i < 12; i++) await page(`filler-${i}`)

  await fs.writeFile(
    path.join(root, "wiki", "index.md"),
    `---\ntype: overview\ntitle: Index\ncreated: "2024-01-01"\nupdated: "2024-01-01"\nas_of: "2024-01-01"\n---\n\n# Index\n`,
    "utf8",
  )
}

/**
 * Every "is this node neglected?" answer the codebase can give, for one slug.
 * Add a row here whenever a new consumer starts judging staleness.
 */
async function neglectAnswers(slug: string) {
  const wikiDir = path.join(root, "wiki")

  const fresh = await scanFreshness(wikiDir, root, { ignoreUpdatedClock: true })
  const purgeable = await purgeByDate({
    wikiRoot: root,
    staleBefore: "2025-01-01",
    dryRun: true,
  })
  const prep = await prepareDream({ wikiRoot: root })
  const salience = prep.salience.find((s) => s.slug === slug)

  return {
    /** freshness (neglect clock): overdue days */
    freshnessOverdue: fresh.due.find((e) => e.slug === slug)?.overdueDays ?? 0,
    /** purge: would this be cleaned up? */
    purgeSeesIt: purgeable.affected.some((a) => a.slug === slug),
    /** dream salience: staleness component */
    salienceOverdue: salience?.overdueDays ?? 0,
  }
}

describe("`updated` is not a maintenance signal", () => {
  it("an ordinary content write does not change any neglect answer", async () => {
    // The generalised form of bugs 5 and 6. Whatever the consumer, rewriting a
    // page's body must not make it look maintained — only `checked` does that.
    await makeWiki()
    const wiki = new WikiGraph(root, { maintainLog: false })

    const before = await neglectAnswers("neglected")
    expect(before.purgeSeesIt).toBe(true)
    expect(before.freshnessOverdue).toBeGreaterThan(300)

    await wiki.updateNode("neglected", { content: "# neglected\n\nRewritten body." })

    expect(await neglectAnswers("neglected")).toEqual(before)
  })

  it("a compression write does not change any neglect answer", async () => {
    // The specific write that caused bugs 5 and 6: it moves a node DOWN the
    // forgetting ladder, and used to reset the very clock that put it there.
    await makeWiki()
    const wiki = new WikiGraph(root, { maintainLog: false })

    const before = await neglectAnswers("neglected")
    await wiki.updateNode("neglected", {
      content: "# neglected\n\nCore claim only.",
      compression: "condensed",
    })
    const after = await neglectAnswers("neglected")

    expect(after.freshnessOverdue).toBe(before.freshnessOverdue)
    expect(after.purgeSeesIt).toBe(before.purgeSeesIt)
    expect(after.salienceOverdue).toBe(before.salienceOverdue)
  })

  it("an edge write does not change the SOURCE page's neglect answer", async () => {
    // The gap that prompted this file: edge-ops bumps the source page's `updated`,
    // so linking A→B makes A look freshly touched. No consumer reads `updated` for
    // neglect today — this test is what keeps that true.
    await makeWiki()
    const wiki = new WikiGraph(root, { maintainLog: false })

    const before = await neglectAnswers("neglected")
    await wiki.addEdge("neglected", "filler-0", { relation: "relates-to" })
    const after = await neglectAnswers("neglected")

    expect(after.freshnessOverdue).toBe(before.freshnessOverdue)
    expect(after.purgeSeesIt).toBe(before.purgeSeesIt)
  })

  it("a real verification DOES change every neglect answer", async () => {
    // The other half: if nothing could clear the neglect flag, the flag would be
    // useless. `checked` is the one write that legitimately resets it.
    await makeWiki()
    const wiki = new WikiGraph(root, { maintainLog: false })

    expect((await neglectAnswers("neglected")).purgeSeesIt).toBe(true)

    await wiki.updateNode("neglected", { checked: new Date().toISOString().slice(0, 10) })

    const after = await neglectAnswers("neglected")
    expect(after.freshnessOverdue).toBe(0)
    expect(after.purgeSeesIt).toBe(false)
    expect(after.salienceOverdue).toBe(0)
  })

  it("the check agent's schedule still moves with `updated` — on purpose", async () => {
    // The line this whole design walks: for CHECK, a content change IS a reason to
    // re-verify, so its default clock keeps the `updated` fallback. Same wiki, two
    // clocks, deliberately different answers. Collapsing them would be a
    // regression in the opposite direction.
    await makeWiki()
    const wiki = new WikiGraph(root, { maintainLog: false })
    await wiki.updateNode("neglected", { content: "# neglected\n\nRewritten today." })

    const wikiDir = path.join(root, "wiki")
    const forCheck = await scanFreshness(wikiDir, root)
    const forNeglect = await scanFreshness(wikiDir, root, { ignoreUpdatedClock: true })

    expect(forCheck.due.map((e) => e.slug)).not.toContain("neglected")
    expect(forNeglect.due.map((e) => e.slug)).toContain("neglected")
  })
})
