/**
 * llm-wiki-ops — graph builder (read operations).
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
import { readFileClean, findMarkdownFiles, statOrNull } from "../io/fs-helpers.js"
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
  type RelatedEntry,
  INFRA_FILES,
  DIR_TYPE_MAP,
  KNOWN_TYPE_ORDER,
  normalizeCompression,
} from "../types.js"
import { relatedEntrySlug, normalizeRelatedEntry } from "./helpers.js"
import { ResultTooLargeError, WikiGraphError } from "../utils/errors.js"

const READ_GRAPH_DEFAULT_LIMIT = 200
const READ_GRAPH_MAX_LIMIT = 500
const GET_EDGES_DEFAULT_LIMIT = 100
const GET_EDGES_MAX_LIMIT = 500
const MAX_K = 5

// ── Internal page record (full scan result) ─────────────────────────

export interface ScannedPage {
  slug: string
  title: string
  type: PageType
  tags: string[]
  related: RelatedEntry[]
  sources: string[]
  created: string
  updated: string
  as_of?: string
  checked?: string
  content: string
  path: string // relative to wikiRoot
  absPath: string
  wikilinkTargets: string[] // normalized slugs from content
  status?: string
  /** Compression stage set by the dream agent: active | condensed | skeleton. */
  compression?: string
  superseded_by?: string
}

// ── Full scan ───────────────────────────────────────────────────────

/**
 * File-level scan cache (design: scancache A′).
 *
 * Module-level, keyed by resolved wikiDir so multiple wikis stay
 * isolated. Lifecycle = process lifecycle; pure memory, never persisted
 * (the .md files are always the source of truth).
 *
 * Invalidation is lazy: every scan stats each file; mtimeMs+size
 * unchanged → reuse the cached ScannedPage, otherwise re-read + parse.
 * The write path never touches this cache — writeFileAtomic bumps mtime,
 * so read-your-writes and external edits both surface on the next scan
 * for free.
 */
interface ScanCacheEntry {
  mtimeMs: number
  size: number
  page: ScannedPage
}

const scanCache = new Map<string, Map<string, ScanCacheEntry>>()

/**
 * Drop cached scan results. No argument clears every wiki; pass a
 * wikiDir to clear just that one (resolved, so relative paths work).
 */
export function clearScanCache(wikiDir?: string): void {
  if (wikiDir === undefined) {
    scanCache.clear()
  } else {
    scanCache.delete(path.resolve(wikiDir))
  }
}

/**
 * Scan the wiki/ directory and return all pages.
 * This is the foundation for all read operations.
 */
export async function scanWiki(wikiDir: string, wikiRoot: string): Promise<ScannedPage[]> {
  const files = await findMarkdownFiles(wikiDir)

  const cacheKey = path.resolve(wikiDir)
  let cache = scanCache.get(cacheKey)
  if (!cache) {
    cache = new Map()
    scanCache.set(cacheKey, cache)
  }

  const pages: ScannedPage[] = []
  const seen = new Set<string>()

  for (const absPath of files) {
    // Skip infrastructure files
    if (INFRA_FILES.has(path.basename(absPath))) continue

    seen.add(absPath)

    // Cache hit: mtimeMs+size unchanged → reuse the parsed page
    const st = await statOrNull(absPath)
    const cached = cache.get(absPath)
    if (st && cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      pages.push(cached.page)
      continue
    }

    // Miss: read + parse, then cache under the fresh stat
    const page = await parsePageFile(absPath, wikiRoot)
    if (st) {
      cache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, page })
    }
    pages.push(page)
  }

  // Evict entries for files that no longer exist (renames, deletions)
  for (const absPath of cache.keys()) {
    if (!seen.has(absPath)) cache.delete(absPath)
  }

  return pages
}

/**
 * Incremental rescan after a write (resident graph support, design:
 * resident-graph.md §4.4).
 *
 * Re-reads ONLY the touched files, updates/removes their A′ cache
 * entries, and returns the full page list from cache — no stat storm
 * over untouched files. Deleted files (rename source, delete_node)
 * drop out of the cache. INFRA_FILES (index.md/log.md) are skipped —
 * they are not graph nodes.
 *
 * Returns null when the cache is empty (never scanned, or externally
 * cleared) — the caller falls back to a full scanWiki.
 */
export async function rescanTouched(
  wikiDir: string,
  wikiRoot: string,
  touchedAbsPaths: string[],
): Promise<ScannedPage[] | null> {
  const cacheKey = path.resolve(wikiDir)
  const cache = scanCache.get(cacheKey)
  if (!cache || cache.size === 0) return null

  for (const absPath of touchedAbsPaths) {
    if (INFRA_FILES.has(path.basename(absPath))) continue
    if (!absPath.endsWith(".md")) continue

    const st = await statOrNull(absPath)
    if (!st) {
      cache.delete(absPath) // deleted (rename source / delete_node)
      continue
    }
    const page = await parsePageFile(absPath, wikiRoot)
    cache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, page })
  }

  // Deterministic order (matches scanWiki's sorted findMarkdownFiles)
  return [...cache.values()]
    .sort((a, b) => (a.page.absPath < b.page.absPath ? -1 : 1))
    .map((e) => e.page)
}

