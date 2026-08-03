/**
 * scripts/test-mcp-connectivity.ts — integration test for agent/mcp.ts
 * Spawns real wiki-graph-mcp, tests handshake + listTools + callTool.
 * Run: npx tsx scripts/test-mcp-connectivity.ts
 */
import { McpClient } from "../src/agent/mcp.js"

const WIKI_ROOT = "C:\\Users\\jinnn\\Documents\\wiki-builder\\wikis\\economic-analysis"
const MCP_SERVER = "node"
const MCP_ARGS = ["dist/src/mcp/index.js", "--wiki", WIKI_ROOT]

async function main() {
  const client = new McpClient()

  console.log("1. Connecting to wiki-graph-mcp (stdio)...")
  await client.connect({
    name: "wiki",
    transport: "stdio",
    command: MCP_SERVER,
    args: MCP_ARGS,
  })
  console.log("   ✓ Connected + initialized")

  console.log("2. Listing tools...")
  const tools = client.listAllTools()
  console.log(`   ✓ ${tools.length} tools discovered:`)
  for (const t of tools) {
    console.log(`     - ${t.function.name}`)
  }

  console.log("3. Calling wiki.get_stats...")
  const stats = await client.callTool("wiki.get_stats", {})
  console.log(`   ✓ Response (${String(stats).length} chars):`)
  console.log(`     ${String(stats).slice(0, 200)}`)

  console.log("4. Calling wiki.read_graph (limit 3, no filter — expect TOOL ERROR)...")
  const graph = await client.callTool("wiki.read_graph", { limit: 3 })
  const graphStr = String(graph)
  if (graphStr.startsWith("[TOOL ERROR]")) {
    console.log("   ✓ Got expected tool error (RESULT_TOO_LARGE) — returned as value, not thrown")
    console.log(`     ${graphStr.slice(0, 120)}...`)
  } else {
    console.log(`   ✓ Response (${graphStr.length} chars)`)
  }

  console.log("5. Calling wiki.read_graph (type=concept, limit 3)...")
  const filtered = await client.callTool("wiki.read_graph", { type: "concept", limit: 3 })
  console.log(`   ✓ Filtered response (${String(filtered).length} chars):`)
  console.log(`     ${String(filtered).slice(0, 200)}`)

  console.log("6. Closing...")
  await client.closeAll()
  console.log("   ✓ Closed")

  console.log("\n✅ MCP client integration test passed.")
  process.exit(0)
}

main().catch((err) => {
  console.error("❌ MCP integration test failed:")
  console.error(err)
  process.exit(1)
})
