# llm-wiki dream 设计方案：用"人类做梦"治理知识图谱

> 状态：讨论稿（第 2 轮，已拍板 —— 见 §11）
> 日期：2026-08-07
> 前序文档：`agent-layer.md`、`reason-inference.md`、`reason-causal-walk.md`、`resident-graph.md`
> 来源：三个并行子智能体设计（usage log 底层 / 候选选择与记忆机制 / 渐进压缩与幻觉产物）+ 主线程审计整合。所有代码锚点已在整合时抽查验证（2026-08-07）。

## 1. 背景与定位

**dream 与 purge 并存，不合并。**

- `purge` = 定向遗忘：用户显式意图驱动的外科手术（`--stale-before`/`--slugs` 纯代码路径必须保留）。
- `dream` = 自发整理：图谱状态驱动的"睡眠期"加工——清除冗余、加强重要链接、随机跨记忆整合、建立新关联。它是所有智能体中随机性最大的一个。
- dream 是唯一的"消费者"智能体：ingest/research/check/reason 是"清醒生活"，dream 是它们的"睡眠生活"。
- dream 复用 purge 的安全机制：默认不物理删除、`status: invalidated` + `superseded_by`、pre-write git snapshot 可逆。

## 2. 神经科学 → 系统映射（设计依据）

人类做梦不是屏保，而是夜间记忆加工的主观体验：记忆重放与巩固（重要的变强）、冗余修剪与遗忘（无用的淡忘）、情绪削平（剥离情绪保留事实）、跨记忆重组（随机拼接产生新关联与灵感）。梦境内容并非随机：大脑按情绪唤醒度、自我相关性、反复排练强度筛选入梦材料，且存在 dream-lag effect（重要事件除当晚入梦外，还会在第 5–7 晚延迟编入，对应深层整合）。

| 人脑 | 系统对应物 | 来源 |
|------|-----------|------|
| 被反复排练（重放） | usage log 查询/读取次数 | **需新建**（§4） |
| 自我相关性 | 入度 / hub 状态 | `metrics/topology.ts` 已有（degree > p95 = hub） |
| 鲜活度 | as_of/checked/updated 时钟 | `core/freshness.ts` 已有 |
| 情绪强度（被"琢磨"过） | hypothesis 页、`needs-verification` tag、`contradicts` 边 | 已有（§5.5） |
| dream-lag（延迟编入） | journal 中未闭合 thread 下次优先重访 | 需新建（§5.1） |
| 梦是灵感也是幻觉 | dream 产物默认 ⚠️ UNVERIFIED，清醒时核验 | 需新建（§7） |
| 遗忘是渐进的 | 压缩阶梯：active → condensed → skeleton → 删除 | 需新建（§6） |

## 3. 总体架构

三个子系统，自底向上：

```
┌─────────────────────────────────────────────────────────┐
│  dream agent（LLM，随机性最大）                            │
│  输入：压力快照 + salience 表(原始数字) + 线索清单 + 梦境场景  │
│  动作：压缩 / 加强 / 建关联 / 产出梦境页（dreams/）          │
├─────────────────────────────────────────────────────────┤
│  选择机制（纯代码）                                        │
│  pressure（该不该做梦）· salience（谁值得梦）·              │
│  random activation（随机拼接梦境）· thread（未决线索重访）   │
├─────────────────────────────────────────────────────────┤
│  usage log（底层，所有 CRUD 必经）                         │
│  .llm-wiki-ops/usage/YYYY-MM-DD.jsonl + 纯代码统计 API     │
└─────────────────────────────────────────────────────────┘
```

## 4. usage log（底层访问/操作日志）

**定位**：底层能力，不是 dream 的附属。除本地文件工具（§9，dream 写梦境页、check 写 verified 标记）外，所有图谱读写必经 usage log——任何路径无法绕过。

### 4.1 埋点位置：WikiGraph facade（唯一咽喉）

在 facade 方法层埋点（`src/index.ts:110–268`）。理由：所有消费者在此汇聚——MCP handler 调 `wiki.*`（`mcp/index.ts`）、CLI 走 `withWiki()`（`cli/graph.ts`）、库用户只能 import `WikiGraph`（唯一公开导出）。在 core 层埋点会让 facade 路径双重计数；只在 MCP 埋点则 CLI/库用户可绕过。

开关：`maintainLog` 选项**已预留未使用**（`types.ts:245`、`index.ts:87,101`，当前默认 false）。提案翻转为**默认 true**（底层要求），测试 helper 传 `maintainLog: false`。

记录范围：**读 + 写都记**（salience 需要"被查询最多"信号；写隐含注意力）。`getStats`/`scanFreshness` 记 `slug: null`（接口活动，不参与节点统计）；stats 查询本身不经过 facade，无递归。

### 4.2 actor 归属：构造参数 + env，不用 AsyncLocalStorage

每个 MCP server 进程 = 一个 agent 会话（stdio spawn），一进程一 actor，无需请求级上下文传播。

- `WikiGraphOptions` 增加 `actor?: string`；MCP server 在 `wiki-cache.ts` 构造实例时传 `actor: process.env.WIKI_AGENT ?? "mcp"`。
- 各 agent spawn 处加一行 env：`WIKI_AGENT: "reason"` 等（现有 `SELECTED_WIKI` 传递点：`check.ts:207`、`purge.ts:229`、`reason.ts:254`、`research.ts:212`；ingest 的 spawn 方式不同，实施时确认；dream 在 P1 新增 spawn 点时一并加）。
- CLI 传 `actor: "cli"`；库消费者默认 `"lib"`。
- actor 可伪造（env 信任模型）——单用户本地工具，记录即可，不做门禁（镜子不是缰绳）。

### 4.3 JSONL schema

```json
{"ts":"2026-08-06T14:03:22.412Z","op":"get_node","slug":"foo","actor":"reason","ok":true}
```

| 字段 | 说明 |
|------|------|
| `ts` | ISO-8601 毫秒（UTC） |
| `op` | facade 方法名（`get_node`、`add_edge`…） |
| `slug` / `slugs` | 字符串；边操作为二元数组；无目标操作为 null |
| `actor` | `ingest`/`research`/`check`/`reason`/`purge`/`dream`/`cli`/`mcp`/`lib` |
| `dry` | 仅当 true 时存在（dry-run 的写尝试也记录——"打算做什么"也是信号） |
| `ok`,`err` | 失败也记（`ok:false` + 错误码）——负信号也是信号 |

不设 tool-name 字段：`op` 已标识接口，MCP 工具名 1:1 映射。

### 4.4 存储与写入路径

位置：`.llm-wiki-ops/usage/YYYY-MM-DD.jsonl` —— **按天分文件**。状态目录已存在（锁与 inflight 标记同住），按天分区使 1/7/30 天窗口只需读 ≤30 个文件，**零轮转代码**。保留策略：跨天时顺手删除 >90 天的文件。

