/**
 * llm-wiki-ops — shared helpers for node-ops and edge-ops.
 *
 * Extracted to eliminate duplication between the two modules.
 */

import * as path from "node:path"
import { normalizeSlug } from "../utils/slug.js"
import { serializeFrontmatter } from "../io/frontmatter.js"
import { findMarkdownFiles } from "../io/fs-helpers.js"
import { WikiGraphError } from "../utils/errors.js"
import { INFRA_FILES, type MutationResult, type RelatedEntry } from "../types.js"

/** Current date as YYYY-MM-DD. */
export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Build frontmatter + body into a full page string. */
export function composePage(fm: Record<string, unknown>, body: string): string {
  return `${serializeFrontmatter(fm)}\n${body}`
}

/** Initialize the common MutationResult fields. */
export function baseMutation(wikiRoot: string, dryRun: boolean): MutationResult {
  return { filesTouched: [], indexUpdated: false, wikiRootUsed: wikiRoot, dryRun }
}

/**
 * Find a page file by slug across all subdirectories.
 * Returns absPath or null. Throws AMBIGUOUS_SLUG on multiple matches.
 */
export async function findPageBySlug(wikiDir: string, slug: string): Promise<string | null> {
  const norm = normalizeSlug(slug)
  const files = await findMarkdownFiles(wikiDir)
  const matches: string[] = []
  for (const f of files) {
    if (INFRA_FILES.has(path.basename(f))) continue
    if (normalizeSlug(path.basename(f, ".md")) === norm) matches.push(f)
  }
  if (matches.length > 1) {
    throw new WikiGraphError("AMBIGUOUS_SLUG", `Slug "${slug}" matches ${matches.length} files`, {
      detail: matches.map((m) => path.relative(wikiDir, m).replace(/\\/g, "/")).join(", "),
    })
  }
  return matches[0] ?? null
}

// ── Related-entry helpers (typed edges) ─────────────────────────────

/** Extract the slug from a related entry (plain string or typed object). */
export function relatedEntrySlug(entry: RelatedEntry): string {
  return typeof entry === "string" ? entry : entry.slug
}

/**
 * Normalize a related entry: NFKC-lowercase the slug, trim+lowercase the
 * relation. An object entry with an empty relation collapses to a plain
 * string (untyped connection).
 */
export function normalizeRelatedEntry(entry: RelatedEntry): RelatedEntry {
  if (typeof entry === "string") return normalizeSlug(entry)
  const slug = normalizeSlug(entry.slug)
  const relation = entry.relation?.trim().toLowerCase()
  return relation ? { slug, relation } : slug
}
