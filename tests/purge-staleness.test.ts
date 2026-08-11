/**
 * purgeByDate staleness clock.
 *
 * purge had NO coverage of its staleness predicate — the field it judges by was
 * swapped out wholesale and all 413 other tests stayed green. That silence is the
 * reason this file exists.
 *
 * The bug it locks down: purge used `updated`, which node-ops bumps on every write,
 * including a dream's compression writes. So compressing a node made it look freshly
 * maintained and purge stopped seeing it. Two pages equally stale at 2024-01-01:
 *
 *   untouched-stale   active    updated=2024-01-01  → PURGED
 *   compressed-stale  skeleton  updated=2026-08-11  → INVISIBLE TO PURGE
 *
 * The node whose content had actually decayed to bones was the one that escaped
 * cleanup. Compression was granting immunity from purge — backwards from intent.
 */
import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { purgeByDate } from "../src/agent/purge.js"
import { WikiGraph } from "../src/index.js"

let root: string

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

interface PageSpec {
  slug: string
  /** Omit to leave the field out of the frontmatter entirely. */
  as_of?: string
  checked?: string
  updated?: string
}

async function makeWiki(specs: PageSpec[]): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-purge-"))
  const dir = path.join(root, "wiki", "concepts")
  await fs.mkdir(dir, { recursive: true })

  for (const s of specs) {
    const fm = [
      "type: concept",
      `title: "${s.slug}"`,
      `created: "2024-01-01"`,
      ...(s.updated ? [`updated: "${s.updated}"`] : []),
      ...(s.as_of ? [`as_of: "${s.as_of}"`] : []),
      ...(s.checked ? [`checked: "${s.checked}"`] : []),
    ].join("\n")
    await fs.writeFile(
      path.join(dir, `${s.slug}.md`),
      `---\n${fm}\n---\n\n# ${s.slug}\n\nBody.\n`,
      "utf8",
    )
  }

  await fs.writeFile(
    path.join(root, "wiki", "index.md"),
    `---\ntype: overview\ntitle: Index\ncreated: "2024-01-01"\nupdated: "2024-01-01"\nas_of: "2024-01-01"\n---\n\n# Index\n`,
    "utf8",
  )
}

const purge = (staleBefore: string) =>
  purgeByDate({ wikiRoot: root, staleBefore, dryRun: true })

describe("purgeByDate: a write is not maintenance", () => {
  it("still sees a node whose `updated` was bumped by compression", async () => {
    // THE regression. Both pages carry the same old facts; one was compressed
    // yesterday. Compression must not buy immunity.
    await makeWiki([
      { slug: "untouched", as_of: "2024-01-01", updated: "2024-01-01" },
      { slug: "compressed", as_of: "2024-01-01", updated: "2024-01-01" },
    ])
    const wiki = new WikiGraph(root, { maintainLog: false })
    await wiki.updateNode("compressed", {
      content: "# compressed\n\nBones only.",
      compression: "skeleton",
    })

    const slugs = (await purge("2025-01-01")).affected.map((a) => a.slug)
    expect(slugs).toContain("untouched")
    expect(slugs).toContain("compressed")
  })

  it("a real verification DOES protect a node", async () => {
    // The distinction the fix rests on: `checked` means somebody looked at the
    // node and confirmed it, which is maintenance. `updated` only means bytes
    // moved. Old facts + recent verification = not stale.
    await makeWiki([
      { slug: "verified", as_of: "2024-01-01", checked: "2026-06-01", updated: "2024-01-01" },
      { slug: "unverified", as_of: "2024-01-01", updated: "2026-08-01" },
    ])

    const result = await purge("2025-01-01")
    const slugs = result.affected.map((a) => a.slug)
    expect(slugs).not.toContain("verified")
    // Recently rewritten but never verified — still stale.
    expect(slugs).toContain("unverified")
  })

  it("reports which clock each decision was made on", async () => {
    // A dry-run report that prints a date without naming its source is unauditable,
    // and the date is no longer `updated`.
    await makeWiki([
      { slug: "by-checked", as_of: "2020-01-01", checked: "2024-03-01" },
      { slug: "by-as-of", as_of: "2024-02-01" },
    ])

    const byslug = new Map((await purge("2025-01-01")).affected.map((a) => [a.slug, a]))
    expect(byslug.get("by-checked")).toMatchObject({
      clockSource: "checked",
      updated: "2024-03-01",
    })
    expect(byslug.get("by-as-of")).toMatchObject({
      clockSource: "as_of",
      updated: "2024-02-01",
    })
  })

  it("skips pages with no honest clock instead of trusting `updated`", async () => {
    // Neither checked nor as_of. `updated` is the only date left, and it is exactly
    // the untrustworthy one — so the page is skipped, and the skip is COUNTED so it
    // cannot be mistaken for "nothing was stale".
    await makeWiki([
      { slug: "no-clock", updated: "2024-01-01" },
      { slug: "has-clock", as_of: "2024-01-01", updated: "2024-01-01" },
    ])

    const result = await purge("2025-01-01")
    expect(result.affected.map((a) => a.slug)).toEqual(["has-clock"])
    expect(result.skippedNoClock).toBe(1)
  })

  it("does not purge nodes newer than the cutoff", async () => {
    // Baseline sanity: the predicate still does its actual job.
    await makeWiki([
      { slug: "old", as_of: "2024-01-01" },
      { slug: "recent", as_of: "2026-01-01" },
    ])

    const slugs = (await purge("2025-01-01")).affected.map((a) => a.slug)
    expect(slugs).toEqual(["old"])
  })

  it("dry run leaves the wiki untouched", async () => {
    await makeWiki([{ slug: "old", as_of: "2024-01-01" }])
    const before = await fs.readFile(
      path.join(root, "wiki", "concepts", "old.md"),
      "utf8",
    )

    await purge("2025-01-01")

    expect(await fs.readFile(path.join(root, "wiki", "concepts", "old.md"), "utf8")).toBe(before)
  })
})
