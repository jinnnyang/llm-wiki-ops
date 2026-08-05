/**
 * WikiCache LRU (design: resident-graph.md §6.2 plan A, §11.5).
 *
 * - Instances are created resident (trustWindowMs=0 — MCP process owns the wiki)
 * - Same root → same instance; access refreshes LRU order
 * - Over WIKI_CACHE_MAX (3): the least-recently-used instance is evicted via
 *   releaseResident(), which also drops its A′ scan cache (§11.5)
 */

import { describe, it, expect, afterEach } from "vitest"

import { WikiCache, WIKI_CACHE_MAX } from "../src/mcp/wiki-cache.js"
import { clearScanCache } from "../src/core/graph-builder.js"

const roots = ["a", "b", "c", "d"].map((n) => `/tmp-fake-wiki-${n}`)

afterEach(() => {
  clearScanCache()
})

describe("WikiCache", () => {
  it("WIKI_CACHE_MAX is 3", () => {
    expect(WIKI_CACHE_MAX).toBe(3)
  })

  it("creates resident instances with trustWindowMs=0", () => {
    const cache = new WikiCache()
    const wiki = cache.get(roots[0])
    expect(wiki.resident).toBe(true)
    expect(wiki.trustWindowMs).toBe(0)
  })

  it("same root returns the same instance (idempotent)", () => {
    const cache = new WikiCache()
    expect(cache.get(roots[0])).toBe(cache.get(roots[0]))
    expect(cache.size).toBe(1)
  })

  it("evicts the LRU instance when over capacity", () => {
    const cache = new WikiCache()
    const a = cache.get(roots[0])
    cache.get(roots[1])
    cache.get(roots[2])
    expect(cache.size).toBe(3)

    cache.get(roots[3]) // evicts roots[0] (oldest)
    expect(cache.size).toBe(3)
    expect(cache.peek(roots[0])).toBeUndefined()
    expect(cache.peek(roots[3])).toBeDefined()

    // Evicted instance's resident state was released; re-access cold-rebuilds
    // a FRESH instance (not the evicted one).
    expect(cache.get(roots[0])).not.toBe(a)
  })

  it("touch refreshes LRU order", () => {
    const cache = new WikiCache()
    cache.get(roots[0])
    cache.get(roots[1])
    cache.get(roots[2])

    cache.get(roots[0]) // touch a → LRU order is now b, c, a
    cache.get(roots[3]) // evicts b, not a
    expect(cache.peek(roots[0])).toBeDefined()
    expect(cache.peek(roots[1])).toBeUndefined()
  })

  it("custom max is honored", () => {
    const cache = new WikiCache(1)
    cache.get(roots[0])
    cache.get(roots[1])
    expect(cache.size).toBe(1)
    expect(cache.peek(roots[0])).toBeUndefined()
  })
})
