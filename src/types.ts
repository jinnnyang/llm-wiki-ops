/**
 * llm-wiki-ops — shared type definitions.
 *
 * Design doc: docs/design/llm-wiki-ops.md §5, §6
 */

// ── Page types ──────────────────────────────────────────────────────

/**
 * Known types (IDE completion + WikiStats ordering).
 * NOT a closed enum — frontmatter can carry any string.
 */
export type KnownPageType =
  | "entity"
  | "concept"
  | "source"
  | "query"
  | "comparison"
  | "synthesis"
  /** Offline recombination product of the dream agent (design: dream.md §7.1). */
  | "dream"
  | "overview"

/** Actual type: known types + arbitrary extension strings */
export type PageType = KnownPageType | (string & {})

// ── Related entries (typed edges) ───────────────────────────────────

/**
 * A single frontmatter `related[]` entry.
 * - string: plain slug — untyped connection (legacy form, permanent, not debt)
 * - { slug, relation }: typed edge (design doc: reason-inference.md §3)
 *
 * Direction is first-class: the entry lives in source page's frontmatter
 * and points at the target, i.e. A→B.
 */
export type RelatedEntry = string | { slug: string; relation?: string }

// ── Graph model ─────────────────────────────────────────────────────

export interface GraphNode {
  slug: string
  title: string
  type: PageType
  tags: string[]
  related: RelatedEntry[]
  sources: string[]
  created: string // YYYY-MM-DD (page clock: when wiki created this page)
  updated: string // YYYY-MM-DD (page clock: any edit)
  as_of?: string // fact clock: when the described state held / event happened
  checked?: string // verification clock: last fact-check (check agent only)
  path: string // relative to wikiRoot (e.g. "wiki/entities/ai基建周期.md")
  status?: string // "active" (default) | "invalidated"
  superseded_by?: string // slug of replacement node (when status=invalidated)
  compression?: string // dream's compression stage: active | condensed | skeleton
}

export type EdgeOrigin = "wikilink" | "related"

