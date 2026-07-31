# llm-wiki-ops 高级智能体层设计方案

> 状态：待评审（v3，MCP 规范升级至 2026-07-28 + 专家评审意见）
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
│   ├── tools.ts        # 本地共用工具：文件读写编辑、目录列表
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

**重试与退避**：

`chat()` 内置指数退避重试，应对 429/5xx 常态错误：

| 可重试状态码 | 最大重试次数 | 退避间隔 |
|-------------|-------------|---------|
| 429, 500, 502, 503, 504 | 3 | 1s → 2s → 4s（指数） |

429 响应若携带 `Retry-After` header，优先使用该值。不可重试的错误（400/401/403/404）直接抛出。

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

#### 4.2.1 上下文窗口管理

30 轮迭代中 tool result 可能累积到数十 KB（`read_graph` 返回 200 个节点），必须主动管理。

**策略**（参考 pi 的 compaction 设计，简化适配）：

1. **Tool result 截断**：单个 tool result 超过 **8KB** 时截断，尾部标注 `[truncated, N chars omitted]`。截断方向：读类工具保留头部（文件开头、列表前部），写类工具保留尾部（操作结果、错误信息）。

2. **滑动窗口**：总 messages 字符数超过模型 context 的 **70%** 时（按 4 chars ≈ 1 token 估算），保留 system prompt + 最近 **10 轮**对话，中间轮次压缩为一条摘要消息：
   ```
   [Summary of iterations 1-N: created 3 nodes (slug-a, slug-b, slug-c),
   added 5 edges, updated node slug-d. No errors.]
   ```
   摘要由 loop 代码模板生成（不调 LLM），只提取 toolCalls 日志中的操作名 + 关键参数 + 成功/失败。

3. **不做精确 token 计算**：不同模型 tokenizer 不同，字符数估算足够。

#### 4.2.2 多步操作的事务限制

Agent 通过 MCP 顺序调用 `add_node` → `add_edge` → `update_node`。如果第 3 步崩了，前两步已落盘，wiki 处于中间态。

**明确承认这个限制**。缓解策略：

- 每个单独操作**已经是原子的**（低级层 transaction 模块保证）
- `AgentResult.toolCalls` 数组是完整的操作日志——崩溃后调用方可据此判断做了什么、没做什么
- 不在 MCP server 侧加 batch 端点（那是在低级层加高级语义，违反分层原则）

### 4.3 agent/mcp.ts — MCP 客户端

支持两种标准传输：

| 传输 | 场景 |
|------|------|
| **stdio** | 本地 server（wiki-graph-mcp、本地搜索工具） |
| **Streamable HTTP** | 远程 server（云端搜索、SaaS 工具） |

不做 legacy SSE（2024-11-05 的 HTTP+SSE 已废弃）。

**连接模型**：stdio spawn 一次，保持长连接。不是每次 tool call 都 spawn。

#### 4.3.1 目标规范与版本兼容

**主要目标：MCP spec 2026-07-28**（2026 年 7 月 28 日发布，自发布以来最大修订）。

2026-07-28 的核心变化——**无状态协议**：

| 旧（≤ 2025-11-25） | 新（2026-07-28） |
|---------------------|-------------------|
| 连接时 `initialize`/`initialized` 握手 | **废除**。每个请求自带 `_meta`（protocolVersion、clientInfo、capabilities） |
| `Mcp-Session-Id` header 维持会话 | **废除**。每个请求完全自包含，可落在任意 server 实例 |
| server-to-client SSE 推送 | **废除**。替代方案：MRTR（Multi Round-Trip Requests），server 返回 `resultType: "input_required"`，client 带回答重新调用 |
| Streamable HTTP header 可选 | `Mcp-Method`、`Mcp-Name`、`MCP-Protocol-Version` 现在是**必需** header |
| `tools/list` 无缓存提示 | 响应携带 `ttlMs` + `cacheScope`，客户端可据此缓存 |
| — | 新增可选 `server/discover` RPC（获取 server 能力，非必须） |

**兼容策略**：2026-07-28 刚发布，现有 MCP server（包括我们自己的 `wiki-graph-mcp` 依赖的 `@modelcontextprotocol/sdk`）大概率还在说 2025-11-25。客户端必须兼容两版：

```
connect(server):
  1. 发送 tools/list，请求带 _meta: { protocolVersion: "2026-07-28", clientInfo: {...} }
     + Streamable HTTP 时带 Mcp-Method / Mcp-Name / MCP-Protocol-Version header
  2. 如果 server 返回错误（不认识 _meta / 要求 initialize）：
     → fallback：发送 initialize 握手（protocolVersion: "2025-11-25"）
     → 等待 initialized 确认
     → 重新发送 tools/list（不带 _meta）
  3. 记录 server 实际协议版本，后续请求按该版本格式发送
```

stdio 和 Streamable HTTP 共用同一套 fallback 逻辑。stdio 下 `_meta` 在 JSON-RPC params 里传；HTTP 下额外带 header。

**实现的 JSON-RPC 方法子集**：

