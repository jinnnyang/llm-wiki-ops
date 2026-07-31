/**
 * wiki-graph-ops — node operations (add / update / rename / delete).
 *
 * Design doc: §6.3
 *
 * All operations are idempotent (§16 decision 23).
 * All mutations bump `updated` to today (§16 decision 20).
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { parseFrontmatter, serializeFrontmatter } from "../io/frontmatter.js"
import { extractWikilinkSlugs, replaceWikilinks, danglingWikilink, removeWikilinks } from "../io/wikilink.js"
import { readFileClean, writeFileAtomic, deleteFileIfExists, fileExists, findMarkdownFiles } from "../io/fs-helpers.js"
import { titleToSlug, normalizeSlug, slugStartsWithDigit } from "../utils/slug.js"
import { executeTransaction, type FileChange } from "../transaction/transaction.js"
import {
  addIndexEntry,
  removeIndexEntry,
  updateIndexEntry,
  rebuildIndexPreservingCustom,
} from "./index-maintainer.js"
import { scanWiki } from "./graph-builder.js"
import { WikiGraphError, InvalidSlugError } from "../utils/errors.js"
import {
  type AddNodeInput,
  type AddNodeResult,
  type UpdateNodePatch,
  type UpdateNodeResult,
  type RenameNodeOptions,
  type RenameResult,
  type DeleteNodeOptions,
  type DeleteResult,
  type RebuildIndexResult,
  type PageType,
  type GraphNode,
  type MutationResult,
  TYPE_DIR_MAP,
  INFRA_FILES,
} from "../types.js"

// ── Helpers ─────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Resolve the directory for a page type. */
function typeDir(type: PageType): string {
  const known = TYPE_DIR_MAP[type as keyof typeof TYPE_DIR_MAP]
  if (known !== undefined) return known
  return type // unknown types: wiki/<type>/
}

