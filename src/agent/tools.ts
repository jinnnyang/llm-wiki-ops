/**
 * agent/tools.ts — local filesystem tools for agent loop.
 *
 * Design doc: §4.4
 * v1: read_file, write_file, edit_file, list_directory.
 * No run_shell (security). All paths sandboxed to wiki root.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { resolve, relative, join, dirname } from "node:path"
import type { ToolDefinition } from "./openai.js"
import { loadEnv } from "./env.js"

// ── Types ────────────────────────────────────────────────────────────

export interface LocalToolResult {
  content: string
  isError?: boolean
}

export interface LocalToolRegistry {
  definitions: ToolDefinition[]
  execute(name: string, args: Record<string, unknown>): Promise<LocalToolResult>
}

// ── Path sandbox ─────────────────────────────────────────────────────

function resolveSandboxed(wikiRoot: string, userPath: string): string {
  const resolved = resolve(wikiRoot, userPath)
  const rel = relative(wikiRoot, resolved)
  if (rel.startsWith("..") || resolve(wikiRoot, rel) !== resolved) {
    throw new Error(`Path escapes wiki root: "${userPath}"`)
  }
  return resolved
}

// ── Truncation ───────────────────────────────────────────────────────

const MAX_READ_BYTES = 50 * 1024 // 50KB
const MAX_READ_LINES = 2000

function truncateContent(text: string, label: string): string {
  const lines = text.split("\n")
  let truncated = false
  let result = lines
  if (lines.length > MAX_READ_LINES) {
    result = lines.slice(0, MAX_READ_LINES)
    truncated = true
  }
  let joined = result.join("\n")
  if (Buffer.byteLength(joined, "utf-8") > MAX_READ_BYTES) {
    // Byte-level truncation
    const buf = Buffer.from(joined, "utf-8")
    joined = buf.subarray(0, MAX_READ_BYTES).toString("utf-8")
    // Cut at last complete line
    const lastNl = joined.lastIndexOf("\n")
    if (lastNl > 0) joined = joined.slice(0, lastNl)
    truncated = true
  }
  if (truncated) {
    joined += `\n[truncated — ${label} exceeds read limit]`
  }
  return joined
}

// ── Tool implementations ─────────────────────────────────────────────

function toolReadFile(wikiRoot: string, args: Record<string, unknown>): LocalToolResult {
  const path = args["path"] as string | undefined
  const offset = (args["offset"] as number) ?? 1
  const limit = (args["limit"] as number) ?? 500
  if (!path) return { content: "Error: 'path' is required", isError: true }

  let resolved: string
  try {
    resolved = resolveSandboxed(wikiRoot, path)
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true }
  }

  if (!existsSync(resolved)) {
    return { content: `Error: file not found: ${path}`, isError: true }
  }

  try {
    const raw = readFileSync(resolved, "utf-8")
    const allLines = raw.split("\n")
    const start = Math.max(0, offset - 1) // 1-indexed → 0-indexed
    const slice = allLines.slice(start, start + limit)
    const numbered = slice.map((line, i) => `${start + i + 1}|${line}`).join("\n")
    const footer =
      start + limit < allLines.length
        ? `\n[showing lines ${start + 1}–${start + slice.length} of ${allLines.length}]`
        : ""
    return { content: truncateContent(numbered + footer, path) }
  } catch (e) {
    return { content: `Error reading file: ${(e as Error).message}`, isError: true }
  }
}

function toolWriteFile(wikiRoot: string, args: Record<string, unknown>): LocalToolResult {
  const path = args["path"] as string | undefined
  const content = args["content"] as string | undefined
  if (!path) return { content: "Error: 'path' is required", isError: true }
  if (content === undefined) return { content: "Error: 'content' is required", isError: true }

  let resolved: string
  try {
    resolved = resolveSandboxed(wikiRoot, path)
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true }
  }

  try {
    writeFileSync(resolved, content, "utf-8")
    return { content: `Written ${Buffer.byteLength(content)} bytes to ${path}` }
  } catch (e) {
    return { content: `Error writing file: ${(e as Error).message}`, isError: true }
  }
}

function toolEditFile(wikiRoot: string, args: Record<string, unknown>): LocalToolResult {
  const path = args["path"] as string | undefined
  const oldString = args["old_string"] as string | undefined
  const newString = args["new_string"] as string | undefined
  if (!path) return { content: "Error: 'path' is required", isError: true }
  if (oldString === undefined) return { content: "Error: 'old_string' is required", isError: true }
  if (newString === undefined) return { content: "Error: 'new_string' is required", isError: true }

  let resolved: string
  try {
    resolved = resolveSandboxed(wikiRoot, path)
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true }
  }

  if (!existsSync(resolved)) {
    return { content: `Error: file not found: ${path}`, isError: true }
  }

  try {
    const raw = readFileSync(resolved, "utf-8")

    // Exact match first
    let idx = raw.indexOf(oldString)
    let matchType = "exact"

    // Fallback: whitespace-tolerant match (normalize indentation per line)
    if (idx === -1) {
      const normalize = (s: string) =>
        s
          .split("\n")
          .map((l) => l.trim())
          .join("\n")
      const normRaw = normalize(raw)
      const normOld = normalize(oldString)
      if (normOld.trim() === "") {
        return { content: `Error: old_string is empty or whitespace-only.`, isError: true }
      }
      const normIdx = normRaw.indexOf(normOld)
      if (normIdx !== -1) {
        // Uniqueness must hold in normalized space too, otherwise the
        // fallback silently picks the first of several candidates.
        if (normRaw.indexOf(normOld, normIdx + 1) !== -1) {
          return {
            content: `Error: old_string matches multiple locations in ${path} (whitespace-insensitive). Include more surrounding context to make it unique.`,
            isError: true,
          }
        }
        // Line-accurate mapping: normalize() trims per line, so line N of
        // normRaw corresponds 1:1 to line N of raw. Compute the offset
        // directly — re-searching with indexOf() from position 0 could
        // land on a different occurrence than the normalized match found.
        const rawLines = raw.split("\n")
        const oldLines = oldString.split("\n")
        const startLine = normRaw.slice(0, normIdx).split("\n").length - 1
        const actualOld = rawLines.slice(startLine, startLine + oldLines.length).join("\n")
        const offset = startLine === 0 ? 0 : rawLines.slice(0, startLine).join("\n").length + 1
        const result = raw.slice(0, offset) + newString + raw.slice(offset + actualOld.length)
        writeFileSync(resolved, result, "utf-8")
        return { content: `Edited ${path} (whitespace-tolerant match, ${oldLines.length} lines replaced)` }
      }
    }

    if (idx === -1) {
      return {
        content: `Error: old_string not found in ${path}. Provide the exact text to replace.`,
        isError: true,
      }
    }

    // Check uniqueness
    const secondIdx = raw.indexOf(oldString, idx + 1)
    if (secondIdx !== -1) {
      return {
        content: `Error: old_string matches multiple locations in ${path}. Include more surrounding context to make it unique.`,
        isError: true,
      }
    }

    const result = raw.slice(0, idx) + newString + raw.slice(idx + oldString.length)
    writeFileSync(resolved, result, "utf-8")
    return { content: `Edited ${path} (${matchType} match)` }
  } catch (e) {
    return { content: `Error editing file: ${(e as Error).message}`, isError: true }
  }
}

function toolListDirectory(wikiRoot: string, args: Record<string, unknown>): LocalToolResult {
  const path = (args["path"] as string) ?? "."
  let resolved: string
  try {
    resolved = resolveSandboxed(wikiRoot, path)
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true }
  }

  if (!existsSync(resolved)) {
    return { content: `Error: directory not found: ${path}`, isError: true }
  }

  try {
    const entries = readdirSync(resolved, { withFileTypes: true })
    const lines = entries
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })
      .map((e) => {
        const suffix = e.isDirectory() ? "/" : ""
        let size = ""
        if (!e.isDirectory()) {
          try {
            const st = statSync(join(resolved, e.name))
            size = ` (${st.size} bytes)`
          } catch {
            /* ignore */
          }
        }
        return `${e.name}${suffix}${size}`
      })
    return { content: lines.join("\n") || "(empty directory)" }
  } catch (e) {
    return { content: `Error listing directory: ${(e as Error).message}`, isError: true }
  }
}

