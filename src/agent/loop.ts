/**
 * agent/loop.ts — agent loop with context window management.
 *
 * Design doc: §4.2, §4.2.1, §4.2.2
 */

import { chat, type ChatMessage, type ChatResponse, type ToolCall, type ToolDefinition, type LlmConfig } from "./openai.js"
import { McpClient, ServerDeadError } from "./mcp.js"
import type { LocalToolRegistry } from "./tools.js"
import { DryRunExecutor, isWriteTool, createPreWriteSnapshot, type SnapshotResult } from "./safety.js"

// ── Types ────────────────────────────────────────────────────────────

export interface AgentConfig {
  systemPrompt: string
  tools: ToolDefinition[]
  maxIterations?: number // default 30
  maxConsecutiveErrors?: number // default 3
  timeoutMs?: number // default 600_000
  llmConfig?: LlmConfig
  dryRun?: boolean // intercept write ops, record without executing
}

export interface ToolCallLog {
  iteration: number
  tool: string
  args: Record<string, unknown>
  result: unknown
  error?: string
  durationMs: number
}

export interface RunReport {
  command: string
  wikiRoot: string
  startedAt: string
  durationMs: number
  operations: { tool: string; args: Record<string, unknown>; status: "ok" | "error" }[]
  changes: { file: string; action: "created" | "modified" | "deleted" }[]
  snapshotPath?: string
  dryRun?: boolean
  dryRunSummary?: string
}

