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
import { INFRA_FILES, type MutationResult } from "../types.js"

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
