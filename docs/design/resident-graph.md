# 常驻内存图(Resident Graph)设计方案

> 状态：待评审
> 日期：2026-08-04
> 前序：`reason-causal-walk.md` §10（scanWiki A′ 缓存）、`task.md` #7
> 动机：reason agent 多轮探索中，每次图读取仍需 ~87ms stat 校验；常驻内存可将读操作降至 <1ms，同时间内支持更多推理轮次。

## 1. 现状与瓶颈

A′ 缓存（`62ee6b6`）已将 scanWiki 从冷 4.7s 降至热 ~50-90ms，但热路径拆解显示瓶颈不在建图：

| 环节 | 耗时（1150 页 / 5552 边） |
|------|--------------------------|
| scanWiki 热扫描（= 1150 次 stat 校验） | **86.7ms** |
| buildGraphFromPages（建图） | 5.2ms |
| 构建邻接表 | 1.2ms |
| getNode 全流程 | 92.1ms |
| getEdges k=1 全流程 | 83.3ms |

**结论**：瓶颈是每次调用对全部文件的 stat 校验（占 ~95%），不是建图。A′ 缓存免掉了"读文件+解析"，但没免掉"校验文件没被外部改过"。

reason agent 一轮漫游 30+ 次图读取（get_node / get_edges / read_graph），每次 ~90ms → 每轮 ~2.7s 纯等待。常驻内存可将此降至 <30ms/轮。

## 2. 目标与非目标

### 目标

- 读操作（getNode / getEdges / readGraph / getStats / getMetrics）在信任窗口内 **<1ms**（纯内存 Map 查找）
- 写操作（addNode / updateNode / renameNode / deleteNode / addEdge / removeEdge）保持 read-your-writes 语义
- 非 resident 行为 **零变更**（默认关闭，现有调用方无感知）
- MCP server 自动继承（已有 `wikiCache` 持有 WikiGraph 实例，生命周期 = reason session）

### 非目标

- **不做双 API**——同一套 WikiGraph 接口，resident 只是构造选项。"静态 API / 动态 API"的分离不引入。
- **不做位映射压缩**——实测 1150 页常驻 ~12MB，5 万页 ~425MB，内存从来不是第一约束（扫描时间先到升级触发器）。位映射留给百万节点级，现在做是纯负担。
- **不做跨进程缓存一致性**——wiki-lock 已防止并发写；trust window 覆盖"人工编辑"场景。不引入分布式失效协议。
- **不改变 A′ 缓存**——resident 是 A′ 之上的第二层，A′ 继续作为文件级缓存存在。

## 3. 架构：两层缓存

```
调用
 │
 ▼
WikiGraph.readXxx()
 │
 ├── resident=false（默认）────────────────────────────────────┐
 │   每次调用 → scanWiki（A′ 缓存，stat 校验）→ buildGraph     │  现有行为
 │   ~87ms/次                                                  │  不变
 │                                                             │
 ├── resident=true ────────────────────────────────────────────┤
 │   信任窗口内 → 直接查 this.graph / this.adjacency / slugIndex│  新增
 │   <1ms                                                     │
 │                                                             │
 │   窗口过期 → revalidate()                                   │
 │     = scanWiki（A′ 缓存兜底）+ rebuildGraph()               │
 │     ~90ms（一次性），然后回到 <1ms                           │
 │                                                             │
 │   写操作后 → rebuildAfterWrite(touchedPaths)                │
 │     精确失效触碰文件的 A′ 缓存条目 → 重读 → rebuildGraph()   │
 │     ~5-10ms（跳过 stat，因为刚写的文件不需要校验）            │
 └─────────────────────────────────────────────────────────────┘
```

**层次关系**：
- Layer 0（A′ 缓存）：`ScannedPage[]` 文件级缓存，懒 stat 失效。每次 scanWiki 仍 stat 全部文件。
- Layer 1（resident）：`Graph` + 邻接表 + slug 索引，进程级常驻。信任窗口内跳过 scanWiki。

