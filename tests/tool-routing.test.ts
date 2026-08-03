/**
 * Tool routing: recover dropped "server." prefix before dispatch.
 * Models occasionally emit "read_graph" instead of "wiki.read_graph";
 * without recovery the call routes to the local registry and fails,
 * tripping the circuit breaker.
 */
import { describe, it, expect } from "vitest"
import { resolveToolName } from "../src/agent/loop.js"
import type { LocalToolRegistry } from "../src/agent/tools.js"
import type { McpClient } from "../src/agent/mcp.js"

function makeLocalTools(names: string[]): LocalToolRegistry {
  return {
    definitions: names.map((name) => ({
      type: "function" as const,
      function: { name, description: "", parameters: { type: "object", properties: {} } },
    })),
    execute: async () => ({ content: "" }),
  }
}

function makeMcpClient(names: string[]): McpClient {
  return {
    listAllTools: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, description: "", parameters: { type: "object", properties: {} } },
      })),
  } as unknown as McpClient
}

describe("resolveToolName", () => {
  const local = makeLocalTools(["read_file", "list_directory"])
  const mcp = makeMcpClient([
    "wiki.read_graph",
    "wiki.get_node",
    "wiki.add_edge",
    "wiki.scan_freshness",
  ])

  it("prefixed names pass through unchanged", () => {
    expect(resolveToolName("wiki.read_graph", local, mcp)).toBe("wiki.read_graph")
    expect(resolveToolName("wiki.nonexistent", local, mcp)).toBe("wiki.nonexistent")
  })

  it("bare local tool names stay local", () => {
    expect(resolveToolName("read_file", local, mcp)).toBe("read_file")
    expect(resolveToolName("list_directory", local, mcp)).toBe("list_directory")
  })

  it("bare MCP tool name recovers its prefix", () => {
    expect(resolveToolName("read_graph", local, mcp)).toBe("wiki.read_graph")
    expect(resolveToolName("add_edge", local, mcp)).toBe("wiki.add_edge")
    expect(resolveToolName("scan_freshness", local, mcp)).toBe("wiki.scan_freshness")
  })

  it("ambiguous bare name (two servers) passes through unchanged", () => {
    const multi = makeMcpClient(["wiki.read_graph", "other.read_graph"])
    expect(resolveToolName("read_graph", local, multi)).toBe("read_graph")
  })

  it("unknown bare name passes through unchanged (error surfaces to model)", () => {
    expect(resolveToolName("nonexistent_tool", local, mcp)).toBe("nonexistent_tool")
  })
})
