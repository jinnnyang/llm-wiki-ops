/**
 * Serial MCP live smoke test — validates the resident graph write path
 * end-to-end through the REAL compiled MCP server process:
 * every read happens AFTER the write's response returns.
 *
 * Usage: node scripts/smoke-mcp-write-path.mjs <wikiDir>
 */
import { spawn } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..")
const serverBin = path.join(root, "dist", "src", "mcp", "index.js")
const wikiDir = process.argv[2]
if (!wikiDir) {
  console.error("usage: node smoke-mcp-write-path.mjs <wikiDir>")
  process.exit(2)
}

const child = spawn(process.execPath, [serverBin], {
  env: { ...process.env, SELECTED_WIKI: wikiDir },
  stdio: ["pipe", "pipe", "pipe"],
})

let buf = ""
const pending = new Map()
let stderrLog = ""
child.stderr.on("data", (d) => (stderrLog += d))
child.stdout.on("data", (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) pending.get(msg.id)(msg)
    } catch { /* partial */ }
  }
})

let nextId = 0
function send(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for id=${id} (${method})`)), 30000)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
}

let failures = 0
function check(name, cond, detail = "") {
  if (cond) console.log(`  PASS  ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`) }
}
function text(resp) {
  return resp?.result?.content?.[0]?.text ?? JSON.stringify(resp?.error ?? resp)
}
function parse(resp) {
  try { return JSON.parse(text(resp)) } catch { return null }
}

try {
  // handshake
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.1" } })
  notify("notifications/initialized")
  console.log(`server: ${stderrLog.split("\n")[0] ?? "(no stderr)"}`)

  // 1. write: add_node
  const addResp = await send("tools/call", { name: "add_node", arguments: { title: "Smoke Write Node", type: "concept" } })
  const add = parse(addResp)
  check("add_node succeeded", add?.filesTouched?.length > 0, text(addResp).slice(0, 150))

  // 2. read-after-write: get_node must see it from MEMORY (resident)
  const getResp = await send("tools/call", { name: "get_node", arguments: { slug: "smoke-write-node" } })
  const node = parse(getResp)
  check("get_node sees write immediately", node?.slug === "smoke-write-node", text(getResp).slice(0, 150))

  // 3. read-after-write: get_stats reflects the new node
  const statsResp = await send("tools/call", { name: "get_stats", arguments: {} })
  const stats = parse(statsResp)
  check("get_stats counts the new node", stats?.totalNodes >= 1, text(statsResp).slice(0, 120))

  // 4. write: add_edge with correct source/target params
  const edgeResp = await send("tools/call", { name: "add_edge", arguments: { source: "smoke-write-node", target: "smoke-write-node" } })
  const edge = parse(edgeResp)
  check("add_edge (self-loop) succeeded", edge?.created !== undefined, text(edgeResp).slice(0, 150))

  // 5. read-after-write: get_edges sees the edge
  const edgesResp = await send("tools/call", { name: "get_edges", arguments: { slug: "smoke-write-node" } })
  const edges = parse(edgesResp)
  check("get_edges reflects write", JSON.stringify(edges).includes("smoke-write-node"), text(edgesResp).slice(0, 150))

  // 6. write: rename_node, then read with NEW slug
  const renameResp = await send("tools/call", { name: "rename_node", arguments: { old_slug: "smoke-write-node", new_slug: "smoke-renamed-node" } })
  const rename = parse(renameResp)
  check("rename_node succeeded", rename?.filesTouched?.length > 0, text(renameResp).slice(0, 150))

  const getNewResp = await send("tools/call", { name: "get_node", arguments: { slug: "smoke-renamed-node" } })
  const newNode = parse(getNewResp)
  check("get_node sees NEW slug after rename", newNode?.slug === "smoke-renamed-node", text(getNewResp).slice(0, 150))

  const getOldResp = await send("tools/call", { name: "get_node", arguments: { slug: "smoke-write-node" } })
  check("OLD slug gone after rename", text(getOldResp).includes("not found"), text(getOldResp).slice(0, 150))

  // 7. scan_freshness on resident graph (freshness read path)
  const freshResp = await send("tools/call", { name: "scan_freshness", arguments: {} })
  const fresh = parse(freshResp)
  check("scan_freshness runs", fresh && (Array.isArray(fresh) || typeof fresh === "object"), text(freshResp).slice(0, 120))

  // 8. write: delete_node, then read must NOT see it
  const delResp = await send("tools/call", { name: "delete_node", arguments: { slug: "smoke-renamed-node" } })
  const del = parse(delResp)
  check("delete_node succeeded", del?.filesTouched?.length > 0, text(delResp).slice(0, 150))

  const getDelResp = await send("tools/call", { name: "get_node", arguments: { slug: "smoke-renamed-node" } })
  check("deleted node invisible to reads", text(getDelResp).includes("not found"), text(getDelResp).slice(0, 150))

  // 9. metrics still healthy after all mutations
  const metricsResp = await send("tools/call", { name: "metrics", arguments: {} })
  check("metrics runs after mutation cycle", text(metricsResp).includes("topology") || text(metricsResp).includes("totalNodes"), text(metricsResp).slice(0, 120))

  console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  child.kill()
  process.exit(failures === 0 ? 0 : 1)
} catch (err) {
  console.error("SMOKE ERROR:", err.message)
  console.error("stderr so far:", stderrLog.slice(0, 500))
  child.kill()
  process.exit(2)
}
