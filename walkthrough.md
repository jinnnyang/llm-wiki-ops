---
kind: walkthrough
last_updated: '2026-07-31T09:34:47+00:00'
last_writer: hand-off
last_agent: hermes
session_id: llm-wiki-ops-agent-layer
last_verified: '2026-07-31T09:33:49+00:00'
---

# Walkthrough

## 2026-07-31 — agent-layer-design-complete

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
