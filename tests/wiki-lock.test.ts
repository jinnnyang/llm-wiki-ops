/**
 * acquireWikiLock error classification: only proper-lockfile's ELOCKED
 * (lock held by another process, retries exhausted) becomes a
 * LockTimeoutError. Anything else (EACCES, disk errors, ...) must be
 * rethrown unchanged so the real cause stays visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

vi.mock("proper-lockfile", () => ({
  default: {
    lock: vi.fn(),
  },
}))

import lockfile from "proper-lockfile"
import { acquireWikiLock } from "../src/concurrency/wiki-lock.js"
import { LockTimeoutError } from "../src/utils/errors.js"

const mockLock = vi.mocked(lockfile.lock)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-lock-"))
  mockLock.mockReset()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("acquireWikiLock error classification", () => {
  it("ELOCKED → LockTimeoutError", async () => {
    const held = Object.assign(new Error("Lock file is being held"), { code: "ELOCKED" })
    mockLock.mockRejectedValue(held)

    await expect(acquireWikiLock(tmpDir)).rejects.toBeInstanceOf(LockTimeoutError)
  })

  it("non-ELOCKED errors are rethrown unchanged", async () => {
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" })
    mockLock.mockRejectedValue(eacces)

    await expect(acquireWikiLock(tmpDir)).rejects.toBe(eacces)
  })

  it("successful lock returns a working handle", async () => {
    const release = vi.fn()
    mockLock.mockResolvedValue(release as unknown as () => Promise<void>)

    const handle = await acquireWikiLock(tmpDir)
    await handle.release()
    expect(release).toHaveBeenCalledTimes(1)

    // Idempotent release
    await handle.release()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
