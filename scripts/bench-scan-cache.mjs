/**
 * scripts/bench-scan-cache.mjs — A′ cache benchmark on a real wiki.
 * Run: node scripts/bench-scan-cache.mjs [wikiDir]
 * (Uses compiled dist/ — run `npm run build` first.)
 */
import { scanWiki, clearScanCache } from "../dist/src/core/graph-builder.js"
import * as path from "node:path"

const wikiDir = process.argv[2] ?? "C:/Users/jinnn/Documents/wiki-builder/wikis/economic-analysis/wiki"
const wikiRoot = path.dirname(wikiDir)

async function timed(label) {
  const start = process.hrtime.bigint()
  const pages = await scanWiki(wikiDir, wikiRoot)
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6
  console.log(`${label}: ${elapsed.toFixed(1)}ms (${pages.length} pages)`)
}

clearScanCache()

await timed("cold scan")
await timed("warm scan #1")
await timed("warm scan #2")
await timed("warm scan #3")

let total = 0
const N = 20
const s = process.hrtime.bigint()
for (let i = 0; i < N; i++) {
  const pages = await scanWiki(wikiDir, wikiRoot)
  total += pages.length
}
const avg = Number(process.hrtime.bigint() - s) / 1e6 / N
console.log(`${N} consecutive warm scans: avg ${avg.toFixed(1)}ms (sanity: ${total / N} pages each)`)
