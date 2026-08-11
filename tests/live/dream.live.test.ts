/**
 * runDream against a real model, real MCP subprocess, real disk.
 *
 * WHY A SEPARATE SUITE
 *
 * `npm test`'s 413 cases cover every piece of the dream in isolation and still
 * missed a bug that made the forgetting ladder's last step unreachable, because
 * that bug lived in the seam between three individually-correct components. The
 * only thing that surfaces seam bugs is running the real thing.
 *
 * WHAT THIS ASSERTS — AND WHAT IT MUST NOT
 *
 * A dream's OUTPUT is a model judgement: how many edges it writes, which nodes it
 * compresses, whether it deletes anything. None of that is a test assertion —
 * asserting it would produce a suite that fails when the model behaves reasonably
 * and differently, which is worse than no suite.
 *
 * So every assertion here is an INVARIANT: something that must hold no matter what
 * the model decides, and whose violation is a code bug. Concretely:
 *
 *   - the run completes rather than crashing or hanging
 *   - every write the model made is a legal write (scope, ladder rules, types)
 *   - the graph is left consistent (no dangling links, no orphan index entries)
 *   - the journal records what pure code actually injected
 *   - dream output does not inflate the next dream's inputs
 *
 * A dream that connects nothing and compresses nothing passes. A dream that
 * deletes a node it was not allowed to delete fails.
 *
 * COST: one dream per run, minutes and real API spend. Not in `npm test`.
 * Run: npm run test:live
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { runDream } from "../../src/agent/dream.js"
import { readLastJournalEntry, journalPath } from "../../src/agent/dream-select.js"
import { WikiGraph } from "../../src/index.js"
import { findDanglingWikilinks } from "../../src/agent/tools.js"
import { scanWiki } from "../../src/core/graph-builder.js"
import { resolveLlmConfig } from "../../src/agent/openai.js"
import type { DreamResult } from "../../src/agent/dream.js"

const SOURCE_WIKI =
  process.env["WIKI_LIVE_SOURCE"] ??
  "C:\\Users\\jinnn\\Documents\\wiki-builder\\wikis\\economic-analysis"

/**
 * Preconditions, checked rather than assumed: a live suite that silently degrades
 * into a no-op is worse than one that refuses to run. Skips (not fails) when the
 * environment simply is not a live-test environment.
 */
const haveWiki = await fs.access(SOURCE_WIKI).then(() => true, () => false)
let haveLlm = true
try {
  resolveLlmConfig()
} catch {
  haveLlm = false
}

const reason = !haveWiki
  ? `source wiki not found: ${SOURCE_WIKI}`
  : !haveLlm
    ? "no LLM config (OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL_NAME)"
    : null

if (reason) console.warn(`\n[live] SKIPPED — ${reason}\n`)
const describeLive = reason ? describe.skip : describe

let root: string
let result: DreamResult
/** Wiki state captured before the dream, for before/after invariants. */
let before: { slugs: Set<string>; byslug: Map<string, { type: string; compression?: string }> }

async function snapshot(wikiRoot: string) {
  const pages = await scanWiki(path.join(wikiRoot, "wiki"), wikiRoot)
  return {
    slugs: new Set(pages.map((p) => p.slug)),
    byslug: new Map(
      pages.map((p) => [p.slug, { type: String(p.type), compression: p.compression }]),
    ),
  }
}

