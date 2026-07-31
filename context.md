---
kind: context
last_updated: '2026-07-31T09:34:36+00:00'
last_writer: hand-off
last_agent: hermes
session_id: llm-wiki-ops-agent-layer
last_verified: '2026-07-31T09:34:36+00:00'
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

## Environment

- 项目路径：C:\Users\jinnn\Documents\llm-wiki-ops
- Git 分支：main，最新 commit a2f8772
- Node.js + TypeScript，vitest 测试框架
- 测试数据源：C:\Users\jinnn\Documents\wiki-builder\wikis\economic-analysis
- 参考文档：C:\Users\jinnn\Documents\wiki-builder\data\deepwiki.com\earendil-works\pi\contents.md（466KB，7411 行，必须局部读取）
- Shell：Git Bash (MSYS)，Python 3.11 via uv
