/**
 * llm-wiki-ops — metrics module.
 *
 * Unified entry point: computeMetrics(graph) runs all four analyses.
 * Each sub-module is also independently importable.
 */

import type { Graph } from "../types.js"
import { computeTopology, type TopologyMetrics } from "./topology.js"
import { computeSourceOverlap, type SourceOverlapMetrics } from "./source-overlap.js"
import { computeTypeEdges, type TypeEdgeMetrics } from "./type-edges.js"
import { computeTypeBalance, type TypeBalanceMetrics } from "./type-balance.js"

// ── Unified result ──────────────────────────────────────────────────

export interface GraphMetrics {
  topology: TopologyMetrics
  sourceOverlap: SourceOverlapMetrics
  typeEdges: TypeEdgeMetrics
  typeBalance: TypeBalanceMetrics
}

// ── Entry point ─────────────────────────────────────────────────────

/**
 * Compute all graph metrics from a Graph object.
 * Pure function — no I/O, no side effects.
 */
export function computeMetrics(graph: Graph): GraphMetrics {
  return {
    topology: computeTopology(graph),
    sourceOverlap: computeSourceOverlap(graph),
    typeEdges: computeTypeEdges(graph),
    typeBalance: computeTypeBalance(graph),
  }
}

// Re-export sub-modules for selective use
export { computeTopology, type TopologyMetrics } from "./topology.js"
export { computeSourceOverlap, type SourceOverlapMetrics } from "./source-overlap.js"
export { computeTypeEdges, type TypeEdgeMetrics } from "./type-edges.js"
export { computeTypeBalance, type TypeBalanceMetrics } from "./type-balance.js"
