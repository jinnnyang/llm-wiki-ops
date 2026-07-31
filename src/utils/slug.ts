/**
 * llm-wiki-ops — slug generation.
 *
 * Design doc: §7
 *
 * Algorithm mirrors the app's `makeQuerySlug` (src/lib/wiki-filename.ts)
 * with additions: Windows reserved-name rejection, no 50-char truncation
 * (wiki pages are not timestamped filenames), and conflict detection is
 * handled by the caller (node-ops), not here.
 */

import { InvalidSlugError } from "./errors.js"

/** Windows device names that cannot be used as filenames. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Convert a human-readable title to a filesystem-safe slug.
 *
 * Steps (§7):
 * 1. NFKC normalize (folds fullwidth chars: Ａ→A, （→()
 * 2. Lowercase
 * 3. Whitespace → hyphen
 * 4. Whitelist filter: keep only \p{L}, \p{N}, hyphen
 * 5. Collapse consecutive hyphens
 * 6. Trim leading/trailing hyphens
 * 7. Validate (non-empty, not a Windows reserved name)
 */
export function titleToSlug(title: string): string {
  const slug = title
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

  if (slug.length === 0) {
    throw new InvalidSlugError(title, "empty")
  }

  if (RESERVED_NAMES.test(slug)) {
    throw new InvalidSlugError(title, "reserved-name")
  }

  return slug
}

/**
 * Normalize a slug for comparison (NFKC + lowercase).
 * Used when matching scanned filenames against known slugs.
 */
export function normalizeSlug(slug: string): string {
  return slug.normalize("NFKC").toLowerCase()
}

/**
 * Check whether a slug starts with a digit (diagnostic field).
 */
export function slugStartsWithDigit(slug: string): boolean {
  return /^\p{N}/u.test(slug)
}
