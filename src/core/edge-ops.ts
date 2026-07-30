/**
 * wiki-graph-ops — edge operations (addEdge / removeEdge).
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
import { parseFrontmatter, serializeFrontmatter } from "../io/frontmatter.js"
import {
  hasWikilink,
  insertWikilink,
  removeWikilinks,
} from "../io/wikilink.js"
import { readFileClean, findMarkdownFiles } from "../io/fs-helpers.js"
import { normalizeSlug } from "../utils/slug.js"
import { executeTransaction, type FileChange } from "../transaction/transaction.js"
import { WikiGraphError } from "../utils/errors.js"
import {
  type AddEdgeOptions,
  type AddEdgeResult,
  type RemoveEdgeOptions,
  type RemoveEdgeResult,
  type EdgeOrigin,
  type MutationResult,
  INFRA_FILES,
} from "../types.js"

// ── Helpers ─────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function baseMutation(wikiRoot: string, dryRun: boolean): MutationResult {
  return { filesTouched: [], indexUpdated: false, wikiRootUsed: wikiRoot, dryRun }
}

/** Find a page file by slug across all subdirectories. */
async function findPageBySlug(wikiDir: string, slug: string): Promise<string | null> {
  const norm = normalizeSlug(slug)
  const files = await findMarkdownFiles(wikiDir)
  for (const f of files) {
    if (INFRA_FILES.has(path.basename(f))) continue
    if (normalizeSlug(path.basename(f, ".md")) === norm) return f
  }
  return null
}

/** Check if frontmatter related[] contains a slug. */
function relatedHas(fm: Record<string, unknown> | null, slug: string): boolean {
  if (!fm || !Array.isArray(fm.related)) return false
  const norm = normalizeSlug(slug)
  return (fm.related as string[]).some((r) => normalizeSlug(String(r)) === norm)
}

/** Add a slug to frontmatter related[] (deduped). */
function addRelated(fm: Record<string, unknown>, slug: string): void {
  const norm = normalizeSlug(slug)
  const existing = Array.isArray(fm.related) ? (fm.related as string[]) : []
  if (!existing.some((r) => normalizeSlug(String(r)) === norm)) {
    fm.related = [...existing, norm]
  }
}

/** Remove a slug from frontmatter related[]. */
function removeRelated(fm: Record<string, unknown>, slug: string): void {
  if (!Array.isArray(fm.related)) return
  const norm = normalizeSlug(slug)
  fm.related = (fm.related as string[]).filter((r) => normalizeSlug(String(r)) !== norm)
}

/** Rebuild a page from frontmatter + body. */
function composePage(fm: Record<string, unknown>, body: string): string {
  return `${serializeFrontmatter(fm)}\n${body}`
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
  const { frontmatter: srcFm, body: srcBody, rawBlock: srcRawBlock } = parseFrontmatter(srcContent)

  const hasWl = hasWikilink(srcBody, tgtNorm)
  const hasRel = isSelfLoop ? false : relatedHas(srcFm as Record<string, unknown> | null, tgtNorm)

  // Determine current origins
  if (hasWl) result.originsBefore.push("wikilink")
  if (hasRel) result.originsBefore.push("related")

  // Truth table: both present → no-op
  if (hasWl && (hasRel || isSelfLoop)) {
    result.originsAfter = [...result.originsBefore]
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
    result.originsAfter.push("wikilink")
  } else {
    result.originsAfter.push("wikilink")
  }

  // Add related if missing (skip for self-loops)
  if (!isSelfLoop && !hasRel) {
    addRelated(fm, tgtNorm)
    result.originsAfter.push("related")
  } else if (hasRel) {
    result.originsAfter.push("related")
  }

  // If page had no frontmatter, create it (§13.1, §16 decision 26)
  if (!srcFm && !isSelfLoop) {
    // Auto-created frontmatter: related only, no type (§13.1)
    fm.related = [tgtNorm]
    fm.updated = today()
    const newContent = `${serializeFrontmatter(fm)}\n${newBody}`
    changes.push({ path: srcPath, oldContent: srcContent, newContent, expectExists: true })
  } else {
    // Bump updated
    fm.updated = today()
    const newContent = srcRawBlock
      ? srcContent.replace(srcRawBlock, serializeFrontmatter(fm))
      : composePage(fm, newBody)

    // If rawBlock existed but we changed body too, reconstruct properly
    if (srcRawBlock && newBody !== srcBody) {
      const fullContent = serializeFrontmatter(fm) + "\n" + newBody
      changes.push({ path: srcPath, oldContent: srcContent, newContent: fullContent, expectExists: true })
    } else if (srcRawBlock) {
      // Only frontmatter changed
      const fullContent = srcContent.replace(srcRawBlock, serializeFrontmatter(fm))
      changes.push({ path: srcPath, oldContent: srcContent, newContent: fullContent, expectExists: true })
    } else {
      // No rawBlock but body changed (shouldn't happen if srcFm exists, but safety)
      changes.push({ path: srcPath, oldContent: srcContent, newContent: composePage(fm, newBody), expectExists: true })
    }
  }

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
  const { frontmatter: srcFm, body: srcBody, rawBlock: srcRawBlock } = parseFrontmatter(srcContent)

  const hasWl = hasWikilink(srcBody, tgtNorm)
  const hasRel = isSelfLoop ? false : relatedHas(srcFm as Record<string, unknown> | null, tgtNorm)

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

  // Bump updated
  if (srcFm) {
    fm.updated = today()
  }

  // Reconstruct page
  if (srcRawBlock) {
    if (newBody !== srcBody) {
      const fullContent = serializeFrontmatter(fm) + "\n" + newBody
      changes.push({ path: srcPath, oldContent: srcContent, newContent: fullContent, expectExists: true })
    } else {
      const fullContent = srcContent.replace(srcRawBlock, serializeFrontmatter(fm))
      changes.push({ path: srcPath, oldContent: srcContent, newContent: fullContent, expectExists: true })
    }
  } else if (srcFm) {
    changes.push({ path: srcPath, oldContent: srcContent, newContent: composePage(fm, newBody), expectExists: true })
  } else {
    // No frontmatter, only wikilink removal
    changes.push({ path: srcPath, oldContent: srcContent, newContent: newBody, expectExists: true })
  }

  const tx = await executeTransaction(changes, { wikiRoot, strictVerify, dryRun })
  result.filesTouched = tx.filesWritten.map((f) =>
    path.relative(wikiRoot, f).replace(/\\/g, "/"),
  )

  return result
}
