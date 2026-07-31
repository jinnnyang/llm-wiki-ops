/**
 * llm-wiki-ops — source overlap / near-duplicate detection.
 *
 * Inverted index: source → pages.
 * Duplicate signal 1: pages sharing identical source sets.
 * Duplicate signal 2: sources appearing in 3+ pages (over-extraction).
 * Pure functions on Graph — no I/O.
 */

import type { Graph } from "../types.js"

// ── Types ───────────────────────────────────────────────────────────

export interface DuplicateCluster {
  /** The shared source set (sorted) */
  sources: string[]
  pages: Array<{ slug: string; title: string; type: string }>
}

export interface OverExtractedSource {
  source: string
  pageCount: number
  slugs: string[]
}

export interface SourceOverlapMetrics {
  pagesWithSources: number
  pagesWithoutSources: number
  uniqueSources: number
  /** Top sources by page count */
  topSources: Array<{ source: string; pageCount: number }>
  /** Pages with identical source sets — strongest duplicate signal */
  duplicateClusters: DuplicateCluster[]
  /** Sources appearing in 3+ pages — potential over-extraction */
  overExtractedSources: OverExtractedSource[]
}

// ── Main ────────────────────────────────────────────────────────────

export function computeSourceOverlap(graph: Graph): SourceOverlapMetrics {
  const { nodes } = graph

  // Inverted index: source → slugs
  const sourceToPages = new Map<string, string[]>()
  // Page → sorted source key (for exact-match grouping)
  const sourceKeyToPages = new Map<string, Array<{ slug: string; title: string; type: string }>>()

  let pagesWithSources = 0
  let pagesWithoutSources = 0

  for (const node of nodes) {
    if (node.sources.length === 0) {
      pagesWithoutSources++
      continue
    }
    pagesWithSources++

    // Inverted index
    for (const src of node.sources) {
      let list = sourceToPages.get(src)
      if (!list) {
        list = []
        sourceToPages.set(src, list)
      }
      list.push(node.slug)
    }

    // Exact source-set grouping
    const key = [...node.sources].sort().join("\x00")
    let group = sourceKeyToPages.get(key)
    if (!group) {
      group = []
      sourceKeyToPages.set(key, group)
    }
    group.push({ slug: node.slug, title: node.title, type: node.type })
  }

  // Top sources
  const topSources = [...sourceToPages.entries()]
    .map(([source, slugs]) => ({ source, pageCount: slugs.length }))
    .sort((a, b) => b.pageCount - a.pageCount)
    .slice(0, 10)

  // Duplicate clusters: identical source sets, 2+ pages
  const duplicateClusters: DuplicateCluster[] = [...sourceKeyToPages.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .map(([key, pages]) => ({
      sources: key.split("\x00"),
      pages: pages.sort((a, b) => a.slug.localeCompare(b.slug)),
    }))
    .sort((a, b) => b.pages.length - a.pages.length)

  // Over-extracted sources: 3+ pages
  const overExtractedSources: OverExtractedSource[] = [...sourceToPages.entries()]
    .filter(([, slugs]) => slugs.length >= 3)
    .map(([source, slugs]) => ({
      source,
      pageCount: slugs.length,
      slugs: [...slugs].sort(),
    }))
    .sort((a, b) => b.pageCount - a.pageCount)

  return {
    pagesWithSources,
    pagesWithoutSources,
    uniqueSources: sourceToPages.size,
    topSources,
    duplicateClusters,
    overExtractedSources,
  }
}
