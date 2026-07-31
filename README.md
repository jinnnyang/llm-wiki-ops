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

Wiki root is resolved from `--wiki <path>` or the `WIKI_ROOT` environment variable — no need to repeat it on every command.

```bash
# Set once, use everywhere
export WIKI_ROOT=/path/to/my-wiki

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
