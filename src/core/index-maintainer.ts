/**
 * llm-wiki-ops — index.md maintenance.
 *
 * Design doc: §9, §6.6
 *
 * Format:
 *   # Wiki Index
 *   ## Entities
 *   - [[slug]] — title
 *   ## Concepts
 *   ...
 *   ## Other        ← unknown types, sorted by slug
 *
 * rebuildIndex preserves custom (non-type) sections.
 */

import * as path from "node:path"
import { readFileClean, writeFileAtomic, fileExists } from "../io/fs-helpers.js"
import {
  type PageType,
  type GraphNode,
  KNOWN_TYPE_ORDER,
} from "../types.js"

/** Section heading for a given type. */
function typeHeading(type: PageType): string {
  // Capitalize first letter for display
  const label = type === "entity" ? "Entities"
    : type === "concept" ? "Concepts"
    : type === "source" ? "Sources"
    : type === "query" ? "Queries"
    : type === "comparison" ? "Comparisons"
    : type === "synthesis" ? "Synthesis"
    : type === "overview" ? "Overview"
    : null

  if (label) return `## ${label}`
  return `## ${type.charAt(0).toUpperCase()}${type.slice(1)}`
}

/** All known type headings (for detecting custom sections). */
const KNOWN_HEADINGS = new Set([
  "## Entities",
  "## Concepts",
  "## Sources",
  "## Queries",
  "## Comparisons",
  "## Synthesis",
  "## Overview",
  "## Other",
])

/**
 * Generate the full index.md content from a list of nodes.
 */
export function generateIndexContent(nodes: GraphNode[]): string {
  const lines: string[] = ["# Wiki Index", ""]

  // Group by type
  const groups = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const key = node.type
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(node)
  }

  // Known types in order
  for (const type of KNOWN_TYPE_ORDER) {
    const group = groups.get(type)
    if (!group || group.length === 0) continue
    lines.push(typeHeading(type), "")
    for (const node of group.sort((a, b) => a.slug.localeCompare(b.slug))) {
      lines.push(`- [[${node.slug}]] — ${node.title}`)
    }
    lines.push("")
  }

  // Unknown types → "## Other" section, sorted by slug
  const unknownNodes: GraphNode[] = []
  for (const [type, group] of groups) {
    if (!KNOWN_TYPE_ORDER.includes(type as (typeof KNOWN_TYPE_ORDER)[number])) {
      unknownNodes.push(...group)
    }
  }
  if (unknownNodes.length > 0) {
    lines.push("## Other", "")
    for (const node of unknownNodes.sort((a, b) => a.slug.localeCompare(b.slug))) {
      lines.push(`- [[${node.slug}]] — ${node.title}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * Incrementally add a node entry to index.md.
 */
export function addIndexEntry(indexContent: string, node: GraphNode): string {
  const heading = typeHeading(node.type)
  const entry = `- [[${node.slug}]] — ${node.title}`
  const lines = indexContent.split("\n")

  // Find the heading
  let headingIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) {
      headingIdx = i
      break
    }
  }

  if (headingIdx === -1) {
    // Section doesn't exist — append it before "## Other" or at end
    const otherIdx = lines.findIndex((l) => l.trim() === "## Other")
    const insertAt = otherIdx !== -1 ? otherIdx : lines.length

    const section = [heading, "", entry, ""]
    lines.splice(insertAt, 0, ...section)
    return lines.join("\n")
  }

  // Find insertion point within section (sorted by slug)
  let insertIdx = headingIdx + 1
  // Skip blank line after heading
  if (insertIdx < lines.length && lines[insertIdx].trim() === "") insertIdx++

  while (insertIdx < lines.length) {
    const line = lines[insertIdx].trim()
    if (line === "" || line.startsWith("## ")) break
    // Compare slug for sort order
    const m = line.match(/^- \[\[([^\]]+)\]\]/)
    if (m && m[1].localeCompare(node.slug) > 0) break
    insertIdx++
  }

  lines.splice(insertIdx, 0, entry)
  return lines.join("\n")
}

/**
 * Remove a node entry from index.md.
 */
export function removeIndexEntry(indexContent: string, slug: string): string {
  const lines = indexContent.split("\n")
  return lines
    .filter((line) => {
      const m = line.match(/^- \[\[([^\]]+)\]\]/)
      return !(m && m[1] === slug)
    })
    .join("\n")
}

/**
 * Update a node entry in index.md (slug and/or title change).
 */
export function updateIndexEntry(
  indexContent: string,
  oldSlug: string,
  node: GraphNode,
): string {
  const lines = indexContent.split("\n")
  const result = lines.map((line) => {
    const m = line.match(/^- \[\[([^\]]+)\]\] — (.*)$/)
    if (m && m[1] === oldSlug) {
      return `- [[${node.slug}]] — ${node.title}`
    }
    return line
  })
  return result.join("\n")
}

/**
 * Rebuild index.md, preserving custom (non-type) sections.
 * Design doc: §6.6
 */
export function rebuildIndexPreservingCustom(
  existingContent: string | null,
  nodes: GraphNode[],
): string {
  const generated = generateIndexContent(nodes)

  if (!existingContent) return generated

  // Parse existing content: extract custom sections
  const customSections: string[] = []
  const lines = existingContent.split("\n")
  let currentSection: string[] = []
  let inCustom = false

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Flush previous
      if (inCustom && currentSection.length > 0) {
        customSections.push(currentSection.join("\n"))
      }
      currentSection = [line]
      inCustom = !KNOWN_HEADINGS.has(line.trim())
    } else if (line.startsWith("# ") && !line.startsWith("## ")) {
      // Top-level heading (e.g. "# Wiki Index") — skip
      if (inCustom && currentSection.length > 0) {
        customSections.push(currentSection.join("\n"))
      }
      currentSection = []
      inCustom = false
    } else {
      currentSection.push(line)
    }
  }
  if (inCustom && currentSection.length > 0) {
    customSections.push(currentSection.join("\n"))
  }

  if (customSections.length === 0) return generated

  // Append custom sections after generated content
  const trimmed = generated.trimEnd()
  return `${trimmed}\n\n${customSections.join("\n\n")}\n`
}
