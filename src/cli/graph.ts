/**
 * cli/graph.ts — `llm-wiki graph xxx` subcommands (existing 12 operations).
 *
 * Design doc: §5. Migrated from cli/index.ts flat commands.
 */

import { Command } from "commander"
import * as fs from "node:fs/promises"
import { WikiGraph } from "../index.js"
import { computeUsageStats } from "../core/usage.js"
import { WikiGraphError } from "../utils/errors.js"
import { resolveTarget } from "./wiki-resolve.js"

// ── Shared helpers (exported for reuse by agent commands) ────────────

export function output(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(formatHuman(data))
  }
}

export function formatHuman(data: unknown, indent = 0): string {
  if (data === null || data === undefined) return "null"
  if (typeof data !== "object") return String(data)
  if (Array.isArray(data)) {
    if (data.length === 0) return "[]"
    return data.map((item) => `${"  ".repeat(indent)}- ${formatHuman(item, indent + 1)}`).join("\n")
  }
  const entries = Object.entries(data as Record<string, unknown>)
  return entries
    .map(([k, v]) => {
      if (typeof v === "object" && v !== null) {
        return `${"  ".repeat(indent)}${k}:\n${formatHuman(v, indent + 1)}`
      }
      return `${"  ".repeat(indent)}${k}: ${v}`
    })
    .join("\n")
}

export function handleError(e: unknown, json: boolean): never {
  if (e instanceof WikiGraphError) {
    if (json) {
      console.error(JSON.stringify({ error: e.code, message: e.message, detail: e.detail ?? null }, null, 2))
    } else {
      console.error(`Error [${e.code}]: ${e.message}`)
      if (e.detail) console.error(`  detail: ${e.detail}`)
    }
    process.exit(1)
  }
  throw e
}

export async function resolveContent(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined
  if (value === "-") {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString("utf-8")
  }
  if (value.startsWith("@")) {
    return fs.readFile(value.slice(1), "utf-8")
  }
  return value
}

export function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value.split(",").map((s) => s.trim()).filter(Boolean)
}

export function safeInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const n = parseInt(value, 10)
  if (Number.isNaN(n)) {
    console.error(`Error: ${flag} expects an integer, got "${value}"`)
    process.exit(1)
  }
  return n
}

export function safeEnum<T extends string>(value: string | undefined, flag: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value as T)) {
    console.error(`Error: ${flag} must be one of [${allowed.join(", ")}], got "${value}"`)
    process.exit(1)
  }
  return value as T
}

/** Resolve wiki root: --wiki > SELECTED_WIKI > WIKIS_ROOT global. Write ops require single target. */
export function resolveWikiRoot(wikiOpt?: string, write = false): string {
  const target = resolveTarget(wikiOpt, write)
  if (target.mode === "global") {
    console.error(
      "Error: this operation requires a specific wiki target.\n" +
      "  Use --wiki <path> or set SELECTED_WIKI.",
    )
    process.exit(1)
  }
  return target.paths[0]
}

/** Boilerplate wrapper: resolve wiki → validate → cleanup → run fn → handle errors. */
export async function withWiki(
  wikiRoot: string,
  json: boolean,
  maintainIndex: boolean,
  fn: (wiki: WikiGraph) => Promise<unknown>,
): Promise<void> {
  const wiki = new WikiGraph(wikiRoot, { maintainIndex, actor: "cli" })
  await wiki.validate()
  await wiki.cleanup()
  try {
    const result = await fn(wiki)
    output(result, json)
  } catch (e) {
    handleError(e, json)
  } finally {
    // Buffered read events would otherwise die with the process (§4.4).
    await wiki.flushUsageLog()
  }
}

/**
 * Run a read operation across one or many wikis.
 * Global mode: iterates all valid wikis under WIKIS_ROOT, outputs per-wiki.
 */
export async function withWikiRead(
  wikiOpt: string | undefined,
  json: boolean,
  maintainIndex: boolean,
  fn: (wiki: WikiGraph) => Promise<unknown>,
): Promise<void> {
  const target = resolveTarget(wikiOpt, false)

  if (target.mode === "single") {
    await withWiki(target.paths[0], json, maintainIndex, fn)
    return
  }

  // Global mode: parallel across all wikis (read-only, skip cleanup)
  const settled = await Promise.allSettled(
    target.paths.map(async (wikiPath) => {
      const wiki = new WikiGraph(wikiPath, { maintainIndex, actor: "cli" })
      await wiki.validate()
      // Skip cleanup() — read-only, no writes to clean up
      const result = await fn(wiki)
      await wiki.flushUsageLog()
      return { wiki: wikiPath, result }
    }),
  )

  const results: Array<{ wiki: string; result?: unknown; error?: string }> = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { wiki: target.paths[i], error: (s.reason as Error).message },
  )

  if (json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    for (const r of results) {
      const label = r.wiki.split(/[\\/]/).pop() ?? r.wiki
      console.log(`\n── ${label} ──`)
      if (r.error) {
        console.log(`  Error: ${r.error}`)
      } else {
        console.log(formatHuman(r.result, 1))
      }
    }
  }
}

