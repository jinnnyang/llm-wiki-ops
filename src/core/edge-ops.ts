/**
 * llm-wiki-ops — edge operations (addEdge / removeEdge).
 *
 * Design doc: §6.4
 *
 * Dual-carrier truth table:
 *   addEdge ensures BOTH [[wikilink]] and related[] exist.
 *   removeEdge removes from BOTH carriers.
 *   Both are idempotent.
 *
 * Self-loops (A→A): wikilink only, no related modification.
 */

import * as path from "node:path"
import { parseFrontmatter } from "../io/frontmatter.js"
import {
  hasWikilink,
  insertWikilink,
  removeWikilinks,
} from "../io/wikilink.js"
import { readFileClean } from "../io/fs-helpers.js"
import { normalizeSlug } from "../utils/slug.js"
import { executeTransaction, type FileChange } from "../transaction/transaction.js"
import { today, composePage, baseMutation, findPageBySlug, relatedEntrySlug } from "./helpers.js"
import { WikiGraphError } from "../utils/errors.js"
import {
  type AddEdgeOptions,
  type AddEdgeResult,
  type RemoveEdgeOptions,
  type RemoveEdgeResult,
  type EdgeOrigin,
  type RelatedEntry,
} from "../types.js"

// ── Helpers ─────────────────────────────────────────────────────────

/** Find a frontmatter related[] entry by slug (plain string or typed object). */
function findRelatedEntry(
  fm: Record<string, unknown> | null,
  slug: string,
): RelatedEntry | null {
  if (!fm || !Array.isArray(fm.related)) return null
  const norm = normalizeSlug(slug)
  for (const r of fm.related as RelatedEntry[]) {
    if (normalizeSlug(relatedEntrySlug(r)) === norm) return r
  }
  return null
}

/**
 * Add or upgrade a related[] entry (deduped by slug).
 * - Entry absent → append (typed object when relation given, else plain slug).
 * - Entry present + relation given → upgrade/change in place.
 * - Entry present + no relation → keep as-is (typed entries never downgrade).
 */
function setRelated(fm: Record<string, unknown>, slug: string, relation?: string): void {
  const norm = normalizeSlug(slug)
  const existing = Array.isArray(fm.related) ? (fm.related as RelatedEntry[]) : []
  const idx = existing.findIndex((r) => normalizeSlug(relatedEntrySlug(r)) === norm)
  if (idx === -1) {
    fm.related = [...existing, relation ? { slug: norm, relation } : norm]
    return
  }
  if (relation !== undefined) {
    const next = [...existing]
    next[idx] = { slug: norm, relation }
    fm.related = next
  }
}

/** Remove a slug from frontmatter related[] (matches both entry forms). */
function removeRelated(fm: Record<string, unknown>, slug: string): void {
  if (!Array.isArray(fm.related)) return
  const norm = normalizeSlug(slug)
  fm.related = (fm.related as RelatedEntry[]).filter(
    (r) => normalizeSlug(relatedEntrySlug(r)) !== norm,
  )
}

// ── addEdge ─────────────────────────────────────────────────────────

