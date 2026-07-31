/**
 * llm-wiki-ops — filesystem helpers.
 *
 * Design doc: §8.4 (write-to-temp + rename), §7.2 (platform notes)
 *
 * Key behaviors:
 * - Atomic writes via temp file + rename (same filesystem guaranteed)
 * - BOM stripping on read, no BOM on write
 * - CRLF detection: preserve original line-ending style
 * - Path length validation (Windows 260 limit)
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { WikiGraphError } from "../utils/errors.js"

const MAX_PATH_LENGTH = 240 // leave headroom under Windows 260

/**
 * Read a file, stripping UTF-8 BOM if present.
 * Returns { content, eol } where eol is "\r\n" or "\n".
 */
export async function readFileClean(
  filePath: string,
): Promise<{ content: string; eol: "\r\n" | "\n" }> {
  const raw = await fs.readFile(filePath, "utf-8")
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  return { content, eol }
}

/**
 * Write content to a file atomically: write to <path>.tmp-<txid>, then rename.
 * Preserves the file's original line-ending style if the file already exists.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  txid?: string,
): Promise<void> {
  validatePathLength(filePath)

  const id = txid ?? randomUUID().slice(0, 8)
  const tmpPath = `${filePath}.tmp-${id}`

  // Detect existing EOL to preserve style
  let eol: "\r\n" | "\n" = "\n"
  try {
    const existing = await fs.readFile(filePath, "utf-8")
    if (existing.includes("\r\n")) eol = "\r\n"
  } catch {
    // New file — default to \n
  }

  const normalized = eol === "\r\n" ? content.replace(/\r?\n/g, "\r\n") : content.replace(/\r\n/g, "\n")

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tmpPath, normalized, "utf-8")
  await fs.rename(tmpPath, filePath)
}

/**
 * Delete a file, ignoring ENOENT (idempotent).
 */
export async function deleteFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath)
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false
    throw e
  }
}

/**
 * Check if a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Stat a file, returning null if it doesn't exist.
 */
export async function statOrNull(
  filePath: string,
): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(filePath)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

/**
 * Recursively find all .md files under a directory.
 * Skips *.tmp-* files (design doc §8.4: readGraph exclusion).
 */
export async function findMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = []

  async function walk(d: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return // directory doesn't exist or unreadable
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue
        await walk(full)
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        !entry.name.includes(".tmp-")
      ) {
        results.push(full)
      }
    }
  }

  await walk(dir)
  return results.sort()
}

/**
 * Find leftover .tmp-* files under a directory (for cleanup).
 */
export async function findTmpFiles(dir: string): Promise<string[]> {
  const results: string[] = []

  async function walk(d: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue
        await walk(full)
      } else if (entry.isFile() && entry.name.includes(".tmp-")) {
        results.push(full)
      }
    }
  }

  await walk(dir)
  return results
}

function validatePathLength(filePath: string): void {
  if (filePath.length > MAX_PATH_LENGTH) {
    throw new WikiGraphError("PATH_TOO_LONG", `Path exceeds ${MAX_PATH_LENGTH} chars: ${filePath}`, {
      detail: `length=${filePath.length}`,
    })
  }
}