Layer 1 的 revalidate 回落到 Layer 0，Layer 0 的冷扫描回落到磁盘。两层正交，互不干扰。

## 4. 接口设计

### 4.1 构造选项

```typescript
// 现有（不变）
new WikiGraph(wikiRoot)
new WikiGraph(wikiRoot, { maintainIndex: true, strictVerify: true })

// 新增
new WikiGraph(wikiRoot, {
  resident: true,            // 启用常驻内存图。默认 false。
  trustWindowMs: 30_000,     // 信任窗口。默认 30s。
                             //   0 = 永不重校验（单进程独占场景）
                             //   >0 = 窗口过期后下次读触发 revalidate
})
```

### 4.2 内部状态（仅 resident=true 时存在）

```typescript
class WikiGraph {
  // ... 现有字段 ...

  // ── Resident graph state（resident=true 时初始化）──
  private residentState: ResidentState | null = null
}

interface ResidentState {
  graph: Graph                          // buildGraphFromPages 产物
  adjacency: Map<string, GraphEdge[]>   // 双向邻接表（source→edges, target→edges）
  slugIndex: Map<string, ScannedPage>   // slug → ScannedPage（O(1) getNode）
  lastValidated: number                 // Date.now()，上次 revalidate 时间
}
```

### 4.3 读路径（resident=true）

```typescript
private ensureResident(): ResidentState {
  if (!this.residentState) {
    // 首次调用：全量构建（~90ms 一次性）
    this.residentState = this.buildResidentState()
    return this.residentState
  }

  const now = Date.now()
  const window = this.opts.trustWindowMs ?? 30_000
  if (window > 0 && now - this.residentState.lastValidated >= window) {
    // 窗口过期：重校验
    this.residentState = this.buildResidentState()
  }
  return this.residentState
}

private async buildResidentState(): Promise<ResidentState> {
  const pages = await scanWiki(this.wikiDir, this.wikiRoot)  // A′ 缓存兜底
  const graph = buildGraphFromPages(pages)
  const adjacency = buildAdjacencyFromGraph(graph)
  const slugIndex = new Map(pages.map(p => [p.slug, p]))
  return { graph, adjacency, slugIndex, lastValidated: Date.now() }
}
```

各读方法变为：

```typescript
async getNode(slug) {
  if (!this.resident) return getNode(this.wikiDir, this.wikiRoot, slug)  // 现有路径
  const state = await this.ensureResident()
  const page = state.slugIndex.get(normalizeSlug(slug))
  return page ? toWikiPage(page) : null   // O(1)
}

async getEdges(slug, opts) {
  if (!this.resident) return getEdges(...)  // 现有路径
  const state = await this.ensureResident()
  return queryAdjacency(state.adjacency, slug, opts)   // O(degree)，不重建图
}
```

### 4.4 写路径（resident=true）

写操作本身不变（仍走 node-ops / edge-ops → transaction → 磁盘）。变化在提交后：

```typescript
async addNode(input) {
  const result = await addNode(this.wikiDir, this.wikiRoot, input, ...)
  await this.maybeRebuildAfterWrite(input.dryRun, result)
  return result
}

/** dry-run 不触发重建；未建图不触发（下次读冷建即可） */
private async maybeRebuildAfterWrite(dryRun: boolean | undefined, result: { filesTouched: string[] }): Promise<void> {
  if (!this.resident || !this.residentState || dryRun || result.filesTouched.length === 0) return
  const pages = await rescanTouched(this.wikiDir, this.wikiRoot,
    result.filesTouched.map((p) => path.join(this.wikiRoot, p)))
  this.residentState = this.buildResidentFromPages(pages)
}
```

**增量重建，不是全量 scanWiki**（实施时修正设计）：`filesTouched` 是 wikiRoot 相对路径（来自 `tx.filesWritten`，含级联改写的引用方文件）。`rescanTouched` 只重读这几个文件（跳过 INFRA_FILES），更新 A′ 缓存条目，返回全量最新 pages 列表——被删除的文件（rename/delete 的旧文件）从缓存移除。重建图 + 邻接表 + 索引共 ~5ms，**不做 1150 次 stat**。

