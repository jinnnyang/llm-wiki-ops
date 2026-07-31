/**
 * llm-wiki-ops — main WikiGraph class.
 *
 * Design doc: §5 (constructor), §6 (all operations)
 *
 * Constructor does NOT touch the filesystem (§16 decision 19).
 * Only stat .inflight-*.json for crash recovery awareness.
 * cleanup() is exposed but NOT auto-called (§16 decision: lib only exposes).
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import {
  type WikiGraphOptions,
  type ReadGraphOptions,
  type GetEdgesOptions,
  type GetEdgesResult,
  type Graph,
  type WikiPage,
  type WikiStats,
  type AddNodeInput,
  type AddNodeResult,
  type UpdateNodePatch,
  type UpdateNodeResult,
  type RenameNodeOptions,
  type RenameResult,
  type DeleteNodeOptions,
  type DeleteResult,
  type RebuildIndexResult,
  type AddEdgeOptions,
  type AddEdgeResult,
  type RemoveEdgeOptions,
  type RemoveEdgeResult,
  type CleanupResult,
} from "./types.js"
import { readGraph, getNode, getEdges, getStats, scanWiki, buildGraphFromPages } from "./core/graph-builder.js"
import { addNode, updateNode, renameNode, deleteNode, rebuildIndex } from "./core/node-ops.js"
import { addEdge, removeEdge } from "./core/edge-ops.js"
import { findTmpFiles, deleteFileIfExists } from "./io/fs-helpers.js"
import { WikiGraphError } from "./utils/errors.js"
import { computeMetrics, type GraphMetrics } from "./metrics/index.js"

export class WikiGraph {
  readonly wikiRoot: string
  readonly wikiDir: string
  readonly maintainIndex: boolean
  readonly maintainLog: boolean
  readonly strictVerify: boolean
  readonly slugStrategy: "preserve-cjk" | "pinyin" | "ascii-only"

  constructor(wikiRoot: string, options?: WikiGraphOptions) {
    this.wikiRoot = path.resolve(wikiRoot)
    this.wikiDir = path.join(this.wikiRoot, "wiki")
    this.maintainIndex = options?.maintainIndex ?? true
    this.maintainLog = options?.maintainLog ?? false
    this.strictVerify = options?.strictVerify ?? false
    this.slugStrategy = options?.slugStrategy ?? "preserve-cjk"
  }

  // ── Read operations ─────────────────────────────────────────────

  async readGraph(options?: ReadGraphOptions): Promise<Graph> {
    return readGraph(this.wikiDir, this.wikiRoot, options)
  }

  async getNode(slug: string): Promise<WikiPage | null> {
    return getNode(this.wikiDir, this.wikiRoot, slug)
  }

  async getEdges(slug: string, options?: GetEdgesOptions): Promise<GetEdgesResult> {
    return getEdges(this.wikiDir, this.wikiRoot, slug, options)
  }

  async getStats(): Promise<WikiStats> {
    return getStats(this.wikiDir, this.wikiRoot)
  }

  /**
   * Compute all graph metrics (topology, source overlap, type edges, type balance).
   * Full wiki scan — read-only, no mutations.
   */
  async getMetrics(): Promise<GraphMetrics> {
    const pages = await scanWiki(this.wikiDir, this.wikiRoot)
    const graph = buildGraphFromPages(pages)
    return computeMetrics(graph)
  }

  // ── Node operations ─────────────────────────────────────────────

  async addNode(input: AddNodeInput): Promise<AddNodeResult> {
    return addNode(this.wikiDir, this.wikiRoot, input, this.maintainIndex, this.strictVerify)
  }

  async updateNode(slug: string, patch: UpdateNodePatch): Promise<UpdateNodeResult> {
    return updateNode(this.wikiDir, this.wikiRoot, slug, patch, this.maintainIndex, this.strictVerify)
  }

  async renameNode(oldSlug: string, newSlug: string, options?: RenameNodeOptions): Promise<RenameResult> {
    return renameNode(this.wikiDir, this.wikiRoot, oldSlug, newSlug, options, this.maintainIndex, this.strictVerify)
  }

  async deleteNode(slug: string, options?: DeleteNodeOptions): Promise<DeleteResult> {
    return deleteNode(this.wikiDir, this.wikiRoot, slug, options, this.maintainIndex, this.strictVerify)
  }

  async rebuildIndex(): Promise<RebuildIndexResult> {
    return rebuildIndex(this.wikiDir, this.wikiRoot, this.strictVerify)
  }

  // ── Edge operations ─────────────────────────────────────────────

  async addEdge(source: string, target: string, options?: AddEdgeOptions): Promise<AddEdgeResult> {
    return addEdge(this.wikiDir, this.wikiRoot, source, target, options, this.strictVerify)
  }

  async removeEdge(source: string, target: string, options?: RemoveEdgeOptions): Promise<RemoveEdgeResult> {
    return removeEdge(this.wikiDir, this.wikiRoot, source, target, options, this.strictVerify)
  }

  // ── Maintenance ─────────────────────────────────────────────────

  /**
   * Remove leftover .tmp-* files from interrupted transactions.
   * Exposed publicly; NOT auto-called by constructor or rebuildIndex.
   * CLI calls this at startup; MCP calls it at server.init().
   */
  async cleanup(): Promise<CleanupResult> {
    const tmpFiles = await findTmpFiles(this.wikiDir)
    const removedFiles: string[] = []

    for (const f of tmpFiles) {
      try {
        await deleteFileIfExists(f)
        removedFiles.push(path.relative(this.wikiRoot, f).replace(/\\/g, "/"))
      } catch {
        // Best-effort
      }
    }

    // Also clean .inflight-*.json markers
    const stateDir = path.join(this.wikiRoot, ".llm-wiki-ops")
    try {
      const entries = await fs.readdir(stateDir)
      for (const entry of entries) {
        if (entry.startsWith(".inflight-") && entry.endsWith(".json")) {
          const p = path.join(stateDir, entry)
          await deleteFileIfExists(p)
          removedFiles.push(path.relative(this.wikiRoot, p).replace(/\\/g, "/"))
        }
      }
    } catch {
      // State dir doesn't exist — nothing to clean
    }

    return { removedFiles }
  }

  /**
   * Validate that wikiRoot exists and contains a wiki/ directory.
   * Throws WIKI_ROOT_NOT_FOUND if invalid.
   */
  async validate(): Promise<void> {
    try {
      const st = await fs.stat(this.wikiDir)
      if (!st.isDirectory()) {
        throw new WikiGraphError("WIKI_ROOT_NOT_FOUND", `${this.wikiDir} is not a directory`)
      }
    } catch (e) {
      if (e instanceof WikiGraphError) throw e
      throw new WikiGraphError("WIKI_ROOT_NOT_FOUND", `wiki/ directory not found at ${this.wikiDir}`)
    }
  }
}

// Re-export everything for library consumers
export * from "./types.js"
export * from "./utils/errors.js"
export { titleToSlug, normalizeSlug, slugStartsWithDigit } from "./utils/slug.js"
export { parseFrontmatter, serializeFrontmatter } from "./io/frontmatter.js"
export {
  extractWikilinks,
  extractWikilinkSlugs,
  hasWikilink,
  insertWikilink,
  removeWikilinks,
  replaceWikilinks,
  danglingWikilink,
} from "./io/wikilink.js"
export {
  computeMetrics,
  computeTopology,
  computeSourceOverlap,
  computeTypeEdges,
  computeTypeBalance,
  type GraphMetrics,
  type TopologyMetrics,
  type SourceOverlapMetrics,
  type TypeEdgeMetrics,
  type TypeBalanceMetrics,
} from "./metrics/index.js"
