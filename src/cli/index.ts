#!/usr/bin/env node
/**
 * llm-wiki-ops CLI — llm-wiki-ops
 *
 * Design doc: §11.2
 *
 * Commands: stats, read, get-node, get-edges, add-node, update-node,
 *           rename-node, delete-node, add-edge, remove-edge, rebuild-index
 *
 * Global options: --json, --no-index, --wiki <path>
 * Wiki root resolution: --wiki > WIKI_ROOT env
 * --content supports: "text" | - (stdin) | @file
 */

import { Command } from "commander"
import * as fs from "node:fs/promises"
import { WikiGraph } from "../index.js"
import { WikiGraphError } from "../utils/errors.js"

const program = new Command()

program
  .name("llm-wiki-ops")
  .description("Graph-level operations for llm-wiki knowledge bases")
  .version("0.1.0")
  .option("--json", "machine-readable JSON output")
  .option("--no-index", "skip index.md maintenance")
  .option("--wiki <path>", "wiki root directory (default: $WIKI_ROOT)")

// ── Helpers ─────────────────────────────────────────────────────────

/** Resolve wiki root: --wiki global > WIKI_ROOT env > error. */
function resolveWikiRoot(): string {
  const root = program.opts().wiki ?? process.env.WIKI_ROOT
  if (!root) {
    console.error(
      "Error: no wiki root specified.\n" +
      "  Use --wiki <path> or set the WIKI_ROOT environment variable.",
    )
    process.exit(1)
  }
  return root
}

/**
 * Boilerplate wrapper: resolve wiki root → validate → cleanup → run fn → handle errors.
 * Eliminates the repeated 5-line preamble in every command.
 */
async function withWiki(fn: (wiki: WikiGraph) => Promise<unknown>): Promise<void> {
  const wikiRoot = resolveWikiRoot()
  const wiki = new WikiGraph(wikiRoot, { maintainIndex: program.opts().index !== false })
  await wiki.validate()
  await wiki.cleanup()
  try {
    const result = await fn(wiki)
    output(result, jsonFlag())
  } catch (e) {
    handleError(e, jsonFlag())
  }
}

function output(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(formatHuman(data))
  }
}

function formatHuman(data: unknown, indent = 0): string {
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

function handleError(e: unknown, json: boolean): never {
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

/** Read --content value: "text" | - (stdin) | @file */
async function resolveContent(value: string | undefined): Promise<string | undefined> {
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

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value.split(",").map((s) => s.trim()).filter(Boolean)
}

/** parseInt with NaN guard — throws a clean error instead of passing NaN downstream. */
function safeInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const n = parseInt(value, 10)
  if (Number.isNaN(n)) {
    console.error(`Error: ${flag} expects an integer, got "${value}"`)
    process.exit(1)
  }
  return n
}

/** Enum guard — validates a value against an allowlist. */
function safeEnum<T extends string>(value: string | undefined, flag: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value as T)) {
    console.error(`Error: ${flag} must be one of [${allowed.join(", ")}], got "${value}"`)
    process.exit(1)
  }
  return value as T
}

// ── Commands ────────────────────────────────────────────────────────

const jsonFlag = () => !!program.opts().json

program
  .command("stats")
  .description("Lightweight wiki overview (<2KB)")
  .action(async () => {
    await withWiki((wiki) => wiki.getStats())
  })

