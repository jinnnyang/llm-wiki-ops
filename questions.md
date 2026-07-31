---
kind: questions
last_updated: '2026-07-31T09:34:47+00:00'
last_writer: hand-off
last_agent: hermes
session_id: llm-wiki-ops-agent-layer
last_verified: '2026-07-31T09:34:05+00:00'
---

# Questions

## Open

- [ ] 核心假设验证：LLM 能否可靠地通过 MCP tools 操作 wiki？需要拿真模型跑一次 ingest 才能回答。
- [ ] 上下文管理参数（100K 阈值、2KB 锚定、512B 降级）是否合理？需要真实运行数据。
- [ ] npm publish 时 `llm-wiki` bin 名是否可用？（已被 @sdsrs/llm-wiki 占用）
- [ ] `status: invalidated` 节点在 `read_graph`/`metrics`/`index.md` 中如何处理？（过滤？标注？）
- [ ] MCP client stdio 消息分帧细节：换行分隔 JSON、partial read、背压、子进程 stderr 处理——设计文档未覆盖，实现时需要确认。

- None.

## Closed

- [x] MCP 版本选择？→ v1 只做 2025-11-25，2026-07-28 放 v1.1 <!-- resolved -->
- [x] purge 删除还是标记？→ 默认标记失效，--hard-delete 才删 <!-- resolved -->
- [x] token 估算是否需要？→ 不需要，纯字符阈值 100K <!-- resolved -->
- [x] 命令优先级？→ 实现 ingest 打样，发布 research 主打 <!-- resolved -->
- [x] MCP client 用 SDK 还是手写？→ v1 手写（零依赖），v1.1 再评估 <!-- resolved -->
