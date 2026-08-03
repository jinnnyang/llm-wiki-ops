/**
 * agent/mcp.ts — MCP client (stdio + Streamable HTTP).
 *
 * Pure fetch + child_process.spawn, zero SDK. Design doc: §4.3
 * Target spec: MCP 2025-11-25 (newline-delimited JSON-RPC over stdio).
 */

import { spawn, type ChildProcess } from "node:child_process"
import type { ToolDefinition } from "./openai.js"

// ── Types ────────────────────────────────────────────────────────────

export interface McpServerConfig {
  name: string
  transport: "stdio" | "http"
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http
  url?: string
  headers?: Record<string, string>
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class ServerDeadError extends Error {
  readonly serverName: string
  constructor(serverName: string) {
    super(`MCP server "${serverName}" is dead (process exited)`)
    this.name = "ServerDeadError"
    this.serverName = serverName
  }
}

// ── Per-server connection state ──────────────────────────────────────

interface ServerConnection {
  config: McpServerConfig
  dead: boolean
  // stdio
  process?: ChildProcess
  writeFn?: (msg: string) => void
  // http
  sessionId?: string
  // pending requests
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  nextId: number
  // buffered partial line (stdio)
  buffer: string
  // discovered tools (raw, without prefix)
  tools: ToolDefinition[]
}

// ── McpClient ────────────────────────────────────────────────────────

export class McpClient {
  private servers = new Map<string, ServerConnection>()

  /** Connect to an MCP server and perform the initialize handshake. */
  async connect(config: McpServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      throw new Error(`MCP server "${config.name}" already connected`)
    }

    const conn: ServerConnection = {
      config,
      dead: false,
      pending: new Map(),
      nextId: 1,
      buffer: "",
      tools: [],
    }
    this.servers.set(config.name, conn)

    if (config.transport === "stdio") {
      await this.connectStdio(conn)
    } else {
      await this.connectHttp(conn)
    }

