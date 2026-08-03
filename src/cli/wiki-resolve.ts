/**
 * cli/wiki-resolve.ts — Wiki resolution logic.
 *
 * Resolution priority:
 *   1. --wiki <path-or-slug>       (explicit, highest)
 *   2. SELECTED_WIKI env var       (default wiki)
 *   3. WIKIS_ROOT global search    (read-only, all valid wikis)
 *
 * Slug resolution: only valid when WIKIS_ROOT is a legal directory.
 *   slug → WIKIS_ROOT/<slug>
 *
 * Valid wiki: has wiki/ dir + raw/ dir + wiki/index.md
 *
 * Global search mode (WIKIS_ROOT valid + SELECTED_WIKI empty):
 *   - Read operations: iterate all valid wikis, output per-wiki
 *   - Write operations: refuse, require --wiki or SELECTED_WIKI
 */

import { existsSync, statSync, readdirSync } from "node:fs"
import { join, isAbsolute, resolve } from "node:path"

// ── Validation ──────────────────────────────────────────────────────

/** A valid wiki has wiki/ + raw/ subdirectories and wiki/index.md */
export function isValidWiki(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
    const wikiDir = join(dir, "wiki")
    const rawDir = join(dir, "raw")
    const indexFile = join(wikiDir, "index.md")
    return (
      statSync(wikiDir).isDirectory() &&
      statSync(rawDir).isDirectory() &&
      statSync(indexFile).isFile()
    )
  } catch {
    return false
  }
}

/** WIKIS_ROOT is valid if it exists and is a directory. */
export function getWikisRoot(): string | null {
  const root = process.env.WIKIS_ROOT
  if (!root) return null
  try {
    if (statSync(root).isDirectory()) return root
  } catch { /* not a directory */ }
  return null
}

/** List all valid wikis under WIKIS_ROOT. */
export function listValidWikis(wikisRoot: string): string[] {
  try {
    return readdirSync(wikisRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(wikisRoot, d.name))
      .filter((p) => isValidWiki(p))
  } catch {
    return []
  }
}

// ── Slug detection ──────────────────────────────────────────────────

/** Heuristic: a slug is a simple name (no path separators, not absolute). */
function looksLikeSlug(value: string): boolean {
  if (isAbsolute(value)) return false
  if (value.includes("/") || value.includes("\\")) return false
  if (value.includes(":")) return false // Windows drive letter
  return true
}

/** Resolve a slug or path to an absolute wiki root path. */
function resolveToPath(value: string, wikisRoot: string | null): string {
  if (looksLikeSlug(value)) {
    if (!wikisRoot) {
      console.error(
        `Error: "${value}" looks like a slug, but WIKIS_ROOT is not set or invalid.\n` +
        `  Slug resolution requires a valid WIKIS_ROOT directory.\n` +
        `  Use a full path instead, or set WIKIS_ROOT.`,
      )
      process.exit(1)
    }
    const resolved = join(wikisRoot, value)
    if (!isValidWiki(resolved)) {
      console.error(
        `Error: "${value}" resolved to "${resolved}" but it is not a valid wiki.\n` +
        `  A valid wiki must have wiki/, raw/, and wiki/index.md.`,
      )
      process.exit(1)
    }
    return resolved
  }
  // Full path — validate early
  const resolved = resolve(value)
  if (!isValidWiki(resolved)) {
    console.error(
      `Error: "${resolved}" is not a valid wiki.\n` +
      `  A valid wiki must have wiki/, raw/, and wiki/index.md.`,
    )
    process.exit(1)
  }
  return resolved
}

// ── Main resolver ───────────────────────────────────────────────────

export interface ResolvedTarget {
  mode: "single" | "global"
  /** For single: exactly 1 path. For global: N valid wiki paths. */
  paths: string[]
}

/**
 * Resolve which wiki(s) to operate on.
 *
 * @param wikiOpt  --wiki flag value (highest priority)
 * @param write    true if the operation mutates the wiki (blocks global mode)
 */
export function resolveTarget(wikiOpt: string | undefined, write: boolean): ResolvedTarget {
  const wikisRoot = getWikisRoot()

  // Priority 1: explicit --wiki
  if (wikiOpt) {
    return { mode: "single", paths: [resolveToPath(wikiOpt, wikisRoot)] }
  }

  // Priority 2: SELECTED_WIKI
  const selected = process.env.SELECTED_WIKI
  if (selected) {
    return { mode: "single", paths: [resolveToPath(selected, wikisRoot)] }
  }

  // Priority 3: global search (WIKIS_ROOT valid, SELECTED_WIKI empty)
  if (wikisRoot) {
    if (write) {
      console.error(
        "Error: write operations require a specific wiki target.\n" +
        "  No SELECTED_WIKI is set and --wiki was not provided.\n" +
        `  Either: llm-wiki use <wiki-slug-or-path>\n` +
        "  Or:     pass --wiki <path> explicitly.",
      )
      process.exit(1)
    }
    const wikis = listValidWikis(wikisRoot)
    if (wikis.length === 0) {
      console.error(
        `Error: WIKIS_ROOT="${wikisRoot}" contains no valid wikis.\n` +
        "  A valid wiki must have wiki/, raw/, and wiki/index.md.",
      )
      process.exit(1)
    }
    return { mode: "global", paths: wikis }
  }

  // Nothing configured
  console.error(
    "Error: no wiki target specified.\n" +
    "  Use --wiki <path>, set SELECTED_WIKI, or set WIKIS_ROOT for global search.\n" +
    "  See: llm-wiki use --help",
  )
  process.exit(1)
}