**三个边界**：
- `rebuildIndex` 只写 index.md（INFRA_FILES，不在图中）→ 不触发重建
- `dryRun` → transaction 不写盘但 `filesWritten` 返回预期清单，必须显式跳过（否则会按"文件不存在"误删节点）
- resident 但未建图（首个操作就是写）→ 跳过重建，下次读冷建，天然正确

**事实核查**：所有写操作（addNode / updateNode / renameNode / deleteNode / addEdge / removeEdge）的返回值**已经**包含 `filesTouched: string[]`（`src/types.ts:125`，node-ops/edge-ops 五处赋值，来自 `tx.filesWritten`，含级联改写的引用方文件）。**transaction 签名零改动**——rebuildAfterWrite 直接消费现有返回值的 `filesTouched` 即可。

### 4.5 生命周期

```typescript
async cleanup() {
  // 现有：释放锁等
  if (this.residentState) {
    this.residentState = null   // 释放内存
  }
  clearScanCache(this.wikiDir)  // 已有
}
```

## 5. 一致性语义

### 5.1 单进程（reason agent 典型场景）

- 读：信任窗口内 <1ms，窗口过期后首次读 ~90ms 重校验
- 写：read-your-writes 保证（rebuildAfterWrite 在返回前完成）
- 无并发写（wiki-lock 保证）

### 5.2 多进程（agent + 人工编辑）

- 人工在编辑器改了文件 → resident 图在信任窗口内是**过期的**
- trustWindowMs=30s 意味着最多 30s 过期窗口
- trustWindowMs=0 意味着永不过期（适合"agent 独占 wiki"场景）
- **不做**文件 watcher（chokidar）——引入依赖 + 跨平台复杂度，收益不匹配

### 5.3 与 wiki-lock 的关系

wiki-lock 防止并发**写**（两个 agent 同时 addNode）。resident 图的信任窗口处理的是**读一致性**（读到的是不是最新的）。两者正交：
- 有锁：写不会冲突，但读可能读到写之前的状态（信任窗口内）
- 无锁：写可能冲突（已有保护），读一致性同上

## 6. reason 集成

reason agent 通过 MCP 子进程访问图。MCP server 已有 `wikiCache: Map<string, WikiGraph>`。

**改动**：MCP server 构造 WikiGraph 时传入 resident 选项，并给 `wikiCache` 加 LRU 上限：

```typescript
// src/mcp/index.ts
const WIKI_CACHE_MAX = 3   // LRU 上限：最多同时常驻 3 个 wiki 的图

function getWiki(wikiRoot?: string): WikiGraph {
  const root = wikiRoot ?? defaultWikiRoot!
  if (!wikiCache.has(root)) {
    if (wikiCache.size >= WIKI_CACHE_MAX) {
      // 淘汰最久未用的实例：释放其 residentState，实例可留可丢
      const oldest = wikiCache.keys().next().value   // Map 迭代序 = 插入序，配合 touch 实现 LRU
      const evicted = wikiCache.get(oldest)!
      evicted.releaseResident()    // 只丢内存图，下次碰自动懒重建（~90ms 回落）
      wikiCache.delete(oldest)
    }
    wikiCache.set(root, new WikiGraph(root, {
      resident: true,
      trustWindowMs: 0,   // reason session 独占 wiki，永不重校验
    }))
  }
  // touch：Map 重新插入以更新 LRU 顺序
  const wiki = wikiCache.get(root)!
  wikiCache.delete(root)
  wikiCache.set(root, wiki)
  return wikiCache.get(root)!
}
```

**效果**：reason agent 的 30+ 轮图读取从每轮 ~90ms 降至 <1ms。MCP server 进程生命周期 = reason session，WikiGraph 实例自然常驻。