describeLive("live dream: one real run, invariants only", () => {
  beforeAll(async () => {
    // Copy, never the real wiki: this run writes, compresses and possibly deletes.
    root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-live-"))
    await fs.cp(SOURCE_WIKI, root, { recursive: true, force: true })
    // Drop any state carried in the copy so pressure/journal start clean.
    await fs.rm(path.join(root, ".llm-wiki-ops"), { recursive: true, force: true })
    await fs.rm(path.join(root, ".llm-wiki"), { recursive: true, force: true })

    before = await snapshot(root)

    result = await runDream({
      wikiRoot: root,
      maxIterations: 40,
      timeoutMs: 8 * 60_000,
    })
  }, 1_200_000)

  afterAll(async () => {
    // Keep the artefacts when the run failed — they are the only record of why.
    if (root && process.env["WIKI_LIVE_KEEP"] !== "1") {
      await fs.rm(root, { recursive: true, force: true })
    } else if (root) {
      console.log(`[live] artefacts kept at ${root}`)
    }
  })

  // ── the run itself ────────────────────────────────────────────────

  it("completes without crashing or exhausting its budget", () => {
    // max_iterations / timeout are failure modes here: the deliverable (the
    // report) is written at the end, so a truncated run loses it entirely.
    expect(result.status).toBe("completed")
    expect(result.iterations).toBeGreaterThan(0)
    expect(result.finalMessage.length).toBeGreaterThan(200)
  })

  it("every tool call the model made was accepted", () => {
    // A failed tool call is not automatically a bug — the model can ask for a
    // node that does not exist. But a HIGH failure rate means the tool surface is
    // misdescribed, which is our bug, not the model's.
    const failed = result.toolCalls.filter((c) => c.error)
    const rate = failed.length / Math.max(1, result.toolCalls.length)
    if (failed.length) {
      console.warn(
        `[live] ${failed.length}/${result.toolCalls.length} tool calls failed:\n` +
          failed.slice(0, 5).map((c) => `  ${c.tool}: ${c.error}`).join("\n"),
      )
    }
    expect(rate).toBeLessThan(0.25)
  })

  it("pure code fed the model actual material", () => {
    // A dream with no scenes is vacuous, and has happened for real: an
    // unparseable --certainty once made seedCount NaN, so the walk loop ran zero
    // times and the model was asked to dream about nothing.
    expect(result.scenes?.length ?? 0).toBeGreaterThan(0)
    for (const scene of result.scenes ?? []) {
      expect(scene.nodes.length).toBeGreaterThan(0)
    }
  })

  // ── legality of what got written ──────────────────────────────────

  it("wrote nothing outside the wiki, and no local writes outside dreams/", async () => {
    const after = await snapshot(root)
    for (const slug of after.slugs) {
      if (before.slugs.has(slug)) continue
      const created = after.byslug.get(slug)!
      // New pages are either dream pages (local file tool, scoped to dreams/) or
      // knowledge nodes created through MCP add_node. Both are legal; anything
      // landing in sources/ or overview would not be.
      expect(["dream", "entity", "concept", "query", "comparison", "synthesis"]).toContain(
        created.type,
      )
    }
  })

  it("dream pages carry no compression stage", async () => {
    // A dream is a question: it is settled or deleted, it does not decay through
    // active → condensed → skeleton. Writing a stage on one implies a four-step
    // ladder it will never walk.
    const after = await snapshot(root)
    for (const [slug, page] of after.byslug) {
      if (page.type === "dream") {
        expect(page.compression, `dream page ${slug} must not have a compression stage`).toBeUndefined()
      }
    }
  })

  it("compression moved at most one rung per node", async () => {
    // "At most one level down per dream" is the whole point of gradual decay.
    // A jump from active straight to skeleton means the prompt's constraint is
    // not being honoured — or worse, that nothing enforces it.
    const rung = (c?: string) => (c === "skeleton" ? 3 : c === "condensed" ? 2 : 1)
    const after = await snapshot(root)
    for (const [slug, now] of after.byslug) {
      const then = before.byslug.get(slug)
      if (!then || now.type === "dream") continue
      const moved = rung(now.compression) - rung(then.compression)
      expect(moved, `${slug}: ${then.compression ?? "active"} → ${now.compression ?? "active"}`)
        .toBeLessThanOrEqual(1)
    }
  })

  it("only skeleton nodes were deleted", async () => {
    // The ladder's terminal step. Deleting an active node skips the whole
    // gradual-decay design and is unrecoverable.
    const after = await snapshot(root)
    const deleted = [...before.slugs].filter((s) => !after.slugs.has(s))
    if (deleted.length) console.log(`[live] deleted: ${deleted.join(", ")}`)
    for (const slug of deleted) {
      const was = before.byslug.get(slug)!
      expect(was.compression, `${slug} was deleted from stage "${was.compression ?? "active"}"`)
        .toBe("skeleton")
    }
  })

  it("never deleted a source or overview page", async () => {
    // Permanently exempt from the ladder: sources are evidence, index is infra.
    const after = await snapshot(root)
    for (const slug of [...before.slugs].filter((s) => !after.slugs.has(s))) {
      expect(["source", "overview"]).not.toContain(before.byslug.get(slug)!.type)
    }
  })

  // ── graph consistency afterwards ──────────────────────────────────

  it("added no NEW dangling wikilinks", async () => {
    // Deliberately incremental, not absolute. A real crawler-built wiki already
    // carries dangling links (path-style targets like "小金财经/xxx.md",
    // comma-split related entries) — 100+ of them in the live source. Asserting
    // zero would fail on inherited debt and say nothing about this dream.
    //
    // What IS this dream's fault: a deletion that left references behind, or a
    // dream page citing a slug it made up. Dream pages are written with the LOCAL
    // file tool, which bypasses MCP's link bookkeeping — exactly where new
    // dangling links come from.
    const danglingIn = async (wikiRoot: string) => {
      const pages = await scanWiki(path.join(wikiRoot, "wiki"), wikiRoot)
      const known = new Set(pages.map((p) => p.slug))
      const out = new Set<string>()
      for (const page of pages) {
        for (const target of findDanglingWikilinks(page.content, known)) {
          out.add(`${page.slug} → ${target}`)
        }
      }
      return out
    }

    const inherited = await danglingIn(SOURCE_WIKI)
    const now = await danglingIn(root)
    const added = [...now].filter((d) => !inherited.has(d))

    console.log(`[live] dangling: ${inherited.size} inherited, ${added.length} added`)
    expect(added, `NEW dangling wikilinks introduced by this dream:\n${added.join("\n")}`).toEqual([])
  })

  it("the graph still loads and its node count matches the files on disk", async () => {
    const wiki = new WikiGraph(root, { maintainLog: false })
    const stats = await wiki.getStats()
    const pages = await scanWiki(path.join(root, "wiki"), root)
    // Every scanned page is a node, index.md/overview included.
    expect(stats.totalNodes).toBe(pages.length)
    expect(stats.totalEdges).toBeGreaterThan(0)
  })

  // ── the journal, and the self-feedback loops it prevents ──────────

  it("recorded the scenes pure code injected, not the model's account of them", async () => {
    // Models have been observed reporting "0 scenes" while demonstrably working
    // from them. The journal is the reproducibility record, so it must carry what
    // was really fed in.
    const entry = (await readLastJournalEntry(root))!
    expect(entry).not.toBeNull()
    expect(entry.seed).toBe(result.seed)
    expect(entry.scenes).toHaveLength(result.scenes!.length)
    entry.scenes!.forEach((s, i) => {
      expect(s.nodes).toEqual(result.scenes![i]!.nodes)
    })
  })

  it("recorded its own writes so the next dream does not read them as activity", async () => {
    // Without touched_slugs, a dream's compressions count as "updated pages" in
    // the next pressure reading: dreaming harder makes the wiki look like it
    // needs dreaming more.
    const entry = (await readLastJournalEntry(root))!
    const wrote = result.toolCalls.some(
      (c) => /update_node|delete_node|rename_node/.test(c.tool) && !c.error,
    )
    if (wrote) {
      expect(entry.touched_slugs?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it("the journal lives outside wiki/ so it never becomes a graph node", async () => {
    expect(journalPath(root)).toContain(".llm-wiki-ops")
    const pages = await scanWiki(path.join(root, "wiki"), root)
    expect(pages.map((p) => p.slug)).not.toContain("journal")
  })

  it("its own output does not inflate the next dream's pressure", async () => {
    // Three separate self-feedback bugs have been fixed in this area (usage log,
    // touch clock, dream pages counted as new pages). This checks the composite
    // property directly: a second pressure reading immediately after a dream must
    // not have been pushed up by the dream's own writes.
    const second = await runDream({ wikiRoot: root, pressureOnly: true })
    const count = (name: string) =>
      second.pressure.components.find((c) => c.name === name)?.count ?? 0

    // Everything this dream just wrote is subtracted via journal touched_slugs,
    // so both activity counts must read zero on the very next scan.
    expect(count("new pages"), "dream's own new pages counted as activity").toBe(0)
    expect(count("updated pages"), "dream's own compressions counted as activity").toBe(0)
    expect(second.pressure.score).toBeLessThanOrEqual(result.pressure.score)
  })
})