- **读路径（热路径）**：绝不 await。内存缓冲成行后 `fs.promises.appendFile` fire-and-forget + 错误静默池。最坏情况崩溃丢几条读事件——对 salience 统计可接受。绝不为此拿 wiki 锁（会把毫秒级读路径串行化）。
- **写路径**：await 后再返回。写本已被 proper-lockfile 全局串行化（`wiki-lock.ts`），多一次 append 是噪声级开销。
- **并发 append**（多 agent MCP 进程 + CLI 同时操作一个 wiki）：无需加锁。每次 flush 是单次 write 调用；Windows `FILE_APPEND_DATA` 单次调用原子。批 <4KB。
- usage 文件在 `wiki/` 之外 → `scanWiki` 与常驻图零影响。
- **进程退出前必须 flush（实施时端到端发现）**：读事件是缓冲的，而 MCP 是 stdio 短进程、CLI 是一次性命令——不显式 flush 就会整批丢失（首次 e2e 验证时 MCP 侧 `read_graph` 一条读事件都没落盘）。落点：`WikiGraph.flushUsageLog()`；MCP 在**每次工具调用的 finally** 里 flush（进程随时可能被杀，不能只靠退出钩子），CLI 在 `withWiki`/全局模式收尾 flush。

### 4.5 统计 API（纯代码，零 LLM）

新模块 `src/core/usage.ts`：

```ts
interface UsageStatsOptions { days?: 1 | 7 | 30; topN?: number; bottomN?: number; actor?: string }
interface NodeUsage { slug: string; reads: number; writes: number; byActor: Record<string, number>; lastTs: string }
function computeUsageStats(wikiRoot: string, opts?: UsageStatsOptions): Promise<{
  windowDays: number; top: NodeUsage[]; bottom: NodeUsage[]; totalEvents: number
}>
```

- 流式解析按天文件 → `Map<slug, counts>`；N（64 只是示例）由 `topN`/`bottomN` 参数配置。
- **bottom-N 包含零访问节点**：与当前 slug 全集 join（有常驻图用常驻图，否则 `scanWiki`）——"使用最少"必须包含从未被碰过的。
- 性能缓存（遵循"昂贵操作必须缓存"原则）：历史按天文件不可变 → 按文件名+大小+mtime memoize 解析结果；**今天的文件不进缓存**——每次 append 都改变 size 即改变 key，缓存它只会每次追加留下一份当日全量事件的死副本，永不命中也永不淘汰（一轮 dream 多次查 usage_stats × 每个常驻 wiki）。今天的文件本来每次都 miss，缓存它零收益。
- 暴露：MCP 工具 `usage_stats`（第 14 个工具）+ CLI `llm-wiki graph usage [--days] [--top N] [--bottom N] [--actor]`。

### 4.6 影响面

- `maintainLog` 默认翻转影响全部构造 `WikiGraph` 的测试（约 251 例）——test helper 统一传 `maintainLog: false`，生产默认开。
- 常驻图、A′ 扫描缓存零改动（usage 文件不在 `wiki/` 内）。
- **多进程读一致性（补评审缺口）**：`wiki-cache.ts:49` 用 `resident:true, trustWindowMs:0`（永不重验证），单进程下成立，但 dream 是多进程并发场景——另一进程 update_node 后，dream 的 resident 图不更新、基于过期图做决策。修法：dream 的 MCP 实例设 `trustWindowMs>0`（如 30s），或每次 dream 运行前 `clearScanCache()` 重建 resident。check/reason 同理（多 agent 同操作一个 wiki）。
- **`wikiRoot` 大小写归一化（补评审缺口）**：`path.resolve(wikiRoot)` 不归一化大小写，Windows 上 `C:\Wiki` 与 `c:\wiki` 字符串不同 → 不同缓存 key → 同一物理目录双 A′ 缓存、`maybeRebuildAfterWrite` 失效。`WikiGraph` 构造时对 `wikiRoot` 做一次 `path.resolve + toLowerCase`（或 `realpath`）归一化。dream 的 `--dreams-dir` 与 `wikiRoot` 拼接尤其要统一。

## 5. dream 的选择机制（纯代码 + 注入 prompt）

### 5.1 Dream journal —— 状态文件位置（拍板）

**位置：`<wikiRoot>/.llm-wiki-ops/dreams/journal.jsonl`，append-only，每次 dream 一行。**

可行性论证（对比其他方案）：

| 方案 | 结论 |
|------|------|
| `.llm-wiki-ops/dreams/`（本方案） | ✅ 状态目录已存在且被 scanWiki 排除（`wiki/` 之外）——运维状态不污染本体；JSONL 追加安全，最后一行即全部所需状态 |
| 图谱内特殊目录 | ❌ 目录表达本体论——"上次做梦的压力值"不是世界中的事物；会进 index、进 freshness 调度 |
| 节点 frontmatter | ❌ 状态频繁覆写，污染 freshness 时钟与扫描缓存 |

Journal 行 schema：

```json
{"date":"2026-08-07","seed":"20260807","pressure":{...快照...},
 "candidates":[{"slug":"x","usage":{"d1":0,"d7":2,"d30":5},"inDegree":3,"overdueDays":12}],
 "threads_carried":["hypothesis:...","contradicts:c-d"],
 "touched_slugs":["compressed-a","compressed-b"],
 "changes":[{"tool":"wiki.add_edge","args":{...}}],
 "report":"..."}
```

`scenes` 与 `touched_slugs` 都从**纯代码/tool log** 记录，不取模型自述——模型会误报自己的输入与动作（实跑见过报告"0 场景"却确实用了场景）。`touched_slugs` 供下一轮扣除自身压缩造成的 `updated`（§5.2）。

不另设 digest 文件（如无必要勿增实体）。

### 5.2 Pressure（该不该做梦）—— `llm-wiki dream --pressure`

纯代码、无状态重算（freshness.ts 风格）：一次 `scanWiki` + `scanFreshnessFromPages`，对照 journal 最后一行的日期计数。**对比基准（补评审缺口）**：一律相对**上次 dream 日期**（journal 最后一行 `date`）统计——新增 = `created > lastDreamDate`，更新 = `updated > lastDreamDate` 且非新增；不滚动 7/30 天窗口（journal 只存一次日期，滚动窗口需额外状态，如无必要勿增实体）。"距上次 dream 天数"即 `today - lastDreamDate`。

| 分项 | 初始权重（可调，展示在报告里） |
|------|------|
| 新增页面数 | ×1 |
| 更新页面数 | ×0.5 |
| hypothesis 页数 | ×2（**依赖 reason 产出，现无生产者**，见下） |
| `contradicts` 边数 | ×3 |
| freshness 逾期数 | ×1 |
| 距上次 dream 天数 | ×1 |

输出人类可读的压力报告：各分项贡献 + 总分 + 阈值对照（如 `pressureScore 14 ≥ threshold 10 → 建议做梦`）。阈值是 `DreamOptions.pressureThreshold` 字段（默认 10，初始值，可调）。量级校准：注意"距上次 dream 天数 ×1"随时间累积——闲 wiki 不活动也会缓慢升压，这是设计意图（久不做梦本身就是压力）。阈值 10 ≈ 忙 wiki 几天的活动量，或闲 wiki 约 10 天没做梦。初始值跑几轮真实 wiki 后再调。**高压力是"建议做梦"，不是门禁**（镜子不是缰绳）；v1 触发 = 手动 + `--pressure` 读数，不做自动调度。dream 主运行时压力快照无条件注入 prompt——数字给模型自己看，深浅自决。