export async function addEdge(
  wikiDir: string,
  wikiRoot: string,
  source: string,
  target: string,
  options?: AddEdgeOptions,
  strictVerify = false,
): Promise<AddEdgeResult> {
  const srcNorm = normalizeSlug(source)
  const tgtNorm = normalizeSlug(target)
  const dryRun = options?.dryRun ?? false
  const isSelfLoop = srcNorm === tgtNorm
  // Self-loops never get a related entry, so relation is ignored for them.
  const relation =
    !isSelfLoop && options?.relation && options.relation.trim()
      ? options.relation.trim().toLowerCase()
      : undefined

  const result: AddEdgeResult = {
    ...baseMutation(wikiRoot, dryRun),
    created: false,
    originsBefore: [],
    originsAfter: [],
  }

  // Validate both nodes exist
  const srcPath = await findPageBySlug(wikiDir, srcNorm)
  if (!srcPath) {
    throw new WikiGraphError("NODE_NOT_FOUND", `Source node "${source}" not found`, {
      slug: srcNorm,
      targetSlug: tgtNorm,
    })
  }
  const tgtPath = await findPageBySlug(wikiDir, tgtNorm)
  if (!tgtPath) {
    throw new WikiGraphError("NODE_NOT_FOUND", `Target node "${target}" not found`, {
      slug: tgtNorm,
    })
  }

  // Read source page
  const { content: srcContent } = await readFileClean(srcPath)
  const { frontmatter: srcFm, body: srcBody } = parseFrontmatter(srcContent)

  const hasWl = hasWikilink(srcBody, tgtNorm)
  const relEntry = isSelfLoop ? null : findRelatedEntry(srcFm as Record<string, unknown> | null, tgtNorm)
  const hasRel = relEntry !== null

  // Determine current origins
  if (hasWl) result.originsBefore.push("wikilink")
  if (hasRel) result.originsBefore.push("related")
  result.relationBefore =
    relEntry !== null && typeof relEntry === "object" ? relEntry.relation : undefined

  // Truth table: both present AND no relation change → no-op (idempotent)
  const relationChanging =
    hasRel && relation !== undefined && result.relationBefore !== relation
  if (hasWl && (hasRel || isSelfLoop) && !relationChanging) {
    result.originsAfter = [...result.originsBefore]
    result.relationAfter = result.relationBefore
    return result
  }

  result.created = true

  // Build changes
  const changes: FileChange[] = []
  let newBody = srcBody
  const fm = (srcFm as Record<string, unknown>) ?? {}

  // Insert wikilink if missing
  if (!hasWl) {
    newBody = insertWikilink(srcBody, tgtNorm, options?.context)
  }
  result.originsAfter.push("wikilink")

  // Add or upgrade related entry (skip for self-loops)
  if (!isSelfLoop) {
    if (!hasRel || relationChanging) {
      setRelated(fm, tgtNorm, relation)
    }
    result.originsAfter.push("related")
    result.relationAfter = relation ?? result.relationBefore
  }

  // Bump `updated` and reconstruct uniformly.
  //
  // NOTE: an edge write bumps the SOURCE page's clock, so linking A→B makes A look
  // freshly touched. That is why `updated` must never be read as a maintenance
  // signal — see GraphNode.updated in types.ts.
  fm.updated = today()
  const newContent = composePage(fm, newBody)
  changes.push({ path: srcPath, oldContent: srcContent, newContent, expectExists: true })

  const tx = await executeTransaction(changes, { wikiRoot, strictVerify, dryRun })
  result.filesTouched = tx.filesWritten.map((f) =>
    path.relative(wikiRoot, f).replace(/\\/g, "/"),
  )

  return result
}

// ── removeEdge ──────────────────────────────────────────────────────

export async function removeEdge(
  wikiDir: string,
  wikiRoot: string,
  source: string,
  target: string,
  options?: RemoveEdgeOptions,
  strictVerify = false,
): Promise<RemoveEdgeResult> {
  const srcNorm = normalizeSlug(source)
  const tgtNorm = normalizeSlug(target)
  const dryRun = options?.dryRun ?? false
  const isSelfLoop = srcNorm === tgtNorm

  const result: RemoveEdgeResult = {
    ...baseMutation(wikiRoot, dryRun),
    removed: false,
    originsBefore: [],
  }

  // Validate both nodes exist
  const srcPath = await findPageBySlug(wikiDir, srcNorm)
  if (!srcPath) {
    throw new WikiGraphError("NODE_NOT_FOUND", `Source node "${source}" not found`, {
      slug: srcNorm,
      targetSlug: tgtNorm,
    })
  }
  const tgtPath = await findPageBySlug(wikiDir, tgtNorm)
  if (!tgtPath) {
    throw new WikiGraphError("NODE_NOT_FOUND", `Target node "${target}" not found`, {
      slug: tgtNorm,
    })
  }

  // Read source page
  const { content: srcContent } = await readFileClean(srcPath)
  const { frontmatter: srcFm, body: srcBody } = parseFrontmatter(srcContent)

  const hasWl = hasWikilink(srcBody, tgtNorm)
  const hasRel = isSelfLoop ? false : findRelatedEntry(srcFm as Record<string, unknown> | null, tgtNorm) !== null

  if (hasWl) result.originsBefore.push("wikilink")
  if (hasRel) result.originsBefore.push("related")

  // Neither exists → no-op (idempotent)
  if (!hasWl && !hasRel) {
    return result
  }

  result.removed = true

  const changes: FileChange[] = []
  let newBody = srcBody
  const fm = (srcFm as Record<string, unknown>) ?? {}

  // Remove wikilink if present
  if (hasWl) {
    newBody = removeWikilinks(srcBody, tgtNorm)
  }

  // Remove related if present
  if (hasRel) {
    removeRelated(fm, tgtNorm)
  }

  // Bump updated and reconstruct uniformly. Removing an edge bumps the source
  // page's clock as much as adding one did — see GraphNode.updated in types.ts.
  if (srcFm) {
    fm.updated = today()
  }

  const newContent = srcFm ? composePage(fm, newBody) : newBody
  changes.push({ path: srcPath, oldContent: srcContent, newContent, expectExists: true })

  const tx = await executeTransaction(changes, { wikiRoot, strictVerify, dryRun })
  result.filesTouched = tx.filesWritten.map((f) =>
    path.relative(wikiRoot, f).replace(/\\/g, "/"),
  )

  return result
}
