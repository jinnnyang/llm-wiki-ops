---
kind: questions
last_updated: '2026-08-04T02:48:19+00:00'
last_verified: '2026-08-04T02:48:19+00:00'
last_writer: hand-off
last_agent: hermes-devops
session_id: 2026-08-03-scancache-design
---

# Questions

## Open

- [ ] scanWiki 缓存 A′ 实施：四步计划已定（见 task.md），等用户放行。用户 2026-08-03 明确「暂不操作文件」。
- [ ] in-flight promise 去重（同一轮并行调用的冷缓存双扫）要不要加？倾向不加（首次之后全命中，避免多余实体），未最终拍板。
- [ ] 上下文管理参数（100K 阈值、2KB 锚定、512B 降级）是否合理？reason 真实运行未报上下文问题，但样本只有 29 轮，仍需更多运行数据。（7-31 遗留）
- [ ] npm publish 时 `llm-wiki` bin 名是否可用？（已被 @sdsrs/llm-wiki 占用）（7-31 遗留）
- [ ] `status: invalidated` 节点在 `read_graph`/`metrics`/`index.md` 中如何处理？（过滤？标注？）（7-31 遗留）

## Closed

- [x] renameNode 级联引用更新是否应 bump 引用方 `updated`？→ 用户拍板 B（2026-08-04）：级联改写（rename/delete 的引用方 wikilink + related[] 修正）视为机械操作，不 bump 引用方 `updated`，freshness 钟（checked ?? updated）不被扰动。被改名/删除节点自身的 `updated` 仍 bump。§16 决策 20 的一个记录在案的特例，见 node-ops.ts 两处 cascade 注释。 <!-- resolved -->

- [x] 本 session 代码提交策略 → 已提交 `4845611`（feat 合一）。2026-08-04 评审发现并修复 4 处问题（孤儿 tool 消息原子性、edit_file 回退唯一性/偏移、锁错误分类、注释过期），另见 fix commit；189/189 测试。

- [x] 核心假设验证：LLM 能否可靠地通过 MCP tools 操作 wiki？→ reason 真实运行已验证：27 次 wiki 工具调用全部成功（read_graph/get_edges/get_node/add 路径打通）。ingest 尚未真跑。（7-31 Open，2026-08-03 关闭） <!-- resolved -->
- [x] MCP client stdio 消息分帧细节？→ agent 层实现中已解决并验证（174/174 测试）。（7-31 Open，2026-08-03 关闭） <!-- resolved -->
- [x] 缓存以文件形式落盘吗？→ 不落盘。纯内存进程级 Map；派生数据不值得持久化；崩溃无需恢复（源头永远是 .md）。 <!-- resolved -->
- [x] CLI 每条命令独立，缓存怎么生效？→ 不跨命令生效也不需要：读命令单次扫描是固有成本；写命令（addNode/addEdge）单进程扫 2 次，第二次受益。主战场是 MCP 常驻进程（agent run）。 <!-- resolved -->
- [x] 多个 wiki 怎么确定调用哪一个？→ key = path.resolve(wikiDir)，调用方显式带 wikiDir（CLI --wiki / reason WIKI_ROOT / desktop wiki_root 参数），缓存不做路由，天然隔离。 <!-- resolved -->
- [x] agent 专属驻留 CRUD 层 / 子图按需加载 / merged 图谱？→ 不做。内存不是先撞的墙；子图层要么零收益要么退化为持久化索引；merged 图无跨 wiki 边 + slug 冲突。A′ 模块级 Map 已满足驻留/多 wiki 需求。 <!-- resolved -->
- [x] reason 超时主因是 wiki 工具慢吗？→ 不是。~9s/600s，大头是 LLM 生成时间（20s/轮）。主因是预算不可见（已修：userMessage 注入预算 + 预留 20% 写报告）。 <!-- resolved -->
- [x] MCP 版本选择？→ v1 只做 2025-11-25，2026-07-28 放 v1.1 <!-- resolved -->
- [x] purge 删除还是标记？→ 默认标记失效，--hard-delete 才删 <!-- resolved -->
- [x] token 估算是否需要？→ 不需要，纯字符阈值 100K <!-- resolved -->
- [x] 命令优先级？→ 实现 ingest 打样，发布 research 主打 <!-- resolved -->
- [x] MCP client 用 SDK 还是手写？→ v1 手写（零依赖），v1.1 再评估 <!-- resolved -->