**pressure 防自污染（实施后复审补）**：dream 的产物有两类，需要两道独立排除。

1. **梦境页**：昨夜写的 dream 页带当夜 `created`，五个新梦境页会给下次运行白送五分——按 `type !== "dream"` 排除。
2. **被压缩的知识页**：压缩改写的是**普通知识页**，不在类型过滤范围内，而 `node-ops.ts` 无条件 `fm.updated = today()`——六个压缩就是六个"更新页面"。按 **slug 排除**：journal 新增 `touched_slugs`（从 tool log 提取 update/delete/rename 的 slug，不读模型自述），下次算 pressure 时扣除。

第 2 条曾被日期比较掩盖：`updated > lastDreamDate` 是严格大于，压缩写入通常落在 journal 同一天，所以分数**碰巧**正确。23:50 UTC 启动、00:05 写入的 dream 打破这个巧合（journal date 08-07、`updated` 08-08），白送分立刻出现。slug 身份对两种情况都成立。这是同一形状的第四例——前三例为 usage 的 `excludeActor`、touch 用 checked 钟、梦境页按类型排除。

排除只持续一次 dream 且按 slug 精确匹配：昨夜被压缩、今晨被人类改写的节点，仍然计入压力。

### 5.3 Salience（谁值得梦）—— 综合分，原始数字进 prompt

每节点分量向量（纯代码）：

- **usage**：stats API 的 d1/d7/d30 读写次数、按 actor 分解（§4.5）；
- **拓扑**：inDegree / hub 标志（`topology.ts` degree > p95）；
- **freshness**：`overdueDays`（`freshness.ts:115–139`）——陈旧但重要的节点恰恰值得做梦；
- **智能体琢磨痕迹**：近期 updated/checked 戳、hypothesis/needs-verification 标记。

初始采样权重（仅用于排序与加权随机，不是门槛）：`usage30 0.35 / inDegree 0.25 / overdue 0.2 / touch 0.2`，外加 **ε 地板**——零 salience 节点保留最低被选中概率：梦必须偶尔回访被遗忘者。

**touch 防自污染（补评审缺口）**：touch 分量原定义含"近期 updated/checked 戳"，但 `node-ops.ts:345` 每次写都 `fm.updated = today()`——dream 压缩节点会 bump updated → touch 增大 → 越压缩越"新鲜"越值得梦，形成正反馈。修法：touch 改用 **checked 戳**（核验钟，仅 check agent 写，`node-ops.ts:447` 附近）而非 updated；不含 checked 的节点 touch=0。dream 自己的压缩不写 checked，自污染消除。

**原始分项数字全部注入 dream prompt**，agent 可自行推翻任何排名。

### 5.4 Random activation（PGO 波模拟）

日期种子 PRNG（seed = `YYYYMMDD`，记入 journal → 同日重跑可复现）：

1. **种子选择**：加权随机抽节点（默认 5–8 个；权重 = salience 综合分 + ε 地板）。种子数与 ε 地板随 certainty 派生（§8.1）。
2. **每个种子随机游走 2–4 跳**：每跳以 p_edge 走真实边（`get_edges` / `read_graph center+k`），以 1−p_edge **瞬移**到另一个加权随机节点。瞬移让远距离节点"同框入梦"。p_edge 默认 0.65（= 0.4 + 0.5 × certainty，§8.1）。
3. 每条游走的节点集 = 一个**梦境场景**；LLM 判断场景内是否存在真实关联（三值裁决，§9）。

500 节点上限与"禁止无过滤 read_graph"规则自然满足——游走始终是 center+k。

本节所有常数（种子数区间、跳数区间、ε 地板、p_edge 公式系数）都是 `DreamOptions` 字段带默认值——库级可覆盖，CLI 只露出 `--certainty` 单旋钮（§8.1 可调性原则）。

### 5.5 未决线索发现（dream-lag，纯代码注入）

| 线索 | 发现方式 |
|------|---------|
| hypothesis 页 | **纯代码 body 扫描**（`ScannedPage.content` 已含全文）——因为 `read_graph query` 只搜 title/slug（`mcp/index.ts` 已验证），body 标记任何 MCP 查询都够不着，无需 tag 改造。**⚠️ 评审核查：`src/agent/` 现无任何 agent 写 hypothesis 标记的代码锚点**——该分项目前无生产者、恒为 0。处置：P1 实施时先 grep reason 真实产物确认写入格式；若 reason 不产出可扫描的 hypothesis 标记，该分项暂时剔除（权重置 0），待 reason 落地协议后再启用，不在 dream 侧硬造一个不存在的信号 |
| `contradicts` 边 | 扫 `related[]` 的 `{slug, relation}`（`types.ts` RelatedEntry） |
| freshness 逾期 | `scan_freshness` MCP 工具 |
| check UNCERTAIN | 现成 `needs-verification` tag（`check.ts:158`）→ `read_graph tag=` |
| 上次未闭合 thread | journal 最后一行 `threads_carried` → **优先重访**（dream-lag 的系统对应物）。**闭合判据（补评审缺口）**：一条 thread（hypothesis 页 / contradicts 边 / needs-verification 页 / UNCERTAIN 灵感）在本轮 dream 得到**裁决**即闭合并从 `threads_carried` 移除——裁决 = check 证实晋升 / dream 明确 link/no-link / 证伪删除。未裁决的 thread 原样带入下一轮 journal；任一判据歧义时按"保守携带"处理（宁多梦一次，不丢线索） |

### 5.6 主题落点与"主题当透镜"（实跑后补）

**问题**：主题原本只是 prompt 里一行软提示（`Theme: "x" — follow this thread.`），而场景是 salience + 随机游走**在主题之前**算好的——主题对选材没有任何否决权。实跑用荒诞主题「深海章鱼的求偶仪式」跑经济 wiki：7 页梦境页的 frontmatter 老实写着主题，正文零次提及，报告也不解释。用户输入一个主题，拿到 7 页无关内容，全程无提示。

**修法（纯代码 + 注入，不加门禁）**：`findThemeMatches` 数主题在 slug/title/tags 上的命中页数，注入 prompt。

- **只匹配 slug/title/tags，不搜 body**：正文里一次擦边提及不等于"图里有这方面材料"。
- **CJK 切 2-gram，不用单字**：中文无空格必须切，但单字"海"会命中 海峡/航海/海外，为一个图里完全没有的主题伪造落点——正是本函数要检测的失败。
- **`hasPurchase` 不用 `count > 0`**：该主题在 1150 页里恰好命中 1 页 `章鱼能源`（Octopus Energy，英国能源公司）。bigram 撞名不算落点，否则正好压掉为这种情况写的指引。门槛 `THEME_PURCHASE_MIN = 2`，撞名照实报告为 name collision。

