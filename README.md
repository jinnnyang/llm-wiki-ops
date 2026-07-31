# llm-wiki-ops

Graph-level operations for [Karpathy LLM Wiki](https://github.com/karpathy/LLM101n) knowledge bases.

Lets LLM agents (via MCP) and humans (via CLI) perform structured graph surgery on a wiki: node/edge CRUD, wikilink management, index rebuilding, and graph metrics — all as pure file operations with zero LLM, Tauri, or network dependencies.

## Features

- **Node ops** — add, update, rename, delete wiki pages with frontmatter and wikilink management
- **Edge ops** — add/remove typed edges between pages, with cascading wikilink insert/removal
- **Metrics** — topology (degree, hubs, connected components, fragmentation), source overlap / near-duplicate detection, cross-type edge matrix, type distribution
- **Index maintenance** — rebuild `index.md` type sections while preserving custom content
- **Concurrency** — wiki-level `proper-lockfile` write lock + optimistic mtime/size/sha256 checks
- **MCP server** — expose all operations as MCP tools for LLM agent integration
- **CLI** — `wiki-graph` command for human/script use

## Install

```bash
npm install llm-wiki-ops
```

## CLI

```bash
# Add a node
wiki-graph add-node ./my-wiki --slug "my-page" --title "My Page" --type concept

# Add an edge
wiki-graph add-edge ./my-wiki --from "my-page" --to "other-page" --type relates_to

# Graph metrics
wiki-graph metrics ./my-wiki --json

# Rebuild index
wiki-graph rebuild-index ./my-wiki
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
await wiki.addNode({ slug: "my-page", title: "My Page", type: "concept" })
await wiki.addEdge({ from: "my-page", to: "other-page", type: "relates_to" })

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
