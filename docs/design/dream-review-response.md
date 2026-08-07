# dream 设计方案评审回复（第 3 轮）

- **回复对象**：`docs/design/dream-review.md`（三路并行评审报告）
- **回复人**：设计主笔（主线程审计整合）
- **方法**：逐条核对源码后，对每条评审意见给出**接受 / 修正 / 驳回**三类结论，并落到 `dream.md` 正文。所有"补评审缺口"标注均已写入设计稿，其中 1 处已同时提交代码（`.gitignore`）。
- **总体结论**：感谢这份评审——12 处 checklist 锚点核查 + 行为断言抽查质量极高，且无一处虚假；4 处高危坑与 4 处机制空白全部成立，已吸收。唯一不同意见在 #1 的"二选一"框架上（见下）。

---

## 一、真·结构性缺口（#1）—— 接受问题，驳回"二选一"框架

**评审意见**：`compression` 写路径断裂，因 §6.1 与 §9 自相矛盾，必须"扩 schema 或开本地写路径"二选一，否则 P2 无法验收。

**我的结论**：问题属实、矛盾属实（这是我上一轮改稿时写入的残留误述），但**"二选一"框架不成立**。

- 评审引用的"不扩展 schema"是一处**误述残留**，不是真实拍板点。真正的拍板点（§6.5）是"**不新增 `compress_node` MCP 工具**"——理由是 update_node 的整页替换已是压缩原语，再造新工具是多余实体。
- 设计稿自己的 checklist（`types.ts:156`）从一开始就把"扩展 `UpdateNodePatch` 加 `compression?: string`"列为 P2 改动。扩展**现有** `update_node` 的 schema（`mcp/index.ts:157`，`additionalProperties:false` 需加一项）与"不新增工具"**不冲突**——它不新增工具，只是给现有工具加一个字段。
- 所以正确解不是二选一，而是：**扩展 `UpdateNodePatch` + MCP `update_node` schema 加 `compression`**（§6.1/§6.5 已改）。本地写路径只给 `dreams/` 内（梦境页 + verified 标记），知识节点压缩一律走 MCP `update_node`——scope 约束不动。

已修正矛盾表述，两处（§6.1、§9 写工具清单）现在一致指向"扩展 schema"。

## 二、高危实施坑（#2/#3/#4）—— 全部接受，1 处已落代码

| # | 评审 | 结论 | 处置 |
|---|------|------|------|
| #2 | `.gitignore` 未忽略 `.llm-wiki-ops/`，git 快照污染 | **接受** | 已加 `.llm-wiki-ops/` 到 `.gitignore` 并提交——git 快照只覆盖 `wiki/`，usage/journal/锁不再进仓库。零风险、立刻生效，采纳评审"第一步就做" |
| #3 | resident 图 `trustWindowMs:0` 多进程脏读 | **接受** | §4.6 补：dream 实例 `trustWindowMs>0`（如 30s）或 run 前 `clearScanCache()` 重建 resident；check/reason 同理。`wiki-cache.ts:49` 的"进程内自有 wiki"假设在多 agent 并发下不成立 |
| #4 | `wikiRoot` 大小写不归一化 → A′ 双缓存 | **接受** | §4.6 补：`WikiGraph` 构造时 `path.resolve + toLowerCase`（或 `realpath`）归一化；dream 的 `--dreams-dir` 拼接尤其要统一。Windows 上 `C:\Wiki` vs `c:\wiki` 确实是不同缓存 key |

三处都属 P0 前置修复，已写进代码改动清单（`graph-builder.ts`、`wiki-cache.ts`）。

## 三、政策缺机制（#5/#6/#7/#8）—— 全部接受，逐条补定义

