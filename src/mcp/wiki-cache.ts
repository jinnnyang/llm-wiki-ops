/**
 * mcp/wiki-cache.ts — LRU cache of resident WikiGraph instances.
 *
 * Design: resident-graph.md §6.2 (LRU plan A), §11.5 (eviction must also
 * clear the A′ file-level scan cache — releaseResident() does both).
 */

import { WikiGraph, wikiRootCacheKey } from "../index.js"

/** Max simultaneously resident wikis (§6.2). */
export const WIKI_CACHE_MAX = 3

/**
 * Trust window for MCP-resident graphs, in ms (dream.md §4.6).
 *
 * Not 0: several agent processes operate on one wiki concurrently (dream while
 * check runs, reason while ingest writes), so "this process owns the wiki" does
 * not hold. A 30s window bounds how long a reader can act on a stale graph;
 * revalidation costs a ~90ms warm stat pass.
 */
export const MCP_TRUST_WINDOW_MS = 30_000

export class WikiCache {
  private readonly cache = new Map<string, WikiGraph>()

  constructor(private readonly max: number = WIKI_CACHE_MAX) {}

  /**
   * Cache key: reuses WikiGraph's canonicalization so "C:\Wiki" and "c:\wiki"
   * map to one instance instead of two (dream.md §4.6). Shared helper rather
   * than a second copy, so the two can never drift apart.
   */
  private key(root: string): string {
    return wikiRootCacheKey(root)
  }

  /** Number of cached instances. */
  get size(): number {
    return this.cache.size
  }

  /**
   * Get (or lazily create) the resident WikiGraph for a wiki root.
   *
   * resident=true + trustWindowMs=0: the MCP server process owns each wiki
   * for its lifetime (reason session or dedicated client) — reads trust the
   * in-memory graph unconditionally (§6).
   *
   * LRU: every access re-inserts the entry (Map iteration order = insertion
   * order). Over capacity, the least-recently-used instance is evicted via
   * releaseResident() (drops the in-memory graph AND its A′ scan cache);
   * the agent only notices a ~90ms lazy rebuild on next access.
   */
  get(root: string): WikiGraph {
    const key = this.key(root)
    const existing = this.cache.get(key)
    if (existing) {
      this.cache.delete(key)
      this.cache.set(key, existing)
      return existing
    }

    if (this.cache.size > 0 && this.cache.size >= this.max) {
      const oldest = this.cache.keys().next().value as string
      this.cache.get(oldest)!.releaseResident()
      this.cache.delete(oldest)
    }

    const wiki = new WikiGraph(root, {
      resident: true,
      trustWindowMs: MCP_TRUST_WINDOW_MS,
      actor: process.env.WIKI_AGENT ?? "mcp",
    })
    this.cache.set(key, wiki)
    return wiki
  }

  /** Peek without touching LRU order (tests / diagnostics). */
  peek(root: string): WikiGraph | undefined {
    return this.cache.get(this.key(root))
  }
}
