# llm-wiki-ops 高级智能体层设计方案

> 状态：待评审
> 日期：2026-07-31

## 1. 背景与动机

llm-wiki-ops 当前提供 12 个低级图操作（add-node、get-edges、read 等），全部是确定性纯文件操作，零 LLM、零网络依赖。这些操作是"手和脚"——移文件、改 frontmatter、插 wikilink。

缺失的是"脑子"：agent 需要的不是"帮我调 add-node"，而是"把这篇论文编译进 wiki"、"核验这个子图的事实"、"发现这些节点之间的隐藏关联"。

本方案在现有低级操作之上，增加五个高级智能体命令：

| 命令 | 一句话定义 |
|------|-----------|
| `ingest` | 对输入文档进行摄取，"编译"进指定 wiki |
| `research` | 查询子图 → 网上检索补充信息 → 更新过期节点（注明原因）→ 返回新子图 |
| `purge` | 删除过期内容、错误内容 |
| `check` | 核验子图内容是否属实，不属实则 purge，属实则 research 补充确定性 |
| `reason` | 图推理/推演：发现陌生节点关联、发现查询缺口、提取事物发展模式 |

## 2. 分层架构

```
llm-wiki ingest / research / purge / check / reason    ← 高级：LLM + 网络
    │
    │  MCP 协议（stdio 长连接 / Streamable HTTP）
    ▼
wiki-graph-mcp (12 个 graph 操作)                       ← 低级：纯文件，零 LLM
    + 外部 MCP server（搜索等）
```

### 设计原则

- **低级层不动**：`core/`、`io/`、`concurrency/`、`transaction/`、`metrics/`、`mcp/index.ts` 全部不改。
- **高级层通过 MCP 协议调用低级层**：agent loop 不 import WikiGraph，不 import 搜索 SDK。它只认识 MCP tools。所有能力都是"连一个 server，拿到 tool 列表，调"。
- **同一个项目，加 LLM 依赖**：不拆包。CLI 命令 `llm-wiki graph xxx` 不碰 LLM；`llm-wiki ingest/research/...` 内部调 LLM。

## 3. 目录结构

```
src/
├── agent/
│   ├── openai.ts       # 自包含 OpenAI 兼容客户端（纯 fetch，零 SDK）
│   ├── loop.ts         # 智能体循环
│   ├── mcp.ts          # MCP 客户端（stdio + Streamable HTTP）
│   ├── tools.ts        # 本地共用工具：文件读写编辑、目录、shell、日期时间
│   ├── ingest.ts       # ingest 智能体
│   ├── research.ts     # research 智能体
│   ├── purge.ts        # purge 智能体
│   ├── check.ts        # check 智能体
│   └── reason.ts       # reason 智能体
├── cli/
│   ├── index.ts        # 主入口，路由 graph/ 和高级命令
│   └── graph.ts        # llm-wiki graph xxx（现有 12 个操作）
├── mcp/
│   └── index.ts        # wiki-graph-mcp（不动）
├── core/               # 不动
├── io/                 # 不动
├── concurrency/        # 不动
├── transaction/        # 不动
├── metrics/            # 不动
├── types.ts
└── index.ts
```

## 4. 各模块设计

### 4.1 agent/openai.ts — LLM 客户端

自包含的 OpenAI 兼容客户端，纯 `fetch` 实现，不依赖 openai SDK。

**配置**（环境变量）：

| 变量 | 说明 |
|------|------|
| `OPENAI_BASE_URL` | API 端点（如 `https://api.openai.com/v1`） |
| `OPENAI_API_KEY` | API 密钥 |
| `OPENAI_MODEL_NAME` | 模型名（如 `gpt-4o`） |

缺少任何一个 → 启动时报错，明确告知缺哪个。

**接口**：

```typescript
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface ChatOptions {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
}

interface ChatResponse {
  message: ChatMessage
  usage: { promptTokens: number; completionTokens: number }
  finishReason: "stop" | "tool_calls" | "length"
}

async function chat(options: ChatOptions): Promise<ChatResponse>
```

非 streaming（agent loop 不需要流式）。

### 4.2 agent/loop.ts — 智能体循环

```
prompt → LLM → tool_calls? ──yes──→ execute tools → append results → LLM → ...
                         └──no───→ 返回最终回复
```

**停止条件**：

| 条件 | 默认值 | 说明 |
|------|--------|------|
| LLM 自然停止 | — | 返回的 message 无 tool_calls |
| maxIterations | 30 | 防无限循环 |
| 连续错误熔断 | 3 | 连续 N 次 tool 调用失败 → 停止 |
| wall clock 超时 | 10 min | 整个 agent 运行时间上限 |
| abort() | — | 外部中断（CLI 层捕获 SIGINT 后调用） |

