# llm-wiki-ops

Graph-level operations for [Karpathy LLM Wiki](https://github.com/karpathy/LLM101n) knowledge bases.

Lets LLM agents (via MCP) and humans (via CLI) perform structured graph surgery on a wiki: node/edge CRUD, wikilink management, index rebuilding, and graph metrics — all as pure file operations with zero LLM, Tauri, or network dependencies.

## Features

- **Node ops** — add, update, rename, delete wiki pages with frontmatter and wikilink management
- **Edge ops** — add/remove edges between pages via dual carriers (`[[wikilink]]` + `related[]`), idempotent
- **Metrics** — topology (degree, hubs, connected components, fragmentation), source overlap / near-duplicate detection, cross-type edge matrix, type distribution
- **Index maintenance** — rebuild `index.md` type sections while preserving custom content
- **Concurrency** — wiki-level `proper-lockfile` write lock + optimistic mtime/size/sha256 checks
- **MCP server** — expose all operations as MCP tools for LLM agent integration
- **CLI** — `llm-wiki-ops` command for human/script use

## Install

```bash
npm install llm-wiki-ops
```

## CLI

Wiki root is resolved from `--wiki <path>` or the `SELECTED_WIKI` environment variable — no need to repeat it on every command.

```bash
# Set once, use everywhere (path or a slug under WIKIS_ROOT)
export SELECTED_WIKI=/path/to/my-wiki

# Or manage multiple wikis: set WIKIS_ROOT to the directory holding them,
# then select one (also enables cross-wiki search on read commands)
export WIKIS_ROOT=/path/to/wikis
llm-wiki-ops use my-wiki      # writes SELECTED_WIKI=my-wiki
llm-wiki-ops status           # show current resolution

# Add a node
llm-wiki-ops add-node --title "My Page" --type concept

# Add an edge (idempotent — ensures both [[wikilink]] and related[])
llm-wiki-ops add-edge my-page other-page

# Query a subgraph
llm-wiki-ops read --type concept --depth 2

# Graph metrics
llm-wiki-ops metrics --json

# Rebuild index
llm-wiki-ops rebuild-index

# Override wiki root per-invocation
llm-wiki-ops --wiki /other/wiki stats
```

## MCP Server

```bash
wiki-graph-mcp --wiki ./my-wiki
```

Default wiki resolution (when `--wiki` is omitted):

```
--wiki <path-or-slug>  >  SELECTED_WIKI env  >  WIKI_ROOT env (deprecated)  >  error
```

`SELECTED_WIKI` is the same variable the CLI reads, so a shell where
`llm-wiki-ops` works also works for the MCP server. It accepts a full path
or a slug resolved against `WIKIS_ROOT`. `WIKI_ROOT` still works as a
fallback but prints a deprecation warning.

Configure in your MCP client:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "wiki-graph-mcp",
      "args": ["--wiki", "/path/to/wiki"]
    }
  }
}
```

Or bind the default wiki via env instead of `--wiki`:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "wiki-graph-mcp",
      "env": { "SELECTED_WIKI": "/path/to/wiki" }
    }
  }
}
```

Individual tools also accept an optional `selected_wiki` argument to target a
different wiki for that one call (a full path or a slug under `WIKIS_ROOT`).

## Library

```typescript
import { WikiGraph } from "llm-wiki-ops"

const wiki = new WikiGraph("/path/to/wiki")
await wiki.validate()

// CRUD
await wiki.addNode({ title: "My Page", type: "concept" })
await wiki.addEdge("my-page", "other-page")

// Metrics
const metrics = await wiki.getMetrics()
console.log(metrics.topology.hubs)
console.log(metrics.sourceOverlap.duplicateClusters)

await wiki.cleanup()
```

## Wiki Structure

Operates on the standard LLM Wiki layout:

```
my-wiki/
├── wiki/
│   ├── index.md
│   ├── entities/
│   ├── concepts/
│   ├── sources/
│   ├── queries/
│   ├── comparisons/
│   ├── synthesis/
│   └── overview/
├── raw/
├── purpose.md
└── schema.md
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
