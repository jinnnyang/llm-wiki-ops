/**
 * llm-wiki-ops — wiki-level exclusive write lock.
 *
 * Design doc: §8.2
 *
 * Uses proper-lockfile (advisory mutex, NOT a RW lock).
 * Lock file: <wikiRoot>/.llm-wiki-ops.lock
 * Timeout: 30s (covers 200+ file cascade rename).
 */

import lockfile from "proper-lockfile"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { LockTimeoutError } from "../utils/errors.js"

const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 60_000 // auto-release if holder crashes

export interface WikiLockHandle {
  release(): Promise<void>
}

/**
 * Acquire the wiki-level exclusive write lock.
 * Throws LockTimeoutError if the lock cannot be acquired within 30s.
 */
export async function acquireWikiLock(wikiRoot: string): Promise<WikiLockHandle> {
  const lockDir = path.join(wikiRoot, ".llm-wiki-ops")
  await fs.mkdir(lockDir, { recursive: true })

  // proper-lockfile locks a *directory* (or file). We lock the state dir.
  const start = Date.now()
  let release: (() => Promise<void>) | undefined

  try {
    release = await lockfile.lock(lockDir, {
      stale: LOCK_STALE_MS,
      retries: {
        retries: Math.ceil(LOCK_TIMEOUT_MS / 500),
        minTimeout: 200,
        maxTimeout: 1000,
        factor: 1.5,
      },
      onCompromised: (err) => {
        console.warn(`[llm-wiki-ops] lock compromised: ${err.message}`)
      },
    })
  } catch (e: unknown) {
    const waited = Date.now() - start
    // proper-lockfile throws code=ELOCKED when retries are exhausted.
    // Anything else (EACCES, disk errors, ...) is NOT a lock timeout —
    // rethrow the original so the real cause is visible.
    if ((e as NodeJS.ErrnoException)?.code === "ELOCKED") {
      throw new LockTimeoutError(path.join(lockDir, ".lock"), waited)
    }
    throw e
  }

  return {
    release: async () => {
      if (release) {
        await release()
        release = undefined
      }
    },
  }
}
