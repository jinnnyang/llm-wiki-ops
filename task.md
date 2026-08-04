---
kind: task
last_updated: '2026-08-04T02:48:19+00:00'
last_verified: '2026-08-04T02:48:19+00:00'
last_writer: hand-off
last_agent: hermes-devops
session_id: 2026-08-03-scancache-design
---

# Task

## Status: COMPLETE — scanWiki A′ 缓存已实施并实测（2026-08-04）

冷扫描 4693ms → 热扫描 48-62ms（1150 页 economic-analysis wiki，实测 scripts/bench-scan-cache.mjs）。
199/199 测试通过（含 8 个 scan-cache 回归）。四步计划全部落地，commit 见 git log。

## Next Actions（后续迭代）

```
- scanFreshness / getMetrics 等高频读路径已全部受益于 A′ 缓存，无需单独优化
- 升级触发器监控：wiki 超 ~5 万页或冷扫描超 ~10s → SQLite 持久化索引
  （当前 1150 页冷扫 4.7s，线性外推 ~2500 页触发；届时只换 scanWiki 内部实现）
- in-flight promise 去重仍未拍板（questions.md）——热路径后并发冷扫窗口极窄，倾向继续不加
```

## Key Constraints（已定，实施时不得偏离）

- 缓存放 graph-builder.ts 模块级（唯一咽喉），不放 WikiGraph 实例/wikiCache 壳层/transaction
- 只缓存 ScannedPage[]，不缓存 Graph（buildGraphFromPages 毫秒级纯内存）
- mtime+size 懒校验，写路径不碰缓存（read-your-writes 免费 + 外部编辑自动生效）
- 纯内存不落盘；缓存生命周期 = 进程生命周期；崩溃无需恢复（源头永远是 .md）
- 多 wiki 隔离：key = path.resolve(wikiDir)，wiki 选择是调用方责任
- 倾向不加 in-flight promise 去重（未最终拍板，见 questions.md）
- 升级触发器：wiki 超 ~5 万页或冷扫描超 ~10s → SQLite 持久化索引，只换 scanWiki 内部实现

## ⚠️ 未提交风险（已解除 2026-08-04）

~~本 session 全部代码改动未 commit~~ — 已于 2026-08-03 17:02 落进 commit
`4845611`（33 文件 +5694 行）。2026-08-04 评审修复（孤儿 tool 消息、
edit_file 回退、锁错误分类、注释过期）另见后续 fix commit。main 的
upstream 已从已删除的 feat/graph-operations-api 重新指向 origin/main。
