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
  type GraphEdge,
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
  type MutationResult,
  INFRA_FILES,
} from "./types.js"
import {
  readGraph,
  getNode,
  getEdges,
  getStats,
  scanWiki,
  buildGraphFromPages,
  readGraphFromGraph,
  getEdgesFromAdjacency,
  getStatsFromGraph,
  pageToWikiPage,
  rescanTouched,
  buildAdjacencyFromGraph,
  clearScanCache,
  type ScannedPage,
} from "./core/graph-builder.js"
import { addNode, updateNode, renameNode, deleteNode, rebuildIndex } from "./core/node-ops.js"
import { addEdge, removeEdge } from "./core/edge-ops.js"
import {
  scanFreshness,
  scanFreshnessFromPages,
  type ScanFreshnessOptions,
  type FreshnessScanResult,
} from "./core/freshness.js"
import { findTmpFiles, deleteFileIfExists } from "./io/fs-helpers.js"
import { WikiGraphError } from "./utils/errors.js"
import { normalizeSlug } from "./utils/slug.js"
import { computeMetrics, type GraphMetrics } from "./metrics/index.js"

/** Default trust window for the resident graph (design: resident-graph.md §4.1). */
const DEFAULT_TRUST_WINDOW_MS = 30_000

/**
 * In-memory state of a resident graph (design: resident-graph.md §4.2).
 * Built once on first read; incrementally rebuilt after writes.
 */
interface ResidentState {
  pages: ScannedPage[] // sorted, matches scanWiki order
  graph: Graph // buildGraphFromPages product
  adjacency: Map<string, GraphEdge[]> // undirected (source→edges, target→edges)
  slugIndex: Map<string, ScannedPage> // O(1) getNode
  lastValidated: number // Date.now() of last disk validation
}

export class WikiGraph {
  readonly wikiRoot: string
  readonly wikiDir: string
  readonly maintainIndex: boolean
  readonly maintainLog: boolean
  readonly strictVerify: boolean
  readonly slugStrategy: "preserve-cjk" | "pinyin" | "ascii-only"
  readonly resident: boolean
  readonly trustWindowMs: number

  // ── Resident graph state (only when resident=true) ────────────────
  private residentState: ResidentState | null = null
  private residentBuildInFlight: Promise<ResidentState> | null = null

  constructor(wikiRoot: string, options?: WikiGraphOptions) {
    this.wikiRoot = path.resolve(wikiRoot)
    this.wikiDir = path.join(this.wikiRoot, "wiki")
    this.maintainIndex = options?.maintainIndex ?? true
    this.maintainLog = options?.maintainLog ?? false
    this.strictVerify = options?.strictVerify ?? false
    this.slugStrategy = options?.slugStrategy ?? "preserve-cjk"
    this.resident = options?.resident ?? false
    this.trustWindowMs = options?.trustWindowMs ?? DEFAULT_TRUST_WINDOW_MS
  }

  // ── Read operations ─────────────────────────────────────────────

  async readGraph(options?: ReadGraphOptions): Promise<Graph> {
    if (!this.resident) return readGraph(this.wikiDir, this.wikiRoot, options)
    const state = await this.ensureResident()
    return readGraphFromGraph(state.graph, state.pages, options)
  }

  async getNode(slug: string): Promise<WikiPage | null> {
    if (!this.resident) return getNode(this.wikiDir, this.wikiRoot, slug)
    const state = await this.ensureResident()
    const page = state.slugIndex.get(normalizeSlug(slug))
    return page ? pageToWikiPage(page) : null
  }

  async getEdges(slug: string, options?: GetEdgesOptions): Promise<GetEdgesResult> {
    if (!this.resident) return getEdges(this.wikiDir, this.wikiRoot, slug, options)
    const state = await this.ensureResident()
    return getEdgesFromAdjacency(state.adjacency, slug, options)
  }

  async getStats(): Promise<WikiStats> {
    if (!this.resident) return getStats(this.wikiDir, this.wikiRoot)
    const state = await this.ensureResident()
    return getStatsFromGraph(state.graph)
  }

  /**
   * Compute all graph metrics (topology, source overlap, type edges, type balance).
   * Full wiki scan — read-only, no mutations.
   */
  async getMetrics(): Promise<GraphMetrics> {
    if (!this.resident) {
      const pages = await scanWiki(this.wikiDir, this.wikiRoot)
      return computeMetrics(buildGraphFromPages(pages))
    }
    const state = await this.ensureResident()
    return computeMetrics(state.graph)
  }

  /**
   * Freshness scan: pure-code exponential backoff, returns the due list for the
   * check agent. Design doc: reason-inference.md §4.5. Read-only, no mutations.
   */
  async scanFreshness(options?: ScanFreshnessOptions): Promise<FreshnessScanResult> {
    if (!this.resident) return scanFreshness(this.wikiDir, this.wikiRoot, options)
    const state = await this.ensureResident()
    return scanFreshnessFromPages(state.pages, options)
  }

  // ── Resident graph internals (design: resident-graph.md §4) ───────