// ── Graph subcommand ─────────────────────────────────────────────────

export function createGraphCommand(): Command {
  const graph = new Command("graph")
    .description("Low-level graph operations (12 commands, no LLM)")

  graph
    .command("stats")
    .description("Lightweight wiki overview (<2KB)")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (opts: Record<string, unknown>) => {
      await withWikiRead(opts.wiki as string | undefined, !!opts.json, true, (wiki) => wiki.getStats())
    })

  graph
    .command("read")
    .description("Query a subgraph with filters")
    .option("--type <type>", "filter by page type")
    .option("--tag <tag>", "filter by tag")
    .option("--query <query>", "substring search on title/slug")
    .option("--center <slug>", "BFS center node")
    .option("-k, --depth <n>", "BFS depth (default 1, max 5)")
    .option("--limit <n>", "max nodes (default 200, max 500)")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (opts: Record<string, unknown>) => {
      await withWikiRead(opts.wiki as string | undefined, !!opts.json, true, (wiki) =>
        wiki.readGraph({
          type: opts.type as string | undefined,
          tag: opts.tag as string | undefined,
          query: opts.query as string | undefined,
          center: opts.center as string | undefined,
          k: safeInt(opts.depth as string | undefined, "--depth"),
          limit: safeInt(opts.limit as string | undefined, "--limit"),
        }),
      )
    })

  graph
    .command("get-node <slug>")
    .description("Get a single page's full detail")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (slug: string, opts: Record<string, unknown>) => {
      await withWikiRead(opts.wiki as string | undefined, !!opts.json, true, async (wiki) => {
        const page = await wiki.getNode(slug)
        if (!page) {
          throw new WikiGraphError("NODE_NOT_FOUND", `Node "${slug}" not found`, { slug })
        }
        return page
      })
    })

  graph
    .command("get-edges <slug>")
    .description("Get inbound + outbound edges for a node")
    .option("-k, --depth <n>", "BFS depth (default 1)")
    .option("--limit <n>", "max edges (default 100)")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (slug: string, opts: Record<string, unknown>) => {
      await withWikiRead(opts.wiki as string | undefined, !!opts.json, true, (wiki) =>
        wiki.getEdges(slug, {
          k: safeInt(opts.depth as string | undefined, "--depth"),
          limit: safeInt(opts.limit as string | undefined, "--limit"),
        }),
      )
    })

  graph
    .command("add-node")
    .description("Create a new wiki page")
    .requiredOption("--title <title>", "page title")
    .option("--type <type>", "page type (default: synthesis)")
    .option("--content <content>", "page body (text | - for stdin | @file)")
    .option("--tags <tags>", "comma-separated tags")
    .option("--related <related>", "comma-separated related slugs")
    .option("--sources <sources>", "comma-separated source URLs")
    .option("--as-of <date>", "fact clock YYYY-MM-DD: when the described state held / event happened")
    .option("--on-slug-conflict <mode>", "append | error (default: append)")
    .option("--dry-run", "preview without writing")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (opts: Record<string, unknown>) => {
      const root = resolveWikiRoot(opts.wiki as string | undefined, true)
      const content = await resolveContent(opts.content as string | undefined)
      await withWiki(root, !!opts.json, true, (wiki) =>
        wiki.addNode({
          title: opts.title as string,
          type: opts.type as string | undefined,
          content,
          tags: parseList(opts.tags as string | undefined),
          related: parseList(opts.related as string | undefined),
          sources: parseList(opts.sources as string | undefined),
          as_of: opts.asOf as string | undefined,
          onSlugConflict: safeEnum(opts.onSlugConflict as string | undefined, "--on-slug-conflict", ["append", "error"] as const) ?? "append",
          dryRun: !!opts.dryRun,
        }),
      )
    })

  graph
    .command("update-node <slug>")
    .description("Update a page's attributes")
    .option("--title <title>", "new title")
    .option("--type <type>", "new type (triggers directory move)")
    .option("--content <content>", "new body (text | - for stdin | @file)")
    .option("--tags <tags>", "comma-separated tags (replaces)")
    .option("--related <related>", "comma-separated related slugs (replaces)")
    .option("--sources <sources>", "comma-separated sources (replaces)")
    .option("--as-of <date>", "fact clock YYYY-MM-DD (reset when facts change)")
    .option("--checked <date>", "verification clock YYYY-MM-DD (check agent)")
    .option("--dry-run", "preview without writing")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (slug: string, opts: Record<string, unknown>) => {
      const root = resolveWikiRoot(opts.wiki as string | undefined, true)
      const content = await resolveContent(opts.content as string | undefined)
      await withWiki(root, !!opts.json, true, (wiki) =>
        wiki.updateNode(slug, {
          title: opts.title as string | undefined,
          type: opts.type as string | undefined,
          content,
          tags: parseList(opts.tags as string | undefined),
          related: parseList(opts.related as string | undefined),
          sources: parseList(opts.sources as string | undefined),
          as_of: opts.asOf as string | undefined,
          checked: opts.checked as string | undefined,
          dryRun: !!opts.dryRun,
        }),
      )
    })

  graph
    .command("rename-node <oldSlug> <newSlug>")
    .description("Rename a page and cascade-update all references")
    .option("--dry-run", "preview without writing")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (oldSlug: string, newSlug: string, opts: Record<string, unknown>) => {
      const root = resolveWikiRoot(opts.wiki as string | undefined, true)
      await withWiki(root, !!opts.json, true, (wiki) =>
        wiki.renameNode(oldSlug, newSlug, { dryRun: !!opts.dryRun }),
      )
    })

  graph
    .command("delete-node <slug>")
    .description("Delete a page and clean all references")
    .option("--dangling-refs <mode>", "strikethrough | plain-text | remove (default: strikethrough)")
    .option("--dry-run", "preview without writing")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (slug: string, opts: Record<string, unknown>) => {
      const root = resolveWikiRoot(opts.wiki as string | undefined, true)
      await withWiki(root, !!opts.json, true, (wiki) =>
        wiki.deleteNode(slug, {
          danglingRefs: safeEnum(opts.danglingRefs as string | undefined, "--dangling-refs", ["strikethrough", "plain-text", "remove"] as const) ?? "strikethrough",
          dryRun: !!opts.dryRun,
        }),
      )
    })

  graph
    .command("add-edge <source> <target>")
    .description("Ensure an edge exists in both carriers (idempotent)")
    .option("--context <heading>", "section heading for wikilink insertion")
    .option("--relation <relation>", "edge type (recommended: is_a, instance_of, causes, contradicts, explains, superseded_by, related)")
    .option("--dry-run", "preview without writing")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (source: string, target: string, opts: Record<string, unknown>) => {
      const root = resolveWikiRoot(opts.wiki as string | undefined, true)
      await withWiki(root, !!opts.json, true, (wiki) =>
        wiki.addEdge(source, target, {
          context: opts.context as string | undefined,
          relation: opts.relation as string | undefined,
          dryRun: !!opts.dryRun,
        }),
      )
    })

  graph
    .command("remove-edge <source> <target>")
    .description("Remove an edge from both carriers (idempotent)")
    .option("--dry-run", "preview without writing")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (source: string, target: string, opts: Record<string, unknown>) => {
      const root = resolveWikiRoot(opts.wiki as string | undefined, true)
      await withWiki(root, !!opts.json, true, (wiki) =>
        wiki.removeEdge(source, target, { dryRun: !!opts.dryRun }),
      )
    })

  graph
    .command("rebuild-index")
    .description("Full rebuild of index.md (preserves custom sections)")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (opts: Record<string, unknown>) => {
      const root = resolveWikiRoot(opts.wiki as string | undefined, true)
      await withWiki(root, !!opts.json, true, (wiki) => wiki.rebuildIndex())
    })

  graph
    .command("metrics")
    .description("Compute graph metrics: topology, source overlap, type edges, type balance")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (opts: Record<string, unknown>) => {
      await withWikiRead(opts.wiki as string | undefined, !!opts.json, true, (wiki) => wiki.getMetrics())
    })

  graph
    .command("scan-freshness")
    .description("Pure-code exponential backoff scan: list nodes due for fact-checking (design doc §4.5)")
    .option("--today <date>", "override today (YYYY-MM-DD, default: current UTC date)")
    .option("--upcoming <days>", "also list nodes due within N days (lookahead window)")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (opts: Record<string, unknown>) => {
      await withWikiRead(opts.wiki as string | undefined, !!opts.json, true, (wiki) =>
        wiki.scanFreshness({
          today: opts.today as string | undefined,
          upcomingDays: safeInt(opts.upcoming as string | undefined, "--upcoming"),
        }),
      )
    })

  graph
    .command("usage")
    .description("Usage log statistics: per-node read/write counts, most/least used nodes")
    .option("--days <n>", "window size in days (default 30)")
    .option("--top <n>", "how many most-used nodes to show (default 64)")
    .option("--bottom <n>", "how many least-used nodes to show, including never-touched (default 64)")
    .option("--actor <name>", "only count events from this actor (ingest/research/check/reason/purge/dream/cli/mcp/lib)")
    .option("--json", "machine-readable JSON output")
    .option("--wiki <path>", "wiki root directory")
    .action(async (opts: Record<string, unknown>) => {
      await withWikiRead(opts.wiki as string | undefined, !!opts.json, true, async (wiki) => {
        // Full slug set so bottom-N can surface never-touched nodes (§4.5).
        // listSlugs, not readGraph: readGraph throws past 200 nodes.
        return computeUsageStats(wiki.wikiRoot, {
          days: safeInt(opts.days as string | undefined, "--days"),
          topN: safeInt(opts.top as string | undefined, "--top"),
          bottomN: safeInt(opts.bottom as string | undefined, "--bottom"),
          actor: opts.actor as string | undefined,
          allSlugs: await wiki.listSlugs(),
        })
      })
    })

  return graph
}
