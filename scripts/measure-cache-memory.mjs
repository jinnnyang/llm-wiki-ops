/**
 * scripts/measure-cache-memory.mjs — how much RAM does the A' scan cache hold?
 * Run: node scripts/measure-cache-memory.mjs
 */
import { scanWiki, clearScanCache } from "../dist/src/core/graph-builder.js"

const wikiDir = "C:/Users/jinnn/Documents/wiki-builder/wikis/economic-analysis/wiki"
const wikiRoot = "C:/Users/jinnn/Documents/wiki-builder/wikis/economic-analysis"

const mb = (n) => (n / 1024 / 1024).toFixed(1)

const before = process.memoryUsage()
clearScanCache()
const pages = await scanWiki(wikiDir, wikiRoot)
const after = process.memoryUsage()

console.log(`pages: ${pages.length}`)
console.log(`heapUsed delta:  ${mb(after.heapUsed - before.heapUsed)} MB`)
console.log(`rss delta:       ${mb(after.rss - before.rss)} MB`)

const totalContentChars = pages.reduce((s, p) => s + p.content.length, 0)
console.log(`total content:   ${(totalContentChars / 1024 / 1024).toFixed(2)} MB of text`)
console.log(`avg page:        ${Math.round(totalContentChars / pages.length)} chars`)
