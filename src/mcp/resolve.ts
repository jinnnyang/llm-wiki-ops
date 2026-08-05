/**
 * mcp/resolve.ts — default wiki resolution for the MCP server.
 *
 * Side-effect free (no process.exit, no stderr) so the chain is unit-testable;
 * the entry point (mcp/index.ts) prints the warning and exits.
 *
 * Design: resident-graph.md §11.2.
 *   --wiki <path-or-slug>  >  SELECTED_WIKI env  >  WIKI_ROOT env (deprecated)  >  none
 *
 * Slug values resolve against WIKIS_ROOT via the same pure resolver the CLI
 * uses (cli/wiki-resolve.ts), so "same shell, CLI works, MCP works".
 */

import { resolve as resolvePath } from "node:path"
import { resolveWikiPath, getWikisRoot } from "../cli/wiki-resolve.js"

export interface ResolvedDefaultWiki {
  /** Absolute wiki root, or undefined when nothing was configured. */
  root?: string
  /** Deprecation warning to emit once on stderr (WIKI_ROOT fallback). */
  warning?: string
}

/**
 * Resolve a --wiki / SELECTED_WIKI value (slug or path) to an absolute wiki
 * root. Falls back to path.resolve(value) when the value is not a valid wiki —
 * startup validate() then produces the canonical WIKI_ROOT_NOT_FOUND error.
 */
function resolveWikiValue(value: string, env: Record<string, string | undefined>): string {
  const r = resolveWikiPath(value, getWikisRoot(env))
  return r.ok ? r.path : resolvePath(value)
}

/**
 * Default wiki resolution chain (§11.2). Pure: returns { root?, warning? }.
 */
export function resolveDefaultWikiRoot(
  cliWiki: string | undefined,
  env: Record<string, string | undefined>,
): ResolvedDefaultWiki {
  if (cliWiki) return { root: resolveWikiValue(cliWiki, env) }
  if (env.SELECTED_WIKI) return { root: resolveWikiValue(env.SELECTED_WIKI, env) }
  if (env.WIKI_ROOT) {
    return {
      root: resolveWikiValue(env.WIKI_ROOT, env),
      warning:
        "[wiki-graph-mcp] warning: WIKI_ROOT is deprecated, use SELECTED_WIKI instead " +
        "(set via: llm-wiki use <wiki-slug-or-path>)",
    }
  }
  return {}
}