/** Find a file by slug across all subdirectories. Returns absPath or null. */
async function findPageBySlug(wikiDir: string, slug: string): Promise<string | null> {
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

/** Build frontmatter + body into a full page string. */
function composePage(fm: Record<string, unknown>, body: string): string {
  return `${serializeFrontmatter(fm)}\n${body}`
}

/** Parse a page file into frontmatter record + body. */
async function parsePage(absPath: string): Promise<{
  fm: Record<string, unknown>
  body: string
  rawBlock: string
}> {
  const { content } = await readFileClean(absPath)
  const { frontmatter, body, rawBlock } = parseFrontmatter(content)
  return { fm: (frontmatter as Record<string, unknown>) ?? {}, body, rawBlock }
}

function baseMutation(wikiRoot: string, dryRun: boolean): MutationResult {
  return { filesTouched: [], indexUpdated: false, wikiRootUsed: wikiRoot, dryRun }
}

// ── addNode ─────────────────────────────────────────────────────────

export async function addNode(
  wikiDir: string,
  wikiRoot: string,
  input: AddNodeInput,
  maintainIndex: boolean,
  strictVerify: boolean,
): Promise<AddNodeResult> {
  const result: AddNodeResult = {
    ...baseMutation(wikiRoot, input.dryRun ?? false),
    slug: "",
    requestedSlug: "",
    slugCollided: false,
    slugStartsWithDigit: false,
    danglingRelated: [],
    path: "",
  }

  const requestedSlug = titleToSlug(input.title)
  result.requestedSlug = requestedSlug
  result.slugStartsWithDigit = slugStartsWithDigit(requestedSlug)

  const type: PageType = input.type ?? "synthesis"

  if (type === "source") {
    result.sourcesWarning = true
  }

  // Auto-sync wikilinks from content into related (§16 decision 2)
  const contentWikilinks = input.content ? extractWikilinkSlugs(input.content) : []
  const mergedRelated = [...new Set([...(input.related ?? []), ...contentWikilinks])].map((r) =>
    normalizeSlug(r),
  )

  // Check for dangling related
  const existingPages = await scanWiki(wikiDir, wikiRoot)
  const existingSlugs = new Set(existingPages.map((p) => p.slug))
  result.danglingRelated = mergedRelated.filter((r) => !existingSlugs.has(r))

  // Determine target path
  const dir = typeDir(type)
  const targetDir = dir ? path.join(wikiDir, dir) : wikiDir
  let slug = requestedSlug
  let targetPath = path.join(targetDir, `${slug}.md`)

  // Slug conflict detection (case-insensitive across ALL subdirs)
  const existingPath = await findPageBySlug(wikiDir, slug)
  if (existingPath) {
    // Check idempotency: same content → no-op
    const { fm: existingFm, body: existingBody } = await parsePage(existingPath)
    if (isSemanticMatch(existingFm, existingBody, input, mergedRelated)) {
      result.slug = normalizeSlug(path.basename(existingPath, ".md"))
      result.path = path.relative(wikiRoot, existingPath).replace(/\\/g, "/")
      return result // no-op
    }

    if (input.onSlugConflict === "error") {
      throw new WikiGraphError("NODE_ALREADY_EXISTS", `Slug "${slug}" already exists`, { slug })
    }

    // Append -2, -3, ...
    let counter = 2
    while (await findPageBySlug(wikiDir, `${requestedSlug}-${counter}`)) {
      counter++
    }
    slug = `${requestedSlug}-${counter}`
    targetPath = path.join(targetDir, `${slug}.md`)
    result.slugCollided = true
  }

  result.slug = slug
  result.path = path.relative(wikiRoot, targetPath).replace(/\\/g, "/")

  // Build page content
  const fm: Record<string, unknown> = {
    type: type,
    title: input.title,
    created: today(),
    updated: today(),
  }
  if (input.tags && input.tags.length > 0) fm.tags = input.tags
  if (mergedRelated.length > 0) fm.related = mergedRelated
  if (input.sources && input.sources.length > 0) fm.sources = input.sources

  const body = input.content ? `# ${input.title}\n\n${input.content}\n` : `# ${input.title}\n`
  const pageContent = composePage(fm, body)

  const changes: FileChange[] = [
    { path: targetPath, oldContent: null, newContent: pageContent, expectExists: false },
  ]

  // Index maintenance
  if (maintainIndex) {
    const indexPath = path.join(wikiDir, "index.md")
    const indexExists = await fileExists(indexPath)
    let indexContent = ""
    if (indexExists) {
      const { content } = await readFileClean(indexPath)
      indexContent = content
    } else {
      indexContent = "# Wiki Index\n"
    }

    const node: GraphNode = {
      slug,
      title: input.title,
      type: type,
      tags: input.tags ?? [],
      related: mergedRelated,
      sources: input.sources ?? [],
      created: fm.created as string,
      updated: fm.updated as string,
      path: result.path,
    }

    const newIndex = addIndexEntry(indexContent, node)
    changes.push({
      path: indexPath,
      oldContent: indexExists ? indexContent : null,
      newContent: newIndex,
      expectExists: indexExists,
    })
    result.indexUpdated = true
  }

  const tx = await executeTransaction(changes, {
    wikiRoot,
    strictVerify,
    dryRun: input.dryRun,
  })

  result.filesTouched = tx.filesWritten.map((f) =>
    path.relative(wikiRoot, f).replace(/\\/g, "/"),
  )
  return result
}

/** Check if existing page semantically matches the input (idempotency). */
function isSemanticMatch(
  existingFm: Record<string, unknown>,
  existingBody: string,
  input: AddNodeInput,
  mergedRelated: string[],
): boolean {
  if (existingFm.title !== input.title) return false
  if (existingFm.type !== (input.type ?? "synthesis")) return false

  // Set comparison for tags/related
  const existingTags = new Set(
    Array.isArray(existingFm.tags) ? existingFm.tags : [],
  )
  const inputTags = new Set(input.tags ?? [])
  if (existingTags.size !== inputTags.size) return false
  for (const t of inputTags) if (!existingTags.has(t)) return false

  const existingRelated = new Set(
    (Array.isArray(existingFm.related) ? existingFm.related : []).map((r: string) =>
      normalizeSlug(String(r)),
    ),
  )
  const inputRelated = new Set(mergedRelated)
  if (existingRelated.size !== inputRelated.size) return false
  for (const r of inputRelated) if (!existingRelated.has(r)) return false

  // Content trim comparison
  const existingContent = existingBody.trim()
  const inputContent = (input.content ? `# ${input.title}\n\n${input.content}\n` : `# ${input.title}\n`).trim()
  return existingContent === inputContent
}

// ── updateNode ──────────────────────────────────────────────────────

export async function updateNode(
  wikiDir: string,
  wikiRoot: string,
  slug: string,
  patch: UpdateNodePatch,
  maintainIndex: boolean,
  strictVerify: boolean,
): Promise<UpdateNodeResult> {
  const norm = normalizeSlug(slug)
  const result: UpdateNodeResult = {
    ...baseMutation(wikiRoot, patch.dryRun ?? false),
    slug: norm,
    fieldsChanged: [],
  }

  const absPath = await findPageBySlug(wikiDir, norm)
  if (!absPath) {
    throw new WikiGraphError("NODE_NOT_FOUND", `Node "${slug}" not found`, { slug: norm })
  }

  const { fm, body } = await parsePage(absPath)
  const changes: FileChange[] = []
  let newBody = body
  let moved: { from: string; to: string } | undefined

  // Track field changes
  if (patch.title !== undefined && patch.title !== fm.title) {
    fm.title = patch.title
    result.fieldsChanged.push("title")
  }

  if (patch.type !== undefined && patch.type !== fm.type) {
    const oldType = fm.type as string
    fm.type = patch.type
    result.fieldsChanged.push("type")

    // Cross-directory move
    const oldDir = typeDir(oldType as PageType)
    const newDir = typeDir(patch.type)
    if (oldDir !== newDir) {
      const newDirPath = newDir ? path.join(wikiDir, newDir) : wikiDir
      const newPath = path.join(newDirPath, `${path.basename(absPath)}`)

      if (await fileExists(newPath)) {
        throw new WikiGraphError("NODE_ALREADY_EXISTS", `Target path already exists: ${newPath}`, {
          slug: norm,
        })
      }

      moved = {
        from: path.relative(wikiRoot, absPath).replace(/\\/g, "/"),
        to: path.relative(wikiRoot, newPath).replace(/\\/g, "/"),
      }

      // Delete old, write new
      const newContent = composePage(fm, newBody)
      changes.push({ path: absPath, oldContent: null, newContent: null, expectExists: true })
      changes.push({ path: newPath, oldContent: null, newContent: newContent, expectExists: false })
    }
  }

  if (patch.content !== undefined) {
    newBody = `\n# ${fm.title}\n\n${patch.content}\n`
    result.fieldsChanged.push("content")
  }

  if (patch.tags !== undefined) {
    fm.tags = patch.tags
    result.fieldsChanged.push("tags")
  }

  if (patch.related !== undefined) {
    fm.related = patch.related.map((r) => normalizeSlug(r))
    result.fieldsChanged.push("related")
  }

  if (patch.sources !== undefined) {
    fm.sources = patch.sources
    result.fieldsChanged.push("sources")
  }

  if (result.fieldsChanged.length === 0) {
    return result // no-op (idempotent)
  }

  // Bump updated
  fm.updated = today()

  // If no cross-dir move, write in place
  if (!moved) {
    const newContent = composePage(fm, newBody)
    const { content: oldContent } = await readFileClean(absPath)
    changes.push({ path: absPath, oldContent, newContent, expectExists: true })
  } else {
    // Update the new-path change with bumped fm
    const newChange = changes.find((c) => c.newContent !== null)
    if (newChange) {
      newChange.newContent = composePage(fm, newBody)
    }
  }

  result.moved = moved

  // Index maintenance
  if (maintainIndex) {
    const indexPath = path.join(wikiDir, "index.md")
    if (await fileExists(indexPath)) {
      const { content: indexContent } = await readFileClean(indexPath)
      const node: GraphNode = {
        slug: norm,
        title: (fm.title as string) ?? norm,
        type: (fm.type as PageType) ?? "unknown",
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        related: Array.isArray(fm.related) ? fm.related : [],
        sources: Array.isArray(fm.sources) ? fm.sources : [],
        created: (fm.created as string) ?? "",
        updated: fm.updated as string,
        path: moved ? moved.to : path.relative(wikiRoot, absPath).replace(/\\/g, "/"),
      }
      const newIndex = updateIndexEntry(indexContent, norm, node)
      changes.push({ path: indexPath, oldContent: indexContent, newContent: newIndex, expectExists: true })
      result.indexUpdated = true
    }
  }

  const tx = await executeTransaction(changes, {
    wikiRoot,
    strictVerify,
    dryRun: patch.dryRun,
  })

  result.filesTouched = tx.filesWritten.map((f) =>
    path.relative(wikiRoot, f).replace(/\\/g, "/"),
  )
  return result
}

// ── renameNode ──────────────────────────────────────────────────────

export async function renameNode(
  wikiDir: string,
  wikiRoot: string,
  oldSlug: string,
  newSlug: string,
  options?: RenameNodeOptions,
  maintainIndex = true,
  strictVerify = false,
): Promise<RenameResult> {
  const oldNorm = normalizeSlug(oldSlug)
  const newNorm = normalizeSlug(newSlug)
  const result: RenameResult = {
    ...baseMutation(wikiRoot, options?.dryRun ?? false),
    oldSlug: oldNorm,
    newSlug: newNorm,
    referencesUpdated: 0,
  }

  const oldPath = await findPageBySlug(wikiDir, oldNorm)

  // Idempotency: old doesn't exist but new does → no-op
  if (!oldPath) {
    const newPath = await findPageBySlug(wikiDir, newNorm)
    if (newPath) {
      return result // already renamed
    }
    throw new WikiGraphError("NODE_NOT_FOUND", `Node "${oldSlug}" not found`, { slug: oldNorm })
  }

  // New slug already exists (and it's not the same file)
  const newPathCheck = await findPageBySlug(wikiDir, newNorm)
  if (newPathCheck && normalizeSlug(path.basename(newPathCheck, ".md")) !== oldNorm) {
    throw new WikiGraphError("RENAME_TARGET_EXISTS", `Slug "${newSlug}" already exists`, {
      slug: oldNorm,
      targetSlug: newNorm,
    })
  }

  // Same-directory rename
  const dir = path.dirname(oldPath)
  const newPath = path.join(dir, `${newNorm}.md`)

  const changes: FileChange[] = []

  // Read old file, update its internal references if any self-refs
  const { content: oldContent } = await readFileClean(oldPath)
  const { fm, body } = await parsePage(oldPath)
  fm.updated = today()
  const newPageContent = composePage(fm, body)

  changes.push({ path: oldPath, oldContent, newContent: null, expectExists: true })
  changes.push({ path: newPath, oldContent: null, newContent: newPageContent, expectExists: false })

  result.moved = {
    from: path.relative(wikiRoot, oldPath).replace(/\\/g, "/"),
    to: path.relative(wikiRoot, newPath).replace(/\\/g, "/"),
  }

  // Update all references across the wiki
  const allFiles = await findMarkdownFiles(wikiDir)
  for (const file of allFiles) {
    if (file === oldPath) continue
    if (INFRA_FILES.has(path.basename(file))) continue

    const { content } = await readFileClean(file)
    let updated = replaceWikilinks(content, oldNorm, newNorm)

    // Also update related[] in frontmatter
    const parsed = parseFrontmatter(updated)
    if (parsed.frontmatter && Array.isArray(parsed.frontmatter.related)) {
      const related = parsed.frontmatter.related as string[]
      const hasOld = related.some((r) => normalizeSlug(r) === oldNorm)
      if (hasOld) {
        const newRelated = related.map((r) =>
          normalizeSlug(r) === oldNorm ? newNorm : r,
        )
        // Rebuild with updated related
        const fmParsed = (parsed.frontmatter as Record<string, unknown>)
        fmParsed.related = newRelated
        fmParsed.updated = today()
        updated = composePage(fmParsed, parsed.body)
      }
    }

    if (updated !== content) {
      changes.push({ path: file, oldContent: content, newContent: updated, expectExists: true })
      result.referencesUpdated++
    }
  }

  // Index maintenance
  if (maintainIndex) {
    const indexPath = path.join(wikiDir, "index.md")
    if (await fileExists(indexPath)) {
      const { content: indexContent } = await readFileClean(indexPath)
      const node: GraphNode = {
        slug: newNorm,
        title: (fm.title as string) ?? newNorm,
        type: (fm.type as PageType) ?? "unknown",
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        related: Array.isArray(fm.related) ? fm.related : [],
        sources: Array.isArray(fm.sources) ? fm.sources : [],
        created: (fm.created as string) ?? "",
        updated: fm.updated as string,
        path: result.moved.to,
      }
      const newIndex = updateIndexEntry(indexContent, oldNorm, node)
      changes.push({ path: indexPath, oldContent: indexContent, newContent: newIndex, expectExists: true })
      result.indexUpdated = true
    }
  }

  const tx = await executeTransaction(changes, {
    wikiRoot,
    strictVerify,
    dryRun: options?.dryRun,
  })

  result.filesTouched = tx.filesWritten.map((f) =>
    path.relative(wikiRoot, f).replace(/\\/g, "/"),
  )
  return result
}

// ── deleteNode ──────────────────────────────────────────────────────

export async function deleteNode(
  wikiDir: string,
  wikiRoot: string,
  slug: string,
  options?: DeleteNodeOptions,
  maintainIndex = true,
  strictVerify = false,
): Promise<DeleteResult> {
  const norm = normalizeSlug(slug)
  const mode = options?.danglingRefs ?? "strikethrough"
  const result: DeleteResult = {
    ...baseMutation(wikiRoot, options?.dryRun ?? false),
    deletedPath: "",
    referencesUpdated: 0,
  }

  const absPath = await findPageBySlug(wikiDir, norm)

  // Idempotency: not found → no-op
  if (!absPath) {
    return result
  }

  result.deletedPath = path.relative(wikiRoot, absPath).replace(/\\/g, "/")

  // Read title BEFORE deleting (§6.3: read title first)
  let title = norm
  try {
    const { fm } = await parsePage(absPath)
    if (fm.title && typeof fm.title === "string") title = fm.title
  } catch {
    // Fall back to slug
  }

  const changes: FileChange[] = []

  // Delete the file
  const { content: oldContent } = await readFileClean(absPath)
  changes.push({ path: absPath, oldContent, newContent: null, expectExists: true })

  // Clean references in all other files
  const allFiles = await findMarkdownFiles(wikiDir)
  for (const file of allFiles) {
    if (file === absPath) continue
    if (INFRA_FILES.has(path.basename(file))) continue

    const { content } = await readFileClean(file)
    let updated = content

    // Handle wikilinks in body
    updated = danglingWikilink(updated, norm, title, mode)

    // Handle related[] in frontmatter — always remove
    const parsed = parseFrontmatter(updated)
    if (parsed.frontmatter && Array.isArray(parsed.frontmatter.related)) {
      const related = parsed.frontmatter.related as string[]
      const hasRef = related.some((r) => normalizeSlug(r) === norm)
      if (hasRef) {
        const newRelated = related.filter((r) => normalizeSlug(r) !== norm)
        const fmParsed = parsed.frontmatter as Record<string, unknown>
        fmParsed.related = newRelated
        fmParsed.updated = today()
        updated = composePage(fmParsed, parsed.body)
      }
    }

    if (updated !== content) {
      changes.push({ path: file, oldContent: content, newContent: updated, expectExists: true })
      result.referencesUpdated++
    }
  }

  // Index maintenance — always remove
  if (maintainIndex) {
    const indexPath = path.join(wikiDir, "index.md")
    if (await fileExists(indexPath)) {
      const { content: indexContent } = await readFileClean(indexPath)
      const newIndex = removeIndexEntry(indexContent, norm)
      if (newIndex !== indexContent) {
        changes.push({ path: indexPath, oldContent: indexContent, newContent: newIndex, expectExists: true })
        result.indexUpdated = true
      }
    }
  }

  const tx = await executeTransaction(changes, {
    wikiRoot,
    strictVerify,
    dryRun: options?.dryRun,
  })

  result.filesTouched = tx.filesWritten.map((f) =>
    path.relative(wikiRoot, f).replace(/\\/g, "/"),
  )
  return result
}

// ── rebuildIndex ────────────────────────────────────────────────────

export async function rebuildIndex(
  wikiDir: string,
  wikiRoot: string,
  strictVerify = false,
): Promise<RebuildIndexResult> {
  const result: RebuildIndexResult = {
    ...baseMutation(wikiRoot, false),
    entriesWritten: 0,
  }

  const pages = await scanWiki(wikiDir, wikiRoot)
  const nodes: GraphNode[] = pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    type: p.type,
    tags: p.tags,
    related: p.related,
    sources: p.sources,
    created: p.created,
    updated: p.updated,
    path: p.path,
  }))

  const indexPath = path.join(wikiDir, "index.md")
  let existingContent: string | null = null
  if (await fileExists(indexPath)) {
    const { content } = await readFileClean(indexPath)
    existingContent = content
  }

  const newContent = rebuildIndexPreservingCustom(existingContent, nodes)
  result.entriesWritten = nodes.length

  const changes: FileChange[] = [
    {
      path: indexPath,
      oldContent: existingContent,
      newContent,
      expectExists: existingContent !== null,
    },
  ]

  const tx = await executeTransaction(changes, { wikiRoot, strictVerify })
  result.filesTouched = tx.filesWritten.map((f) =>
    path.relative(wikiRoot, f).replace(/\\/g, "/"),
  )
  result.indexUpdated = true

  return result
}