export interface GraphEdge {
  source: string
  target: string
  origins: EdgeOrigin[]
  /**
   * Edge type from the frontmatter related entry (wikilinks are never typed).
   * Undefined = untyped connection ("edge exists, type unknown").
   */
  relation?: string
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ── Read options ────────────────────────────────────────────────────

export interface ReadGraphOptions {
  type?: PageType
  tag?: string
  query?: string
  center?: string
  k?: number // BFS depth from center (default 1, max 5)
  limit?: number // default 200, hard cap 500
  cursor?: string // reserved for v2 pagination (ignored in v1)
}

export interface GetEdgesOptions {
  k?: number // default 1
  limit?: number // default 100, hard cap 500
}

/** k=1: { inbound, outbound }; k>1: flat edges + depth */
export type GetEdgesResult =
  | { inbound: GraphEdge[]; outbound: GraphEdge[] }
  | { edges: Array<GraphEdge & { depth: number }> }

// ── Page model (single page detail) ─────────────────────────────────

export interface WikiPage {
  slug: string
  title: string
  type: PageType
  tags: string[]
  related: RelatedEntry[]
  sources: string[]
  created: string
  updated: string
  as_of?: string
  checked?: string
  content: string // body without frontmatter, without title heading
  path: string
  status?: string
  superseded_by?: string
  /** Compression stage (dream.md §6.1): active | condensed | skeleton. */
  compression?: string
}

export interface WikiStats {
  totalNodes: number
  totalEdges: number
  types: Record<string, number>
  topTags: Array<{ tag: string; count: number }>
  largestNeighborhoods: Array<{ slug: string; degree: number }>
}

// ── Mutation results ────────────────────────────────────────────────

export interface MutationResult {
  filesTouched: string[]
  indexUpdated: boolean
  wikiRootUsed: string
  dryRun: boolean
}

// ── Node operations ─────────────────────────────────────────────────

export interface AddNodeInput {
  title: string
  type?: PageType // default "synthesis"
  content?: string
  tags?: string[]
  related?: string[]
  sources?: string[]
  /** Fact clock: when the described state held / event happened. Extract, never invent; omit when unknown. */
  as_of?: string
  onSlugConflict?: "append" | "error" // default "append"
  dryRun?: boolean
}

export interface AddNodeResult extends MutationResult {
  slug: string
  requestedSlug: string
  slugCollided: boolean
  slugStartsWithDigit: boolean
  danglingRelated: string[]
  path: string
  sourcesWarning?: boolean
}

export interface UpdateNodePatch {
  title?: string
  type?: PageType
  content?: string
  tags?: string[]
  related?: string[]
  sources?: string[]
  status?: string
  superseded_by?: string
  /** Fact clock (see AddNodeInput.as_of). Fact changed → reset to the new fact's effective date. */
  as_of?: string
  /** Verification clock: set by check agent after fact verification. */
  checked?: string
  dryRun?: boolean
  /**
   * Compression stage, dream's private bookkeeping (design: dream.md §6.1).
   * active | condensed | skeleton. Deliberately NOT status: that field has
   * live consumers (freshness exclusion, purge, check prompt semantics).
   */
  compression?: string
}

export interface UpdateNodeResult extends MutationResult {
  slug: string
  fieldsChanged: string[]
  moved?: { from: string; to: string }
}

export interface RenameNodeOptions {
  dryRun?: boolean
}

export interface RenameResult extends MutationResult {
  oldSlug: string
  newSlug: string
  referencesUpdated: number
  moved?: { from: string; to: string }
}

export type DanglingRefMode = "strikethrough" | "plain-text" | "remove"

export interface DeleteNodeOptions {
  danglingRefs?: DanglingRefMode // default "strikethrough"
  dryRun?: boolean
}

export interface DeleteResult extends MutationResult {
  deletedPath: string
  referencesUpdated: number
}

export interface RebuildIndexResult extends MutationResult {
  entriesWritten: number
}

// ── Edge operations ─────────────────────────────────────────────────

export interface AddEdgeOptions {
  context?: string
  /**
   * Edge type (open vocabulary; recommended: is_a, instance_of, causes,
   * contradicts, explains, superseded_by, related). Ignored for self-loops.
   * Upgrades an existing plain-string related entry in place.
   */
  relation?: string
  dryRun?: boolean
}

export interface AddEdgeResult extends MutationResult {
  created: boolean
  originsBefore: EdgeOrigin[]
  originsAfter: EdgeOrigin[]
  relationBefore?: string
  relationAfter?: string
}

export interface RemoveEdgeOptions {
  dryRun?: boolean
}

export interface RemoveEdgeResult extends MutationResult {
  removed: boolean
  originsBefore: EdgeOrigin[]
}

// ── Cleanup ─────────────────────────────────────────────────────────

export interface CleanupResult {
  removedFiles: string[]
}

// ── Constructor options ─────────────────────────────────────────────

export interface WikiGraphOptions {
  maintainIndex?: boolean // default true
  /**
   * Usage log: append one JSONL event per facade operation to
   * <wikiRoot>/.llm-wiki-ops/usage/YYYY-MM-DD.jsonl (design: dream.md §4).
   * Default true — it is a baseline capability, not a dream add-on.
   * Tests pass false to keep fixtures clean.
   */
  maintainLog?: boolean // default true
  strictVerify?: boolean // default false (sha256 in optimistic check)
  slugStrategy?: "preserve-cjk" | "pinyin" | "ascii-only" // v1: preserve-cjk only
  /**
   * Resident in-memory graph (design: resident-graph.md §4.1).
   * Reads trust the in-memory graph (pages + adjacency + slug index) built
   * once on first read; writes still go through transactions to disk and
   * then incrementally rebuild the in-memory state. Default false.
   */
  resident?: boolean
  /**
   * Trust window for the resident graph, in ms. Default 30_000.
   *   0  = never revalidate (single-process owns the wiki, e.g. reason agent)
   *   >0 = after the window expires, the next read revalidates from disk
   * Ignored when resident=false. (design: resident-graph.md §5.2)
   */
  trustWindowMs?: number
  /**
   * Who is operating, recorded in every usage log event (dream.md §4.2).
   * MCP server passes process.env.WIKI_AGENT ?? "mcp"; CLI passes "cli".
   * Default "lib" (library consumers).
   */
  actor?: UsageActor
}

// ── Usage log (design: dream.md §4) ─────────────────────────────────

/**
 * Who is performing the operation. Recorded, never enforced — the env-based
 * trust model is spoofable by design (single-user local tool: a mirror, not
 * a bridle). dream.md §4.2.
 */
export type UsageActor =
  | "ingest"
  | "research"
  | "check"
  | "reason"
  | "purge"
  | "dream"
  | "cli"
  | "mcp"
  | "lib"
  | (string & {})

/** One line of <wikiRoot>/.llm-wiki-ops/usage/YYYY-MM-DD.jsonl (dream.md §4.3). */
export interface UsageEvent {
  /** ISO-8601 with ms, UTC. */
  ts: string
  /** Facade method name in snake_case: get_node, add_edge, … */
  op: string
  /** Target slug; two-element array for edge ops; null for target-less ops. */
  slug: string | [string, string] | null
  actor: UsageActor
  /** Present only when true — a dry-run write attempt is still a signal. */
  dry?: true
  ok: boolean
  /** Error code/message when ok is false — negative signal is signal too. */
  err?: string
}

// ── Type → directory mapping ────────────────────────────────────────

/** Hard-coded mapping for known types (directory names are NOT simple plurals). */
export const TYPE_DIR_MAP: Record<KnownPageType, string> = {
  entity: "entities",
  concept: "concepts",
  source: "sources",
  query: "queries",
  comparison: "comparisons",
  synthesis: "synthesis",
  dream: "dreams",
  overview: "", // wiki/ root
}

/** Reverse: directory name → type. Built from TYPE_DIR_MAP. */
export const DIR_TYPE_MAP: Record<string, KnownPageType> = Object.fromEntries(
  Object.entries(TYPE_DIR_MAP)
    .filter(([type, dir]) => dir !== "")
    .map(([type, dir]) => [dir, type as KnownPageType]),
)

/** Infrastructure files that are NOT nodes. */
export const INFRA_FILES = new Set(["index.md", "log.md"])

/** Ordered known types for stats/index display. */
export const KNOWN_TYPE_ORDER: KnownPageType[] = [
  "entity",
  "concept",
  "source",
  "query",
  "comparison",
  "synthesis",
  "dream",
  "overview",
]