**零落点时不阻塞，改道**：明确许可把主题当**透镜**——问主题有什么结构（求偶 = 昂贵信号 + 欺骗 + 不确定下的选择），在既有材料里找同构，并要求页面标注"这个类比是做梦者的，不是来源的"。实测产出 `state-industrial-policy-as-courtship-display`：美欧稀土最低价机制读作昂贵信号、政府持股读作虚张声势、伊朗要海峡管理权读作"要求对方承认信号效力"，并推出可检验预测（劣势方才需要戏剧化炫耀，优势方安静）。主题词从 0 升到 32，每页字数 725→1390。

### 5.7 悬挂 wikilink 必须报警（实跑后补）

`buildGraphFromPages` 对目标不存在的 wikilink **静默跳过**（`graph-builder.ts:310` `if (!slugSet.has(target)) continue`）：不建边、不报错。对梦境页这是实质损失——§7 规定 wikilink **就是**溯源记录，所以一个拼错的 slug 意味着该页记录的推理对图不可见、永远无法被 check 核验。实跑写出 `[[外需强劲]]`（正确 slug 是 `外需强劲内需冷静`），全链路无人报告。

修法：本地写工具（`write_file`/`edit_file`）落盘后回读文件、校验全部 wikilink，把悬挂目标**作为警告追加到工具结果**里。

- **警告不是拒写**：文件已经写好，slug 错了不代表正文错了。给智能体看见并自行修正（镜子不是缰绳）。
- **回读文件而非检查参数**：`edit_file` 只收到片段，只有落盘内容才能看到完整链接集合。副作用是下次编辑会顺带暴露此前遗留的悬挂链接。
- slug 集合每次调用重建：否则本轮刚写的梦境页之间互链会被误报。
- 带目录前缀的 `[[entities/三菱]]` 按 basename 比对，与图的键一致。

### 5.8 采样温度 —— 不归 certainty 管（实测否掉了自己的假设）

**起因**：`loop.ts` 里 `temperature: 0.1` 写死,所有智能体共用。dream 和 check/purge 用同一个温度,近乎贪心解码。当时的假设是:这就是五页梦境页同质的原因（同一句式骨架、同一认知动作——三个例子排成梯度再加粗一句金句），于是提议 `temperature = tempMin + (tempMax−tempMin) × (1−certainty)`,让 certainty 一并驱动采样。

**实测直接否掉了这个假设**。`--temperature 1.9` 跑真 wiki:

```
Status: completed (2 iterations)     ← 4 次工具调用后自己停了
dream pages: 0
```

产出的报告长这样:

> Enough budget consumed; leaving a full record rather than a tidy subset was done with page, write_edge only when certain in cases done; remaining to dream to verify exact quot.
> Sc4. 銀行卖房(中国拿) → to, "4-qinjin=real"? unknown so not claim

语法崩坏、`quot` 截断词、自造 token `4-qinjin=real`、坏链接 `[[外汇||natural]]`,还声称「This page also links correctly already」——**它根本没写出任何页面**。

**结构性原因**：梦境页正文是**通过 `write_file` 的参数**写出来的,所以散文采样和 JSON 采样是同一个分布。任何足以让文风"松动"的温度,同时在破坏那个负责写文的工具调用。这个架构下二者不可分离。

**结论:创造性不在采样噪声里。** 本项目唯一真正有想象力的产出（章鱼求偶透镜那页）是在 **0.1** 温度下写出来的,靠的是外部框架强制的结构位移,不是采样多样性。杠杆在 prompt 的框架供给,不在温度。

**落地**：
- `DreamTuning.temperature` 默认 **0.5**（常规中间值）,**不由 certainty 派生**。certainty 继续只管图游走(它在那儿有效)。
- `tempConclusion` 默认 0.2,比主循环更低:结论轮陈述已发生的事,高温会让它编造没做过的操作(本仓库修过一次这个 bug)。
- `--temperature` 保留为显式实验开关,帮助文本写明高于约 1.5 会导致完全无产出。
- 派生逻辑（`tempMin`/`tempMax` 双字段 + 反向插值）已删除:一个被实测否掉的机制留在代码里只会误导下一个人。

## 6. 渐进压缩（模拟遗忘）

**核心：不是一次性删除，而是每次 dream 最多降一级。**

### 6.1 阶段 —— 专属 `compression:` frontmatter 字段（枚举）（拍板）

压缩阶梯在所有被触及的节点（知识节点 + 梦境页）上用专属字段 `compression:`，不复用 `status`。`status` 有三个活跃消费者（freshness 排除 `invalidated`、purge 标记死节点、check prompt 语义约束），语义是"知识生命周期"——往里塞压缩等级会污染旧规则。`compression:` 是 dream 的内部簿记，旧逻辑碰不到它，dream agent 拥有干净的解释权。

字段写入：知识节点由 dream 经 `update_node` 改级——**扩展 `UpdateNodePatch` 增加 `compression?: string` 字段**（`types.ts:156`，小改动；这是拍板"不新增 `compress_node` 工具"的正解，见 §6.5——不是"不扩展 schema"）。同步扩展 MCP `update_node` schema（`mcp/index.ts:157`，`additionalProperties:false` 需加 `compression` properties 项）。梦境页由本地读写工具直接改（§9）。该字段对 MCP `get_node` 不可见（`WikiPage` 固定接口不含未知字段）——设计意图：压缩状态的受众是 dream agent 自己（`read_file` 读取），不是图谱查询。

| 阶段 | compression | 内容规则 |
|------|-------------|---------|
| 活跃 | `active`（默认） | 完整正文 |
| 浓缩 | `condensed` | 模型重写正文为核心论断 + 关键事实；砍示例、叙述、冗余引文。边保留 |
| 骨架 | `skeleton` | 一句话摘要 + 内容索引（章节名、边列表、来源 slug）。正文 ≤ ~300 字符 |
| 消失 | — | `delete_node` |

**知识节点每次 dream 周期最多降一级，不许跳级**——这是"渐进淡忘"的硬协议，由 prompt 约束（镜子：阶段与判据全部可见；缰绳：不写代码门禁）。**梦境页豁免**：dreams/ 是 dream agent 自己的产出（§7.1 绝对控制），用户原则 2 要求"遗忘更快、压缩更快"——梦境页可在单周期内多级下降（active → skeleton → 删除）。"更快"的实现不是另造一套时钟，而是协议对自己领地的放宽。

### 6.2 触发与裁决

dream 读 `scan_freshness`（严重逾期 = 长期无人核验）、`metrics` 度数（低连接度）、usage 统计（无人问津）后**自主裁决**——数字是输入，决定是模型的。`invalidated` 节点归 purge 管，不是压缩对象。

### 6.3 原件保存：git 足够，不做影子归档

agent loop 已在首次写操作前自动 git snapshot（`safety.ts`/`loop.ts` 已验证）。每次压缩重写前都有含完整原件的 commit。恢复 = `git log --follow wiki/<path>` + checkout + `status: active`。影子 `.llm-wiki/archive/` 会复制溯源、游离于 scanWiki 之外（割裂图谱），换来的东西为零。

### 6.4 删除阈值

知识节点到达 `skeleton` 后，**下一次** dream 周期仍被判无价值 → `delete_node`（梦境页可同周期走完，§6.1）。删除的脏活已由 deleteNode 在一个事务内原子处理：悬空 wikilink 删除线、`related[]` 清理、index 移除。dream 应在更早周期先剪待删节点的入边，使最终删除很少触发删除线级联。