// ── Write serialization ──────────────────────────────────────────────

const writeQueues = new Map<string, Promise<void>>()

function serializedWrite(key: string, fn: () => LocalToolResult): Promise<LocalToolResult> {
  const prev = writeQueues.get(key) ?? Promise.resolve()
  const next = prev.then(() => {
    // fn is sync but we wrap for queue ordering
    return fn()
  })
  writeQueues.set(key, next.then(() => undefined))
  return next
}

// ── Web search (Tavily) ─────────────────────────────────────────────

const TAVILY_API_URL = "https://api.tavily.com/search"

async function toolWebSearch(args: Record<string, unknown>): Promise<LocalToolResult> {
  const query = args["query"] as string | undefined
  if (!query) return { content: "Error: 'query' is required", isError: true }

  const maxResults = Math.min((args["max_results"] as number) ?? 5, 10)
  loadEnv()
  const apiKey = process.env["TAVILY_API_KEY"]
  if (!apiKey) {
    return { content: "Error: TAVILY_API_KEY not configured. Set it in .env or environment.", isError: true }
  }

  try {
    const resp = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_answer: true,
        search_depth: "basic",
      }),
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      return { content: `Error: Tavily API returned ${resp.status}: ${body.slice(0, 200)}`, isError: true }
    }

    const data = (await resp.json()) as {
      answer?: string
      results?: Array<{ title: string; url: string; content: string; score?: number }>
    }

    const parts: string[] = []
    if (data.answer) {
      parts.push(`## Answer\n${data.answer}\n`)
    }
    if (data.results?.length) {
      parts.push("## Sources")
      for (const r of data.results) {
        const snippet = r.content.slice(0, 500)
        parts.push(`\n### ${r.title}\nURL: ${r.url}\n${snippet}`)
      }
    }
    return { content: parts.join("\n") || "No results found." }
  } catch (e) {
    return { content: `Error: web search failed: ${(e as Error).message}`, isError: true }
  }
}

