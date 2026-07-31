/**
 * llm-wiki-ops — cross-type edge matrix.
 *
 * For each (sourceType, targetType) pair, counts edges and computes
 * the fraction of sourceType's outgoing edges going to targetType.
 * Pure functions on Graph — no I/O.
 */

import type { Graph } from "../types.js"

// ── Types ───────────────────────────────────────────────────────────

export interface TypeEdgeMetrics {
  /** Ordered type labels (row/column headers) */
  types: string[]
  /** counts[i][j] = edges from types[i] → types[j] */
  counts: number[][]
  /** ratios[i][j] = fraction of types[i]'s outgoing edges → types[j]. Row sums ≈ 1 (0 row = no outgoing edges) */
  ratios: number[][]
  /** Total outgoing edges per type (row sums of counts) */
  outgoing: number[]
}

// ── Main ────────────────────────────────────────────────────────────

export function computeTypeEdges(graph: Graph): TypeEdgeMetrics {
  const { nodes, edges } = graph

  // Collect types in stable order: by count desc, then alpha
  const typeCounts = new Map<string, number>()
  for (const node of nodes) {
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1)
  }
  const types = [...typeCounts.keys()].sort((a, b) => {
    const diff = (typeCounts.get(b) ?? 0) - (typeCounts.get(a) ?? 0)
    return diff !== 0 ? diff : a.localeCompare(b)
  })

  const typeIndex = new Map(types.map((t, i) => [t, i]))
  const n = types.length

  // Build count matrix
  const counts: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  const nodeType = new Map(nodes.map((nd) => [nd.slug, nd.type]))

  for (const edge of edges) {
    const si = typeIndex.get(nodeType.get(edge.source) ?? "")
    const ti = typeIndex.get(nodeType.get(edge.target) ?? "")
    if (si !== undefined && ti !== undefined) {
      counts[si][ti]++
    }
  }

  // Row sums → ratios
  const outgoing = counts.map((row) => row.reduce((s, v) => s + v, 0))
  const ratios = counts.map((row, i) =>
    outgoing[i] > 0 ? row.map((v) => Math.round((v / outgoing[i]) * 1000) / 1000) : row.map(() => 0),
  )

  return { types, counts, ratios, outgoing }
}
