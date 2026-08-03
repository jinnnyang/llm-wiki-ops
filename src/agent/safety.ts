/**
 * agent/safety.ts — dry-run executor + pre-write snapshot.
 *
 * Design doc: §4.2.2, §5 (dry-run option)
 *
 * Dry-run: intercepts all write operations, records them without executing.
 * Snapshot: before the first write op, creates a git commit or zip backup.
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// ── Write tool detection ─────────────────────────────────────────────

const WRITE_TOOLS = new Set([
  // MCP write tools
  "wiki.add_node",
  "wiki.update_node",
  "wiki.delete_node",
  "wiki.rename_node",
  "wiki.add_edge",
  "wiki.remove_edge",
  "wiki.rebuild_index",
  // Local write tools
  "write_file",
  "edit_file",
])

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName)
}

// ── Dry-run record ───────────────────────────────────────────────────

export interface DryRunEntry {
  tool: string
  args: Record<string, unknown>
  timestamp: string
}

export class DryRunExecutor {
  readonly entries: DryRunEntry[] = []

  /** Record a write operation without executing it. */
  record(tool: string, args: Record<string, unknown>): string {
    const entry: DryRunEntry = {
      tool,
      args,
      timestamp: new Date().toISOString(),
    }
    this.entries.push(entry)
    return `[DRY-RUN] Would execute: ${tool}(${JSON.stringify(args).slice(0, 200)})`
  }

  /** Format the operation list for display. */
  summary(): string {
    if (this.entries.length === 0) return "No write operations recorded."
    const lines = this.entries.map((e, i) => {
      const key = Object.keys(e.args).slice(0, 3).map((k) => `${k}=${JSON.stringify(e.args[k]).slice(0, 40)}`).join(", ")
      return `  ${i + 1}. ${e.tool}(${key})`
    })
    return `Dry-run: ${this.entries.length} write operations would be executed:\n${lines.join("\n")}`
  }
}

// ── Pre-write snapshot ───────────────────────────────────────────────

export interface SnapshotResult {
  success: boolean
  method: "git" | "zip" | "none"
  path?: string
  error?: string
}

/**
 * Create a pre-write snapshot of the wiki directory.
 *
 * - If wiki has .git → git commit -am "llm-wiki: pre-agent snapshot (<command>)"
 * - If no .git → zip to .llm-wiki/snapshots/<timestamp>.zip
 * - Failure does NOT block the agent (returns success=false, warns to stderr)
 */
export function createPreWriteSnapshot(wikiRoot: string, command: string): SnapshotResult {
  const gitDir = join(wikiRoot, ".git")

  if (existsSync(gitDir)) {
    return createGitSnapshot(wikiRoot, command)
  }
  return createZipSnapshot(wikiRoot, command)
}

function createGitSnapshot(wikiRoot: string, command: string): SnapshotResult {
  try {
    // Stage all changes (including untracked) and commit
    execSync("git add -A", { cwd: wikiRoot, stdio: "pipe" })

    // Check if there's anything to commit
    const status = execSync("git status --porcelain", { cwd: wikiRoot, encoding: "utf-8", stdio: "pipe" })
    if (status.trim() === "") {
      // Nothing to commit — wiki is clean, snapshot is implicit
      return { success: true, method: "git", path: "(clean working tree)" }
    }

    const msg = `llm-wiki: pre-agent snapshot (${command})`
    execSync(`git commit -m "${msg}"`, { cwd: wikiRoot, stdio: "pipe" })

    const hash = execSync("git rev-parse --short HEAD", { cwd: wikiRoot, encoding: "utf-8", stdio: "pipe" }).trim()
    return { success: true, method: "git", path: `commit ${hash}` }
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[snapshot] git snapshot failed: ${msg}`)
    return { success: false, method: "git", error: msg }
  }
}

function createZipSnapshot(wikiRoot: string, command: string): SnapshotResult {
  try {
    const snapshotDir = join(wikiRoot, ".llm-wiki", "snapshots")
    mkdirSync(snapshotDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const zipPath = join(snapshotDir, `${timestamp}-${command}.zip`)

    // Use PowerShell Compress-Archive on Windows, zip on Unix
    const isWindows = process.platform === "win32"
    if (isWindows) {
      // PowerShell: compress wiki/ subdirectory
      const wikiDir = join(wikiRoot, "wiki")
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${wikiDir}' -DestinationPath '${zipPath}' -Force"`,
        { stdio: "pipe" },
      )
    } else {
      execSync(`cd "${wikiRoot}" && zip -r "${zipPath}" wiki/`, { stdio: "pipe" })
    }

    return { success: true, method: "zip", path: zipPath }
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[snapshot] zip snapshot failed: ${msg}`)
    return { success: false, method: "zip", error: msg }
  }
}
