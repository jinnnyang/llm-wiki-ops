/**
 * wiki-graph-ops — graph builder (read operations).
 *
 * Design doc: §6.2 (read ops), §5 (graph model), §6.7 (observability)
 *
 * Scans wiki/ recursively, builds Graph { nodes, edges }.
 * - Skips index.md, log.md (infra files)
 * - Skips *.tmp-* files
 * - Type inferred from directory when frontmatter is missing/broken
 * - Wikilink extraction skips code blocks
 */

import * as path from "node:path"
import { parseFrontmatter } from "../io/frontmatter.js"
import { extractWikilinks } from "../io/wikilink.js"
import { readFileClean, findMarkdownFiles } from "../io/fs-helpers.js"
import { normalizeSlug } from "../utils/slug.js"
import {
  type Graph,
  type GraphNode,
  type GraphEdge,
  type EdgeOrigin,
  type PageType,
  type WikiPage,
  type WikiStats,
  type ReadGraphOptions,
  type GetEdgesOptions,
  type GetEdgesResult,
  INFRA_FILES,
  DIR_TYPE_MAP,
  KNOWN_TYPE_ORDER,
} from "../types.js"
import { ResultTooLargeError, WikiGraphError } from "../utils/errors.js"

const READ_GRAPH_DEFAULT_LIMIT = 200
const READ_GRAPH_MAX_LIMIT = 500
const GET_EDGES_DEFAULT_LIMIT = 100
const GET_EDGES_MAX_LIMIT = 500
const MAX_K = 5

// ── Internal page record (full scan result) ─────────────────────────

interface ScannedPage {
  slug: string
  title: string
  type: PageType
  tags: string[]
  related: string[]
  sources: string[]
  created: string
  updated: string
  content: string
  path: string // relative to wikiRoot
  absPath: string
  wikilinkTargets: string[] // normalized slugs from content
}

// ── Full scan ───────────────────────────────────────────────────────

/**
 * Scan the wiki/ directory and return all pages.
 * This is the foundation for all read operations.
 */
export async function scanWiki(wikiDir: string, wikiRoot: string): Promise<ScannedPage[]> {
  const files = await findMarkdownFiles(wikiDir)
  const pages: ScannedPage[] = []

  for (const absPath of files) {
    const relPath = path.relative(wikiRoot, absPath).replace(/\\/g, "/")
    const fileName = path.basename(absPath, ".md")

    // Skip infrastructure files
    if (INFRA_FILES.has(path.basename(absPath))) continue

    const slug = normalizeSlug(fileName)
    const { content: rawContent } = await readFileClean(absPath)
    const { frontmatter, body } = parseFrontmatter(rawContent)

    // Infer type from directory when frontmatter is missing/broken
    const type = inferType(frontmatter?.type as string | undefined, relPath, fileName)

    const title = (frontmatter?.title as string) ?? fileName
    const tags = toStringArray(frontmatter?.tags)
    const related = toStringArray(frontmatter?.related).map((r) =>
      // Clean dirty data: related: ["[[a]]"] → "a"
      r.replace(/^\[\[/, "").replace(/\]\]$/, ""),
    )
    const sources = toStringArray(frontmatter?.sources)
    const created = (frontmatter?.created as string) ?? ""
    const updated = (frontmatter?.updated as string) ?? ""

    // Extract wikilinks from body (skips code blocks)
    const wikilinkTargets = [...new Set(extractWikilinks(body).map((t) => normalizeSlug(t)))]

    pages.push({
      slug,
      title,
      type,
      tags,
      related: related.map((r) => normalizeSlug(r)),
      sources,
      created,
      updated,
      content: body,
      path: relPath,
      absPath,
      wikilinkTargets,
    })
  }

  return pages
}

/**
 * Infer page type from frontmatter or directory.
 * Design doc: §13.1, §16 decision 25
 */
function inferType(fmType: string | undefined, relPath: string, fileName: string): PageType {
  if (fmType && typeof fmType === "string" && fmType.trim()) {
    return fmType.trim().toLowerCase()
  }

  // overview.md in wiki/ root
  if (fileName === "overview" && !relPath.includes("/")) {
    return "overview"
  }
  // Also handle wiki/overview.md (relPath = "wiki/overview.md")
  const parts = relPath.split("/")
  if (fileName === "overview" && parts.length <= 2) {
    return "overview"
  }

  // Infer from directory: wiki/entities/foo.md → entity
  const dir = parts.length > 2 ? parts[parts.length - 2] : ""
  return DIR_TYPE_MAP[dir] ?? "unknown"
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string")
  if (typeof v === "string") return v ? [v] : []
  return []
}

// ── Build graph ─────────────────────────────────────────────────────