program
  .command("read")
  .description("Query a subgraph with filters")
  .option("--type <type>", "filter by page type")
  .option("--tag <tag>", "filter by tag")
  .option("--query <query>", "substring search on title/slug")
  .option("--center <slug>", "BFS center node")
  .option("-k, --depth <n>", "BFS depth (default 1, max 5)")
  .option("--limit <n>", "max nodes (default 200, max 500)")
  .action(async (opts: Record<string, unknown>) => {
    await withWiki((wiki) =>
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

program
  .command("get-node <slug>")
  .description("Get a single page's full detail")
  .action(async (slug: string) => {
    await withWiki(async (wiki) => {
      const page = await wiki.getNode(slug)
      if (!page) {
        throw new WikiGraphError("NODE_NOT_FOUND", `Node "${slug}" not found`, { slug })
      }
      return page
    })
  })

program
  .command("get-edges <slug>")
  .description("Get inbound + outbound edges for a node")
  .option("-k, --depth <n>", "BFS depth (default 1)")
  .option("--limit <n>", "max edges (default 100)")
  .action(async (slug: string, opts: Record<string, unknown>) => {
    await withWiki((wiki) =>
      wiki.getEdges(slug, {
        k: safeInt(opts.depth as string | undefined, "--depth"),
        limit: safeInt(opts.limit as string | undefined, "--limit"),
      }),
    )
  })

program
  .command("add-node")
  .description("Create a new wiki page")
  .requiredOption("--title <title>", "page title")
  .option("--type <type>", "page type (default: synthesis)")
  .option("--content <content>", "page body (text | - for stdin | @file)")
  .option("--tags <tags>", "comma-separated tags")
  .option("--related <related>", "comma-separated related slugs")
  .option("--sources <sources>", "comma-separated source URLs")
  .option("--on-slug-conflict <mode>", "append | error (default: append)")
  .option("--dry-run", "preview without writing")
  .action(async (opts: Record<string, unknown>) => {
    const content = await resolveContent(opts.content as string | undefined)
    await withWiki((wiki) =>
      wiki.addNode({
        title: opts.title as string,
        type: opts.type as string | undefined,
        content,
        tags: parseList(opts.tags as string | undefined),
        related: parseList(opts.related as string | undefined),
        sources: parseList(opts.sources as string | undefined),
        onSlugConflict: safeEnum(opts.onSlugConflict as string | undefined, "--on-slug-conflict", ["append", "error"] as const) ?? "append",
        dryRun: !!opts.dryRun,
      }),
    )
  })

program
  .command("update-node <slug>")
  .description("Update a page's attributes")
  .option("--title <title>", "new title")
  .option("--type <type>", "new type (triggers directory move)")
  .option("--content <content>", "new body (text | - for stdin | @file)")
  .option("--tags <tags>", "comma-separated tags (replaces)")
  .option("--related <related>", "comma-separated related slugs (replaces)")
  .option("--sources <sources>", "comma-separated sources (replaces)")
  .option("--dry-run", "preview without writing")
  .action(async (slug: string, opts: Record<string, unknown>) => {
    const content = await resolveContent(opts.content as string | undefined)
    await withWiki((wiki) =>
      wiki.updateNode(slug, {
        title: opts.title as string | undefined,
        type: opts.type as string | undefined,
        content,
        tags: parseList(opts.tags as string | undefined),
        related: parseList(opts.related as string | undefined),
        sources: parseList(opts.sources as string | undefined),
        dryRun: !!opts.dryRun,
      }),
    )
  })

program
  .command("rename-node <oldSlug> <newSlug>")
  .description("Rename a page and cascade-update all references")
  .option("--dry-run", "preview without writing")
  .action(async (oldSlug: string, newSlug: string, opts: Record<string, unknown>) => {
    await withWiki((wiki) =>
      wiki.renameNode(oldSlug, newSlug, { dryRun: !!opts.dryRun }),
    )
  })

program
  .command("delete-node <slug>")
  .description("Delete a page and clean all references")
  .option("--dangling-refs <mode>", "strikethrough | plain-text | remove (default: strikethrough)")
  .option("--dry-run", "preview without writing")
  .action(async (slug: string, opts: Record<string, unknown>) => {
    await withWiki((wiki) =>
      wiki.deleteNode(slug, {
        danglingRefs: safeEnum(opts.danglingRefs as string | undefined, "--dangling-refs", ["strikethrough", "plain-text", "remove"] as const) ?? "strikethrough",
        dryRun: !!opts.dryRun,
      }),
    )
  })

program
  .command("add-edge <source> <target>")
  .description("Ensure an edge exists in both carriers (idempotent)")
  .option("--context <heading>", "section heading for wikilink insertion")
  .option("--dry-run", "preview without writing")
  .action(async (source: string, target: string, opts: Record<string, unknown>) => {
    await withWiki((wiki) =>
      wiki.addEdge(source, target, {
        context: opts.context as string | undefined,
        dryRun: !!opts.dryRun,
      }),
    )
  })

program
  .command("remove-edge <source> <target>")
  .description("Remove an edge from both carriers (idempotent)")
  .option("--dry-run", "preview without writing")
  .action(async (source: string, target: string, opts: Record<string, unknown>) => {
    await withWiki((wiki) =>
      wiki.removeEdge(source, target, { dryRun: !!opts.dryRun }),
    )
  })

program
  .command("rebuild-index")
  .description("Full rebuild of index.md (preserves custom sections)")
  .action(async () => {
    await withWiki((wiki) => wiki.rebuildIndex())
  })

program
  .command("metrics")
  .description("Compute graph metrics: topology, source overlap, type edges, type balance")
  .action(async () => {
    await withWiki((wiki) => wiki.getMetrics())
  })

program.parse()
