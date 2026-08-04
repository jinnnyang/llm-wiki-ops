/**
 * Context window management: tool-call blocks must stay atomic.
 *
 * An assistant message carrying tool_calls and ALL of its tool-result
 * messages form one unit. When compression keeps a tool result (recent
 * window or anchoring), the assistant message that issued the call must
 * be kept too — otherwise the payload contains orphan tool messages and
 * strict OpenAI-compatible APIs reject the request.
 *
 * Also covers: buildSummary must filter toolLogs by tool_call_id of the
 * compressed tool messages, not by iteration-number range (message
 * indices ≠ iteration numbers).
 */
import { describe, it, expect } from "vitest"
import { manageContextWindow, type ToolCallLog } from "../src/agent/loop.js"
import type { ChatMessage } from "../src/agent/openai.js"

const BIG = "x".repeat(6000) // enough per tool result to exceed 100K total

interface Built {
  messages: ChatMessage[]
  logs: ToolCallLog[]
}

/**
 * Build: system + user + 8 single-tool rounds + 1 double-tool round +
 * 8 single-tool rounds = 37 messages.
 *
 * With RECENT_ROUNDS_KEEP=10 (→ recent window = last 20 messages), the
 * window starts at index 17 — exactly on a tool result whose issuing
 * assistant message sits at index 16, outside the window. Without block
 * expansion, index 17 survives as an orphan tool message.
 */
function buildOrphanScenario(): Built {
  const messages: ChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "user query" },
  ]
  const logs: ToolCallLog[] = []
  let callCounter = 0
  let iter = 1

  const addRound = (toolCount: number) => {
    const ids: string[] = []
    for (let i = 0; i < toolCount; i++) ids.push(`c${++callCounter}`)
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: ids.map((id) => ({
        id,
        type: "function" as const,
        function: { name: `tool_${id}`, arguments: "{}" },
      })),
    })
    for (const id of ids) {
      // Content carries the call id — anchoring works by content match,
      // so embedded ids make anchoring testable.
      messages.push({ role: "tool", content: BIG + `\n[id:${id}]`, tool_call_id: id })
      // Deliberately misleading iteration numbers: far outside any message
      // index range. An iteration-range filter (the old bug) would miss
      // these entirely; an id-based filter finds them.
      logs.push({
        iteration: 500 + callCounter,
        toolCallId: id,
        tool: `tool_${id}`,
        args: { slug: id },
        result: BIG,
        durationMs: 1,
      })
    }
    iter++
  }

  for (let i = 0; i < 8; i++) addRound(1) // messages 2..17, calls c1..c8
  addRound(2) // messages 18..20, calls c9,c10 (parity shift)
  for (let i = 0; i < 8; i++) addRound(1) // messages 21..36, calls c11..c18

  return { messages, logs }
}

/** Invariant: no orphan tool messages in the managed payload. */
function assertNoOrphans(messages: ChatMessage[]): void {
  const issuedIds = new Set<string>()
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) issuedIds.add(tc.id)
    }
    if (m.role === "tool") {
      expect(
        issuedIds.has(m.tool_call_id ?? ""),
        `orphan tool message (tool_call_id=${m.tool_call_id}) without preceding tool_calls`,
      ).toBe(true)
    }
  }
}

describe("manageContextWindow", () => {
  it("returns input unchanged below the char threshold", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const out = manageContextWindow(messages, 1, new Set(), [])
    expect(out).toBe(messages)
  })

  it("keeps tool-call blocks atomic across the recent-window boundary", () => {
    const { messages, logs } = buildOrphanScenario()
    // Sanity: scenario exceeds the 100K threshold
    const total = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0)
    expect(total).toBeGreaterThan(100_000)

    const out = manageContextWindow(messages, 1, new Set(), logs)

    assertNoOrphans(out)

    // The assistant message that issued the boundary tool call must be kept
    const boundaryAssistant = out.find(
      (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "c8"),
    )
    expect(boundaryAssistant).toBeDefined()
  })

  it("summarizes exactly the compressed tool calls (by id, not iteration)", () => {
    const { messages, logs } = buildOrphanScenario()
    const out = manageContextWindow(messages, 1, new Set(), logs)

    const summaries = out.filter((m) => m.role === "user" && m.content?.startsWith("[Summary"))
    expect(summaries.length).toBeGreaterThan(0)

    // Rounds 1-7 (c1..c7) fall fully in the compressed span.
    // Round 8 (c8) was rescued by block expansion and must NOT appear.
    const summaryText = summaries.map((m) => m.content).join("\n")
    expect(summaryText).toContain("tool_c1")
    expect(summaryText).toContain("7 operations")
    expect(summaryText).not.toContain("tool_c8")
    expect(summaryText).not.toContain("tool_c18")
  })

  it("keeps an anchored tool message together with its assistant", () => {
    const { messages, logs } = buildOrphanScenario()
    // Anchor a tool result deep in the compressed zone (c3, message idx 7).
    const out = manageContextWindow(messages, 1, new Set(["c3"]), logs)
    assertNoOrphans(out)

    const anchored = out.find((m) => m.role === "tool" && m.tool_call_id === "c3")
    expect(anchored).toBeDefined()
    const issuer = out.find(
      (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "c3"),
    )
    expect(issuer).toBeDefined()
  })
})