// ── Registry factory ─────────────────────────────────────────────────

export function createLocalTools(wikiRoot: string, opts?: { webSearch?: boolean }): LocalToolRegistry {
  const definitions: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a text file with line numbers and pagination. Output format: 'LINE_NUM|CONTENT'. Use offset and limit for large files.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to wiki root" },
            offset: { type: "number", description: "Line number to start from (1-indexed, default 1)" },
            limit: { type: "number", description: "Max lines to read (default 500, max 2000)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file, completely replacing existing content. Creates parent directories automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to wiki root" },
            content: { type: "string", description: "Complete content to write" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Targeted find-and-replace edit. Finds old_string in the file and replaces it with new_string. old_string must be unique in the file. Whitespace/indentation-tolerant fallback.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to wiki root" },
            old_string: { type: "string", description: "Exact text to find (must be unique)" },
            new_string: { type: "string", description: "Replacement text" },
          },
          required: ["path", "old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List files and directories at a path. Directories shown with trailing /.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to wiki root (default '.')" },
          },
          additionalProperties: false,
        },
      },
    },
  ]

  // Conditionally add web_search if enabled and API key available
  if (opts?.webSearch) {
    loadEnv()
    if (process.env["TAVILY_API_KEY"]) {
      definitions.push({
        type: "function",
        function: {
          name: "web_search",
          description:
            "Search the web for current information via Tavily API. Returns an AI-generated answer plus source snippets with URLs. Use for fact-checking, recent events, or information not in the wiki.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              max_results: { type: "number", description: "Max results (default 5, max 10)" },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      })
    }
  }

  const WRITE_TOOLS = new Set(["write_file", "edit_file"])

  return {
    definitions,
    async execute(name: string, args: Record<string, unknown>): Promise<LocalToolResult> {
      switch (name) {
        case "read_file":
          return toolReadFile(wikiRoot, args)
        case "list_directory":
          return toolListDirectory(wikiRoot, args)
        case "write_file": {
          const path = (args["path"] as string) ?? ""
          return serializedWrite(path, () => toolWriteFile(wikiRoot, args))
        }
        case "edit_file": {
          const path = (args["path"] as string) ?? ""
          return serializedWrite(path, () => toolEditFile(wikiRoot, args))
        }
        case "web_search":
          return toolWebSearch(args)
        default:
          return { content: `Unknown local tool: ${name}`, isError: true }
      }
    },
  }
}