### 6.5 豁免集与工具

- **永不压缩**：`sources/`（溯源，引用目标）与 `overview`（根地图）。entities/concepts 自由压缩。
- **不新增 `compress_node` MCP 工具**：`update_node` 的整页替换就是压缩原语（get_node → 模型浓缩 → 整页写回），但要给 `UpdateNodePatch` 与 MCP `update_node` schema 各加一个 `compression?: string` 字段（§6.1），否则没有写路径能碰 compression。内容丢失风险由 pre-write snapshot 兜底——research 早已带着同样的风险工作。新工具是把 prompt 协议已能治理的东西再编码一遍，多余实体。

### 6.6 遗忘候选的排序（实跑后补 —— 遗忘曾静默失效）

**症状**：连续三次真跑 `update_node` 全为 0，遗忘功能形同关闭。模型在报告里给的理由是：

> The never-touched nodes (中国, 美国, 伊朗, 美联储…) are hubs/overviews that must not be compressed.

这个判断是**对的**——错的是喂给它的候选清单。

**根因**（`dream.ts` renderContext）：

```ts
const forgotten = salience.filter((s) => s.usage30 === 0).slice(0, 10)
```

`salience` 按分数**降序**排列，所以 `filter + slice(0,10)` 取的是"零访问节点里分数最高的十个"——也就是枢纽。真 wiki 上这意味着把 `中国`（入度 136）、`美国`、`美联储` 当作"遗忘候选"递给模型，而 `战争钨`、`关税大战` 这些真正无人问津的节点**从未进入 prompt**。标题写着"candidates for forgetting"，内容是绝对不能碰的东西。

**修法**：取 `slice(-10).reverse()`（最低分优先），并在纯代码层过滤掉 `source` / `overview`——它们按 §6.5 永久豁免，占候选名额只会挤掉真正能衰减的页。渲染成带 `inDeg` / `overdue` / `compression` 的表格，而不是一行 slug 逗号列表：模型需要入度才能判断"未被读但承重"。

**hub 页不做代码过滤**：高入度是否等于承重是判断题，数字摊在表里让模型自己决定（镜子不是缰绳）。

**测试环境的坑**：新复制的 wiki 里 1150 页全部 `usage30 = 0`，salience 退化成只看 inDegree，底部塞满刚写的梦境页。要验证遗忘必须先造出真实访问分布——`scripts/seed-usage-log.py` 按 5% 热 / 15% 温 / 80% 冷写入 usage log（actor 用 reason/check/cli，绝不用 dream，否则被 `excludeActor` 排除）。

**修复后实跑**：`战争钨-tungsten-as-strategic-mineral`（零访问、入度 0、concept）active → condensed，1319 → 935 字符（70%），7 条 `related` 边与 7 个 wikilink 全保留，核心数字（53% 储量 / 79% 产量 / 85% APT / 涨 5 倍 / 2 年与 5 年重建期）无丢失。

### 6.7 遗忘需要自己的分数，不能复用 salience 尾部（实测后补）

§6.6 修好排序方向后，遗忘依然走不动：连续多轮 dream 只在 active→condensed 之间打转，或干脆不动。根因不是模型保守，是**分数用错了**。

`overdueDays` 在 salience 里是**正权重**——salience 回答"谁值得注意"，久未核实的节点该去重访。而遗忘候选直接取 salience 排序的**尾部**。真 wiki 实测：

| 节点 | 状态 | salience |
|---|---|---|
| `英特尔-intel` | 零访问、零入边、**逾期 393 天** | **0.400** |
| 任意普通节点 | 逾期 12 天、2 条入边 | 0.210 |

**最该被忘掉的东西分数最高，排得离遗忘列表最远。** 另有 567 个节点并列 0.21，"排序"退化成字母序。

**修法**：新增 `computeForgettability`，独立评分，几乎每项符号都与 salience 相反：

| 因子 | salience | forgettability |
|---|---|---|
| 未被读 | 负（不值得注意） | **正**（核心信号） |
| 入边多 | 正（枢纽重要） | **负**（承重，不能动） |
| 出边 | 不计 | **明确忽略**——指向 `中国` 不代表自己重要 |
| 逾期久 | 正（该去重访） | **正**（无人维护） |
| 已压缩 | 阻尼降分 | **加分**——阶梯该继续 |

并列时按 slug 排序，避免退化成插入序。权重经 `DreamTuning.forgetWeights` 可调（默认 unread .35 / unneeded .3 / stale .2 / stage .15）。

**实测：完整阶梯走通**（1150 页真 wiki，先用 `scripts/seed-usage-log.py` 造访问分布 + `scripts/age-wiki-nodes.py` 把 12 个节点做旧 400 天并剪断入边）：

- 修复后做旧的 12 个节点全部占据榜首（forget≈0.85），普通节点 0.656，分层清晰。
- 四轮 dream 共 10 个节点 active→condensed，体积真实下降（英特尔 1765→1112b、王传福 2791→1767b）。模型给的理由准确引用 `in=0`、`393 days overdue`。
- 第五轮 `芯片法案-chips-act` **condensed→skeleton**：1381b → 1171b → **899b**，一行摘要 + 5 条边全保留，89 亿美元换 10% 股份这个事实没丢。

**尚未实测**：`skeleton → delete_node`。机制齐备（prompt 规定只删已是 skeleton 的节点），但需要节点在 skeleton 状态再被判一次无价值，实测未触发。

**可观测性缺陷（顺带修）**：某轮三次 `write_file` 失败触发熔断，verbose 日志**只打 ❌ 不打原因**，而本地写工具不走 usage log——故障在任何产物里都查不到。现在 `--verbose` 输出错误首行。那次失败本身是 14 秒超时，偶发，重跑即过。

## 7. dream 产物（幻觉 / 灵感）

**用户洞察**：dream 新增的大多数内容是幻觉、是昙花一现的灵感，只有经仔细核验后才能成为突破性创新 → 必须带 UNVERIFIED 状态与警告，留给清醒智能体核验。

### 7.1 载体：新节点类型 `dream` + `wiki/dreams/` 目录（用户拍板，覆盖第 1 轮推荐）

第 1 轮推荐 synthesis + dream-journal 页；用户第 2 轮决定梦境是一等公民：新类型 `dream`，默认落在 `<wikiRoot>/wiki/dreams/`（即 `wiki/dreams/`）。**必须在 `wiki/` 子树内**：`scanWiki` 只扫 `wikiDir = <wikiRoot>/wiki`（`index.ts:99`），在子树内才进图谱，核验回路（§7.2）才成立。第 1 轮两个反对理由的处置：

- "无 as_of → freshness 永久周调度" → 由类型排除解决：`scanFreshnessFromPages` 跳过 `type === "dream"`（拍板点 2，一行 skip）。dream 节点故意不写 as_of——梦境没有"事实生效日"，旧时钟语义不适用。
- "目录表达本体论，幻觉不是世界中的事物" → 用户取舍：梦境是 dream 智能体的正式产出，有自己的生命周期（遗忘更快、dream 绝对控制），给一级目录是承认其地位；昙花一现性由更快的压缩（§6）与 UNVERIFIED banner 表达，不由目录降级表达。

