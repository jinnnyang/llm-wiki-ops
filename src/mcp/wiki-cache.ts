/**
 * mcp/wiki-cache.ts — LRU cache of resident WikiGraph instances.
 *
 * Design: resident-graph.md §6.2 (LRU plan A), §11.5 (eviction must also
 * clear the A′ file-level scan cache — releaseResident() does both).
 */

import { WikiGraph } from "../index.js"

/** Max simultaneously resident wikis (§6.2). */
export const WIKI_CACHE_MAX = 3

export class WikiCache {
  private readonly cache = new Map<string, WikiGraph>()

  constructor(private readonly max: number = WIKI_CACHE_MAX) {}

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
    const existing = this.cache.get(root)
    if (existing) {
      this.cache.delete(root)
      this.cache.set(root, existing)
      return existing
    }

    if (this.cache.size > 0 && this.cache.size >= this.max) {
      const oldest = this.cache.keys().next().value as string
      this.cache.get(oldest)!.releaseResident()
      this.cache.delete(oldest)
    }

    const wiki = new WikiGraph(root, { resident: true, trustWindowMs: 0 })
    this.cache.set(root, wiki)
    return wiki
  }

  /** Peek without touching LRU order (tests / diagnostics). */
  peek(root: string): WikiGraph | undefined {
    return this.cache.get(root)
  }
}
