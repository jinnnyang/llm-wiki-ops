/**
 * agent/mcp-server-path.ts — locate the bundled wiki-graph MCP server.
 *
 * Every agent spawns the same MCP server as a subprocess. All five used to inline
 * `join(import.meta.dirname, "..", "mcp", "index.js")`, which silently assumes the
 * caller is running COMPILED code: from dist/src/agent/ that resolves to
 * dist/src/mcp/index.js and works.
 *
 * Run the same code as TypeScript source (vitest, tsx, a debugger) and
 * import.meta.dirname is src/agent/ instead, so the path becomes src/mcp/index.js
 * — a file that does not exist, since the source is index.ts. `node` exits
 * immediately and the agent reports "MCP server is dead (process exited)" with no
 * hint that the cause is a missing path rather than a broken server.
 *
 * Resolution order: the compiled sibling first (the normal case), then the dist
 * build from a source-tree layout, then an explicit override.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

/** Escape hatch for unusual layouts (monorepo hoisting, packaged installs). */
const OVERRIDE_ENV = "WIKI_MCP_SERVER_PATH"

/**
 * Absolute path to the MCP server entry point.
 *
 * @throws if no candidate exists — with the candidates listed, because the
 *   failure this replaces was a bare "process exited".
 */
export function resolveMcpServerPath(): string {
  const override = process.env[OVERRIDE_ENV]
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`${OVERRIDE_ENV}="${override}" does not exist.`)
    }
    return override
  }

  const here = import.meta.dirname
  const candidates = [
    // Compiled: dist/src/agent/ → dist/src/mcp/index.js
    join(here, "..", "mcp", "index.js"),
    // Source tree (vitest/tsx): src/agent/ → dist/src/mcp/index.js
    join(here, "..", "..", "dist", "src", "mcp", "index.js"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `Cannot find the wiki-graph MCP server. Tried:\n` +
      candidates.map((c) => `  ${c}`).join("\n") +
      `\nRun \`npm run build\`, or set ${OVERRIDE_ENV} to the server entry point.`,
  )
}
