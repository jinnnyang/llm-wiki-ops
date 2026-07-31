/**
 * llm-wiki-ops — topology metrics.
 *
 * Degree distribution, hub detection, connected components, fragmentation.
 * Pure functions on Graph — no I/O.
 */

import type { Graph } from "../types.js"

// ── Types ───────────────────────────────────────────────────────────

export interface DegreeStats {
  mean: number
  median: number
  std: number
  p95: number
  max: number
  /** Nodes with total degree = 0 */
  isolated: number
}

export interface HubInfo {
  slug: string
  title: string
  type: string
  inDegree: number
  outDegree: number
  totalDegree: number
}

export interface SmallComponent {
  size: number
  slugs: string[]
}

export interface ComponentStats {
  count: number
  largestSize: number
  largestRatio: number
  /** 1 - largestSize/total. 0 = fully connected, 1 = all isolated */
  fragmentationIndex: number
  /** Components with fewer than 5 nodes */
  smallComponents: SmallComponent[]
}

export interface TopologyMetrics {
  nodeCount: number
  edgeCount: number
  degree: DegreeStats
  /** Nodes with degree > p95, sorted desc, capped at 20 */
  hubs: HubInfo[]
  components: ComponentStats
}

// ── Union-Find (iterative, path-compressed) ─────────────────────────

class UnionFind {
  private parent: Map<string, string>
  private rank: Map<string, number>

  constructor(ids: string[]) {
    this.parent = new Map(ids.map((id) => [id, id]))
    this.rank = new Map(ids.map((id) => [id, 0]))
  }

  find(x: string): string {
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // path compression
    while (x !== root) {
      const next = this.parent.get(x)!
      this.parent.set(x, root)
      x = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    const rankA = this.rank.get(ra)!
    const rankB = this.rank.get(rb)!
    if (rankA < rankB) this.parent.set(ra, rb)
    else if (rankA > rankB) this.parent.set(rb, ra)
    else {
      this.parent.set(rb, ra)
      this.rank.set(ra, rankA + 1)
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1)
  return sorted[Math.max(idx, 0)]
}

// ── Main ────────────────────────────────────────────────────────────

export function computeTopology(graph: Graph): TopologyMetrics {
  const { nodes, edges } = graph
  const n = nodes.length

  if (n === 0) {
    return {
      nodeCount: 0,
      edgeCount: 0,
      degree: { mean: 0, median: 0, std: 0, p95: 0, max: 0, isolated: 0 },
      hubs: [],
      components: {
        count: 0,
        largestSize: 0,
        largestRatio: 0,
        fragmentationIndex: 0,
        smallComponents: [],
      },
    }
  }

  // ── Degree counting ─────────────────────────────────────────────
  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  for (const node of nodes) {
    inDeg.set(node.slug, 0)
    outDeg.set(node.slug, 0)
  }
  for (const edge of edges) {
    outDeg.set(edge.source, (outDeg.get(edge.source) ?? 0) + 1)
    inDeg.set(edge.target, (inDeg.get(edge.target) ?? 0) + 1)
  }

  const totalDeg = new Map<string, number>()
  for (const node of nodes) {
    totalDeg.set(node.slug, (inDeg.get(node.slug) ?? 0) + (outDeg.get(node.slug) ?? 0))
  }

  const degrees = [...totalDeg.values()].sort((a, b) => a - b)
  const mean = degrees.reduce((s, d) => s + d, 0) / n
  const median =
    n % 2 === 1
      ? degrees[Math.floor(n / 2)]
      : (degrees[n / 2 - 1] + degrees[n / 2]) / 2
  const variance = degrees.reduce((s, d) => s + (d - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)
  const p95 = percentile(degrees, 0.95)
  const max = degrees[n - 1]
  const isolated = degrees.filter((d) => d === 0).length

  // ── Hubs: degree > p95, sorted desc, cap 20 ─────────────────────
  // When p95 === max (e.g. star graph with one outlier), use >= max
  // so the top node is still reported. Skip entirely if uniform (max === median).
  const isUniform = max <= median
  const hubs: HubInfo[] = isUniform
    ? []
    : nodes
        .filter((nd) => {
          const d = totalDeg.get(nd.slug) ?? 0
          return p95 < max ? d > p95 : d >= max
        })
    .map((nd) => ({
      slug: nd.slug,
      title: nd.title,
      type: nd.type,
      inDegree: inDeg.get(nd.slug) ?? 0,
      outDegree: outDeg.get(nd.slug) ?? 0,
      totalDegree: totalDeg.get(nd.slug) ?? 0,
    }))
    .sort((a, b) => b.totalDegree - a.totalDegree)
    .slice(0, 20)

  // ── Connected components (weak / undirected) ────────────────────
  const uf = new UnionFind(nodes.map((nd) => nd.slug))
  for (const edge of edges) {
    uf.union(edge.source, edge.target)
  }

  const componentMap = new Map<string, string[]>()
  for (const node of nodes) {
    const root = uf.find(node.slug)
    let group = componentMap.get(root)
    if (!group) {
      group = []
      componentMap.set(root, group)
    }
    group.push(node.slug)
  }

  const components = [...componentMap.values()]
  const sizes = components.map((c) => c.length).sort((a, b) => b - a)
  const largestSize = sizes[0] ?? 0
  const smallComponents: SmallComponent[] = components
    .filter((c) => c.length < 5)
    .map((c) => ({ size: c.length, slugs: [...c].sort() }))
    .sort((a, b) => a.size - b.size)

  return {
    nodeCount: n,
    edgeCount: edges.length,
    degree: {
      mean: round2(mean),
      median: round2(median),
      std: round2(std),
      p95,
      max,
      isolated,
    },
    hubs,
    components: {
      count: sizes.length,
      largestSize,
      largestRatio: round2(largestSize / n),
      fragmentationIndex: round2(1 - largestSize / n),
      smallComponents,
    },
  }
}
