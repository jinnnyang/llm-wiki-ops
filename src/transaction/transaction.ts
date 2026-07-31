/**
 * llm-wiki-ops — multi-file transaction with best-effort rollback.
 *
 * Design doc: §8.5
 *
 * Flow: collect → lock → verify → execute → release
 * On failure: reverse-order rollback of completed writes.
 * Large cascades (>10 files): write .inflight-<txid>.json marker.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { writeFileAtomic, deleteFileIfExists } from "../io/fs-helpers.js"
import { acquireWikiLock } from "../concurrency/wiki-lock.js"
import { snapshotFile, verifySnapshots, type FileSnapshot } from "../concurrency/optimistic-check.js"
import {
  TransactionRollbackError,
  TransactionDirtyError,
} from "../utils/errors.js"

export interface FileChange {
  path: string
  oldContent: string | null // null = file didn't exist (new file)
  newContent: string | null // null = delete file
  expectExists: boolean
}

export interface TransactionOptions {
  wikiRoot: string
  strictVerify?: boolean
  dryRun?: boolean
}

export interface TransactionResult {
  txid: string
  filesWritten: string[]
}

const LARGE_CASCADE_THRESHOLD = 10

/**
 * Execute a set of file changes atomically (best-effort).
 *
 * dryRun: skip lock/verify/write, just return the file list.
 */
export async function executeTransaction(
  changes: FileChange[],
  opts: TransactionOptions,
): Promise<TransactionResult> {
  const txid = randomUUID().slice(0, 8)
  const filesWritten: string[] = []

  if (opts.dryRun) {
    return { txid, filesWritten: changes.map((c) => c.path) }
  }

  if (changes.length === 0) {
    return { txid, filesWritten: [] }
  }

  // ── Collect phase: snapshot all files ──
  const snapshots: FileSnapshot[] = []
  for (const change of changes) {
    snapshots.push(await snapshotFile(change.path, change.expectExists, opts.strictVerify))
  }

  // ── Lock phase ──
  const lock = await acquireWikiLock(opts.wikiRoot)

  try {
    // ── Verify phase ──
    await verifySnapshots(snapshots, opts.strictVerify)

    // ── Inflight marker for large cascades ──
    const inflightPath = path.join(opts.wikiRoot, ".llm-wiki-ops", `.inflight-${txid}.json`)
    if (changes.length > LARGE_CASCADE_THRESHOLD) {
      await fs.mkdir(path.dirname(inflightPath), { recursive: true })
      await fs.writeFile(
        inflightPath,
        JSON.stringify({ txid, changes: changes.map((c) => c.path), startedAt: new Date().toISOString() }),
        "utf-8",
      )
    }

    // ── Execute phase ──
    const completed: FileChange[] = []
    try {
      for (const change of changes) {
        if (change.newContent === null) {
          // Delete
          await deleteFileIfExists(change.path)
        } else {
          // Write (atomic)
          await writeFileAtomic(change.path, change.newContent, txid)
        }
        completed.push(change)
        filesWritten.push(change.path)
      }
    } catch (execErr) {
      // ── Rollback phase (best-effort, reverse order) ──
      const dirtyPaths: string[] = []
      for (let i = completed.length - 1; i >= 0; i--) {
        const c = completed[i]
        try {
          if (c.oldContent === null) {
            // Was a new file → delete it
            await deleteFileIfExists(c.path)
          } else {
            // Restore original content
            await writeFileAtomic(c.path, c.oldContent, txid)
          }
        } catch {
          dirtyPaths.push(c.path)
        }
      }

      // Clean up inflight marker
      await deleteFileIfExists(inflightPath).catch(() => {})

      if (dirtyPaths.length > 0) {
        throw new TransactionDirtyError(txid, dirtyPaths)
      }
      throw new TransactionRollbackError({
        txid,
        phase: "executing",
        rollbackStatus: "complete",
        dirtyPaths: [],
        retryable: true,
      })
    }

    // ── Clean up inflight marker ──
    if (changes.length > LARGE_CASCADE_THRESHOLD) {
      await deleteFileIfExists(inflightPath).catch(() => {})
    }

    return { txid, filesWritten }
  } finally {
    // ── Release phase ──
    await lock.release()
  }
}