export function buildGraphFromPages(pages: ScannedPage[]): Graph {
  const slugSet = new Set(pages.map((p) => p.slug))
  const edgeMap = new Map<string, GraphEdge>()

  for (const page of pages) {
    // Wikilink edges
    for (const target of page.wikilinkTargets) {
      if (!slugSet.has(target)) continue // dangling wikilink
      const key = `${page.slug}→${target}`
      const existing = edgeMap.get(key)
      if (existing) {
        if (!existing.origins.includes("wikilink")) existing.origins.push("wikilink")
      } else {
        edgeMap.set(key, { source: page.slug, target, origins: ["wikilink"] })
      }
    }

    // Related edges
    for (const target of page.related) {
      if (!slugSet.has(target)) continue // dangling related
      const key = `${page.slug}→${target}`
      const existing = edgeMap.get(key)
      if (existing) {
        if (!existing.origins.includes("related")) existing.origins.push("related")
      } else {
        edgeMap.set(key, { source: page.slug, target, origins: ["related"] })
      }
    }
  }

  return {
    nodes: pages.map((p) => ({
      slug: p.slug,
      title: p.title,
      type: p.type,
      tags: p.tags,
      related: p.related,
      sources: p.sources,
      created: p.created,
      updated: p.updated,
      path: p.path,
    })),
    edges: [...edgeMap.values()],
  }
}

// ── Public read operations ──────────────────────────────────────────

export async function readGraph(
  wikiDir: string,
  wikiRoot: string,
  options?: ReadGraphOptions,
): Promise<Graph> {
  const startTime = Date.now()
  const allPages = await scanWiki(wikiDir, wikiRoot)
  const fullGraph = buildGraphFromPages(allPages)

  const limit = Math.min(options?.limit ?? READ_GRAPH_DEFAULT_LIMIT, READ_GRAPH_MAX_LIMIT)
  const k = Math.min(options?.k ?? 1, MAX_K)

  let filteredNodes = fullGraph.nodes
  let filteredEdges = fullGraph.edges

  // Center + k: BFS neighborhood
  if (options?.center) {
    const centerNorm = normalizeSlug(options.center)
    const neighborSlugs = bfsNeighborhood(fullGraph, centerNorm, k)
    filteredNodes = filteredNodes.filter((n) => neighborSlugs.has(n.slug))
    filteredEdges = filteredEdges.filter(
      (e) => neighborSlugs.has(e.source) && neighborSlugs.has(e.target),
    )
  }

  // Type filter
  if (options?.type) {
    const t = options.type.toLowerCase()
    filteredNodes = filteredNodes.filter((n) => n.type === t)
    const nodeSlugs = new Set(filteredNodes.map((n) => n.slug))
    filteredEdges = filteredEdges.filter(
      (e) => nodeSlugs.has(e.source) && nodeSlugs.has(e.target),
    )
  }

  // Tag filter
  if (options?.tag) {
    const tag = options.tag.toLowerCase()
    filteredNodes = filteredNodes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag))
    const nodeSlugs = new Set(filteredNodes.map((n) => n.slug))
    filteredEdges = filteredEdges.filter(
      (e) => nodeSlugs.has(e.source) && nodeSlugs.has(e.target),
    )
  }

  // Query filter (substring, case-insensitive, on title + slug)
  if (options?.query) {
    const q = options.query.toLowerCase()
    filteredNodes = filteredNodes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q),
    )
    const nodeSlugs = new Set(filteredNodes.map((n) => n.slug))
    filteredEdges = filteredEdges.filter(
      (e) => nodeSlugs.has(e.source) && nodeSlugs.has(e.target),
    )
  }

  // Check limit
  if (filteredNodes.length > limit) {
    const suggestions = buildSuggestions(allPages, options)
    throw new ResultTooLargeError({
      matchedCount: filteredNodes.length,
      limitUsed: limit,
      maxLimit: READ_GRAPH_MAX_LIMIT,
      suggestions,
    })
  }

  // Observability (§6.7)
  const elapsed = Date.now() - startTime
  if (elapsed > 1000 || allPages.length > 3000) {
    console.warn(
      `[wiki-graph-ops] readGraph took ${elapsed}ms (nodes=${allPages.length}, edges=${fullGraph.edges.length}) — consider adding filters`,
    )
  }

  return { nodes: filteredNodes, edges: filteredEdges }
}

export async function getNode(
  wikiDir: string,
  wikiRoot: string,
  slug: string,
): Promise<WikiPage | null> {
  const pages = await scanWiki(wikiDir, wikiRoot)
  const norm = normalizeSlug(slug)
  const page = pages.find((p) => p.slug === norm)
  if (!page) return null

  return {
    slug: page.slug,
    title: page.title,
    type: page.type,
    tags: page.tags,
    related: page.related,
    sources: page.sources,
    created: page.created,
    updated: page.updated,
    content: page.content,
    path: page.path,
  }
}