### 6.1 缓存切换语义（谁切换、怎么切）

两类调用方，两种语义：

**reason agent：绑定环境变量，不能切图。** `reason.ts` 的工具定义（REASON_READ_TOOLS / REASON_WRITE_TOOLS）**不含** `selected_wiki` 参数——agent 只能碰 spawn 时 `SELECTED_WIKI` 环境变量绑定的那个 wiki。这与本地工具沙箱（`resolveSandboxed` 锁死单一 wiki root）保持一致。切换 wiki = 新开一次 reason 指定别的 `--wiki`。**这是刻意设计**：若图工具暴露 `selected_wiki`，会造成"文件工具只能碰一个 wiki、图工具却能碰任何 wiki"的沙箱割裂。

**直连 MCP 客户端（Claude Desktop 等长驻场景）：`selected_wiki` 参数切换。** 13 个工具 schema 都带可选 `selected_wiki`，`getWiki(selectedWiki ?? defaultWikiRoot)` 按 root 懒创建实例。residentState 挂在 **WikiGraph 实例**上 → 天然 per-wiki 隔离，**写 A 永远不会脏 B**。懒建：新 wiki 首次被碰时才付 ~90ms 冷建，之后全程 <1ms。

**LRU 的真正服务对象是后者**：reason 单 wiki 场景下 LRU 永不触发；长驻 MCP 客户端跳多 wiki 时，进程不死、`wikiCache` 只增不减，才需要淘汰。

**已知小缝（暂不处理）**：reason 调 MCP 是 `callTool` 透传 args，服务端不校验——LLM 若幻觉出 schema 外的 `selected_wiki` 会被接受。当前是"schema 约定"而非强制。收紧方案：loop.ts 转发前 strip `selected_wiki`（一行）。判断：LLM 看不见的参数基本不会吐，先不做。

### 6.2 LRU 淘汰（已拍板：方案 A）

现 `wikiCache` 只增不减。非 resident 时代无所谓（facade 无状态，实例几 KB）；resident 化后每个被碰过的 wiki 压着 ~14MB+。agent 跳 20 个 wiki = ~300MB。

**方案 A（采纳）**：LRU 上限 `WIKI_CACHE_MAX = 3`。淘汰 = `releaseResident()` 丢弃内存图（实例本身可留可丢），agent 视角无感知，只是该 wiki 下次碰时回落到 ~90ms 懒重建。约 20 行。

方案 B（不做、信任 session 短命）已否决：内存占用随使用量线性增长而无上限，20 行代码换掉这个泄漏面更合算。

### 6.3 库直调方的切换

不走 MCP 的代码自己持有多实例即可：

```typescript
const a = new WikiGraph(dirA, { resident: true })
const b = new WikiGraph(dirB, { resident: true })
// ... 用完释放
await a.cleanup()   // 释放 residentState + scan cache
```

切换纯粹是调用方自己的对象管理，库不掺和。

### 6.4 缓存生命周期边界（重要澄清）

resident 图是 **per-session、非全局**：MCP server 是 reason 每次调用现 spawn 的子进程（`new McpClient()` → stdio connect）。一次 reason 跑完，子进程退出，所有常驻图随之释放；两次 reason 之间**不共享**，每次重新冷建（~90ms 一次性）。这符合"创建 reason 智能体时建好、留存到退出"的语义，但不是跨 session 的持久缓存。

CLI 单次命令（`llm-wiki stats` / `llm-wiki read`）不启用 resident（进程即退出，无收益）。

## 7. 内存估算

| 组件 | 1150 页 | 5000 页（外推） | 50000 页（外推） |
|------|---------|----------------|-----------------|
| ScannedPage 缓存（A′） | 9.6 MB | ~42 MB | ~420 MB |
| Graph（nodes+edges） | ~3 MB | ~13 MB | ~130 MB |
| 邻接表 | ~1.5 MB | ~6 MB | ~60 MB |
| slugIndex | ~0.1 MB | ~0.5 MB | ~5 MB |
| **合计** | **~14 MB** | **~62 MB** | **~615 MB** |

