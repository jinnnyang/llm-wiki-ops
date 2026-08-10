/**
 * Put a chosen set of nodes at the END of the forgetting ladder.
 *
 * The ladder's last step (skeleton → delete_node) has never fired in a live run,
 * because reaching skeleton takes three dreams per node and each dream picks its
 * own material. This constructs the state a long-running wiki would reach on its
 * own: a handful of nodes already reduced to bones, so the next dream's decision
 * is genuinely "delete or keep", not "compress one more step".
 *
 * What it does NOT do is decide the outcome. The body it writes is the shape a
 * real dream produces at skeleton (one-line summary + an index of what was
 * there), taken from an actual observed compression. Whether the model then
 * deletes is the model's call — that is the thing under test.
 *
 * Usage: node scripts/stage-skeleton-nodes.mjs <wikiRoot> [slug ...]
 */
import { WikiGraph } from "../dist/src/index.js"
import * as path from "node:path"

const root = process.argv[2]
if (!root) {
  console.error("usage: node scripts/stage-skeleton-nodes.mjs <wikiRoot> [slug ...]")
  process.exit(1)
}

// Same guard as age-wiki-nodes.py: this rewrites page bodies in place.
const low = root.replace(/\\/g, "/").toLowerCase()
if (!["temp", "tmp", "test", "fixture"].some((k) => low.includes(k))) {
  console.error(
    `refusing to stage ${root}\n` +
      "This rewrites page bodies in place. Point it at a throwaway copy under a\n" +
      "temp/test path, never at a wiki you care about.",
  )
  process.exit(1)
}

const slugs = process.argv.slice(3)
if (slugs.length === 0) {
  console.error("no slugs given — pass the slugs to reduce to skeleton")
  process.exit(1)
}

const wiki = new WikiGraph(root, { maintainLog: false })

for (const slug of slugs) {
  const page = await wiki.getNode(slug)
  if (!page) {
    console.error(`  ${slug}: NOT FOUND, skipped`)
    continue
  }
  const edges = await wiki.getEdges(slug)
  const before = page.content.length

  // Skeleton shape, per the dream prompt: one-line summary plus an index of what
  // used to be here — section names, edges, sources. Nothing invented: every
  // item below is read off the page itself.
  const sections = [...page.content.matchAll(/^##+\s+(.+)$/gm)].map((m) => m[1].trim())
  const out = edges.outbound.map((e) => e.target)
  const first = page.content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("|"))

  const body = [
    `# ${page.title}`,
    "",
    first ? first.slice(0, 200) : `${page.title} — content reduced to skeleton.`,
    "",
    "## What was here",
    "",
    sections.length ? `- Sections: ${sections.join("、")}` : "- Sections: (none)",
    out.length ? `- Links: ${out.map((s) => `[[${s}]]`).join(" ")}` : "- Links: (none)",
    page.sources?.length ? `- Sources: ${page.sources.join(", ")}` : "- Sources: (none)",
  ].join("\n")

  const res = await wiki.updateNode(slug, { content: body, compression: "skeleton" })
  const after = (await wiki.getNode(slug)).content.length
  console.log(
    `  ${slug}: ${before} → ${after} bytes, fields=${res.fieldsChanged.join(",")}, ` +
      `edges kept out=${out.length} in=${edges.inbound.length}`,
  )
}

console.log("staged.")
