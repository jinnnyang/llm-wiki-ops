/**
 * agent/openai.ts — self-contained OpenAI-compatible LLM client.
 *
 * Pure fetch, zero SDK. Design doc: §4.1
 *
 * Config via env vars (loaded by env.ts):
 *   OPENAI_BASE_URL   — API endpoint (e.g. https://api.openai.com/v1)
 *   OPENAI_API_KEY    — API key
 *   OPENAI_MODEL_NAME — model name (e.g. gpt-4o)
 */

import { loadEnv } from "./env.js"

// ── Types ────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown> // JSON Schema
  }
}

export interface ChatOptions {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
}

export interface ChatResponse {
  message: ChatMessage
  usage: { promptTokens: number; completionTokens: number }
  finishReason: "stop" | "tool_calls" | "length"
}

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

// ── Config resolution ────────────────────────────────────────────────

export function resolveLlmConfig(): LlmConfig {
  loadEnv()
  const missing: string[] = []
  const baseUrl = process.env["OPENAI_BASE_URL"]
  const apiKey = process.env["OPENAI_API_KEY"]
  const model = process.env["OPENAI_MODEL_NAME"]
  if (!baseUrl) missing.push("OPENAI_BASE_URL")
  if (!apiKey) missing.push("OPENAI_API_KEY")
  if (!model) missing.push("OPENAI_MODEL_NAME")
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them in .env or export them before running agent commands.`,
    )
  }
  return { baseUrl: baseUrl!, apiKey: apiKey!, model: model! }
}

// ── Retry logic ──────────────────────────────────────────────────────

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Core chat function ───────────────────────────────────────────────

export async function chat(
  options: ChatOptions,
  config?: LlmConfig,
): Promise<ChatResponse> {
  const cfg = config ?? resolveLlmConfig()
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: options.messages,
    stream: false,
  }
  if (options.tools && options.tools.length > 0) {
    body["tools"] = options.tools
  }
  if (options.temperature !== undefined) {
    body["temperature"] = options.temperature
  }
  if (options.maxTokens !== undefined) {
    body["max_tokens"] = options.maxTokens
  }

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      await sleep(delay)
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      // Network-level failure (DNS, connection refused, etc.)
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRIES) continue
      throw new Error(
        `LLM request failed after ${MAX_RETRIES + 1} attempts (network error): ${lastError.message}`,
      )
    }

    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown>
      return parseResponse(json)
    }

    // Non-retryable client errors
    if (!RETRYABLE_STATUS.has(res.status)) {
      const text = await res.text().catch(() => "(unreadable body)")
      throw new Error(
        `LLM API error ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      )
    }

    // Retryable — read body for diagnostics, honour Retry-After if present
    const errBody = await res.text().catch(() => "(unreadable body)")
    const retryAfter = res.headers.get("retry-after")
    if (retryAfter && attempt < MAX_RETRIES) {
      const secs = Number(retryAfter)
      if (!Number.isNaN(secs) && secs > 0) {
        await sleep(secs * 1000)
      }
    }

    lastError = new Error(
      `LLM API error ${res.status} ${res.statusText}: ${errBody.slice(0, 500)}`,
    )
  }

  throw new Error(
    `LLM request failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message ?? "unknown"}`,
  )
}

// ── Response parsing ─────────────────────────────────────────────────

function parseResponse(json: Record<string, unknown>): ChatResponse {
  const choices = json["choices"] as Array<Record<string, unknown>> | undefined
  if (!choices || choices.length === 0) {
    throw new Error(`LLM returned no choices: ${JSON.stringify(json).slice(0, 300)}`)
  }
  const choice = choices[0]!
  const raw = choice["message"] as Record<string, unknown>
  const usage = json["usage"] as Record<string, unknown> | undefined

  const message: ChatMessage = {
    role: (raw["role"] as ChatMessage["role"]) ?? "assistant",
    content: (raw["content"] as string) ?? null,
  }

  if (raw["tool_calls"]) {
    message.tool_calls = (raw["tool_calls"] as Array<Record<string, unknown>>).map(
      (tc) => ({
        id: tc["id"] as string,
        type: "function" as const,
        function: {
          name: (tc["function"] as Record<string, unknown>)["name"] as string,
          arguments: (tc["function"] as Record<string, unknown>)[
            "arguments"
          ] as string,
        },
      }),
    )
  }

  const finishRaw = choice["finish_reason"] as string | undefined
  const finishReason: ChatResponse["finishReason"] =
    finishRaw === "tool_calls" ? "tool_calls" : finishRaw === "length" ? "length" : "stop"

  return {
    message,
    usage: {
      promptTokens: (usage?.["prompt_tokens"] as number) ?? 0,
      completionTokens: (usage?.["completion_tokens"] as number) ?? 0,
    },
    finishReason,
  }
}
