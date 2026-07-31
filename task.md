---
kind: task
last_updated: '2026-07-31T09:33:24+00:00'
last_writer: hand-off
last_agent: hermes
session_id: llm-wiki-ops-agent-layer
last_verified: '2026-07-31T09:33:24+00:00'
---

# Task

## Status: DESIGN COMPLETE — READY TO IMPLEMENT

设计文档 `docs/design/agent-layer.md` v6 已通过四轮专家评审（36 条意见 + 6 条 GO 前提），全部落地。

## Next Actions (按优先级)

1. **实现核心管道**：`agent/openai.ts` → `agent/mcp.ts`（2025-11-25）→ `agent/tools.ts` → `agent/loop.ts`
2. **真实验证**：拿真模型跑一次 ingest（一篇真论文 → 真 wiki），验证核心假设
3. **调参**：根据真实运行结果调上下文管理参数（100K 阈值、2KB 锚定、512B 降级）
4. **安全层**：dry-run executor + 写前快照 + RunReport
5. **低级层 schema 扩展**：`status`/`superseded_by` frontmatter 字段（purge archive 前置）
6. **五个 agent**：purge → ingest → research → check → reason
7. **CLI 重构**：`llm-wiki graph xxx` 子命令 + `llm-wiki new` + bin alias

## Implementation Order (from §10)

1. `agent/openai.ts` — LLM 客户端
2. `agent/mcp.ts` — MCP 客户端（2025-11-25）
3. `agent/tools.ts` — 本地工具
4. `agent/loop.ts` — 智能体循环 + dry-run + 快照
5. `cli/graph.ts` — 现有操作搬迁
6. `cli/index.ts` — 主入口 + `llm-wiki new` + `create_wiki` MCP tool
7. 低级层 schema 变更
8. `agent/purge.ts`
9. `agent/ingest.ts`（实现打样）
10. `agent/research.ts`（发布主打）
11. `agent/check.ts`
12. `agent/reason.ts`

## Key Constraints

- 零新 npm 依赖（LLM 纯 fetch，MCP 纯 fetch + spawn）
- v1 只说 MCP 2025-11-25，2026-07-28 放 v1.1
- 上下文管理用纯字符阈值（100K），不做 token 换算
- purge 默认标记失效（`status: invalidated`），`--hard-delete` 才删
- 所有写操作命令支持 `--dry-run`
- 写前自动快照（git commit 或 zip）
