---
kind: context
last_updated: '2026-08-03T08:52:56+00:00'
last_verified: '2026-08-03T08:52:56+00:00'
last_writer: hand-off
last_agent: hermes-devops
session_id: 2026-08-03-scancache-design
---

# Context

## Invariants

- 设计文档 `docs/design/agent-layer.md` v6 是最终设计，四轮评审 36 条意见 + 6 条 GO 前提全部落地。[git:a2f8772]
- 低级层（core/io/concurrency/transaction/metrics/mcp）代码已修复并通过 148/148 测试。[test:19cf12e]
- CLI 已重写：去掉 wikiRoot 位置参数，使用 `--wiki` + `WIKI_ROOT`。[git:19cf12e]
- v1 只说 MCP 2025-11-25（initialize 握手），2026-07-28 放 v1.1。[user:四人共识P4]
- 零新 npm 依赖：LLM 纯 fetch，MCP 纯 fetch + child_process.spawn。[user:设计决策]
- 上下文管理用纯字符阈值（100K），不做 token 换算。[user:用户明确指示]
- purge 默认标记 `status: invalidated` + `superseded_by`，`--hard-delete` 才真删。[user:产品专家+Karpathy方法论]
- 所有写操作命令支持 `--dry-run`（tool executor 拦截写操作，只记录不执行）。[user:三人GO前提P1]
- 写前自动快照：有 .git → git commit；无 → zip 到 .llm-wiki/snapshots/。[user:三人GO前提P2]
- purge 内容判断模式两步确认：--report 列候选 → --apply 执行。[user:三人GO前提P3]
- 实现顺序：ingest 打样验证 agent loop，research 发布主打（竞品真空地带）。[user:产品专家建议]
- MCP 工具名必须与 server 一致：get_stats/read_graph/get_node/get_edges/add_node/update_node/rename_node/delete_node/add_edge/remove_edge/rebuild_index/metrics/create_wiki。[git:a2f8772]
- 锚定消息引用判定：Set 查找（slug/path 精确匹配），不做内容级/语义级匹配。[user:第三轮评审]
- 项目命名不教条化：llm-wiki-ops 是项目名，wiki-graph-mcp/llm-wiki-e2e-test 等可保留。[user:用户明确指示]
- agent 层已全部实现（src/agent/：openai/mcp/tools/loop + purge/ingest/research/check/reason 五 agent），174/174 测试通过，但整目录尚未 git commit。[test:2026-08-03-vitest]
- 用户核心原则：漫游的启动-经过-终止由 agent 自主裁决；状态机只当「镜子」（读回当前位置/路径/已访问集合）不当「缰绳」（不控制/不阻断/不强制终止）；预算可见性同理——把预算数字读给 agent 看，由 agent 自己收口。[user:多轮明确指示]
- wiki 工具延时根因：mcp/index.ts 的 wikiCache 是假缓存（只缓存 WikiGraph 实例，WikiGraph 构造只存 config）；readGraph/getNode/getEdges/getStats/scanFreshness 每次调用都全量 scanWiki() 重建，330–384ms/次 @1149 页。[test:2026-08-03-真实运行计时]
- scanWiki（graph-builder.ts:70）是所有读方唯一咽喉；调用点：graph-builder.ts:255/333/363/420、freshness.ts:157、node-ops.ts:99/641；addNode/addEdge 单命令内扫描 2 次。[git:uncommitted-2026-08-03]
- scanWiki 缓存方案已定（未实施）：A′ 文件级增量缓存，graph-builder.ts 模块级 Map，key=path.resolve(wikiDir)，缓存内容 path→{mtimeMs,size,page}，mtime+size 懒校验；只缓存 ScannedPage[] 不缓存 Graph（buildGraphFromPages 毫秒级纯内存每次重建）；写路径不碰缓存。[user:2026-08-03-讨论定稿]
- 缓存生命周期 = 进程生命周期，纯内存不落盘；崩溃无需恢复（源头永远是磁盘 .md）；MCP 子进程随 agent run 生死，CLI 单命令建了即死。[user:2026-08-03-澄清]
- 缓存升级触发器：wiki 超 ~5 万页或冷扫描超 ~10s → SQLite 持久化索引（files 表 path/mtime/size/parsed_json + edges 表），只换 scanWiki 内部实现，调用方一行不动。A′ 是今天的解药也是明天的预留接口。[user:2026-08-03-讨论定稿]
- 已否决方案（勿重提）：merged 图谱（无跨 wiki 边 + slug 冲突 + 无需求）、agent 专属驻留 CRUD 层（A′ 已满足）、磁盘缓存文件（派生数据不值得持久化，真需要时叫索引不叫缓存）、transaction 主动失效（挡不住外部编辑，重复建设）。[user:2026-08-03-讨论定稿]
- 诚实的账：reason 那次 600s 超时主因不是 wiki 工具（27 次调用合计 ~9s），是 LLM 生成时间（~20s/轮）+ 预算不可见（已修）；缓存解决的是规模线性劣化，不是这次超时。[test:2026-08-03-运行数据分析]
- reason 预算可见性已实施：userMessage 注入 maxIterations/timeoutMs/timeoutMin，prompt 要求预留最后 ~20% 预算写报告；「浅而完整 > 深而超时零产出」。[git:uncommitted-2026-08-03]
- 因果漫游纪律已写入 reason prompt：证据锚定（每跳引用原文）+ 因果三检验（时序/机制/反例）+ 三值判定（真因果→add_edge / 伪因果→辨析页 / 存疑→不判）；web_search 用于机制检验与反例搜索，外部线索写入 wiki 必须标注来源 URL。[git:uncommitted-2026-08-03]
- 创建 wiki 页面必须走 wiki.add_node（自动处理 frontmatter/type→目录/index/slug 冲突/related 同步），不用 write_file 绕过；查询回答落 queries/、辨析页 comparisons/、概念/假设 concepts/（假设加 status: hypothesis）、链条记录 synthesis/。[user:2026-08-03]

## Environment

- 项目路径：C:\Users\jinnn\Documents\llm-wiki-ops
- Git 分支：main，最新 commit 6d6c427（7-31 hand-off 文档）；⚠️ 工作区大量未提交：src/agent/ 整目录 untracked + 11 个已跟踪文件 modified
- Node.js + TypeScript（strict, Node16, ESM），vitest 174/174 通过，build 通过
- 测试数据源：C:\Users\jinnn\Documents\wiki-builder\wikis\economic-analysis（1149 页，性能实测基准）
- gitnexus 1.6.6 已对本仓库建索引：751 节点 / 2078 边 / 63 flows
- LLM 环境变量 OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL_NAME 已配置；TAVILY_API_KEY 可用（web_search 实测成功）
- Shell：Git Bash (MSYS)，Python 3.11 via uv；search_files 工具在本工作区不可靠（rg IO error），用 read_file/terminal grep 代替