export interface AgentResult {
  status: "completed" | "max_iterations" | "error" | "timeout" | "aborted"
  iterations: number
  messages: ChatMessage[]
  toolCalls: ToolCallLog[]
  finalMessage: string
  /** Post-loop conclusion: LLM's answer to the user's original query. */
  conclusion?: string
  error?: string
  runReport: RunReport
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 30
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3
const DEFAULT_TIMEOUT_MS = 600_000
const TOOL_RESULT_MAX_BYTES = 8 * 1024 // 8KB per tool result
const CONTEXT_WINDOW_MAX_CHARS = 100_000 // 100K chars
const ANCHORED_KEEP_BYTES = 2 * 1024 // 2KB for anchored messages
const ANCHORED_DEGRADED_BYTES = 512 // 512B when overflow
const RECENT_ROUNDS_KEEP = 10

// ── Abort controller ─────────────────────────────────────────────────

export class AgentAbortController {
  private _aborted = false
  abort(): void {
    this._aborted = true
  }
  get aborted(): boolean {
    return this._aborted
  }
}

// ── Context window management ────────────────────────────────────────

interface AnchoredEntry {
  messageIndex: number // index in messages array
  identifier: string // slug or path
  keepBytes: number
}

/**
 * Recover a dropped "server." prefix.
 * Models occasionally emit "read_graph" instead of "wiki.read_graph".
 * A bare name that uniquely matches one connected MCP tool gets its
 * prefix restored, so isWriteTool / dry-run / snapshot checks all see
 * the canonical name. Ambiguous or unknown names pass through unchanged
 * (the local registry then reports the error back to the model).
 */
export function resolveToolName(
  name: string,
  localTools: LocalToolRegistry,
  mcpClient: McpClient,
): string {
  if (name.includes(".")) return name
  if (localTools.definitions.some((t) => t.function.name === name)) return name
  const candidates = mcpClient
    .listAllTools()
    .map((t) => t.function.name)
    .filter((n) => n.slice(n.indexOf(".") + 1) === name)
  return candidates.length === 1 ? candidates[0] : name
}

/**
 * Truncate a single tool result to TOOL_RESULT_MAX_BYTES.
 * Read tools keep head, write tools keep tail.
 */
function truncateToolResult(text: string, toolName: string): string {
  if (Buffer.byteLength(text, "utf-8") <= TOOL_RESULT_MAX_BYTES) return text
  const isWrite = /write|edit|add|update|delete|rename|remove|create/.test(toolName)
  if (isWrite) {
    // Keep tail
    const buf = Buffer.from(text, "utf-8")
    const tail = buf.subarray(buf.length - TOOL_RESULT_MAX_BYTES).toString("utf-8")
    const omitted = Buffer.byteLength(text) - TOOL_RESULT_MAX_BYTES
    return `[truncated, ${omitted} chars omitted from head]\n${tail}`
  }
  // Keep head
  const buf = Buffer.from(text, "utf-8")
  const head = buf.subarray(0, TOOL_RESULT_MAX_BYTES).toString("utf-8")
  const lastNl = head.lastIndexOf("\n")
  const cut = lastNl > 0 ? head.slice(0, lastNl) : head
  const omitted = Buffer.byteLength(text) - TOOL_RESULT_MAX_BYTES
  return `${cut}\n[truncated, ${omitted} chars omitted from tail]`
}

/**
 * Build a template summary of compressed iterations (no LLM call).
 */
function buildSummary(toolLogs: ToolCallLog[], fromIter: number, toIter: number): string {
  const relevant = toolLogs.filter((l) => l.iteration >= fromIter && l.iteration <= toIter)
  const ops = relevant.map((l) => {
    const status = l.error ? "FAILED" : "ok"
    const key = Object.keys(l.args).slice(0, 2).map((k) => `${k}=${JSON.stringify(l.args[k]).slice(0, 30)}`).join(", ")
    return `${l.tool}(${key}) [${status}]`
  })
  const errors = relevant.filter((l) => l.error).length
  return `[Summary of iterations ${fromIter}–${toIter}: ${ops.length} operations. ${errors > 0 ? `${errors} errors. ` : ""}${ops.slice(0, 20).join("; ")}${ops.length > 20 ? `; ... and ${ops.length - 20} more` : ""}]`
}

/**
 * Apply context window management to the messages array.
 * Mutates a copy, returns the managed array.
 */
function manageContextWindow(
  messages: ChatMessage[],
  userMessageIndex: number,
  anchoredIdentifiers: Set<string>,
  toolLogs: ToolCallLog[],
): ChatMessage[] {
  // Calculate total chars
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
  if (totalChars <= CONTEXT_WINDOW_MAX_CHARS) return messages

  // Identify anchored message indices
  const anchoredIndices = new Set<number>([userMessageIndex])
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === "tool" && m.tool_call_id) {
      // Check if this tool result's identifier was referenced
      // We track identifiers via the anchoredIdentifiers set
      // The message itself doesn't carry the identifier directly,
      // so we check if any content matches
      if (m.content) {
        for (const id of anchoredIdentifiers) {
          if (m.content.includes(id)) {
            anchoredIndices.add(i)
            break
          }
        }
      }
    }
  }

  // Check overflow: anchored + user + recent 10 rounds
  const recentStart = Math.max(0, messages.length - RECENT_ROUNDS_KEEP * 2) // ~2 messages per round
  const mustKeep = new Set<number>([0]) // system prompt always index 0
  for (const idx of anchoredIndices) mustKeep.add(idx)
  for (let i = recentStart; i < messages.length; i++) mustKeep.add(i)

  // Calculate size of must-keep
  let mustKeepChars = 0
  for (const idx of mustKeep) {
    mustKeepChars += messages[idx]?.content?.length ?? 0
  }

  // Determine anchored keep size
  let anchoredKeep = ANCHORED_KEEP_BYTES
  if (mustKeepChars > CONTEXT_WINDOW_MAX_CHARS) {
    anchoredKeep = ANCHORED_DEGRADED_BYTES
  }

  // Build compressed messages
  const result: ChatMessage[] = []
  let compressedFrom = -1
  let compressedTo = -1

  for (let i = 0; i < messages.length; i++) {
    if (mustKeep.has(i)) {
      // Flush any pending compression
      if (compressedFrom !== -1) {
        const summary = buildSummary(toolLogs, compressedFrom, compressedTo)
        result.push({ role: "user", content: summary })
        compressedFrom = -1
      }
      // Apply anchored truncation
      const m = messages[i]!
      if (anchoredIndices.has(i) && i !== userMessageIndex && i !== 0 && m.content) {
        const truncated = m.content.length > anchoredKeep
          ? m.content.slice(0, anchoredKeep) + "\n[anchored, truncated]"
          : m.content
        result.push({ ...m, content: truncated })
      } else {
        result.push(m)
      }
    } else {
      // Mark for compression
      if (compressedFrom === -1) compressedFrom = i
      compressedTo = i
    }
  }

  // Flush trailing compression
  if (compressedFrom !== -1) {
    const summary = buildSummary(toolLogs, compressedFrom, compressedTo)
    result.push({ role: "user", content: summary })
  }

  return result
}

// ── Main agent loop ──────────────────────────────────────────────────

