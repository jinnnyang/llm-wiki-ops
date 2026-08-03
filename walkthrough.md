---
kind: walkthrough
last_updated: '2026-08-03T08:59:05+00:00'
last_verified: '2026-08-03T08:52:56+00:00'
last_writer: hand-off
last_agent: hermes-devops
session_id: 2026-08-03-scancache-design
---

# Walkthrough

## 2026-08-03 — reason-causal-walk-and-scancache-design <!-- keep -->

### What happened

1. **reason 因果漫游实施**（承接 7-31 agent 层设计）：REASON_WRITE_TOOLS 加 wiki.add_node（完整 schema），prompt 五项改动（因果漫游与验证节、页面产出指引、报告格式加因果链主干+伪因果辨析、web_search 纪律、预算纪律）。gitnexus 影响分析（751 节点/2078 边/63 flows）确认 reason.ts 单文件改动、低风险。174/174 测试 + build 通过。
2. **真实运行暴露超时**：economic-analysis wiki（1149 页）跑 reason，29 iterations 后 `Agent timed out after 600000ms`，零报告产出。诊断：agent 对预算完全失明——原 userMessage/prompt 不暴露 maxIterations/timeoutMs，超时是静默处决。
3. **预算可见性修复**（镜子式，不加代码层控制）：userMessage 注入预算数字 + system prompt 要求预留最后 ~20% 迭代/时间写报告。「浅而完整 > 深而超时零产出」。符合用户原则：状态机当镜子不当缰绳。
4. **性能根因确认**：用户猜测「工具无状态、图谱每次创建销毁」→ 调查证实方向正确、细节修正：mcp/index.ts 的 wikiCache 是**假缓存**（只缓存 WikiGraph 实例，而 WikiGraph 构造只存 config、读操作全转发无状态函数）；readGraph/getNode/getEdges/getStats/scanFreshness 每次调用都全量 scanWiki()（graph-builder.ts:70）重建，330–384ms/次 @1149 页。
5. **方案评估**：A（整图级+mtime 签名）/ A′（文件级增量）/ B（transaction 主动失效）/ C（落盘快照）/ D（批量工具）/ 用户提议的子图驻留层 → **选 A′**。
6. **用户三连问澄清**：①缓存生命周期 = 纯内存进程级、不落盘（派生数据不值得持久化；落盘会多一层「缓存 vs 真实文件谁新」）；②CLI 受益边界 = MCP 常驻进程是主战场，CLI 写命令（addNode/addEdge 单进程扫 2 次）第二次扫描受益，读命令无感但也不需要；③多 wiki = key 为 path.resolve(wikiDir)，选择是调用方责任，缓存不引入路由逻辑。
7. **用户提议的 agent 子图驻留层被否决**：内存不是先撞的墙（1 万页 ~50–100MB 但扫描已 3s；10 万页冷扫 35s）；子图层要么是零收益中间层（全图在内存）要么是持久化索引的别名（全图在磁盘）；merged 图谱无跨 wiki 边 + slug 冲突 + 无真实需求。A′ 的模块级 Map 已满足「驻留、随 agent 生死、多 wiki 各缓存」。
8. 用户要求「记录想法，暂不操作文件」→ 讨论定稿记录完毕，执行 hand-off。

### Key decisions

1. **A′ 缓存放 graph-builder.ts 模块级**：scanWiki 是所有读方唯一咽喉，一处缓存六处调用方零改动受益；且是未来换 SQLite 索引的预留接口。
2. **只缓存 ScannedPage[]，不缓存 Graph**：贵的是 I/O+解析（330ms 全部来源），buildGraphFromPages 是毫秒级纯内存；不缓存 Graph 避免「谁先失效」问题。
3. **mtime+size 懒校验，写路径不碰缓存**：read-your-writes 免费（写完 mtime 已变），外部编辑（Obsidian 手改）自动生效——这是选懒校验而非 transaction 主动失效的核心理由。
4. **诚实的账**：wiki 工具合计 ~9s 不是那次 600s 超时的主因（20s/轮大头是 LLM 生成）；缓存的价值是解除规模增长后的线性劣化 + desktop/freshness/深漫游累积成本，不是救这次超时（那已由预算可见性修）。
5. **升级触发器**：wiki 超 ~5 万页或冷扫描超 ~10s → SQLite 持久化索引项目，只换 scanWiki 内部实现，调用方一行不动。
6. **拒绝磁盘缓存文件**：真到需要跨进程持久化那天，它不叫缓存叫索引，不该用半吊子形态提前占坑。

