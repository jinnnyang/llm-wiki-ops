/**
 * Dry-run transparency fixes (2026-08-06):
 * - record() tells the model nothing hit disk, so it stops re-reading
 * - deriveChanges covers add_node (title-derived path) and rename_node
 * - runAgent reports changes=[] in dry-run; dryRunSummary carries the plan
 */
import { describe, it, expect, vi } from "vitest"
import { deriveChanges, runAgent, type ToolCallLog } from "../src/agent/loop.js"
import { DryRunExecutor } from "../src/agent/safety.js"
import type { McpClient } from "../src/agent/mcp.js"
import type { LocalToolRegistry } from "../src/agent/tools.js"
import type { ChatMessage, ChatResponse } from "../src/agent/openai.js"

function log(tool: string, args: Record<string, unknown>, error?: string): ToolCallLog {
  return { iteration: 1, toolCallId: "t1", tool, args, result: null, error, durationMs: 1 }
}

describe("deriveChanges", () => {
  it("add_node: derives page path from title + type directory", () => {
    const changes = deriveChanges([
      log("wiki.add_node", { title: "芯片封锁 (Chip Blockade)", type: "concept" }),
    ])
    expect(changes).toEqual([{ file: "concepts/芯片封锁-chip-blockade.md", action: "created" }])
  })

  it("add_node: type defaults to synthesis", () => {
    const changes = deriveChanges([log("add_node", { title: "My Walk" })])
    expect(changes).toEqual([{ file: "synthesis/my-walk.md", action: "created" }])
  })

  it("add_node: overview type maps to wiki root", () => {
    const changes = deriveChanges([log("add_node", { title: "Overview Page", type: "overview" })])
    expect(changes).toEqual([{ file: "overview-page.md", action: "created" }])
  })

  it("add_node: unsalvageable title is skipped, not guessed", () => {
    expect(deriveChanges([log("add_node", { title: "!!!" })])).toEqual([])
    expect(deriveChanges([log("add_node", {})])).toEqual([])
  })

  it("rename_node: reports new_slug", () => {
    const changes = deriveChanges([
      log("rename_node", { old_slug: "old-name", new_slug: "new-name" }),
    ])
    expect(changes).toEqual([{ file: "new-name", action: "modified" }])
  })

  it("write_file and edit_file: report the path", () => {
    const changes = deriveChanges([
      log("write_file", { path: "notes/x.md", content: "hi" }),
      log("edit_file", { path: "notes/y.md", old_string: "a", new_string: "b" }),
    ])
    expect(changes).toEqual([
      { file: "notes/x.md", action: "modified" },
      { file: "notes/y.md", action: "modified" },
    ])
  })

  it("update_node / delete_node: report the slug", () => {
    const changes = deriveChanges([
      log("update_node", { slug: "deepseek" }),
      log("delete_node", { slug: "stale-page" }),
    ])
    expect(changes).toEqual([
      { file: "deepseek", action: "modified" },
      { file: "stale-page", action: "deleted" },
    ])
  })

  it("error logs are skipped", () => {
    expect(deriveChanges([log("write_file", { path: "a.md" }, "boom")])).toEqual([])
  })
})

describe("DryRunExecutor.record message", () => {
  it("warns the model that nothing hit disk", () => {
    const executor = new DryRunExecutor()
    const msg = executor.record("wiki.add_node", { title: "X" })
    expect(msg).toContain("[DRY-RUN] Would execute")
    expect(msg).toContain("Nothing was written to disk")
    expect(msg).toContain("do not try to read it back")
  })
})

// ── Full-loop dry-run: intercept message + empty changes + summary ──

vi.mock("../src/agent/openai.js", () => ({
  chat: vi.fn(),
}))

import { chat } from "../src/agent/openai.js"

function assistantWithToolCall(): ChatResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "add_node", arguments: JSON.stringify({ title: "Dry Node", type: "concept" }) },
      }],
    },
    usage: { promptTokens: 10, completionTokens: 10 },
    finishReason: "tool_calls",
  }
}

function assistantText(text: string): ChatResponse {
  return {
    message: { role: "assistant", content: text },
    usage: { promptTokens: 10, completionTokens: 10 },
    finishReason: "stop",
  }
}

function makeMcpClient(toolNames: string[]): McpClient {
  return {
    listAllTools: () =>
      toolNames.map((name) => ({
        type: "function" as const,
        function: { name, description: "", parameters: { type: "object", properties: {} } },
      })),
  } as unknown as McpClient
}

const localTools: LocalToolRegistry = { definitions: [], execute: async () => ({ content: "" }) }

describe("runAgent dry-run", () => {
  it("intercepts writes, feeds no-disk warning, reports no changes", async () => {
    const mockedChat = chat as unknown as ReturnType<typeof vi.fn>
    mockedChat
      .mockResolvedValueOnce(assistantWithToolCall()) // iter 1: add_node
      .mockResolvedValueOnce(assistantText("done")) // iter 2: natural stop
      .mockResolvedValueOnce(assistantText("conclusion text")) // conclusion round

    const result = await runAgent(
      { systemPrompt: "sys", tools: [], dryRun: true, timeoutMs: 60_000 },
      "do something",
      makeMcpClient(["wiki.add_node"]),
      localTools,
      "reason",
      "C:\\fake",
    )

    // The intercepted tool result tells the model nothing was written
    const toolMsg = result.messages.find((m: ChatMessage) => m.role === "tool")
    expect(toolMsg?.content).toContain("Nothing was written to disk")

    // No on-disk changes reported; the plan lives in dryRunSummary
    expect(result.runReport.dryRun).toBe(true)
    expect(result.runReport.changes).toEqual([])
    expect(result.runReport.dryRunSummary).toContain("wiki.add_node")
    expect(result.runReport.dryRunSummary).toContain("Dry Node")
  })
})