| # | 缺口 | 处置（已写入 §5） |
|---|------|------|
| #5 | pressure 对比基准未定义 | §5.2 补：一律相对**上次 dream 日期**（journal 最后一行 `date`）统计——新增 = `created > lastDreamDate`，更新 = `updated > lastDreamDate` 且非新增。不滚动 7/30 天窗口（journal 只存一次日期，滚动窗口需额外状态，如无必要勿增实体） |
| #6 | hypothesis 无生产者 | 接受评审核查（grep `src/agent/` 确无标记锚点）。§5.2/§5.5 补：该分项目前恒 0；P1 先 grep reason 真实产物确认写入格式，若 reason 不产出可扫描标记则暂时剔除（权重置 0），不在 dream 侧硬造不存在的信号 |
| #7 | threads_carried 闭合判据未定义 | §5.5 补：一条 thread 在本轮 dream 得到**裁决**即闭合——裁决 = check 证实晋升 / dream 明确 link/no-link / 证伪删除；未裁决原样带入下一轮；歧义按"保守携带"处理 |
| #8 | touch 自污染 | 接受（`node-ops.ts:345` 每次写 bump updated 属实）。§5.3 补：touch 改用 **checked 戳**（核验钟，仅 check 写）而非 updated，不含 checked 则 touch=0——dream 压缩不写 checked，正反馈消除 |

## 四、设计缺口（#9/#10/#11）—— 全部接受

| # | 缺口 | 处置 |
|---|------|------|
| #9 | "任何路径无法绕过"前提被本地写打破 | §4 开头改为"**除本地文件工具外**，所有图谱读写必经 usage log"——与 §7.1 的补偿机制对齐，后续审核不再拿旧句当铁律 |
| #10 | 核验回路缺闭环标记 | §7.2 补：证实/证伪时**在原梦境页 frontmatter 写 `verified: true/false`**（本地文件工具）+ 建与正式节点的边；下一轮 dream 跳过 `verified: true` 的页（勿删勿压缩）。否则 dream 会把刚证实、有价值的页删掉 |
| #11 | `list_directory` 是否过滤 INFRA_FILES 未定义 | §9 补：与图谱一致，`list_directory` 产出剔除 `index.md`/`log.md`（`INFRA_FILES` 按 basename，`types.ts:285`），避免把残留/基建文件算进"梦境页全集" |

## 五、代码锚点核查（六）—— 接受全部行号修正

12 处锚点 9 处属实、3 处行号偏差，均接受并已写入 §11 评审核实：
- `KnownPageType` 在 `types.ts:13`（设计稿此前混注为 267，267 是 `TYPE_DIR_MAP`）；
- `overdueDays` 计算在 `freshness.ts:192`（115-139 是 `computeFreshness`）；
- `typeHeading()` 对未知类型返回首字母大写（`## Dream`），批量索引未知段写死 `## Other`（`index-maintainer.ts:26-38, 85-92`）——需加 `## Dreams` 的确认更精确了。

其余行为断言（facade 方法区、spawn 点、snapshot、读工具集合、INFRA_FILES、测试数 247 误差 1.6%）全部接受，无异议。

## 六、对评审工作方式的评价

- checklist 锚点逐步验证、不抽样装样子——这是最值钱的部分，直接暴露了 #1 的矛盾和 #6 的空分项这两个光靠推演发现不了的坑。
- #8 的 touch 自污染是机制间的意外耦合，属真·洞察，普通评审不会注意到 `node-ops.ts:345` 的 side effect。
- 唯一商榷：把"不扩展 schema"（误述残留）当成真实拍板点，从而导致 #1 被升格为"阻断 P2 的二选一"。其实它只是措辞 bug，正确解早已在 checklist 里。拆解后，**没有一条意见会真的阻断 P0/P1**——P0（usage log）实现可以照常开工。

## 七、开工顺序（吸收评审后的更新）

1. **已做**：`.gitignore` 加 `.llm-wiki-ops/`（零风险）。
2. **P0 前置**（原计划 + 评审 #3/#4）：`wikiRoot` 归一化 + dream 实例 trustWindow 策略并入 P0 的 `wiki-cache.ts`/`graph-builder.ts` 改动。
3. **P0**：usage log 底层照旧。
4. **P1**：dream 骨架；hypothesis 分项按 §5.5 先核实 reason 产物。
5. **P2**：压缩协议照 checklist 加 `compression` schema 扩展（#1 已定）。
6. **P3**：清醒侧纪律 + verified 闭环标记动作。