export async function getEdges(
  wikiDir: string,
  wikiRoot: string,
  slug: string,
  options?: GetEdgesOptions,
): Promise<GetEdgesResult> {
  const norm = normalizeSlug(slug)
  const pages = await scanWiki(wikiDir, wikiRoot)
  const graph = buildGraphFromPages(pages)

  const k = Math.min(options?.k ?? 1, MAX_K)
  const limit = Math.min(options?.limit ?? GET_EDGES_DEFAULT_LIMIT, GET_EDGES_MAX_LIMIT)

  if (k === 1) {
    const inbound = graph.edges.filter((e) => e.target === norm)
    const outbound = graph.edges.filter((e) => e.source === norm)

    if (inbound.length + outbound.length > limit) {
      throw new ResultTooLargeError({
        matchedCount: inbound.length + outbound.length,
        limitUsed: limit,
        maxLimit: GET_EDGES_MAX_LIMIT,
        suggestions: [{ action: "reduce_k" }],
      })
    }

    return { inbound, outbound }
  }

  // k > 1: BFS with depth
  const edgesWithDepth: Array<GraphEdge & { depth: number }> = []
  const visited = new Set<string>([norm])
  let frontier = [norm]

  for (let depth = 1; depth <= k; depth++) {
    const nextFrontier: string[] = []
    for (const nodeSlug of frontier) {
      for (const edge of graph.edges) {
        if (edge.source === nodeSlug && !visited.has(edge.target)) {
          edgesWithDepth.push({ ...edge, depth })
          visited.add(edge.target)
          nextFrontier.push(edge.target)
        }
        if (edge.target === nodeSlug && !visited.has(edge.source)) {
          edgesWithDepth.push({ ...edge, depth })
          visited.add(edge.source)
          nextFrontier.push(edge.source)
        }
      }
    }
    frontier = nextFrontier
  }

  if (edgesWithDepth.length > limit) {
    throw new ResultTooLargeError({
      matchedCount: edgesWithDepth.length,
      limitUsed: limit,
      maxLimit: GET_EDGES_MAX_LIMIT,
      neighborhoodSizes: [{ k, count: edgesWithDepth.length }],
      suggestions: [{ action: "reduce_k", recommendK: k - 1 }],
    })
  }

  return { edges: edgesWithDepth }
}

export async function getStats(wikiDir: string, wikiRoot: string): Promise<WikiStats> {
  const pages = await scanWiki(wikiDir, wikiRoot)
  const graph = buildGraphFromPages(pages)

  // Type counts (known types first, then alphabetical for unknown)
  const typeCounts: Record<string, number> = {}
  for (const node of graph.nodes) {
    typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1
  }
  const sortedTypes: Record<string, number> = {}
  for (const t of KNOWN_TYPE_ORDER) {
    if (typeCounts[t] !== undefined) {
      sortedTypes[t] = typeCounts[t]
      delete typeCounts[t]
    }
  }
  for (const t of Object.keys(typeCounts).sort()) {
    sortedTypes[t] = typeCounts[t]
  }

  // Top tags
  const tagCounts = new Map<string, number>()
  for (const node of graph.nodes) {
    for (const tag of node.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }))

  // Largest neighborhoods (by degree)
  const degreeMap = new Map<string, number>()
  for (const edge of graph.edges) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1)
    degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1)
  }
  const largestNeighborhoods = [...degreeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([slug, degree]) => ({ slug, degree }))

  return {
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    types: sortedTypes,
    topTags,
    largestNeighborhoods,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function bfsNeighborhood(graph: Graph, center: string, k: number): Set<string> {
  const visited = new Set<string>([center])
  let frontier = [center]

  for (let depth = 0; depth < k; depth++) {
    const next: string[] = []
    for (const slug of frontier) {
      for (const edge of graph.edges) {
        if (edge.source === slug && !visited.has(edge.target)) {
          visited.add(edge.target)
          next.push(edge.target)
        }
        if (edge.target === slug && !visited.has(edge.source)) {
          visited.add(edge.source)
          next.push(edge.source)
        }
      }
    }
    frontier = next
  }

  return visited
}

function buildSuggestions(
  allPages: ScannedPage[],
  options?: ReadGraphOptions,
): ResultTooLargeError["suggestions"] {
  const suggestions: ResultTooLargeError["suggestions"] = []

  // Suggest type filter
  const typeCounts = new Map<string, number>()
  for (const p of allPages) {
    typeCounts.set(p.type, (typeCounts.get(p.type) ?? 0) + 1)
  }
  const topTypes = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t)
  suggestions.push({ action: "add_filter", field: "type", candidates: topTypes })

  // Suggest tag filter
  const tagCounts = new Map<string, number>()
  for (const p of allPages) {
    for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t)
  if (topTags.length > 0) {
    suggestions.push({ action: "add_filter", field: "tag", candidates: topTags })
  }

  // Suggest reducing k
  if (options?.center && (options.k ?? 1) > 1) {
    suggestions.push({ action: "reduce_k", recommendK: (options.k ?? 1) - 1 })
  }

  // Suggest increasing limit
  suggestions.push({ action: "increase_limit" })

  return suggestions
}