**返回结构**：

```typescript
interface AgentResult {
  status: "completed" | "max_iterations" | "error" | "timeout" | "aborted"
  iterations: number
  messages: ChatMessage[]
  toolCalls: ToolCallLog[]
  finalMessage: string
  error?: string
}

interface ToolCallLog {
  iteration: number
  tool: string
  args: Record<string, unknown>
  result: unknown
  error?: string
  durationMs: number
}
```

**接口**：

```typescript
interface AgentConfig {
  systemPrompt: string
  tools: ToolDefinition[]
  maxIterations?: number       // 默认 30
  maxConsecutiveErrors?: number // 默认 3
  timeoutMs?: number           // 默认 600_000
}

async function runAgent(
  config: AgentConfig,
  userMessage: string,
  mcpClient: McpClient,
  localTools: LocalToolRegistry,
): Promise<AgentResult>
```

### 4.3 agent/mcp.ts — MCP 客户端

支持两种标准传输：

| 传输 | 场景 |
|------|------|
| **stdio** | 本地 server（wiki-graph-mcp、本地搜索工具） |
| **Streamable HTTP** | 远程 server（云端搜索、SaaS 工具） |

不做 legacy SSE。

**连接模型**：stdio spawn 一次，保持长连接。不是每次 tool call 都 spawn。

```typescript
interface McpServerConfig {
  name: string
  transport: "stdio" | "http"
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http
  url?: string
  headers?: Record<string, string>
}

class McpClient {
  async connect(config: McpServerConfig): Promise<void>
  async listAllTools(): Promise<ToolDefinition[]>
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  async closeAll(): Promise<void>
}
```

**典型用法**（agent 启动时）：

```typescript
const mcp = new McpClient()
await mcp.connect({
  name: "wiki",
  transport: "stdio",
  command: "wiki-graph-mcp",
  args: ["--wiki", wikiRoot],
})
await mcp.connect({
  name: "search",
  transport: "http",
  url: "https://search.example.com/mcp",
})
```

Tool 名称自动加 server 前缀避免冲突：`wiki.add_node`、`search.web_search`。

### 4.4 agent/tools.ts — 本地共用工具

参考 Hermes Agent 的基础工具集，提供 agent 操作本地文件系统的能力：

| 工具 | 说明 |
|------|------|
| `read_file` | 读文件（带行号、分页） |
| `write_file` | 写文件（覆盖） |
| `edit_file` | 精确查找替换编辑 |
| `list_directory` | 列目录 |
| `run_shell` | 执行 shell 命令（带超时） |
| `get_datetime` | 当前日期时间 |

这些工具不经过 MCP，直接在 loop 内执行。与 MCP tools 合并后一起传给 LLM。

### 4.5 五个高级智能体

每个 agent 是一个独立文件，内联 system prompt，定义自己的 tool 子集和默认参数。

#### ingest.ts

- **输入**：文档路径（PDF/MD/TXT/HTML）+ wiki root
- **tool 集**：`wiki.add_node`、`wiki.add_edge`、`wiki.get_node`、`wiki.read_graph`、`wiki.rebuild_index` + 本地文件工具
- **行为**：读文档 → 提取结构 → 决定建哪些节点（类型、slug、关联）→ 写入 wiki
- **不包含**：`wiki.delete_node`（ingest 不删东西）

#### research.ts

- **输入**：查询（自然语言）+ wiki root + 搜索 MCP server
- **tool 集**：`wiki.read_graph`、`wiki.get_node`、`wiki.get_edges`、`wiki.update_node`、`wiki.add_node`、`wiki.add_edge` + 搜索 MCP tools
- **行为**：查子图 → 搜索补充 → 更新过期节点（在节点内注明更新原因和来源）→ 返回新子图
- **关键约束**：更新节点时必须注明"为什么更新"（来源 URL + 日期 + 原因）

#### purge.ts

- **输入**：目标（slug / 查询 / 过期日期阈值）+ wiki root
- **tool 集**：`wiki.read_graph`、`wiki.get_node`、`wiki.delete_node`、`wiki.remove_edge`
- **行为**：识别过期/错误内容 → 删除 → 清理引用
- **不包含**：`wiki.add_node`（purge 不建东西）

#### check.ts

- **输入**：查询（子图范围）+ wiki root + 搜索 MCP server
- **tool 集**：`wiki.read_graph`、`wiki.get_node`、`wiki.get_edges`、`wiki.delete_node`、`wiki.remove_edge`、`wiki.update_node`、`wiki.add_node`、`wiki.add_edge` + 搜索 MCP tools
- **行为**：独立 loop。核验子图每条内容 → 不属实则 purge → 属实但不确定则 research 补充
- **设计决策**：check 是独立 agent loop，不是代码编排。因为"属实但不确定"和"不属实"之间的界限是模糊的，LLM 比 if/else 判断得好。

