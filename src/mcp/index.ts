#!/usr/bin/env node
/**
 * wiki-graph-mcp — MCP server for llm-wiki-ops.
 *
 * Design doc: §11.3, §11.4
 *
 * Single instance + default wiki + optional per-tool override.
 * 11 tools exposed. cleanup() called once at server.init().
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { WikiGraph } from "../index.js"
import { WikiGraphError } from "../utils/errors.js"

// ── Configuration ───────────────────────────────────────────────────

const args = process.argv.slice(2)
let defaultWikiRoot: string | undefined

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--wiki" && args[i + 1]) {
    defaultWikiRoot = args[i + 1]
    i++
  }
}

if (!defaultWikiRoot) {
  defaultWikiRoot = process.env.WIKI_ROOT
}

if (!defaultWikiRoot) {
  console.error("Usage: wiki-graph-mcp --wiki <path>")
  console.error("  or set WIKI_ROOT environment variable")
  process.exit(1)
}

// ── Wiki instance cache (per wiki_root override) ────────────────────

const wikiCache = new Map<string, WikiGraph>()

function getWiki(wikiRoot?: string): WikiGraph {
  const root = wikiRoot ?? defaultWikiRoot!
  if (!wikiCache.has(root)) {
    wikiCache.set(root, new WikiGraph(root))
  }
  return wikiCache.get(root)!
}

// ── Server setup ────────────────────────────────────────────────────

const server = new Server(
  { name: "llm-wiki-ops", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

// ── Tool definitions ────────────────────────────────────────────────

const wikiRootProp = {
  type: "string" as const,
  description: "Wiki root directory. Omit to use the default (--wiki / WIKI_ROOT).",
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_stats",
      description:
        "Returns a lightweight overview of the wiki: total counts, per-type breakdown, top tags, highest-degree nodes. Guaranteed <2KB. Call this FIRST when connecting to an unknown wiki — never start with an unfiltered read_graph.",
      inputSchema: {
        type: "object",
        properties: { wiki_root: wikiRootProp },
        additionalProperties: false,
      },
    },
    {
      name: "read_graph",
      description:
        "Query a subgraph with mandatory filters. Returns { nodes, edges }.\nUSE WHEN: exploring a topic area, finding candidates for bulk operations.\nDO NOT USE for: (a) initial discovery — call get_stats first; (b) single node — use get_node; (c) one node's neighbors — use get_edges.\nHARD LIMIT: refuses >500 nodes. If exceeded, errors with code=RESULT_TOO_LARGE and structured suggestions. Narrow via type/tag/query, or set center with small k. Never retry blindly.\nWhen center is set: BFS k hops from that slug; other filters apply within the neighborhood. Without center, k is ignored.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter by page type" },
          tag: { type: "string", description: "Filter by tag" },
          query: { type: "string", description: "Substring search on title/slug" },
          center: { type: "string", description: "BFS center slug" },
          k: { type: "number", description: "BFS depth (default 1, max 5)" },
          limit: { type: "number", description: "Max nodes (default 200, max 500)" },
          wiki_root: wikiRootProp,
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_node",
      description: "Get a single page's full detail including content body.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Page slug" },
          wiki_root: wikiRootProp,
        },
        required: ["slug"],
        additionalProperties: false,
      },
    },
    {
      name: "get_edges",
      description: "Get inbound + outbound edges for a node. k=1 returns { inbound, outbound }; k>1 returns flat edges with depth.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Page slug" },
          k: { type: "number", description: "BFS depth (default 1, max 5)" },
          limit: { type: "number", description: "Max edges (default 100, max 500)" },
          wiki_root: wikiRootProp,
        },
        required: ["slug"],
        additionalProperties: false,
      },
    },
    {
      name: "add_node",
      description:
        "Create a wiki page. Slug is derived from title (lowercase, spaces→hyphens, CJK preserved). If slug collides, appends -2/-3 and returns slug_collided=true — caller MUST inspect this before wiring edges. Content wikilinks are auto-synced into related[]. Type defaults to 'synthesis' if omitted.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Page title" },
          type: { type: "string", description: "Page type (entity, concept, source, etc.). Default: synthesis" },
          content: { type: "string", description: "Page body (markdown)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
          related: { type: "array", items: { type: "string" }, description: "Related slugs" },
          sources: { type: "array", items: { type: "string" }, description: "Source URLs or paths" },
          on_slug_conflict: { type: "string", enum: ["append", "error"], description: "Default: append" },
          dry_run: { type: "boolean", description: "Preview without writing" },
          wiki_root: wikiRootProp,
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    {
      name: "update_node",
      description: "Update a page's attributes. Changing type triggers a directory move.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          type: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          related: { type: "array", items: { type: "string" } },
          sources: { type: "array", items: { type: "string" }, description: "Source URLs or paths (replaces)" },
          dry_run: { type: "boolean" },
          wiki_root: wikiRootProp,
        },
        required: ["slug"],
        additionalProperties: false,
      },
    },
    {
      name: "rename_node",
      description:
        "Rename a page's slug. Updates: filename, all [[wikilink]] references, all related[] entries, index.md. Atomic (best-effort rollback on failure). Returns referencesUpdated count.",
      inputSchema: {
        type: "object",
        properties: {
          old_slug: { type: "string" },
          new_slug: { type: "string" },
          dry_run: { type: "boolean" },
          wiki_root: wikiRootProp,
        },
        required: ["old_slug", "new_slug"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_node",
      description:
        "Delete a page and clean all references across the wiki. Dangling [[wikilinks]] in other pages are replaced per dangling_refs mode (default: ~~strikethrough~~). Returns filesTouched and referencesCleaned.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          dangling_refs: { type: "string", enum: ["strikethrough", "plain-text", "remove"] },
          dry_run: { type: "boolean" },
          wiki_root: wikiRootProp,
        },
        required: ["slug"],
        additionalProperties: false,
      },
    },
    {
      name: "add_edge",
      description:
        "Ensure an edge from source to target exists in BOTH carriers (inline [[wikilink]] and frontmatter related). IDEMPOTENT: if both already present, succeeds with created=false. If only one carrier exists, fills the missing one (created=true). Inspect created and origins_after to know what happened.\nEdge insertion point: uses context param if given, else appends to \"## 相关\" section, else creates one at file end.\nERRORS: throws NODE_NOT_FOUND if source or target slug does not exist. Self-loops (source=target) are allowed.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source slug" },
          target: { type: "string", description: "Target slug" },
          context: { type: "string", description: "Section heading for wikilink insertion" },
          dry_run: { type: "boolean" },
          wiki_root: wikiRootProp,
        },
        required: ["source", "target"],
        additionalProperties: false,
      },
    },
    {
      name: "remove_edge",
      description:
        "Remove an edge from source to target in BOTH carriers. IDEMPOTENT: if edge doesn't exist at all, succeeds with removed=false. Partial existence (only wikilink or only related) is cleaned fully.\nERRORS: throws NODE_NOT_FOUND if source or target slug does not exist.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          dry_run: { type: "boolean" },
          wiki_root: wikiRootProp,
        },
        required: ["source", "target"],
        additionalProperties: false,
      },
    },
    {
      name: "rebuild_index",
      description: "Full rebuild of index.md. Preserves custom (non-type) sections.",
      inputSchema: {
        type: "object",
        properties: { wiki_root: wikiRootProp },
        additionalProperties: false,
      },
    },
    {
      name: "metrics",
      description:
        "Compute graph health metrics: topology (degree distribution, hubs, connected components, fragmentation), source overlap (near-duplicate detection), cross-type edge matrix, and type balance. Read-only full scan. Use after get_stats to diagnose structural problems before bulk operations.",
      inputSchema: {
        type: "object",
        properties: { wiki_root: wikiRootProp },
        additionalProperties: false,
      },
    },
  ],
}))

// ── Tool handler ────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const wikiRoot = args?.wiki_root as string | undefined

  try {
    const wiki = getWiki(wikiRoot)
    let result: unknown

    switch (name) {
      case "get_stats":
        result = await wiki.getStats()
        break

      case "read_graph":
        result = await wiki.readGraph({
          type: args?.type as string | undefined,
          tag: args?.tag as string | undefined,
          query: args?.query as string | undefined,
          center: args?.center as string | undefined,
          k: args?.k as number | undefined,
          limit: args?.limit as number | undefined,
        })
        break

      case "get_node": {
        const page = await wiki.getNode(args!.slug as string)
        if (!page) {
          return { content: [{ type: "text", text: `Node "${args!.slug}" not found` }], isError: true }
        }
        result = page
        break
      }

      case "get_edges":
        result = await wiki.getEdges(args!.slug as string, {
          k: args?.k as number | undefined,
          limit: args?.limit as number | undefined,
        })
        break

      case "add_node":
        result = await wiki.addNode({
          title: args!.title as string,
          type: args?.type as string | undefined,
          content: args?.content as string | undefined,
          tags: args?.tags as string[] | undefined,
          related: args?.related as string[] | undefined,
          sources: args?.sources as string[] | undefined,
          onSlugConflict: (args?.on_slug_conflict as "append" | "error") ?? "append",
          dryRun: args?.dry_run as boolean | undefined,
        })
        break

      case "update_node":
        result = await wiki.updateNode(args!.slug as string, {
          title: args?.title as string | undefined,
          type: args?.type as string | undefined,
          content: args?.content as string | undefined,
          tags: args?.tags as string[] | undefined,
          related: args?.related as string[] | undefined,
          sources: args?.sources as string[] | undefined,
          dryRun: args?.dry_run as boolean | undefined,
        })
        break

      case "rename_node":
        result = await wiki.renameNode(
          args!.old_slug as string,
          args!.new_slug as string,
          { dryRun: args?.dry_run as boolean | undefined },
        )
        break

      case "delete_node":
        result = await wiki.deleteNode(args!.slug as string, {
          danglingRefs: (args?.dangling_refs as "strikethrough" | "plain-text" | "remove") ?? "strikethrough",
          dryRun: args?.dry_run as boolean | undefined,
        })
        break

      case "add_edge":
        result = await wiki.addEdge(args!.source as string, args!.target as string, {
          context: args?.context as string | undefined,
          dryRun: args?.dry_run as boolean | undefined,
        })
        break

      case "remove_edge":
        result = await wiki.removeEdge(args!.source as string, args!.target as string, {
          dryRun: args?.dry_run as boolean | undefined,
        })
        break

      case "rebuild_index":
        result = await wiki.rebuildIndex()
        break

      case "metrics":
        result = await wiki.getMetrics()
        break

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    }
  } catch (e) {
    if (e instanceof WikiGraphError) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: e.code,
            message: e.message,
            slug: e.slug,
            targetSlug: e.targetSlug,
            detail: e.detail,
            ...(e.code === "RESULT_TOO_LARGE" ? {
              matchedCount: (e as any).matchedCount,
              suggestions: (e as any).suggestions,
            } : {}),
          }, null, 2),
        }],
        isError: true,
      }
    }
    return {
      content: [{ type: "text", text: `Internal error: ${(e as Error).message}` }],
      isError: true,
    }
  }
})

// ── Startup ─────────────────────────────────────────────────────────

async function main() {
  // MCP server.init(): validate + auto cleanup once (§16 decision)
  const wiki = getWiki()
  await wiki.validate()
  await wiki.cleanup()

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[wiki-graph-mcp] ready (default wiki: ${defaultWikiRoot})`)
}

main().catch((e) => {
  console.error(`[wiki-graph-mcp] fatal: ${e.message}`)
  process.exit(1)
})
