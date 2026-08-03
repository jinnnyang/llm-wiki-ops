/**
 * agent/env.ts — minimal .env loader (zero dependencies).
 *
 * Parses KEY=VALUE lines, strips surrounding single/double quotes,
 * ignores comments (#) and blank lines. Does NOT override existing
 * process.env values (real env vars win over .env file).
 *
 * Discovery: walks up from `startDir` (default cwd) looking for `.env`.
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"

/** Find .env by walking up from startDir. Returns null if not found. */
function findDotEnv(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, ".env")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null // reached filesystem root
    dir = parent
  }
}

/** Parse .env content into a key-value map. */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // Strip surrounding quotes (single or double)
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

let loaded = false

/**
 * Load .env into process.env (idempotent, call-safe).
 * Existing process.env values are never overridden.
 */
export function loadEnv(startDir: string = process.cwd()): void {
  if (loaded) return
  loaded = true
  const envPath = findDotEnv(startDir)
  if (!envPath) return
  const vars = parseDotEnv(readFileSync(envPath, "utf-8"))
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}