### Surprises

- wikiCache 名字像缓存实际是假缓存：WikiGraph 是纯直通壳。
- addNode/addEdge 一个命令内全量扫描 2 次（node-ops.ts:99 dangling 检查 + :641 slug 冲突；edge-ops source+target 各一次 findPageBySlug）。
- agent 27 次调用里 14 次是 read_graph（要整图）——子图缓存本来就接不住主导调用形状。
- search_files 工具在本工作区不可靠（rg IO error「系统找不到指定的路径」+ 括号正则 parse error），改用 read_file / terminal grep 稳定。
- 一次 terminal 命令（sed 嵌套 $(...)）被 Hermes 安全过滤器硬拦截，改走 read_file 绕开。

### What's NOT done

- A′ 缓存零行代码（用户明确暂停）。
- 本 session 全部代码未 commit（含 src/agent/ 整目录 untracked）。
- iter 18 read_file 一次 0ms 失败未查（后续成功，疑似瞬时）。
- 真实验证未做：查询回答是否落 queries/、因果漫游是否输出 Causal Chain / False Causal Analyses、缓存实测耗时。

## 2026-07-31 — agent-layer-design-complete <!-- keep -->

### What happened

完整设计了 llm-wiki-ops 高级智能体层（`docs/design/agent-layer.md`），经历四轮专家评审迭代：

- **v1**（9e432d6）：初始设计，五个 agent + MCP 双传输 + 停止条件
- **v2**（2d2739f）：第一轮评审 14 条意见全部处理（PDF 缺口、工具名对齐、LLM 重试、上下文管理等）
- **v3**（56f9544）：MCP spec 升级至 2026-07-28 + 向后兼容（后来在 v6 砍掉）
- **v4**（83c926a）：第二轮评审 9 条（purge 执行分叉、锚定消息、SERVER_DEAD、非法 JSON）
- **v5**（7921c04）：第三轮评审 7 条（引用判定收窄、purge 枚举路径、fallback 条件、MRTR）
- **v6**（a2f8772）：三人 GO 评审 P1-P6 落地（dry-run、快照、两步确认、砍 2026-07-28、RunReport、安全测试）

同 session 还完成了代码修复（19cf12e）：共享 helper 提取、BFS 邻接表优化、CLI 重写（去掉 wikiRoot 位置参数）、README 重写。148/148 测试通过。

### Key decisions

1. **P4 砍 2026-07-28**：v1 只说 2025-11-25。这是最有价值的简化——省 2-4 天，§4.3 从 50 行缩到 15 行。
2. **purge → archive**：默认标记 `status: invalidated`，不删除。对齐 Karpathy 方法论。需要低级层 schema 扩展（前置依赖）。
3. **token 估算砍掉**：滑动窗口改为纯字符阈值 100K。用户原话："没必要token计算吧，这有什么用？"——确实没用。
4. **实现用 ingest 打样，发布用 research 主打**：ingest 验证 agent loop，research 是竞品真空地带。
5. **零依赖守住**：P4 落地后手写 2025-11-25 可控（2-3 天），不引入 MCP client SDK。

### Surprises

- 参考了 pi agent 框架的 DeepWiki 文档（466KB），提取了 compaction、tool 截断、路径沙箱等设计模式。
- npm 上 `llm-wiki` 已被 @sdsrs/llm-wiki 占用，publish 时需要确认 bin 名。
- "低级层不动"原则已被打破（快照、status/superseded_by），但变更很小。

### What's NOT done

- 零行 agent 代码。设计文档 650 行，实现 0 行。
- 核心假设未验证：LLM 能否可靠地通过 MCP tools 操作 wiki。
- 上下文管理参数（100K/2KB/512B）全是拍脑袋，需要真实运行调参。