| 方法 | 说明 | 2026-07-28 | ≤ 2025-11-25 |
|------|------|-----------|-------------|
| `tools/list` | 获取 tool 列表 | ✅ 带 `_meta` | ✅ 需先 initialize |
| `tools/call` | 调用 tool | ✅ 带 `_meta` | ✅ |
| `initialize` | 握手 | ❌ 已废除 | ✅ fallback 时用 |
| `notifications/initialized` | 确认初始化 | ❌ 已废除 | ✅ fallback 时用 |
| `server/discover` | 获取 server 能力 | 可选 | 不存在 |

**不实现**：资源订阅（resources）、prompts、sampling、MRTR（v1 不需要 server 向 client 发起请求）、Extensions/MCP Apps/Tasks。

**`tools/list` 缓存**：server 返回 `ttlMs` 时，客户端在 TTL 内复用缓存的 tool 列表，不重复请求。未返回 `ttlMs` 时每次 connect 请求一次。

#### 4.3.2 接口

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

v1 只提供文件系统工具，**不提供 `run_shell`**（五个高级 agent 均无 shell 需求，安全风险不值得）。

| 工具 | 说明 |
|------|------|
| `read_file` | 读文件（带行号、分页、自动截断） |
| `write_file` | 写文件（覆盖） |
| `edit_file` | 精确查找替换编辑（支持模糊匹配） |
| `list_directory` | 列目录 |

**安全约束**：

- 所有路径操作限制在 wiki root 目录内（`resolveToCwd` 模式，路径逃逸 → 报错）
- 文件写入按路径串行化（防止并行 tool 执行时竞争写同一文件）
- 输出截断：`read_file` 超过 50KB / 2000 行时截断

**不提供 `get_datetime`**：当前时间写进每个 agent 的 system prompt，省一轮 round-trip。

### 4.5 五个高级智能体

每个 agent 是一个独立文件，内联 system prompt，定义自己的 tool 子集和默认参数。

**MCP server 暴露的实际工具名**（agent tool 集必须与之一致）：

`get_stats`、`read_graph`、`get_node`、`get_edges`、`add_node`、`update_node`、`rename_node`、`delete_node`、`add_edge`、`remove_edge`、`rebuild_index`、`metrics`

以下 tool 集中 `wiki.` 前缀由 MCP 客户端自动添加。

#### ingest.ts

- **输入**：文档路径（**MD/TXT/HTML**）+ wiki root。PDF 需调用方预处理为文本。
- **tool 集**：`wiki.get_stats`、`wiki.add_node`、`wiki.add_edge`、`wiki.get_node`、`wiki.read_graph`、`wiki.rename_node`、`wiki.rebuild_index` + 本地文件工具
- **行为**：读文档 → 提取结构 → 决定建哪些节点（类型、slug、关联）→ 写入 wiki
- **不包含**：`wiki.delete_node`（ingest 不删东西）

#### research.ts

- **输入**：查询（自然语言）+ wiki root + 搜索 MCP server
- **tool 集**：`wiki.get_stats`、`wiki.read_graph`、`wiki.get_node`、`wiki.get_edges`、`wiki.update_node`、`wiki.add_node`、`wiki.add_edge`、`wiki.rename_node` + 搜索 MCP tools
- **行为**：查子图 → 搜索补充 → 更新过期节点（在节点内注明更新原因和来源）→ 返回新子图
- **关键约束**：更新节点时必须注明"为什么更新"（来源 URL + 日期 + 原因）

#### purge.ts

- **输入**：目标 + wiki root
- **tool 集**：`wiki.get_stats`、`wiki.read_graph`、`wiki.get_node`、`wiki.delete_node`、`wiki.remove_edge`
- **行为**：识别过期/错误内容 → 删除 → 清理引用
- **不包含**：`wiki.add_node`（purge 不建东西）

**三种触发模式**：

| 模式 | CLI 参数 | 是否需要 LLM |
|------|----------|-------------|
| 日期阈值 | `--stale-before 2025-01-01`（按 `updated` 字段） | 不需要 |
| 内容判断 | `--query "..."` + 搜索 MCP 验证是否过时 | 需要 |
| 精确指定 | `--slugs a,b,c` 直接删 | 不需要 |

> 注：`updated` 日期只代表最后修改时间，不代表内容过时。日期阈值是机械规则，内容判断才需要 LLM + 搜索验证。

#### check.ts

- **输入**：查询（子图范围）+ wiki root + 搜索 MCP server
- **tool 集**：`wiki.get_stats`、`wiki.read_graph`、`wiki.get_node`、`wiki.get_edges`、`wiki.delete_node`、`wiki.remove_edge`、`wiki.update_node`、`wiki.add_node`、`wiki.add_edge` + 搜索 MCP tools
- **行为**：独立 loop。核验子图每条内容 → 不属实则 purge → 属实但不确定则 research 补充
- **设计决策**：check 是独立 agent loop，不是代码编排。因为"属实但不确定"和"不属实"之间的界限是模糊的，LLM 比 if/else 判断得好。

#### reason.ts