frontmatter（独立语义，dream 全权解释）：

```yaml
---
title: 人类可读的梦境标题
type: dream
theme: "注意力机制"        # 可选；缺省 = 自由梦（无主题漫游）
compression: active        # 枚举 active | condensed | skeleton（§6.1）
created: 2026-08-07
updated: 2026-08-07
tags: <tag1>, <tag2>
description: "压缩 2 节点，新增 3 边，产出 1 条未核验灵感"  # 单行机器可读摘要
# 故意不写 as_of —— 梦境无事实时钟；freshness 按类型排除（§7.2）
---
```

- `theme`/`description`/`compression` 对 MCP `get_node` 不可见（`WikiPage` 固定接口）——受众是 dream agent 自己（`read_file`），不是图谱查询；溯源走正文 wikilink（`extractWikilinks` 自动建边），不加字段。
- 正文开头一律 ⚠️ UNVERIFIED DREAM banner。
- 写入路径：本地文件工具（`add_node` schema 装不下 theme/description/compression），写 scope 限 dreams/ 内（§9）。本地写不经过 facade → 无 usage log，journal 的 `changes` 字段是补偿记录。
- 注意：dreams/ 内不得建 `index.md`/`log.md`（`INFRA_FILES` 按 basename 匹配，会被图谱静默跳过）。
- 类型注册（代码改动）：`KnownPageType` 加 `"dream"`、`TYPE_DIR_MAP` 加 `dream: "dreams"`（`types.ts:267`；`DIR_TYPE_MAP` 自动反向派生，目录→类型推断随之打通——不注册则 `inferType` 落 `unknown`，且跨目录移动会算出 `wiki/dream/` 单数）；`KNOWN_TYPE_ORDER` 加 dream（stats/index 展示序）。梦境页 frontmatter 仍显式写 `type: dream`，不依赖目录推断。
- index 维护（代码改动 + 协议）：本地 write_file 不走 node-ops → index.md 不增量维护。index.md 是派生视图（scanWiki 才是事实源，图谱不依赖 index），陈旧不破坏图谱——补救走协议：dream 收尾前跑一次 `rebuild_index`（§9 写工具清单已列入）。另需给 `index-maintainer.ts` 的 `typeHeading()` 加 `## Dreams`（现状：未知类型落 `## Other`）。

### 7.2 核验回路（类型排除后重建）

dream 节点被 freshness 排除 → 不再自动进 check 队列（第 1 轮"免费核验"失效）。核验改为 pull 式：

- dream 节点在图谱内可见（`scanWiki` 递归扫整个 wiki，`get_node`/`read_graph` 都能查到）——可见性是核验的前提；
- 清醒 agent（reason/research/check）的 prompt 纪律：带 ⚠️ UNVERIFIED DREAM 的页面是线索不是引用来源；认为有价值 → 路由给 check 或自行核验；
- **证实** → 晋升为正式节点：新建 concept/entity（as_of/来源齐全），建与梦境页的边（溯源）；梦境页保留为出处，或由下一轮 dream 压缩/删除；
- **证伪** → 留给 dream 下一轮清理（dream 对 dreams/ 绝对控制）；清醒 agent 不改写梦境正文。
- check 现有的 `needs-verification` tag 机制（check.ts:158）可复用：被路由核验但判 UNCERTAIN 的灵感打 tag 留待后续。
- **闭环标记（补评审缺口）**：证实晋升时，check/晋升动作**在原梦境页 frontmatter 写 `verified: true`**（本地文件工具），并建与正式节点的边（溯源）。下一轮 dream 的 prompt：跳过 `verified: true` 的梦境页（已证实，勿删勿压缩）；证伪则写 `verified: false` 供 dream 清理。否则 dream 会把刚证实、有价值的页下一轮删掉——核验回路缺闭环。

### 7.3 两种"梦的记录"的分工（回答状态文件之问）

| | 过程状态（journal） | 内容产物（梦境页） |
|---|---|---|
| 是什么 | 运维状态：压力、候选、变更、未决线索 | 认知内容：未核验的关联与洞见 |
| 放哪 | `.llm-wiki-ops/dreams/journal.jsonl` | `<wikiRoot>/wiki/dreams/*.md`（type: dream） |
| 谁能看见 | 代码（pressure/dream 自己） | 所有 agent（MCP 可读；核验靠 pull） |
| 为什么 | 状态不进图谱：不污染本体/index/freshness | 内容不留图外：否则核验回路断裂 |

## 8. 运行模式与 CLI（审计结论）

**dream 只用 `--dry-run`，不搞 report→apply 两步。**（用户已拍板，此处记录审计依据。）

| 维度 | `--report` | `--dry-run` |
|------|-----------|-------------|
| 拦截层 | 工具表层：写工具从列表移除 | 执行层：DryRunExecutor 拦截（`loop.ts`） |
| 产物 | 结构化报告 = 交付物 | `dryRunSummary` = 计划操作清单 |

- dream 的交付物**本来就是操作**（压缩、加边、建页、删除候选）——dry-run 的操作清单恰好就是"梦境报告"，无需第二种模式。
- 子智能体曾担忧 dry-run 回执误导模型；已验证当前措辞安全（2026-08-06 透明化修复后）：`"Nothing was written to disk — do not try to read it back, it does not exist."`（`safety.ts:55`）——不会触发读回验证循环。
- reason 的 `--report` 保持不动（移除写工具保护推理预算，交付物是报告本身）；purge 暂不为对称性重构。

CLI 表面：

```
llm-wiki dream [主题] --wiki <wiki> [--pressure] [--dry-run] [--dreams-dir <dir>]
             [--certainty <0..1>] [--max-iterations N] [--timeout <minutes>] [--verbose] [--json]
```

### 8.1 参数语义（拍板）

**可调性原则**：dream 参数一律不硬编码——全部是 `DreamOptions` 字段（库级可覆盖 = 最低继承点），CLI flag 只是直通；默认值集中在 options 接口定义处。

接口骨架（照 `ReasonOptions` 模式，`reason.ts:233`）：

```ts
export interface DreamOptions {
  wikiRoot: string
  theme?: string                  // 位置参数直通；undefined = 自由梦
  dreamsDir?: string              // 默认 <wikiRoot>/wiki/dreams/；必须留在 wiki/ 子树内，入口校验
  certainty?: number              // 0..1，默认 0.5
  maxIterations?: number          // 梦境深度，默认 50
  timeoutMs?: number              // 默认 600_000
  dryRun?: boolean
  pressureOnly?: boolean          // --pressure：只读数不做梦
  verbose?: boolean
  llmConfig?: LlmConfig
  // 内部调优旋钮（全部带默认值，库级可覆盖，CLI 不露出）：
  seedCountRange?: [number, number]   // 默认 [5, 8]
  walkHopRange?: [number, number]     // 默认 [2, 4]
  epsilonFloor?: number               // 零 salience 节点最低入选概率
  pEdgeBase?: number                  // 默认 0.4（p_edge = base + 0.5 × certainty）
  salienceWeights?: { usage30: number; inDegree: number; overdue: number; touch: number }
  pressureWeights?: Record<string, number>
  pressureThreshold?: number          // 默认 10
}
```