    // Discover tools
    const toolsResult = await this.rawRequest(conn, "tools/list", {}) as {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    }
    conn.tools = (toolsResult.tools ?? []).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    }))
  }

  /** Get all tools from all connected servers, prefixed with server name. */
  listAllTools(): ToolDefinition[] {
    const all: ToolDefinition[] = []
    for (const [name, conn] of this.servers) {
      for (const tool of conn.tools) {
        all.push({
          type: "function",
          function: {
            name: `${name}.${tool.function.name}`,
            description: tool.function.description,
            parameters: tool.function.parameters,
          },
        })
      }
    }
    return all
  }

  /** Call a tool by prefixed name (e.g. "wiki.add_node"). */
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<unknown> {
    const dotIdx = prefixedName.indexOf(".")
    if (dotIdx === -1) {
      throw new Error(`Tool name "${prefixedName}" missing server prefix (expected "server.tool")`)
    }
    const serverName = prefixedName.slice(0, dotIdx)
    const toolName = prefixedName.slice(dotIdx + 1)
    const conn = this.servers.get(serverName)
    if (!conn) {
      throw new Error(`MCP server "${serverName}" not connected`)
    }
    if (conn.dead) {
      throw new ServerDeadError(serverName)
    }

    const result = await this.rawRequest(conn, "tools/call", {
      name: toolName,
      arguments: args,
    })

    // MCP tools/call returns { content: [...], isError?: boolean }
    const res = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    // Extract text content (both success and error paths)
    const text =
      res.content && res.content.length > 0
        ? res.content.map((c) => c.text ?? JSON.stringify(c)).join("\n")
        : JSON.stringify(result)
    // Tool-level errors are NOT exceptions — the agent loop passes them
    // back to the LLM as tool results so it can adapt. Only transport-level
    // failures (ServerDeadError, timeout) throw.
    if (res.isError) {
      return `[TOOL ERROR] ${text}`
    }
    return text
  }

  /** Close all connections. */
  async closeAll(): Promise<void> {
    for (const [, conn] of this.servers) {
      if (conn.process) {
        conn.process.kill("SIGTERM")
        // Give it 2s to exit gracefully, then SIGKILL
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            conn.process?.kill("SIGKILL")
            resolve()
          }, 2000)
          conn.process?.once("exit", () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      conn.dead = true
      conn.pending.clear()
    }
    this.servers.clear()
  }

  /** Check if a server is connected and alive. */
  isAlive(serverName: string): boolean {
    const conn = this.servers.get(serverName)
    return !!conn && !conn.dead
  }

  // ── stdio transport ──────────────────────────────────────────────

  private async connectStdio(conn: ServerConnection): Promise<void> {
    const { config } = conn
    if (!config.command) {
      throw new Error(`stdio server "${config.name}" requires "command"`)
    }

    const child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
      shell: process.platform === "win32", // needed for .cmd/.bat on Windows
    })
    conn.process = child

    child.on("exit", (code) => {
      conn.dead = true
      // Reject all pending requests
      for (const [, p] of conn.pending) {
        p.reject(new ServerDeadError(config.name))
      }
      conn.pending.clear()
      if (code !== 0 && code !== null) {
        process.stderr.write(`[mcp] server "${config.name}" exited with code ${code}\n`)
      }
    })

    child.on("error", (err) => {
      conn.dead = true
      for (const [, p] of conn.pending) {
        p.reject(new ServerDeadError(config.name))
      }
      conn.pending.clear()
      process.stderr.write(`[mcp] server "${config.name}" spawn error: ${err.message}\n`)
    })

    // Drain stderr (server logs)
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[mcp:${config.name}] ${chunk.toString()}`)
    })

    // Read stdout — newline-delimited JSON
    conn.writeFn = (msg: string) => {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(msg + "\n")
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      conn.buffer += chunk.toString("utf-8")
      this.processBuffer(conn)
    })

    // Initialize handshake
    await this.initializeHandshake(conn)
  }

  private processBuffer(conn: ServerConnection): void {
    for (;;) {
      const nlIdx = conn.buffer.indexOf("\n")
      if (nlIdx === -1) break
      const line = conn.buffer.slice(0, nlIdx).replace(/\r$/, "").trim()
      conn.buffer = conn.buffer.slice(nlIdx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        this.handleResponse(conn, msg)
      } catch {
        // Non-JSON line (server log noise) — ignore
      }
    }
  }

  private handleResponse(conn: ServerConnection, msg: JsonRpcResponse): void {
    if (msg.id === null || msg.id === undefined) return // notification from server — ignore
    const pending = conn.pending.get(msg.id)
    if (!pending) return
    conn.pending.delete(msg.id)
    if (msg.error) {
      pending.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`))
    } else {
      pending.resolve(msg.result)
    }
  }

  // ── HTTP transport (Streamable HTTP) ─────────────────────────────

  private async connectHttp(conn: ServerConnection): Promise<void> {
    const { config } = conn
    if (!config.url) {
      throw new Error(`http server "${config.name}" requires "url"`)
    }
    // HTTP is stateless per-request; no persistent connection needed.
    // Initialize handshake still required per spec.
    await this.initializeHandshake(conn)
  }

  // ── Shared ───────────────────────────────────────────────────────

  private async initializeHandshake(conn: ServerConnection): Promise<void> {
    const result = await this.rawRequest(conn, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "llm-wiki-ops-agent", version: "0.1.0" },
    }) as { protocolVersion?: string }

    // Send initialized notification (no response expected)
    await this.sendNotification(conn, "notifications/initialized", {})

    // Log negotiated version if different
    if (result.protocolVersion && result.protocolVersion !== "2025-11-25") {
      process.stderr.write(
        `[mcp] server "${conn.config.name}" negotiated protocol ${result.protocolVersion}\n`,
      )
    }
  }

  private rawRequest(conn: ServerConnection, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (conn.dead) {
      return Promise.reject(new ServerDeadError(conn.config.name))
    }

    const id = conn.nextId++
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }

    if (conn.config.transport === "stdio") {
      return new Promise<unknown>((resolve, reject) => {
        conn.pending.set(id, { resolve, reject })
        conn.writeFn!(JSON.stringify(request))
        // Timeout after 60s
        setTimeout(() => {
          if (conn.pending.has(id)) {
            conn.pending.delete(id)
            reject(new Error(`MCP request "${method}" timed out (60s) on server "${conn.config.name}"`))
          }
        }, 60_000)
      })
    }

    // HTTP: POST JSON-RPC, expect JSON-RPC response
    return this.httpRequest(conn, request)
  }

  private async sendNotification(conn: ServerConnection, method: string, params: Record<string, unknown>): Promise<void> {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params }

    if (conn.config.transport === "stdio") {
      conn.writeFn!(JSON.stringify(notification))
      return
    }

    // HTTP: POST notification (no id, no response expected — but server may return 202)
    await fetch(conn.config.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...conn.config.headers,
        ...(conn.sessionId ? { "Mcp-Session-Id": conn.sessionId } : {}),
      },
      body: JSON.stringify(notification),
    })
  }

  private async httpRequest(conn: ServerConnection, request: JsonRpcRequest): Promise<unknown> {
    const res = await fetch(conn.config.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...conn.config.headers,
        ...(conn.sessionId ? { "Mcp-Session-Id": conn.sessionId } : {}),
      },
      body: JSON.stringify(request),
    })

    // Capture session id from response
    const sessionId = res.headers.get("mcp-session-id")
    if (sessionId) conn.sessionId = sessionId

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`MCP HTTP error ${res.status}: ${text.slice(0, 300)}`)
    }

    const json = (await res.json()) as JsonRpcResponse
    if (json.error) {
      throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`)
    }
    return json.result
  }
}
