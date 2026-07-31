/**
 * wiki-graph-ops — structured error model.
 *
 * Design doc: §10
 */

export type ErrorCode =
  // node / edge
  | "NODE_NOT_FOUND"
  | "NODE_ALREADY_EXISTS"
  | "RENAME_TARGET_EXISTS"
  | "INVALID_SLUG"
  | "AMBIGUOUS_SLUG"
  // query
  | "RESULT_TOO_LARGE"
  // concurrency / transaction
  | "LOCK_TIMEOUT"
  | "EXTERNAL_MODIFICATION"
  | "TRANSACTION_ROLLBACK"
  | "TRANSACTION_DIRTY"
  // environment
  | "WIKI_ROOT_NOT_FOUND"
  | "PATH_TOO_LONG"

export class WikiGraphError extends Error {
  readonly code: ErrorCode
  readonly slug?: string
  readonly targetSlug?: string
  readonly detail?: string

  constructor(
    code: ErrorCode,
    message: string,
    extra?: { slug?: string; targetSlug?: string; detail?: string },
  ) {
    super(message)
    this.name = "WikiGraphError"
    this.code = code
    this.slug = extra?.slug
    this.targetSlug = extra?.targetSlug
    this.detail = extra?.detail
  }
}

// ── Concrete error classes ──────────────────────────────────────────

export interface ResultTooLargeSuggestion {
  action: "add_filter" | "increase_limit" | "reduce_k"
  field?: "type" | "tag"
  candidates?: string[]
  recommendK?: number
  expectedCount?: number
}

export class ResultTooLargeError extends WikiGraphError {
  readonly matchedCount: number
  readonly limitUsed: number
  readonly maxLimit: number
  readonly neighborhoodSizes?: Array<{ k: number; count: number }>
  readonly suggestions: ResultTooLargeSuggestion[]

  constructor(opts: {
    matchedCount: number
    limitUsed: number
    maxLimit: number
    neighborhoodSizes?: Array<{ k: number; count: number }>
    suggestions: ResultTooLargeSuggestion[]
  }) {
    super(
      "RESULT_TOO_LARGE",
      `Query matched ${opts.matchedCount} items (limit=${opts.limitUsed}, max=${opts.maxLimit}). Narrow your query.`,
    )
    this.name = "ResultTooLargeError"
    this.matchedCount = opts.matchedCount
    this.limitUsed = opts.limitUsed
    this.maxLimit = opts.maxLimit
    this.neighborhoodSizes = opts.neighborhoodSizes
    this.suggestions = opts.suggestions
  }
}

export class LockTimeoutError extends WikiGraphError {
  readonly lockPath: string
  readonly waitedMs: number

  constructor(lockPath: string, waitedMs: number) {
    super("LOCK_TIMEOUT", `Failed to acquire wiki lock after ${waitedMs}ms: ${lockPath}`)
    this.name = "LockTimeoutError"
    this.lockPath = lockPath
    this.waitedMs = waitedMs
  }
}

export class ExternalModificationError extends WikiGraphError {
  readonly conflictedPaths: string[]

  constructor(conflictedPaths: string[]) {
    super(
      "EXTERNAL_MODIFICATION",
      `Files modified externally during operation: ${conflictedPaths.join(", ")}`,
    )
    this.name = "ExternalModificationError"
    this.conflictedPaths = conflictedPaths
  }
}

export class TransactionRollbackError extends WikiGraphError {
  readonly txid: string
  readonly phase: "executing" | "rolling-back"
  readonly rollbackStatus: "complete" | "partial"
  readonly dirtyPaths: string[]
  readonly retryable: boolean

  constructor(opts: {
    txid: string
    phase: "executing" | "rolling-back"
    rollbackStatus: "complete" | "partial"
    dirtyPaths: string[]
    retryable: boolean
  }) {
    super(
      "TRANSACTION_ROLLBACK",
      `Transaction ${opts.txid} failed during ${opts.phase}; rollback ${opts.rollbackStatus}.`,
    )
    this.name = "TransactionRollbackError"
    this.txid = opts.txid
    this.phase = opts.phase
    this.rollbackStatus = opts.rollbackStatus
    this.dirtyPaths = opts.dirtyPaths
    this.retryable = opts.retryable
  }
}

export class TransactionDirtyError extends WikiGraphError {
  readonly txid: string
  readonly dirtyPaths: string[]
  readonly retryable = false as const

  constructor(txid: string, dirtyPaths: string[]) {
    super(
      "TRANSACTION_DIRTY",
      `Transaction ${txid} rollback failed. Manual intervention needed for: ${dirtyPaths.join(", ")}`,
    )
    this.name = "TransactionDirtyError"
    this.txid = txid
    this.dirtyPaths = dirtyPaths
  }
}

export class InvalidSlugError extends WikiGraphError {
  readonly requestedTitle: string
  readonly reason: "reserved-name" | "empty" | "control-chars" | "path-too-long"

  constructor(
    requestedTitle: string,
    reason: "reserved-name" | "empty" | "control-chars" | "path-too-long",
  ) {
    super("INVALID_SLUG", `Invalid slug from title "${requestedTitle}": ${reason}`, {
      detail: reason,
    })
    this.name = "InvalidSlugError"
    this.requestedTitle = requestedTitle
    this.reason = reason
  }
}