#### reason.ts

- **输入**：查询（子图范围）+ wiki root
- **tool 集**：`wiki.read_graph`、`wiki.get_node`、`wiki.get_edges`、`wiki.get_metrics`、`wiki.add_edge`、`wiki.update_node`
- **行为**：深度图推理——发现陌生节点关联、发现查询缺口、提取事物发展模式
- **特点**：最重的 LLM 任务，maxIterations 可能需要调高
- **不包含**：`wiki.delete_node`（reason 不删东西，只发现）

## 5. CLI 设计

### 二进制名

| bin 名 | 入口 | 说明 |
|--------|------|------|
| `llm-wiki` | `cli/index.ts` | 用户面对的主命令 |
| `wiki-graph-mcp` | `mcp/index.ts` | MCP server（不变） |

npm 包名保持 `llm-wiki-ops`。

### 命令结构

```bash
# 低级操作（现有 12 个，收进 graph 子命令）
llm-wiki graph stats
llm-wiki graph add-node --title "My Page" --type concept
llm-wiki graph get-edges my-slug --depth 2
llm-wiki graph read --type concept --query "attention"
llm-wiki graph metrics --json

# 高级操作（新增）
llm-wiki ingest ./paper.pdf --wiki ./my-wiki
llm-wiki research "量子计算最新进展" --wiki ./my-wiki
llm-wiki purge --stale-before 2025-01-01 --wiki ./my-wiki
llm-wiki check --center "attention-mechanism" --depth 2 --wiki ./my-wiki
llm-wiki reason --center "transformer" --depth 3 --wiki ./my-wiki
```

### Wiki root 解析

与现有 CLI 一致：`--wiki <path>` > `WIKI_ROOT` 环境变量 > 报错。

### 高级命令通用选项

| 选项 | 说明 |
|------|------|
| `--wiki <path>` | wiki 根目录 |
| `--json` | JSON 输出（AgentResult 结构） |
| `--max-iterations <n>` | 覆盖默认 30 |
| `--timeout <minutes>` | 覆盖默认 10 |
| `--mcp-config <path>` | 外部 MCP server 配置文件（JSON） |
| `--verbose` | 打印每轮 tool 调用日志到 stderr |

## 6. MCP server 配置

高级 agent 需要连接外部 MCP server（搜索等）。配置文件格式：

```json
{
  "servers": [
    {
      "name": "search",
      "transport": "http",
      "url": "https://search.example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    },
    {
      "name": "local-tools",
      "transport": "stdio",
      "command": "some-mcp-server",
      "args": ["--flag"]
    }
  ]
}
```

wiki-graph-mcp 不需要配置——agent 启动时自动连接，wiki root 从 `--wiki` / `WIKI_ROOT` 取。

## 7. 不动的部分

| 模块 | 理由 |
|------|------|
| `core/` | 低级操作内核，已验证 |
| `io/` | frontmatter / wikilink / fs 工具 |
| `concurrency/` | 锁 + 乐观并发 |
| `transaction/` | 多文件事务 |
| `metrics/` | 图指标计算 |
| `mcp/index.ts` | wiki-graph-mcp server，agent 通过 MCP 连它 |

## 8. 依赖变更

新增零个 npm 依赖：

- LLM 客户端：纯 `fetch`（Node 20+ 内置）
- MCP 客户端：纯 `fetch` + `child_process.spawn`（Node 内置）
- JSON-RPC：手写（协议极简）

不装 `openai` SDK，不装 `@modelcontextprotocol/sdk`（客户端侧）。

> 注：`@modelcontextprotocol/sdk` 仍作为 `mcp/index.ts`（server 侧）的依赖保留。

## 9. 实现顺序

1. `agent/openai.ts` — LLM 客户端（无外部依赖，可独立测试）
2. `agent/mcp.ts` — MCP 客户端（stdio + Streamable HTTP）
3. `agent/tools.ts` — 本地工具
4. `agent/loop.ts` — 智能体循环（依赖 1/2/3）
5. `cli/graph.ts` — 现有操作搬迁到 graph 子命令
6. `cli/index.ts` — 主入口路由
7. `agent/purge.ts` — 最简单的高级 agent（不需要网络）
8. `agent/ingest.ts` — 核心场景
9. `agent/research.ts` — 需要搜索 MCP
10. `agent/check.ts` — 组合能力
11. `agent/reason.ts` — 最重的推理任务