export async function runAgent(
  config: AgentConfig,
  userMessage: string,
  mcpClient: McpClient,
  localTools: LocalToolRegistry,
  commandName: string = "agent",
  wikiRoot: string = "",
  abortController?: AgentAbortController,
): Promise<AgentResult> {
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const maxConsecutiveErrors = config.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = new Date().toISOString()
  const startMs = Date.now()

  const messages: ChatMessage[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: userMessage },
  ]
  const userMessageIndex = 1

  const toolLogs: ToolCallLog[] = []
  const anchoredIdentifiers = new Set<string>()
  let consecutiveErrors = 0
  let status: AgentResult["status"] = "completed"
  let errorMsg: string | undefined
  let iterations = 0

  // Safety: dry-run executor + pre-write snapshot
  const dryRun = config.dryRun ?? false
  const dryRunExecutor = dryRun ? new DryRunExecutor() : null
  let snapshotResult: SnapshotResult | undefined
  let snapshotTaken = false

  // All tools available to the LLM
  const allTools = [...config.tools, ...localTools.definitions]

  for (let iter = 1; iter <= maxIterations; iter++) {
    iterations = iter

    // Check abort
    if (abortController?.aborted) {
      status = "aborted"
      break
    }

    // Check timeout
    if (Date.now() - startMs > timeoutMs) {
      status = "timeout"
      errorMsg = `Agent timed out after ${timeoutMs}ms`
      break
    }

    // Apply context window management before each LLM call
    const managedMessages = manageContextWindow(messages, userMessageIndex, anchoredIdentifiers, toolLogs)

    // Call LLM
    let response: ChatResponse
    try {
      response = await chat(
        { messages: managedMessages, tools: allTools, temperature: 0.1 },
        config.llmConfig,
      )
    } catch (err) {
      status = "error"
      errorMsg = `LLM call failed: ${(err as Error).message}`
      break
    }

    const assistantMsg = response.message
    messages.push(assistantMsg)

    // No tool calls → natural stop
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      status = "completed"
      break
    }

    // Execute tool calls
    for (const tc of assistantMsg.tool_calls) {
      const rawToolName = tc.function.name
      const t0 = Date.now()

      // Parse arguments
      let args: Record<string, unknown>
      try {
        args = JSON.parse(tc.function.arguments || "{}")
      } catch {
        // Invalid JSON — send error back to LLM
        const errMsg = `Invalid JSON in tool arguments: ${tc.function.arguments.slice(0, 200)}`
        messages.push({ role: "tool", content: errMsg, tool_call_id: tc.id })
        toolLogs.push({ iteration: iter, tool: rawToolName, args: {}, result: null, error: errMsg, durationMs: Date.now() - t0 })
        consecutiveErrors++
        if (consecutiveErrors >= maxConsecutiveErrors) {
          status = "error"
          errorMsg = `Circuit breaker: ${consecutiveErrors} consecutive tool errors`
        }
        continue
      }

      // Track anchored identifiers from tool args
      for (const key of ["slug", "path", "center"]) {
        if (typeof args[key] === "string") {
          anchoredIdentifiers.add(args[key] as string)
        }
      }

      // Recover dropped "server." prefix BEFORE write-tool checks, so a
      // bare "add_edge" still hits dry-run/snapshot interception.
      const toolName = resolveToolName(rawToolName, localTools, mcpClient)

      // Route: local tool or MCP tool
      let result: string
      let toolError: string | undefined

      // Pre-write snapshot: before the first write op (skip in dry-run)
      if (!dryRun && !snapshotTaken && isWriteTool(toolName)) {
        snapshotTaken = true
        if (wikiRoot) {
          snapshotResult = createPreWriteSnapshot(wikiRoot, commandName)
          if (snapshotResult.success) {
            console.error(`[snapshot] ${snapshotResult.method}: ${snapshotResult.path}`)
          } else {
            console.error(`[snapshot] WARNING: ${snapshotResult.method} snapshot failed: ${snapshotResult.error}`)
          }
        }
      }

      // Dry-run: intercept write ops
      if (dryRun && dryRunExecutor && isWriteTool(toolName)) {
        result = dryRunExecutor.record(toolName, args)
        messages.push({ role: "tool", content: result, tool_call_id: tc.id })
        toolLogs.push({ iteration: iter, tool: toolName, args, result, durationMs: Date.now() - t0 })
        consecutiveErrors = 0 // dry-run is not an error
        continue
      }

      try {
        if (toolName.includes(".")) {
          // MCP tool (prefixed)
          const raw = await mcpClient.callTool(toolName, args)
          result = truncateToolResult(String(raw), toolName)
        } else {
          // Local tool
          const localResult = await localTools.execute(toolName, args)
          result = truncateToolResult(localResult.content, toolName)
          if (localResult.isError) {
            toolError = result
          }
        }
      } catch (err) {
        if (err instanceof ServerDeadError) {
          // Server dead — immediate termination, no circuit breaker
          status = "error"
          errorMsg = `MCP server dead: ${err.message}`
          toolError = err.message
          result = `[FATAL] ${err.message}`
          messages.push({ role: "tool", content: result, tool_call_id: tc.id })
          toolLogs.push({ iteration: iter, tool: toolName, args, result: null, error: toolError, durationMs: Date.now() - t0 })
          break
        }
        toolError = (err as Error).message
        result = `[ERROR] ${toolError}`
      }

      messages.push({ role: "tool", content: result, tool_call_id: tc.id })
      toolLogs.push({ iteration: iter, tool: toolName, args, result, error: toolError, durationMs: Date.now() - t0 })

      if (toolError) {
        consecutiveErrors++
        if (consecutiveErrors >= maxConsecutiveErrors) {
          status = "error"
          errorMsg = `Circuit breaker: ${consecutiveErrors} consecutive tool errors`
          break
        }
      } else {
        consecutiveErrors = 0
      }
    }

    // Break outer loop if inner loop set error status
    if (status === "error") break
  }

  // If we exhausted iterations
  if (iterations >= maxIterations && status === "completed") {
    status = "max_iterations"
  }

  // ── Conclusion round: answer the user's original query ──────────────
  let conclusion: string | undefined
  if (status === "completed" || status === "max_iterations") {
    try {
      const conclusionPrompt: ChatMessage = {
        role: "user",
        content:
          "You have finished all tool operations. Now write a brief conclusion for the user.\n" +
          "- Directly answer the user's original query based on what you found and did.\n" +
          "- For research/check/reason: state your findings and verdict clearly.\n" +
          "- For ingest: summarize what was created (node count, key topics).\n" +
          "- Keep it under 300 words. No tool calls. Write in the same language as the user's query.",
      }
      const conclusionMessages = manageContextWindow(
        [...messages, conclusionPrompt],
        userMessageIndex,
        anchoredIdentifiers,
        toolLogs,
      )
      const conclusionResp = await chat(
        { messages: conclusionMessages, tools: [], temperature: 0.1 },
        config.llmConfig,
      )
      conclusion = conclusionResp.message.content ?? undefined
    } catch {
      // Conclusion is best-effort; don't fail the whole run
    }
  }

  const durationMs = Date.now() - startMs
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content)
  const finalMessage = lastAssistant?.content ?? ""

  // Build run report
  const runReport: RunReport = {
    command: commandName,
    wikiRoot,
    startedAt,
    durationMs,
    operations: toolLogs.map((l) => ({
      tool: l.tool,
      args: l.args,
      status: l.error ? "error" : "ok",
    })),
    changes: deriveChanges(toolLogs),
    snapshotPath: snapshotResult?.path,
    dryRun: dryRun || undefined,
    dryRunSummary: dryRunExecutor?.summary(),
  }

  return {
    status,
    iterations,
    messages,
    toolCalls: toolLogs,
    finalMessage,
    conclusion,
    error: errorMsg,
    runReport,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Derive file changes from tool call logs (best-effort). */
function deriveChanges(toolLogs: ToolCallLog[]): RunReport["changes"] {
  const changes: RunReport["changes"] = []
  for (const log of toolLogs) {
    if (log.error) continue
    const tool = log.tool.split(".").pop() ?? log.tool
    const path = (log.args["path"] as string) ?? undefined
    const slug = (log.args["slug"] as string) ?? undefined
    const target = path ?? slug
    if (!target) continue

    if (tool === "write_file") {
      changes.push({ file: target, action: "modified" })
    } else if (tool === "add_node") {
      changes.push({ file: target, action: "created" })
    } else if (tool === "delete_node") {
      changes.push({ file: target, action: "deleted" })
    } else if (tool === "update_node" || tool === "rename_node" || tool === "edit_file") {
      changes.push({ file: target, action: "modified" })
    }
  }
  return changes
}