- **输入**：查询（子图范围）+ wiki root
- **tool 集**：`wiki.get_stats`、`wiki.read_graph`、`wiki.get_node`、`wiki.get_edges`、`wiki.metrics`
- **行为**：深度图推理——发现陌生节点关联、发现查询缺口、提取事物发展模式

**双模式**：

| 模式 | CLI 参数 | 行为 | tool 集差异 |
|------|----------|------|------------|
| 报告模式（默认） | `--report` | 只返回推理报告，不改 wiki | 只有读操作 |
| 应用模式 | `--apply` | 把发现的关联写入图 | 加入 `wiki.add_edge`、`wiki.update_node` |

默认不改东西。要改，用户显式 `--apply`。

## 5. CLI 设计

### 二进制名

| bin 名 | 入口 | 说明 |
|--------|------|------|
| `llm-wiki` | `cli/index.ts` | 用户面对的主命令 |
| `llm-wiki-ops` | `cli/index.ts` | alias（向后兼容） |
| `wiki-graph-mcp` | `mcp/index.ts` | MCP server（不变） |

npm 包名保持 `llm-wiki-ops`。项目处于 v0.1.0，semver 0.x 允许 breaking change，但保留 alias 是零成本的。

### 命令结构

```bash
# 低级操作（现有 12 个，收进 graph 子命令）
llm-wiki graph stats
llm-wiki graph add-node --title "My Page" --type concept
llm-wiki graph get-edges my-slug --depth 2
llm-wiki graph read --type concept --query "attention"
llm-wiki graph metrics --json

# 高级操作（新增）
llm-wiki ingest ./paper.md --wiki ./my-wiki
llm-wiki research "量子计算最新进展" --wiki ./my-wiki
llm-wiki purge --stale-before 2025-01-01 --wiki ./my-wiki
llm-wiki purge --slugs old-page-1,old-page-2 --wiki ./my-wiki
llm-wiki check --center "attention-mechanism" --depth 2 --wiki ./my-wiki
llm-wiki reason --center "transformer" --depth 3 --wiki ./my-wiki
llm-wiki reason --center "transformer" --depth 3 --apply --wiki ./my-wiki
```

不做隐式 fallback（`llm-wiki stats` ≠ `llm-wiki graph stats`）。命令层级明确。

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
- JSON-RPC：手写（实现子集见 §4.3）

不装 `openai` SDK，不装 `@modelcontextprotocol/sdk`（客户端侧）。

> 注：`@modelcontextprotocol/sdk` 仍作为 `mcp/index.ts`（server 侧）的依赖保留。

## 9. 测试策略

| 层 | 方法 | 说明 |
|----|------|------|
| `openai.ts` | mock fetch | 测重试/退避/错误处理/不可重试状态码直接抛出 |
| `mcp.ts` | 集成测试 | 起真实 `wiki-graph-mcp` 子进程，测 connect/listTools/callTool/closeAll |
| `loop.ts` | mock LLM | 返回固定 tool_calls 序列，测五种停止条件（自然停止/maxIterations/熔断/超时/abort） |
| 五个 agent | fixture wiki + mock LLM | 端到端：给定输入文档/查询 + 预设 LLM 回复序列 → 验证 wiki 文件变更 |

## 10. 实现顺序

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

## 附录 A：专家评审意见处理记录

| # | 意见 | 处理 |
|---|------|------|
| 1 | ingest 无法处理 PDF | ✅ 输入规格改为 MD/TXT/HTML，PDF 由调用方预处理 |
| 2 | 工具名与实际 MCP server 不一致 | ✅ 全部对齐：`get_stats`/`read_graph`/.../`metrics` |
| 3 | 五个 agent 缺 `get_stats` | ✅ 全部加入 |
| 4 | LLM 客户端缺重试/退避 | ✅ 429/5xx 指数退避，最多 3 次 |
| 5 | 上下文窗口管理未讨论 | ✅ 新增 §4.2.1：截断 + 滑动窗口 + 模板摘要 |
| 6 | 多步操作无事务保护 | ⚠️ 承认限制（§4.2.2），不在低级层加 batch 端点 |
| 7 | `run_shell` 安全风险 | ✅ v1 砍掉，tools.ts 只保留文件操作 |
| 8 | CLI 二进制名 breaking change | ⚠️ 保留 `llm-wiki-ops` alias bin，不做隐式 fallback |
| 9 | purge 过期定义模糊 | ✅ 三种触发模式：日期阈值 / LLM 内容判断 / 精确 slug |
| 10 | 测试策略缺失 | ✅ 新增 §9：四层测试方案 |
| 11 | reason 规格最弱，"只发现"与写操作矛盾 | ✅ 双模式：`--report`（默认，只读）/ `--apply`（写） |
| 12 | `get_datetime` 价值存疑 | ✅ 砍掉，当前时间写进 system prompt |
| 13 | MCP 客户端工作量被低估 | ✅ 目标升级为 spec 2026-07-28（无状态核心），兼容 ≤2025-11-25 fallback；明确方法子集 + 缓存 |
| 14 | 缺 `rename_node` | ✅ ingest 和 research 的 tool 集加入 |