CLI flag 只直通用户面参数；内部旋钮不给 flag——要改就构造 DreamOptions（继承点）。

- **[主题]** 可选位置参数：给了就聚焦该主题做梦；不给则自由梦（压力 + salience + 随机性选择）。
- **梦境深度 = `--max-iterations`，不做映射层**（拍板）。迭代数就是深度本身，help message 里说明语义即可，例如：`--max-iterations <n>  梦境深度：迭代越多，梦得越深越久（默认 50）`。默认 50（与 reason 同级——开放式游走，迭代是约束）。
- **确定性 `--certainty <0..1>`，单旋钮派生子参数**（拍板；默认 0.5 ≈ §5.4 现值）。高确定性 = 紧紧围绕主题展开，低确定性 = 天马行空。派生用行为比率，不加独立 flag：
  - 游走沿真实边概率 p_edge = 0.4 + 0.5c（c=1 → 0.9 紧贴图结构与主题；c=0 → 0.4 多瞬移，远距离节点同框）；
  - 种子候选域：c 高 → 限主题邻域（`read_graph query=`/tag 过滤），c 低 → 全图加权抽样；
  - ε 地板与种子数随 c 降低而放大——更散的梦覆盖更多被遗忘者。
  - **噪声注入不新增工具**：§5.4 的瞬移机制就是输入噪声（用户原问"可能需要额外噪声注入工具"——已有机制覆盖）。LLM temperature 不动（loop 固定 0.1）：梦的随机性在输入选择，不在采样。
- **系统压力**：不是 flag——pressure 是自动计算的状态（§5.2），快照注入 prompt 供 agent 参考；`--pressure` 单独调用只读数不做梦。权重展示在报告里（镜子不是缰绳）。
- **`--dreams-dir <dir>`**：梦境目录，默认 `<wikiRoot>/wiki/dreams/`（拍板：必须可调）。最起码 `DreamOptions.dreamsDir` 库级可覆盖（继承点），CLI flag 直通。约束：必须保持在 `wiki/` 子树内（否则 scanWiki 不可见、核验回路断），入口处校验。freshness 排除按类型（`type === "dream"`）不按目录、工具 scope 读同一 option——位置换了语义不乱。
- 其余不变：`--timeout` 默认 10 分钟；不加 `--dry-run` = 真实执行（首次写自动 git snapshot 兜底）。

## 9. 工具清单与 prompt 骨架

**读工具**（13 个 MCP 工具中全部 6 个只读工具）：`get_stats, read_graph, get_node, get_edges, metrics, scan_freshness` + 新增 `usage_stats`。

**写工具（MCP，仅真实执行模式）**：`add_edge`, `remove_edge`, `update_node`（压缩原语，§6.5；`UpdateNodePatch` 与 `update_node` schema 各加 `compression?: string`——见 §6.1，这是 compression 的唯一 MCP 写路径），`delete_node`（压缩终末阶段 §6.4 与梦境页清理共用——deleteNode 事务内清理悬空 wikilink/related/index，正是删梦境页需要的语义），`rebuild_index`（收尾跑一次，补本地写不维护 index 的缺口，§7.1）。**不含 `add_node`、`rename_node`**（拍板）：前者 schema 装不下 theme/description/compression，梦境节点创建走本地文件工具；后者不是 dream 的动作域（知识节点不重命名、梦境页只增删不改名）。知识节点创建是 ingest/research 的领地，dream 不碰。

**本地文件工具（梦境页创建/修改，写 scope 限 dreams/ 内）**：`read_file`, `write_file`, `edit_file`, `list_directory`（现有四件，`tools.ts:321`；当前只有 `readOnly` 旗标、**无 delete 工具**——删除一律走 MCP `delete_node`）。`createLocalTools` 需新增选项 `writeScope?: string`（相对目录；界外 write_file/edit_file 拒绝，读不受限；实现 = 现有 `resolveSandboxed` 根沙箱上加一层包含检查，`tools.ts:28`）——这是 §7.1"写 scope 限 dreams/ 内"的实现。"绝对控制" = 界内任意 CRUD + delete_node，不是跨 wiki 的无界写权限。**`list_directory` 过滤 INFRA_FILES（补评审缺口）**：与图谱一致，产出剔除 `index.md`/`log.md`（`INFRA_FILES` 按 basename，`types.ts:285`），避免把删除残留或基建文件算进"梦境页全集"。

本地写的两个事实（接受的风险，写明理由）：(a) 不走事务层（无 wiki 锁）——dreams/ 唯一写者是 dream agent，单进程内已有 serializedWrite 按路径串行，进程间对手只有清醒 agent，而 prompt 纪律禁止它们碰 dreams/（§7.2）；(b) `writeFileSync` 非原子（`tools.ts:115`，不同于事务的 writeFileAtomic）——写一半崩溃得坏页，pre-write git snapshot 可恢复（本地 write_file/edit_file 已在 WRITE_TOOLS 集合，`safety.ts:16-28`，dry-run 拦截与快照对本地写同样生效）。对昙花一现的低价值梦境内容，两者均可接受。

prompt 沿用已验证模式：

1. **预算可见**：user message 注入"至多 N 轮迭代、M 分钟，不会提醒"；
2. **三值裁决**：每个候选关联 link / no-link / uncertain（不强制二值，避免编造）；
3. **证据锚定**：新边必须引用两端节点的具体原文，"感觉相关"不是证据；随机联想自由，建边必须锚定；
4. **压缩协议**：每次至多降一级；豁免集；skeleton + 再裁决才删除；
5. **产物纪律**：新洞见一律写 `dreams/` 梦境页（type: dream）+ UNVERIFIED banner，不直接改已有节点正文塞结论。

user message 注入：日期、压力快照、salience 表（原始分项）、线索清单（§5.5）、梦境场景（§5.4）、上次 journal 的 threads_carried。

## 10. 实施分期

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **P0** | usage log 底层：facade 埋点 + actor 接线（5 个 spawn 点）+ `src/core/usage.ts` 统计 + MCP `usage_stats` + CLI `graph usage` + 测试 | 无（dream 的前置） |
| **P1** | dream 骨架：journal、pressure、salience 表、随机游走、prompt、`--dry-run`/主题/certainty 参数、`DreamOptions` 接口（本地工具仍 read-only） | P0 |
| **P2** | 压缩协议 + 梦境页产物：类型注册（KnownPageType/TYPE_DIR_MAP/KNOWN_TYPE_ORDER/index heading）、`UpdateNodePatch.compression`、`writeScope` 本地写、freshness 类型排除、delete 终末阶段 | P1 |
| **P3** | 清醒侧联动：reason/research/check prompt 加 UNVERIFIED 引用纪律 | P2 |

验证标准：typecheck + vitest 全绿；usage log 与写路径改动需跑串行 MCP 写路径 smoke（`scripts/smoke-mcp-write-path.mjs`）；dream 在真实 wiki 上先 `--dry-run` 冒烟。

