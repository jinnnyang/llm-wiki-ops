---
kind: task
last_updated: '2026-08-03T08:57:26+00:00'
last_verified: '2026-08-03T08:57:26+00:00'
last_writer: hand-off
last_agent: hermes-devops
session_id: 2026-08-03-scancache-design
---

# Task

## Status: DISCUSSION COMPLETE — IMPLEMENTATION PAUSED（用户要求暂不操作文件）

scanWiki 文件级增量缓存方案（A′）讨论完成，用户全部疑问已澄清（生命周期/CLI/多wiki/子图层），实施四步计划已定，等待用户放行。

## Current Todo（本 session，verbatim，全部完成）

1. [x] REASON_WRITE_TOOLS 加 wiki.add_node（完整 schema）
2. [x] prompt 加因果漫游与验证节（三检验+三值判定+选边纪律+自主裁决）
3. [x] prompt 加页面产出指引（五类页面 type + 元数据纪律 + add_node 优先）
4. [x] 报告格式加因果链条主干 + 伪因果辨析清单
5. [x] web_search 使用纪律写入 prompt
6. [x] typecheck + 测试 + build 验证（174/174 通过）

## Next Actions（scanWiki 缓存 A′ 实施四步，待放行）

```
1. src/core/graph-builder.ts 加文件级增量缓存 + 导出 clearScanCache(wikiDir?)
   - 模块级 Map<resolvedWikiDir, Map<absPath, {mtimeMs, size, page: ScannedPage}>>
   - scanWiki 改造：findMarkdownFiles → 逐文件 stat → 命中（mtimeMs+size 一致）
     复用 page，未命中才 readFileClean+解析 → 清理已删除文件 entry → 返回 ScannedPage[]
   - 现有逐文件解析逻辑抽内部函数，其余零改动；调用方
     （readGraph/getNode/getEdges/getStats/freshness/dangling）一行不改
2. tests/scan-cache.test.ts：vi.spyOn(fs,'readFile') 数读取次数，四断言
   - 命中：连续两次 scanWiki，第二次 readFile=0 且结果相同
   - 外部编辑失效：改文件后 readFile=1 且内容为新值
   - 增删感知：新增/删除文件后页面集合正确
   - read-your-writes：addNode 后 readGraph 立即可见新节点
3. docs/design/reason-causal-walk.md 补「性能：scanWiki 缓存决策」节 + 升级触发器
4. 验证：tsc --noEmit && vitest run && npm run build，
   再在 1149 页 economic-analysis wiki 实测（预期首扫 ~350ms → 二次 ≤40ms）
```

## Key Constraints（已定，实施时不得偏离）

- 缓存放 graph-builder.ts 模块级（唯一咽喉），不放 WikiGraph 实例/wikiCache 壳层/transaction
- 只缓存 ScannedPage[]，不缓存 Graph（buildGraphFromPages 毫秒级纯内存）
- mtime+size 懒校验，写路径不碰缓存（read-your-writes 免费 + 外部编辑自动生效）
- 纯内存不落盘；缓存生命周期 = 进程生命周期；崩溃无需恢复（源头永远是 .md）
- 多 wiki 隔离：key = path.resolve(wikiDir)，wiki 选择是调用方责任
- 倾向不加 in-flight promise 去重（未最终拍板，见 questions.md）
- 升级触发器：wiki 超 ~5 万页或冷扫描超 ~10s → SQLite 持久化索引，只换 scanWiki 内部实现

## ⚠️ 未提交风险

本 session 全部代码改动未 commit，交接提交时应一并处理：

```
untracked:  src/agent/（整目录）、src/cli/graph.ts、src/cli/wiki-resolve.ts、
            src/core/freshness.ts、tests/freshness.test.ts、
            tests/tool-routing.test.ts、tests/typed-edges.test.ts、
            docs/design/reason-causal-walk.md、docs/design/reason-inference.md
modified:   src/cli/index.ts、src/core/edge-ops.ts、src/core/graph-builder.ts、
            src/core/helpers.ts、src/core/node-ops.ts、src/index.ts、
            src/io/frontmatter.ts、src/mcp/index.ts、src/types.ts、
            .gitignore、package.json
```