  /**
   * Return the resident state, building it on first use and revalidating it
   * from disk when the trust window has expired (§4.3). Concurrent callers
   * share a single in-flight build.
   */
  private async ensureResident(): Promise<ResidentState> {
    if (this.residentState) {
      const expired =
        this.trustWindowMs > 0 &&
        Date.now() - this.residentState.lastValidated >= this.trustWindowMs
      if (!expired) return this.residentState
    }

    if (!this.residentBuildInFlight) {
      this.residentBuildInFlight = this.buildResidentState()
        .then((state) => {
          this.residentState = state
          return state
        })
        .finally(() => {
          this.residentBuildInFlight = null
        })
    }
    return this.residentBuildInFlight
  }

  /**
   * Build the in-memory state from a fresh disk scan (§4.3).
   * scanWiki is backed by the A′ file-level cache: cold ~4.7s, warm ~90ms
   * (stat all files). Revalidation after trust-window expiry follows the same
   * path — it is the cost of detecting external edits (§5.2).
   */
  private async buildResidentState(): Promise<ResidentState> {
    const pages = await scanWiki(this.wikiDir, this.wikiRoot)
    return this.buildResidentFromPages(pages)
  }

  /** Derive graph + adjacency + slug index from a page list (~5ms for 1150 pages). */
  private buildResidentFromPages(pages: ScannedPage[]): ResidentState {
    const graph = buildGraphFromPages(pages)
    const adjacency = buildAdjacencyFromGraph(graph.edges)
    const slugIndex = new Map(pages.map((p) => [p.slug, p]))
    return { pages, graph, adjacency, slugIndex, lastValidated: Date.now() }
  }

  /**
   * After a committed write, incrementally refresh the resident state from the
   * touched files (§4.4). Skipped for dry-run, non-resident graphs, graphs not
   * yet built (first write before any read — next read cold-builds), and
   * index-only writes (rebuildIndex touches only INFRA_FILES).
   */
  private async maybeRebuildAfterWrite(result: MutationResult): Promise<void> {
    if (!this.resident || !this.residentState || result.dryRun) return
    const touched = result.filesTouched.filter(
      (p) => !INFRA_FILES.has(path.basename(p)) && p.endsWith(".md"),
    )
    if (touched.length === 0) return

    const absPaths = touched.map((p) => path.join(this.wikiRoot, p))
    const pages = await rescanTouched(this.wikiDir, this.wikiRoot, absPaths)
    if (!pages) return // A′ cache empty — next read cold-builds
    this.residentState = this.buildResidentFromPages(pages)
  }

  // ── Node operations ─────────────────────────────────────────────

  async addNode(input: AddNodeInput): Promise<AddNodeResult> {
    const result = await addNode(this.wikiDir, this.wikiRoot, input, this.maintainIndex, this.strictVerify)
    await this.maybeRebuildAfterWrite(result)
    return result
  }

  async updateNode(slug: string, patch: UpdateNodePatch): Promise<UpdateNodeResult> {
    const result = await updateNode(this.wikiDir, this.wikiRoot, slug, patch, this.maintainIndex, this.strictVerify)
    await this.maybeRebuildAfterWrite(result)
    return result
  }

  async renameNode(oldSlug: string, newSlug: string, options?: RenameNodeOptions): Promise<RenameResult> {
    const result = await renameNode(this.wikiDir, this.wikiRoot, oldSlug, newSlug, options, this.maintainIndex, this.strictVerify)
    await this.maybeRebuildAfterWrite(result)
    return result
  }

  async deleteNode(slug: string, options?: DeleteNodeOptions): Promise<DeleteResult> {
    const result = await deleteNode(this.wikiDir, this.wikiRoot, slug, options, this.maintainIndex, this.strictVerify)
    await this.maybeRebuildAfterWrite(result)
    return result
  }

  async rebuildIndex(): Promise<RebuildIndexResult> {
    const result = await rebuildIndex(this.wikiDir, this.wikiRoot, this.strictVerify)
    await this.maybeRebuildAfterWrite(result)
    return result
  }

  // ── Edge operations ─────────────────────────────────────────────

  async addEdge(source: string, target: string, options?: AddEdgeOptions): Promise<AddEdgeResult> {
    const result = await addEdge(this.wikiDir, this.wikiRoot, source, target, options, this.strictVerify)
    await this.maybeRebuildAfterWrite(result)
    return result
  }

  async removeEdge(source: string, target: string, options?: RemoveEdgeOptions): Promise<RemoveEdgeResult> {
    const result = await removeEdge(this.wikiDir, this.wikiRoot, source, target, options, this.strictVerify)
    await this.maybeRebuildAfterWrite(result)
    return result
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

    // Release resident graph state + file-level scan cache (design:
    // resident-graph.md §4.5). No-op when resident=false / never built.
    this.residentState = null
    this.residentBuildInFlight = null
    clearScanCache(this.wikiDir)

    return { removedFiles }
  }

  /**
   * Release the resident graph state (design: resident-graph.md §4.5).
   * Also called by MCP's LRU eviction. Safe to call multiple times;
   * next read cold-builds again.
   */
  releaseResident(): void {
    this.residentState = null
    this.residentBuildInFlight = null
    clearScanCache(this.wikiDir)
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
