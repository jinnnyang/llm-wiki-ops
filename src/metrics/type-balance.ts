/**
 * llm-wiki-ops — type distribution / balance.
 *
 * Pages per type, dominant type, empty known types.
 * Pure functions on Graph — no I/O.
 */

import type { Graph } from "../types.js"
import { KNOWN_TYPE_ORDER } from "../types.js"

// ── Types ───────────────────────────────────────────────────────────

export interface TypeDistributionEntry {
  type: string
  count: number
  ratio: number
}

export interface TypeBalanceMetrics {
  total: number
  /** Sorted by count desc */
  distribution: TypeDistributionEntry[]
  /** Known types with 0 pages */
  emptyKnownTypes: string[]
  /** The type with the most pages, null if graph is empty */
  dominant: { type: string; count: number; ratio: number } | null
}

// ── Main ────────────────────────────────────────────────────────────

export function computeTypeBalance(graph: Graph): TypeBalanceMetrics {
  const { nodes } = graph
  const total = nodes.length

  const counts = new Map<string, number>()
  for (const node of nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1)
  }

  const distribution: TypeDistributionEntry[] = [...counts.entries()]
    .map(([type, count]) => ({
      type,
      count,
      ratio: total > 0 ? Math.round((count / total) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))

  const presentTypes = new Set(counts.keys())
  const emptyKnownTypes = KNOWN_TYPE_ORDER.filter((t) => !presentTypes.has(t))

  const dominant =
    distribution.length > 0
      ? { type: distribution[0].type, count: distribution[0].count, ratio: distribution[0].ratio }
      : null

  return { total, distribution, emptyKnownTypes, dominant }
}