8GB 笔记本：5000 页 wiki 占 <1% 内存。50000 页才需要认真考虑——但那个规模下扫描时间（升级触发器 ~2500 页到 10s）早就先触发 SQLite 迁移了。

**位映射压缩**：如果真到 50 万页，邻接表可用 bitset 压缩（每对节点 1 bit），但这要求节点 ID 整数化 + 固定节点数，与当前 slug-based 设计冲突大。留作 v2+ 议题，不在本方案范围。

## 8. 测试计划

| 测试 | 覆盖点 |
|------|--------|
| resident 构造 + 首次读 | 懒初始化，首次 ~90ms，后续 <1ms |
| 信任窗口过期 | trustWindowMs=100，等 150ms，下次读触发 revalidate |
| trustWindowMs=0 | 永不 revalidate（验证 lastValidated 不更新） |
| 写后读一致 | addNode → getNode 立即返回新节点（read-your-writes） |
| 级联写后读一致 | renameNode → getEdges 返回更新后的边 |
| 外部编辑 + revalidate | 手工改文件 → 等窗口过期 → 读到新内容 |
| 非 resident 零回归 | resident=false 时所有测试与现有行为一致 |
| cleanup 释放内存 | cleanup() 后 residentState=null |

## 9. 实施步骤

1. **graph-builder 新增 `rescanTouched(wikiDir, wikiRoot, absPaths)`**——只重读触碰文件（跳过 INFRA_FILES、更新/移除 A′ 缓存条目）、返回全量最新 pages 的增量重建原语
2. **graph-builder 导出 `buildAdjacencyFromGraph`**（从 Graph 建邻接表，独立于 getEdges 内部的 buildAdjacency）
3. **WikiGraph facade 加 resident 逻辑**（ensureResident / maybeRebuildAfterWrite / releaseResident / 各读写方法分支）——rebuildAfterWrite 直接消费现有写返回值的 `filesTouched`（跳过 dryRun），**transaction 零改动**
4. **命名统一 + MCP server 启用 resident + LRU**（`wiki_root` 参数 → `selected_wiki`；默认解析 `--wiki > SELECTED_WIKI > WIKI_ROOT(deprecated) > 报错`；`getWiki` 传 resident:true，`WIKI_CACHE_MAX=3` 淘汰）——详见 §11
5. **agent spawn env 改 `SELECTED_WIKI`**（check / purge / reason / research 4 处）
6. **测试**（§8 全部 + 命名/解析优先级测试）
7. **benchmark**（resident 读 vs 非 resident 读，reason 模拟 30 轮）

预计改动：~200 行新增，~40 行修改（MCP getWiki + schema 改名 + releaseResident 挂接 + 4 处 spawn env）。**transaction 签名零改动**（`filesTouched` 已存在）。`selected_wiki` 参数名变更为 MCP schema 层 breaking change，无已知外部消费方（reason schema 不暴露此参数，tests 无引用）。

## 10. 备选方案（已否决）

| 方案 | 否决理由 |
|------|----------|
| 双 API（静态文件 API + 动态内存 API） | 两套接口面 = 双倍测试维护成本，收益为零。同一套 API + 构造选项即可。 |
| 位映射压缩邻接表 | 过早优化。当前规模 ~14MB，50000 页才 ~600MB。且 bitset 要求整数节点 ID，与 slug 设计冲突。 |
| 文件 watcher（chokidar）实时失效 | 引入依赖 + 跨平台复杂度。trust window 已覆盖人工编辑场景，成本更低。 |
| 缓存 Graph 但不缓存邻接表 | getEdges 仍需每次 filter 全部 edges（O(E)）。邻接表是 getEdges 的核心收益点。 |
| 在 A′ 缓存层直接缓存 Graph（不加 resident 选项） | 所有调用方被迫接受常驻内存语义。CLI 单次命令、测试等短生命周期场景不需要。选项化让调用方自选。 |

