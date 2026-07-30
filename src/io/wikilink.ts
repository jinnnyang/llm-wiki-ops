/**
 * wiki-graph-ops — [[wikilink]] extraction, insertion, removal, replacement.
 *
 * Design doc: §6.4 (edge ops), §6.3 (addNode auto-sync)
 *
 * Key behaviors:
 * - Extraction skips fenced code blocks (```…```) and inline code (`…`)
 * - Supports title-form wikilinks: [[KV Cache]] resolves to slug kv-cache
 * - Insertion follows the context → "## 相关" → EOF decision chain
 */

import { normalizeSlug } from "../utils/slug.js"

// ── Extraction ──────────────────────────────────────────────────────

/**
 * Extract all [[wikilink]] targets from markdown content,
 * skipping fenced code blocks and inline code spans.
 *
 * Returns raw target strings (may be title-form, not yet slug-normalized).
 */
export function extractWikilinks(content: string): string[] {
  const results: string[] = []
  const lines = content.split("\n")
  let inFencedCode = false

  for (const line of lines) {
    // Track fenced code blocks (``` or ~~~)
    if (/^\s*(```|~~~)/.test(line)) {
      inFencedCode = !inFencedCode
      continue
    }
    if (inFencedCode) continue

    // Strip inline code spans before extracting
    const stripped = line.replace(/`[^`]*`/g, "")

    // Extract [[target]] or [[target|alias]]
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      results.push(m[1].trim())
    }
  }

  return results
}

/**
 * Extract wikilink targets and normalize to slugs.
 */
export function extractWikilinkSlugs(content: string): string[] {
  return extractWikilinks(content).map((t) => normalizeSlug(t))
}

// ── Detection ───────────────────────────────────────────────────────

/**
 * Check whether content contains a [[wikilink]] pointing to the given slug.
 * Checks both slug-form and possible title-forms.
 */
export function hasWikilink(content: string, slug: string): boolean {
  const targets = extractWikilinks(content)
  const norm = normalizeSlug(slug)
  return targets.some((t) => normalizeSlug(t) === norm)
}

// ── Insertion ───────────────────────────────────────────────────────

/**
 * Insert a `- [[target]]` line into content following the decision chain:
 * 1. If `context` heading is given → append to end of that section
 * 2. Else if page has "## 相关" or "## Related" → append there
 * 3. Else → create "## 相关" section at EOF
 *
 * Returns the modified content.
 */
export function insertWikilink(content: string, targetSlug: string, context?: string): string {
  const entry = `- [[${targetSlug}]]`

  // 1. Try caller-specified context heading
  if (context) {
    const inserted = insertAtSectionEnd(content, context, entry)
    if (inserted !== null) return inserted
  }

  // 2. Try existing "## 相关" or "## Related"
  for (const heading of ["## 相关", "## Related"]) {
    const inserted = insertAtSectionEnd(content, heading, entry)
    if (inserted !== null) return inserted
  }

  // 3. Create "## 相关" at EOF
  const trimmed = content.trimEnd()
  return `${trimmed}\n\n## 相关\n\n${entry}\n`
}

/**
 * Find a heading line matching `heading`, then insert `entry` at the
 * end of that section (before the next same-or-higher-level heading or EOF).
 * Skips code blocks when scanning for section end.
 *
 * Returns null if the heading is not found.
 */
function insertAtSectionEnd(content: string, heading: string, entry: string): string | null {
  const lines = content.split("\n")
  const headingLevel = (heading.match(/^#+/) ?? [""])[0].length

  // Find the heading line
  let headingIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading || lines[i].trim().startsWith(heading + " ")) {
      headingIdx = i
      break
    }
  }
  if (headingIdx === -1) return null

  // Scan for section end
  let inCode = false
  let insertIdx = lines.length // default: EOF
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inCode = !inCode
      continue
    }
    if (inCode) continue

    const m = lines[i].match(/^(#+)\s/)
    if (m && m[1].length <= headingLevel) {
      insertIdx = i
      break
    }
  }

  // Insert before insertIdx, ensuring blank-line separation
  const before = lines.slice(0, insertIdx)
  const after = lines.slice(insertIdx)

  // Trim trailing blank lines from `before` to avoid double blanks
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop()
  }

  const result = [...before, "", entry, "", ...after]
  return result.join("\n")
}

// ── Removal ─────────────────────────────────────────────────────────

/**
 * Remove all [[wikilink]] references to `slug` from content.
 * Handles both [[slug]] and [[slug|alias]] forms.
 * Returns modified content.
 */
export function removeWikilinks(content: string, slug: string): string {
  const norm = normalizeSlug(slug)
  const lines = content.split("\n")
  let inFencedCode = false
  const result: string[] = []

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFencedCode = !inFencedCode
      result.push(line)
      continue
    }
    if (inFencedCode) {
      result.push(line)
      continue
    }

    // Remove list items that are solely a wikilink to this slug
    const listItemMatch = line.match(/^(\s*-\s+)\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*$/)
    if (listItemMatch && normalizeSlug(listItemMatch[2].trim()) === norm) {
      continue // drop the entire line
    }

    // Remove inline wikilinks (replace with empty)
    const cleaned = line.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (match, target) => {
      return normalizeSlug(target.trim()) === norm ? "" : match
    })
    result.push(cleaned)
  }

  return result.join("\n")
}

// ── Replacement ─────────────────────────────────────────────────────

/**
 * Replace all [[oldSlug]] references with [[newSlug]] in content.
 * Handles both [[slug]] and [[slug|alias]] forms (alias preserved).
 */
export function replaceWikilinks(content: string, oldSlug: string, newSlug: string): string {
  const oldNorm = normalizeSlug(oldSlug)
  return content.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (match, target, alias) => {
    if (normalizeSlug(target.trim()) === oldNorm) {
      return alias ? `[[${newSlug}${alias}]]` : `[[${newSlug}]]`
    }
    return match
  })
}

/**
 * Replace [[slug]] with a dangling-ref treatment.
 * Design doc: §6.3 DanglingRefMode
 */
export function danglingWikilink(
  content: string,
  slug: string,
  title: string,
  mode: "strikethrough" | "plain-text" | "remove",
): string {
  const norm = normalizeSlug(slug)
  const lines = content.split("\n")
  let inFencedCode = false
  const result: string[] = []

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFencedCode = !inFencedCode
      result.push(line)
      continue
    }
    if (inFencedCode) {
      result.push(line)
      continue
    }

    // List items that are solely a wikilink → remove entirely for all modes
    const listItemMatch = line.match(/^(\s*-\s+)\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*$/)
    if (listItemMatch && normalizeSlug(listItemMatch[2].trim()) === norm) {
      if (mode === "remove") continue
      // strikethrough / plain-text: replace the wikilink but keep the list item
      const replacement = mode === "strikethrough" ? `~~${title}~~` : title
      result.push(`${listItemMatch[1]}${replacement}`)
      continue
    }

    // Inline replacement
    const cleaned = line.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (match, target) => {
      if (normalizeSlug(target.trim()) !== norm) return match
      switch (mode) {
        case "strikethrough":
          return `~~${title}~~`
        case "plain-text":
          return title
        case "remove":
          return ""
      }
    })
    result.push(cleaned)
  }

  return result.join("\n")
}
