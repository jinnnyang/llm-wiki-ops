/**
 * scripts/bench-hot-path-breakdown.mjs — where do the ~50ms hot reads go?
 * Splits: stat revalidation vs scan-cache hit vs buildGraphFromPages vs adjacency.
 * Run: node scripts/bench-hot-path-breakdown.mjs
 */
import { scanWiki, buildGraphFromPages, getNode, getEdges, clearScanCache } from "../dist/src/core/graph-builder.js"

const wikiDir = "C:/Users/jinnn/Documents/wiki-builder/wikis/economic-analysis/wiki"
const wikiRoot = "C:/Users/jinnn/Documents/wiki-builder/wikis/economic-analysis"

async function timeIt(label, fn, n = 20) {
  await fn() // warm
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) await fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n
  console.log(`${label.padEnd(38)} ${ms.toFixed(2)} ms`)
  return ms
}

clearScanCache()
await scanWiki(wikiDir, wikiRoot) // prime cache

await timeIt("hot scanWiki (stat revalidation)", () => scanWiki(wikiDir, wikiRoot))

const pages = await scanWiki(wikiDir, wikiRoot)
await timeIt("buildGraphFromPages (in-memory)", () => Promise.resolve(buildGraphFromPages(pages)))

const graph = buildGraphFromPages(pages)
await timeIt("build adjacency map", () => {
  const adj = new Map()
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    if (!adj.has(e.target)) adj.set(e.target, [])
    adj.get(e.source).push(e)
    adj.get(e.target).push(e)
  }
  return Promise.resolve(adj)
})

await timeIt("getNode (scan + find)", () => getNode(wikiDir, wikiRoot, pages[0].slug))
await timeIt("getEdges k=1 (scan+build+filter)", () => getEdges(wikiDir, wikiRoot, pages[0].slug))

console.log(`\npages: ${pages.length}, edges: ${graph.edges.length}`)