/** Read + parse a single page file into a ScannedPage. */
async function parsePageFile(absPath: string, wikiRoot: string): Promise<ScannedPage> {
  const relPath = path.relative(wikiRoot, absPath).replace(/\\/g, "/")
  const fileName = path.basename(absPath, ".md")

  const slug = normalizeSlug(fileName)
  const { content: rawContent } = await readFileClean(absPath)
  const { frontmatter, body } = parseFrontmatter(rawContent)

  // Infer type from directory when frontmatter is missing/broken
  const type = inferType(frontmatter?.type as string | undefined, relPath, fileName)

  const title = (frontmatter?.title as string) ?? fileName
  const tags = toStringArray(frontmatter?.tags)
  const related = parseRelatedEntries(frontmatter?.related).map(normalizeRelatedEntry)
  const sources = toStringArray(frontmatter?.sources)
  const created = (frontmatter?.created as string) ?? ""
  const updated = (frontmatter?.updated as string) ?? ""
  const as_of = (frontmatter?.as_of as string) || undefined
  const checked = (frontmatter?.checked as string) || undefined

  // Extract wikilinks from body (skips code blocks)
  const wikilinkTargets = [...new Set(extractWikilinks(body).map((t) => normalizeSlug(t)))]

  return {
    slug,
    title,
    type,
    tags,
    related,
    sources,
    created,
    updated,
    as_of,
    checked,
    content: body,
    path: relPath,
    absPath,
    wikilinkTargets,
    status: (frontmatter?.status as string) ?? undefined,
    // Normalized on read too: frontmatter can be hand-edited, and an unknown
    // stage must not silently score as active-with-full-weight.
    compression: normalizeCompression(frontmatter?.compression),
    superseded_by: (frontmatter?.superseded_by as string) ?? undefined,
  }
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

/**
 * Parse a frontmatter related value into entries.
 * Accepts: a string, an array of strings, and typed entries
 * ({ slug, relation? }). Cleans legacy "[[a]]" wrapping.
 * Malformed items are dropped.
 */
function parseRelatedEntries(v: unknown): RelatedEntry[] {
  const clean = (s: string): string => s.replace(/^\[\[/, "").replace(/\]\]$/, "").trim()
  if (typeof v === "string") {
    const c = clean(v)
    return c ? [c] : []
  }
  if (!Array.isArray(v)) return []
  const out: RelatedEntry[] = []
  for (const item of v) {
    if (typeof item === "string") {
      const c = clean(item)
      if (c) out.push(c)
    } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>
      if (typeof obj.slug === "string") {
        const slug = clean(obj.slug)
        if (!slug) continue
        const entry: { slug: string; relation?: string } = { slug }
        if (typeof obj.relation === "string" && obj.relation.trim()) {
          entry.relation = obj.relation.trim()
        }
        out.push(entry)
      }
    }
  }
  return out
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

    // Related edges (entries may carry a relation — typed edges)
    for (const entry of page.related) {
      const target = relatedEntrySlug(entry)
      if (!slugSet.has(target)) continue // dangling related
      const relation = typeof entry === "string" ? undefined : entry.relation
      const key = `${page.slug}→${target}`
      const existing = edgeMap.get(key)
      if (existing) {
        if (!existing.origins.includes("related")) existing.origins.push("related")
        if (relation && !existing.relation) existing.relation = relation
      } else {
        edgeMap.set(key, {
          source: page.slug,
          target,
          origins: ["related"],
          ...(relation ? { relation } : {}),
        })
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
      as_of: p.as_of,
      checked: p.checked,
      path: p.path,
      status: p.status,
      compression: p.compression,
      superseded_by: p.superseded_by,
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
  const allPages = await scanWiki(wikiDir, wikiRoot)
  return readGraphFromPages(allPages, options)
}

/**
 * readGraph core, operating on an already-scanned page list.
 * Shared by the disk path (readGraph) and the resident graph path.
 */
export function readGraphFromPages(allPages: ScannedPage[], options?: ReadGraphOptions): Graph {
  return readGraphFromGraph(buildGraphFromPages(allPages), allPages, options)
}

/**
 * readGraph core, operating on a prebuilt full graph.
 * Shared by readGraphFromPages and the resident graph path — resident callers
 * pass the cached Graph so reads never rebuild it (design: resident-graph.md §4.3).
 */
export function readGraphFromGraph(
  fullGraph: Graph,
  allPages: ScannedPage[],
  options?: ReadGraphOptions,
): Graph {
  const startTime = Date.now()

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
      `[llm-wiki-ops] readGraph took ${elapsed}ms (nodes=${allPages.length}, edges=${fullGraph.edges.length}) — consider adding filters`,
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
  return getNodeFromPages(pages, slug)
}

/** getNode core, operating on an already-scanned page list. */
export function getNodeFromPages(pages: ScannedPage[], slug: string): WikiPage | null {
  const norm = normalizeSlug(slug)
  const page = pages.find((p) => p.slug === norm)
  if (!page) return null
  return pageToWikiPage(page)
}

/** Project a ScannedPage into the public WikiPage shape. */
export function pageToWikiPage(page: ScannedPage): WikiPage {
  return {
    slug: page.slug,
    title: page.title,
    type: page.type,
    tags: page.tags,
    related: page.related,
    sources: page.sources,
    created: page.created,
    updated: page.updated,
    as_of: page.as_of,
    checked: page.checked,
    content: page.content,
    path: page.path,
    status: page.status,
    compression: page.compression,
    superseded_by: page.superseded_by,
  }
}

export async function getEdges(
  wikiDir: string,
  wikiRoot: string,
  slug: string,
  options?: GetEdgesOptions,
): Promise<GetEdgesResult> {
  const pages = await scanWiki(wikiDir, wikiRoot)
  return getEdgesFromPages(pages, slug, options)
}

/** getEdges core, operating on an already-scanned page list. */
export function getEdgesFromPages(
  pages: ScannedPage[],
  slug: string,
  options?: GetEdgesOptions,
): GetEdgesResult {
  const graph = buildGraphFromPages(pages)
  return getEdgesFromAdjacency(buildAdjacencyFromGraph(graph.edges), slug, options)
}

/**
 * getEdges core, operating on a prebuilt adjacency list.
 * Shared by the disk path (getEdgesFromPages) and the resident graph
 * path (O(degree) for k=1 instead of O(E) filtering).
 */
export function getEdgesFromAdjacency(
  adj: Map<string, GraphEdge[]>,
  slug: string,
  options?: GetEdgesOptions,
): GetEdgesResult {
  const norm = normalizeSlug(slug)

  const k = Math.min(options?.k ?? 1, MAX_K)
  const limit = Math.min(options?.limit ?? GET_EDGES_DEFAULT_LIMIT, GET_EDGES_MAX_LIMIT)

  if (k === 1) {
    // Dedup: self-loops appear twice in the undirected adjacency list
    // (pushed once as source, once as target).
    const seen = new Set<GraphEdge>()
    const inbound: GraphEdge[] = []
    const outbound: GraphEdge[] = []
    for (const edge of adj.get(norm) ?? []) {
      if (seen.has(edge)) continue
      seen.add(edge)
      if (edge.target === norm) inbound.push(edge)
      if (edge.source === norm) outbound.push(edge)
    }

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
      for (const edge of adj.get(nodeSlug) ?? []) {
        const neighbor = edge.source === nodeSlug ? edge.target : edge.source
        if (!visited.has(neighbor)) {
          edgesWithDepth.push({ ...edge, depth })
          visited.add(neighbor)
          nextFrontier.push(neighbor)
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
  return getStatsFromPages(pages)
}

/** getStats core, operating on an already-scanned page list. */
export function getStatsFromPages(pages: ScannedPage[]): WikiStats {
  return getStatsFromGraph(buildGraphFromPages(pages))
}

/**
 * getStats core, operating on a prebuilt full graph.
 * Shared by getStatsFromPages and the resident graph path (no rebuild).
 */
export function getStatsFromGraph(graph: Graph): WikiStats {

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

/**
 * Build an undirected adjacency list from graph edges. O(E).
 * Exported for the resident graph path (design: resident-graph.md §4.2).
 */
export function buildAdjacencyFromGraph(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const adj = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, [])
    if (!adj.has(edge.target)) adj.set(edge.target, [])
    adj.get(edge.source)!.push(edge)
    adj.get(edge.target)!.push(edge)
  }
  return adj
}

/** Build an undirected adjacency list from graph edges. O(E). */
function buildAdjacency(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  return buildAdjacencyFromGraph(edges)
}

function bfsNeighborhood(graph: Graph, center: string, k: number): Set<string> {
  const adj = buildAdjacency(graph.edges)
  const visited = new Set<string>([center])
  let frontier = [center]

  for (let depth = 0; depth < k; depth++) {
    const next: string[] = []
    for (const slug of frontier) {
      for (const edge of adj.get(slug) ?? []) {
        const neighbor = edge.source === slug ? edge.target : edge.source
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          next.push(neighbor)
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
