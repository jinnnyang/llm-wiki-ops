#!/usr/bin/env node
/**
 * wiki-graph-ops CLI — wiki-graph
 *
 * Design doc: §11.2
 *
 * Commands: stats, read, get-node, get-edges, add-node, update-node,
 *           rename-node, delete-node, add-edge, remove-edge, rebuild-index
 *
 * Global options: --json, --no-index
 * --content supports: "text" | - (stdin) | @file
 */

import { Command } from "commander"
import * as fs from "node:fs/promises"
import { WikiGraph } from "../index.js"
import { WikiGraphError } from "../utils/errors.js"

const program = new Command()

program
  .name("wiki-graph")
  .description("Graph-level operations for llm-wiki knowledge bases")
  .version("0.1.0")
  .option("--json", "machine-readable JSON output")
  .option("--no-index", "skip index.md maintenance")

// ── Helpers ─────────────────────────────────────────────────────────

function makeWiki(wikiRoot: string, opts: { index?: boolean }): WikiGraph {
  return new WikiGraph(wikiRoot, { maintainIndex: opts.index !== false })
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
    // Read from stdin
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
  .command("stats <wikiRoot>")
  .description("Lightweight wiki overview (<2KB)")
  .action(async (wikiRoot: string) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    const stats = await wiki.getStats()
    output(stats, jsonFlag())
  })

program
  .command("read <wikiRoot>")
  .description("Query a subgraph with filters")
  .option("--type <type>", "filter by page type")
  .option("--tag <tag>", "filter by tag")
  .option("--query <query>", "substring search on title/slug")
  .option("--center <slug>", "BFS center node")
  .option("-k, --k <n>", "BFS depth (default 1, max 5)")
  .option("--limit <n>", "max nodes (default 200, max 500)")
  .action(async (wikiRoot: string, opts: Record<string, unknown>) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    try {
      const graph = await wiki.readGraph({
        type: opts.type as string | undefined,
        tag: opts.tag as string | undefined,
        query: opts.query as string | undefined,
        center: opts.center as string | undefined,
        k: safeInt(opts.k as string | undefined, "--k"),
        limit: safeInt(opts.limit as string | undefined, "--limit"),
      })
      output(graph, jsonFlag())
    } catch (e) {
      handleError(e, jsonFlag())
    }
  })

program
  .command("get-node <wikiRoot> <slug>")
  .description("Get a single page's full detail")
  .action(async (wikiRoot: string, slug: string) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    const page = await wiki.getNode(slug)
    if (!page) {
      if (jsonFlag()) {
        console.error(JSON.stringify({ error: "NODE_NOT_FOUND", message: `Node "${slug}" not found` }))
      } else {
        console.error(`Node "${slug}" not found`)
      }
      process.exit(1)
    }
    output(page, jsonFlag())
  })

program
  .command("get-edges <wikiRoot> <slug>")
  .description("Get inbound + outbound edges for a node")
  .option("-k, --k <n>", "BFS depth (default 1)")
  .option("--limit <n>", "max edges (default 100)")
  .action(async (wikiRoot: string, slug: string, opts: Record<string, unknown>) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    try {
      const edges = await wiki.getEdges(slug, {
        k: safeInt(opts.k as string | undefined, "--k"),
        limit: safeInt(opts.limit as string | undefined, "--limit"),
      })
      output(edges, jsonFlag())
    } catch (e) {
      handleError(e, jsonFlag())
    }
  })

program
  .command("add-node <wikiRoot>")
  .description("Create a new wiki page")
  .requiredOption("--title <title>", "page title")
  .option("--type <type>", "page type (default: synthesis)")
  .option("--content <content>", "page body (text | - for stdin | @file)")
  .option("--tags <tags>", "comma-separated tags")
  .option("--related <related>", "comma-separated related slugs")
  .option("--sources <sources>", "comma-separated source URLs")
  .option("--on-slug-conflict <mode>", "append | error (default: append)")
  .option("--dry-run", "preview without writing")
  .action(async (wikiRoot: string, opts: Record<string, unknown>) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    const content = await resolveContent(opts.content as string | undefined)
    try {
      const result = await wiki.addNode({
        title: opts.title as string,
        type: opts.type as string | undefined,
        content,
        tags: parseList(opts.tags as string | undefined),
        related: parseList(opts.related as string | undefined),
        sources: parseList(opts.sources as string | undefined),
        onSlugConflict: safeEnum(opts.onSlugConflict as string | undefined, "--on-slug-conflict", ["append", "error"] as const) ?? "append",
        dryRun: !!opts.dryRun,
      })
      output(result, jsonFlag())
    } catch (e) {
      handleError(e, jsonFlag())
    }
  })

