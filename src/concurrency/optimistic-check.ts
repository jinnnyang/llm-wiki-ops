/**
 * wiki-graph-ops — optimistic concurrency check (mtime + size).
 *
 * Design doc: §8.3
 *
 * Between the collect phase and the execute phase, we re-stat every
 * file to detect external modifications (Obsidian, git, VSCode, etc.).
 */

import { statOrNull } from "../io/fs-helpers.js"
import { ExternalModificationError } from "../utils/errors.js"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"

export interface FileSnapshot {
  path: string
  mtimeMs: number
  size: number
  sha256?: string // only when strictVerify
  expectExists: boolean
}

/**
 * Take a snapshot of a file for later verification.
 */
export async function snapshotFile(
  filePath: string,
  expectExists: boolean,
  strictVerify = false,
): Promise<FileSnapshot> {
  const stat = await statOrNull(filePath)

  if (!stat) {
    return { path: filePath, mtimeMs: 0, size: 0, expectExists }
  }

  let sha256: string | undefined
  if (strictVerify && expectExists) {
    const content = await fs.readFile(filePath)
    sha256 = crypto.createHash("sha256").update(content).digest("hex")
  }

  return {
    path: filePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256,
    expectExists,
  }
}

/**
 * Verify that files haven't changed since the snapshot was taken.
 * Throws ExternalModificationError if any file was modified externally.
 */
export async function verifySnapshots(
  snapshots: FileSnapshot[],
  strictVerify = false,
): Promise<void> {
  const conflicted: string[] = []

  for (const snap of snapshots) {
    const stat = await statOrNull(snap.path)

    if (snap.expectExists) {
      // File should exist and be unchanged
      if (!stat) {
        conflicted.push(snap.path)
        continue
      }
      if (stat.mtimeMs !== snap.mtimeMs || stat.size !== snap.size) {
        conflicted.push(snap.path)
        continue
      }
      if (strictVerify && snap.sha256) {
        const content = await fs.readFile(snap.path)
        const hash = crypto.createHash("sha256").update(content).digest("hex")
        if (hash !== snap.sha256) {
          conflicted.push(snap.path)
        }
      }
    } else {
      // File should NOT exist (new file creation)
      if (stat) {
        conflicted.push(snap.path)
      }
    }
  }

  if (conflicted.length > 0) {
    throw new ExternalModificationError(conflicted)
  }
}