代码改动清单（实施 checklist，全部来自上文锚点）：

| 文件 | 改动 | 阶段 |
|------|------|------|
| `src/index.ts` | facade 埋点 + `WikiGraphOptions.actor`；`maintainLog` 默认翻转 | P0 |
| `src/core/usage.ts` | 新建：JSONL 解析 + computeUsageStats（memoize） | P0 |
| `src/mcp/index.ts` | `usage_stats` 工具（第 14 个）；`update_node` schema 加 `compression` | P0/P2 |
| `src/core/graph-builder.ts` | `WikiGraph` 构造时 `wikiRoot` 大小写归一化（`path.resolve+toLowerCase`/`realpath`） | P0 |
| `src/mcp/wiki-cache.ts` | dream 实例 `trustWindowMs>0`（或 run 前 `clearScanCache`）；actor 传递 | P0 |
| `src/cli/` | `graph usage` 子命令；dream 命令 + `WIKI_AGENT` env（spawn 点） | P0/P1 |
| `src/types.ts` | `KnownPageType` 加 dream；`TYPE_DIR_MAP` 加 `dream: "dreams"`；`KNOWN_TYPE_ORDER` 加 dream；`UpdateNodePatch.compression?: string` | P2 |
| `src/core/index-maintainer.ts` | `typeHeading()` 加 `## Dreams` | P2 |
| `src/core/freshness.ts` | `scanFreshnessFromPages` 跳过 `type === "dream"`（一行） | P2 |
| `src/core/node-ops.ts` | `updateNode` 处理 `patch.compression`（仿 status 分支，`node-ops.ts:320`） | P2 |
| `src/agent/tools.ts` | `createLocalTools` 加 `writeScope` 选项（`resolveSandboxed` 之上加包含检查）；`list_directory` 过滤 INFRA_FILES | P2 |
| `src/agent/dream.ts` | 新建：DreamOptions、journal、pressure、salience、游走、prompt、runDream | P1/P2 |
| `src/mcp/server.ts` + `wiki-cache.ts` | actor 传递（`WIKI_AGENT` env） | P0 |
| reason/research/check prompt | UNVERIFIED DREAM 引用纪律 + dreams/ 不写纪律 | P3 |

## 11. 拍板点（第 2 轮全部拍板，2026-08-07）

**已拍板：**

1. **压缩状态标记** → 独立 `compression:` frontmatter 字段，枚举 `active | condensed | skeleton`（§6.1）。不复用 `status`——它有活跃消费者（freshness 排除 / purge 标记 / check 语义），塞压缩等级会污染旧规则。
2. **dream 产物载体** → 新节点类型 `dream` + `wiki/dreams/` 目录（§7.1；必须在 wiki/ 子树内，否则 scanWiki 不可见；`KnownPageType`/`TYPE_DIR_MAP`/`KNOWN_TYPE_ORDER` 注册 dream）。独立 frontmatter 语义、dream agent 绝对控制、更快遗忘（实现 = 梦境页豁免"每轮至多降一级"、可同周期多级下降，§6.1）；freshness 按类型排除（一行 skip），梦境页故意不写 as_of。
3. **删除门槛** → 保守版成立：skeleton + 下一轮再裁决仍无价值 → `delete_node`；sources/ 与 overview 永不压缩（§6.4–6.5）。
4. **主题参数** → 保留 `dream [主题]` 可选位置参数；缺省 = 自由梦（§8.1）。
5. **梦境深度** → `--max-iterations` 就是深度，**不做映射层**；help message 说明语义，默认 50（§8.1）。
6. **确定性** → 单旋钮 `--certainty <0..1>`，按行为比率派生子参数（沿边概率 / 候选域 / ε 地板 / 种子数），不加独立 flag；噪声注入 = 瞬移机制，不新增工具；temperature 不动（§8.1）。
7. **系统压力** → 不是 flag——自动计算的状态，快照注入 prompt；`--pressure` 只读数不做梦（§5.2、§8.1）。
8. **梦境位置** → `--dreams-dir`，默认 `wiki/dreams/`（wiki/ 子树内），**必须可调**：最起码 `DreamOptions.dreamsDir` 库级可覆盖（继承点）；freshness 排除按类型不按目录、工具 scope 读同一 option（§8.1）。
9. **执行模式** → 只用 `--dry-run`，不搞 report→apply 两步（§8）。

**默认设定（未提异议）：**

- usage log 读写全记、`maintainLog` 默认开、按天 JSONL、90 天保留、统计 N 可配；
- salience 采样 ε 地板 + 初始权重（usage30 0.35 / inDegree 0.25 / overdue 0.2 / touch 0.2）——只排序不门禁；
- v1 手动触发 + `--pressure`，不自动调度；
- 每次压缩至多降一级（prompt 协议，无代码门禁），梦境页豁免；
- pressureThreshold 默认 10、salience/pressure 权重初始值如 §5.2/5.3——全是 DreamOptions 字段，库级可调；
- 顺手在 reason/research/check prompt 加一句 dream 页引用纪律。

**评审核实（2026-08-07，逐条核对源码后吸收）：**

- **compression 写路径** → 扩展 `UpdateNodePatch` + MCP `update_node` schema 加 `compression?: string`（§6.1/§6.5）。拍板是"不新增 `compress_node` 工具"，不是"不扩展 schema"——原稿矛盾表述（"不扩展 schema，update_node 摸不到该字段"）已修正；这是唯一让压缩协议可落地的选择。
- **`.gitignore` 加 `.llm-wiki-ops/`**（已提交）——git 快照只覆盖 `wiki/`，不把 usage/journal/锁提交进仓库。
- **多进程读一致性** → dream 实例 `trustWindowMs>0` 或 run 前 `clearScanCache`（§4.6）——`wiki-cache.ts:49` 的 trust0 单进程假设不成立。
- **`wikiRoot` 大小写归一化** → `WikiGraph` 构造时 `resolve+toLowerCase`（§4.6）——防 Windows 双 A′ 缓存。
- **pressure 对比基准** → 相对上次 dream 日期统计新增/更新（§5.2）。
- **hypothesis 分项** → 现无生产者，P1 核实 reason 产物，无则置 0（§5.2/§5.5）。
- **threads_carried 闭合判据** → 本轮得到裁决（证实 / link-no-link / 证伪）即闭合（§5.5）。
- **touch 防自污染** → 改用 checked 戳而非 updated（§5.3）——`node-ops.ts:345` 每次写 bump updated 会形成正反馈。
- **核验闭环** → 证实 / 证伪时在原梦境页写 `verified` 标记（§7.2）。
- **usage 总前提措辞**收窄为"除本地文件工具外"（§4）。
- **`list_directory` 过滤 INFRA_FILES**（§9）。
- **行号修正**：`KnownPageType` 在 `types.ts:13`（非 267）；`overdueDays` 计算在 `freshness.ts:192`；`typeHeading()` 对未知类型返回首字母大写（`## Dream`），批量索引的未知段写死 `## Other`——`index-maintainer.ts:26-38, 85-92`。