## 11. 命名统一：三族环境变量 + selected_wiki 参数（已拍板）

> 背景：CLI 侧默认 wiki 用 `SELECTED_WIKI`，MCP 侧却用 `WIKI_ROOT`，同一项目两族命名。
> 拍板（2026-08-04）：全项目统一到 `SELECTED_WIKI`；`wiki_root` MCP 参数改名 `selected_wiki`；`WIKI_ROOT` 走 deprecation warning（不硬删）。

### 11.1 三族语义（严格区分）

| 环境变量 | 语义 | 消费方 | 本次处置 |
|---|---|---|---|
| `WIKIS_ROOT` | wiki **集合**根目录（slug 解析、全局只读搜索） | 仅 CLI（wiki-resolve / use / status） | **不动** |
| `SELECTED_WIKI` | 当前**选中**的单个 wiki（`llm-wiki use` 设置；值可以是 slug 或路径） | CLI + **新增 MCP** | **升级为跨世界唯一默认** |
| `WIKI_ROOT` | MCP 旧默认环境变量 | MCP server | **停用**：deprecation warning，一个 release 周期后删 |

**假朋友（不是环境变量，不得误伤）**：`WIKI_ROOT_NOT_FOUND` 错误码字符串；tests/scripts 里的局部常量名。

### 11.2 MCP 默认 wiki 解析链（改后）

```
--wiki <path>                      （最高，显式）
SELECTED_WIKI env                  （次之；值可能是 slug，需 WIKIS_ROOT 参与解析）
WIKI_ROOT env                      （deprecated：stderr 警告一次，仍生效）
报错退出
```

**slug 解析复用**：CLI 的 `resolveToPath`（wiki-resolve.ts）抽出纯函数 `resolveWikiPath(value, wikisRoot)` ——返回路径或错误信息，**不 process.exit**。MCP 侧复用同一份逻辑，保证"同一 shell，CLI 能用、MCP 也能用"。

**MCP SDK env 白名单坑**：`StdioClientTransport` 只继承 HOME/PATH 等 sudo 风格变量，`SELECTED_WIKI`/`WIKIS_ROOT` 传不进外部客户端 spawn 的子进程。因此：
- 本仓 agent（check/purge/reason/research）走自研 `McpClient`（`env: {...process.env, ...config.env}` 全量继承），spawn 时显式传 `SELECTED_WIKI` 即可
- Claude Desktop 等外部客户端必须在 JSON 配置里显式写 `"env": { "SELECTED_WIKI": "...", "WIKIS_ROOT": "..." }`（README 补示例）

### 11.3 参数改名：wiki_root → selected_wiki

MCP 13 个工具 schema 的可选覆盖参数 `wiki_root` 全部改名 `selected_wiki`，消费点 `args?.wiki_root` → `args?.selected_wiki`。

**兼容性结论（已核实）**：reason agent 工具 schema 不含此参数（0 处引用）；tests 无引用；库层无引用。唯一理论消费方是直连 MCP 的 LLM 客户端——schema 改了什么 LLM 就看到什么，**直接改名，不留 alias**。

### 11.4 agent spawn env（4 处）

check.ts / purge.ts / reason.ts / research.ts 的 `mcp.connect({ env: { WIKI_ROOT: options.wikiRoot } })` → `env: { SELECTED_WIKI: options.wikiRoot }`。（ingest.ts 用 `--wiki` arg 传参，不受影响。）

### 11.5 LRU 淘汰与 A′ 缓存联动

LRU 淘汰（§6.2）必须**连 A′ 缓存一起清**（`clearScanCache(wikiDir)` + `releaseResident()`）：A′ 的模块级 `scanCache` 按 wikiDir 隔离但无上限，只丢 residentState 不清 A′ 的话，多 wiki 长驻场景下文件级缓存无限增长，内存上限是假的。