program
  .command("update-node <wikiRoot> <slug>")
  .description("Update a page's attributes")
  .option("--title <title>", "new title")
  .option("--type <type>", "new type (triggers directory move)")
  .option("--content <content>", "new body (text | - for stdin | @file)")
  .option("--tags <tags>", "comma-separated tags (replaces)")
  .option("--related <related>", "comma-separated related slugs (replaces)")
  .option("--sources <sources>", "comma-separated sources (replaces)")
  .option("--dry-run", "preview without writing")
  .action(async (wikiRoot: string, slug: string, opts: Record<string, unknown>) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    const content = await resolveContent(opts.content as string | undefined)
    try {
      const result = await wiki.updateNode(slug, {
        title: opts.title as string | undefined,
        type: opts.type as string | undefined,
        content,
        tags: parseList(opts.tags as string | undefined),
        related: parseList(opts.related as string | undefined),
        sources: parseList(opts.sources as string | undefined),
        dryRun: !!opts.dryRun,
      })
      output(result, jsonFlag())
    } catch (e) {
      handleError(e, jsonFlag())
    }
  })

program
  .command("rename-node <wikiRoot> <oldSlug> <newSlug>")
  .description("Rename a page and cascade-update all references")
  .option("--dry-run", "preview without writing")
  .action(async (wikiRoot: string, oldSlug: string, newSlug: string, opts: Record<string, unknown>) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    try {
      const result = await wiki.renameNode(oldSlug, newSlug, { dryRun: !!opts.dryRun })
      output(result, jsonFlag())
    } catch (e) {
      handleError(e, jsonFlag())
    }
  })

program
  .command("delete-node <wikiRoot> <slug>")
  .description("Delete a page and clean all references")
  .option("--dangling-refs <mode>", "strikethrough | plain-text | remove (default: strikethrough)")
  .option("--dry-run", "preview without writing")
  .action(async (wikiRoot: string, slug: string, opts: Record<string, unknown>) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    try {
      const result = await wiki.deleteNode(slug, {
        danglingRefs: safeEnum(opts.danglingRefs as string | undefined, "--dangling-refs", ["strikethrough", "plain-text", "remove"] as const) ?? "strikethrough",
        dryRun: !!opts.dryRun,
      })
      output(result, jsonFlag())
    } catch (e) {
      handleError(e, jsonFlag())
    }
  })

program
  .command("add-edge <wikiRoot> <source> <target>")
  .description("Ensure an edge exists in both carriers (idempotent)")
  .option("--context <heading>", "section heading for wikilink insertion")
  .option("--dry-run", "preview without writing")
  .action(async (wikiRoot: string, source: string, target: string, opts: Record<string, unknown>) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    try {
      const result = await wiki.addEdge(source, target, {
        context: opts.context as string | undefined,
        dryRun: !!opts.dryRun,
      })
      output(result, jsonFlag())
    } catch (e) {
      handleError(e, jsonFlag())
    }
  })

program
  .command("remove-edge <wikiRoot> <source> <target>")
  .description("Remove an edge from both carriers (idempotent)")
  .option("--dry-run", "preview without writing")
  .action(async (wikiRoot: string, source: string, target: string, opts: Record<string, unknown>) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    try {
      const result = await wiki.removeEdge(source, target, { dryRun: !!opts.dryRun })
      output(result, jsonFlag())
    } catch (e) {
      handleError(e, jsonFlag())
    }
  })

program
  .command("rebuild-index <wikiRoot>")
  .description("Full rebuild of index.md (preserves custom sections)")
  .action(async (wikiRoot: string) => {
    const wiki = makeWiki(wikiRoot, program.opts())
    await wiki.validate()
    await wiki.cleanup()
    const result = await wiki.rebuildIndex()
    output(result, jsonFlag())
  })

program.parse()
