# dream 设计方案专家评审报告

- **评审对象**：`docs/design/dream.md`（dream 模块——梦境/知识压缩 agent 设计方案，第 2 轮拍板定稿）
- **评审方式**：三路并行只读评审（代码事实核查 / 架构批判 / 工程落地坑），全部对照真实源码逐条验证，**未修改任何文件**
- **评审时间**：2026-08-07
- **评审结论**：设计稿整体扎实、代码锚点高度可信，绝大多数机制可落地；但存在 **1 处真·结构性缺口**（compression 写路径断裂）、**3 处高危实施坑**、**4 处政策缺机制**、**3 处设计缺口**，需在开工前定掉。

---

## 一、总评

设计稿的严谨度很高，绝大多数代码锚点精确到行，无一处指向不存在的符号。核查的 12 处 checklist 锚点中 **9 处完全属实**，3 处为行号级小偏差（不影响实施）；其余行为断言（facade 方法区、spawn 点、snapshot 机制、读工具集合、INFRA_FILES 匹配等）逐一核对均属实。

但有一处结构性矛盾会让整个 P2 压缩协议无法验收，必须开工前拍板；另有若干实施坑和机制空白，建议一并处理。

---

## 二、真·结构性缺口（必须拍板，否则 P2 无法验收）

### 1. `compression` 字段的写入路径是断的

设计稿自相矛盾：

- §6.1 写「知识节点由 dream 经 `update_node` 改级」，并要新增 `compression?: string` 字段；
- 但同一段又写「**不扩展 schema，update_node 摸不到该字段**」（§9 同）；
- §9 又把本地文件写锁死在 `dreams/` 内（`writeScope`），碰不到知识节点。

核实结果：MCP `update_node` 的 schema（`src/mcp/index.ts:157-180`）`additionalProperties: false`，字段集固定（title/type/content/tags/related/sources/status/superseded_by/as_of/checked/dry_run/selected_wiki），**没有** `compression`。dream agent 只能通过 MCP 工具操作，于是知识节点的压缩阶梯（active→condensed→skeleton）**在图纸上无法实现**：既不能经 MCP 改级，也不能经本地文件改。

`frontmatter` 的 normalize 其实能保留未知字段（compression/theme/description 能被读写保留），断点不在存储，而在于**没有任何工具能碰它**。

**必须二选一**：
- 扩展 MCP schema（违背「不扩展」的拍板点），或
- 给知识节点开一条本地写路径（违背 §9 的 scope 约束）。

若不拍板，压缩协议整体无法验收。

---

## 三、开工前必须修的高危实施坑（Windows / 并发）

### 2. `.gitignore` 未忽略 `.llm-wiki-ops/` → git 快照污染状态目录

`createPreWriteSnapshot` 用 `git add -A`（`safety.ts:99`）stage 所有内容含 untracked；`.gitignore` 只有 `node_modules/ dist/ *.tsbuildinfo .env`，未忽略 `.llm-wiki-ops/`。

设计把 usage（§4.4，`usage/`）、journal（§5.1，`dreams/`）、锁目录都放 `.llm-wiki-ops/`。后果：每次写前 `git add -A && git commit` 会把 usage JSONL、journal、锁全提交进 git。usage 每天一个文件、90 天保留 → 仓库无限膨胀、提交噪音大，「恢复 = git checkout」会连状态文件一起翻回旧版。

**建议**：第一步就在 `.gitignore` 加 `.llm-wiki-ops/`，让 git 快照只覆盖 `wiki/`。

### 3. resident 图 `trustWindowMs:0` 在多进程下脏读

`wiki-cache.ts:49` 用 `resident:true, trustWindowMs:0`（永不重验证），这是「MCP 进程内自己拥有 wiki」的假设。但 dream 是**多进程并发**场景（dream 进程 + reason/check + CLI 同操作一个 wiki）。`trust0` 意味着 dream 进程永不从磁盘重读——另一进程的 update_node 后，dream 的 resident 图不更新，基于过期图做压缩/关联决策。设计 §4.6「常驻图零改动」这个假设在多进程下不成立。

**建议**：dream 的 MCP 实例应设 `trustWindowMs>0`（如 30s），或每次 dream 运行前 `clearScanCache` + 重建 resident。

### 4. `wikiRoot` 大小写不归一化 → scanCache 双缓存

`path.resolve(wikiRoot)` 不归一化大小写：进程 A 用 `C:\Wiki`、B 用 `c:\wiki` 打开同一目录，结果字符串不同 → 不同缓存 key，落到同一物理目录 → scanCache（A′）双缓存，B 看不到 A 的写入，`maybeRebuildAfterWrite` 失效。锁本身安全（按目录实体），但缓存会分裂。dream 的 `--dreams-dir` 与 `wikiRoot` 拼接时尤其要统一。

**建议**：`WikiGraph` 构造时对 `wikiRoot` 做一次规范化（`path.resolve` + `toLowerCase` 或 `realpath`）。

---

## 四、政策有方向、缺机制（拍板前需明确）

### 5. threshold 10 的校准基准未定义

§5.2 给压力分项权重，说「阈值 10 ≈ 忙 wiki 几天的活动量」。但「新增/更新页面数」的分母没定义——journal 只记上次 dream 日期，那「新增/更新」是相对上次 dream 单次算，还是相对 7/30 天滚动算？若相对上次 dream，则「几天内新增多少页」没定义，阈值 10 无法验证。缺对比基准。

### 6. `hypothesis` 页检测是「将来时」，现在是空的

§2 表、§5.2、§5.5 把 hypothesis 页当作压力与线索的重要信号（×2 权重），但 §5.5 自己承认「标记约定需与 reason 实际写入格式对齐」。搜遍 `src/agent/` 未找到任何 agent 写 hypothesis 标记的代码锚点。这个 ×2 分项目前**没有确定的产出物机制**，如果 reason 不写可被纯代码扫描到的标记，该分项永远为 0。

### 7. `threads_carried` 的「未闭合」判据未定义

§5.1 journal 行有 `threads_carried`，§5.5 说「上次未闭合 thread → 优先重访」。但「未闭合」的判据未定义：是需要 check 的 UNVERIFIED 页？`needs-verification` tag？还是 `contradicts` 边双方？没有闭合条件，dream-lag 无法落地。

### 8. salience 的 touch 分量会自污染

§5.3 touch 权重包含「近期 updated/checked 戳」。但 `node-ops.ts:345` 每次写都 `fm.updated = today()`——dream 压缩节点会 bump `updated` → touch 分量增大 → 越压缩越「新鲜」越值得梦，形成正反馈。机制间意外耦合，设计未处理。

---

## 五、设计缺口（未覆盖的路径）

### 9. 「任何路径无法绕过」的总前提被本地写打破

§4 开头说「增删改查全部经过它（usage log），任何路径无法绕过」。但 §7.1 承认梦境页用本地文件工具写，**不经过 facade、无 usage log**（靠 journal 的 `changes` 字段补偿）。两者不矛盾（补偿已定义），但总前提表述是错的。建议改成「除本地文件工具外，所有图谱读写必经 usage log」，否则后续审核会拿这句当铁律。

### 10. 核验回路缺闭环标记

§7.2 说证实后晋升为正式节点，但**没有任何机制告诉下一轮 dream「这一页已被证实」**。check 证实了灵感、建了新节点，却不在梦境页写 `verified: true` 或建一条边，下一轮 dream 很可能把刚证实、有价值的梦境页删了。这是核验回路的闭环缺口。

### 11. `list_directory` 是否过滤 INFRA_FILES 未定义

§9 本地工具有 `list_directory`，dream 用它看 dreams/ 内容时，产出是否混入 index.md/log.md 这类 INFRA 文件、或把删除后的残留算进去？未定义。小缺口，但与「绝对控制」的说法相关。

---

## 六、代码锚点核查结果（代码事实专家）

### 12 处 checklist 锚点

| # | 设计稿声称 | 实际代码事实 | 是否属实 |
|---|-----------|-------------|---------|
| 1 | `UpdateNodePatch` 需新增 `compression?: string`（`types.ts:156`）| `types.ts:156` 正是 `export interface UpdateNodePatch {`，当前无 compression。行号与判断准确 | ✅ |
| 2 | `KnownPageType` 加 `"dream"`、`TYPE_DIR_MAP` 加 `dream:"dreams"`（`types.ts:267`）| `KnownPageType` 实际在 `types.ts:13`；`TYPE_DIR_MAP` 在 267 属实；`DIR_TYPE_MAP` 反向派生 278-282 属实 | ⚠️ KnownPageType 行号写错（13 非 267）|
| 3 | `KNOWN_TYPE_ORDER` 加 dream（stats/index 展示序）| `types.ts:288-295`，无 dream，需加 | ✅ |
| 4 | `scanWiki` 只扫 `wikiDir = <wikiRoot>/wiki`（`index.ts:99`）| `index.ts:99` 是 `this.wikiDir = path.join(this.wikiRoot, "wiki")`；`scanWiki` 定义在 `graph-builder.ts:103` | ✅ 语义对，行号指向 wikiDir 赋值 |
| 5 | `scanFreshnessFromPages` 需新增跳过 `type==="dream"`| `freshness.ts:150-215` 当前只 `if (page.status === "invalidated") continue`，无按类型排除 | ✅ 新增点确认存在 |
| 6 | `freshness.ts:115-139` 是 overdueDays | `overdueDays` 字段在 `types.ts:81`，计算在 192；115-139 实际是 `computeFreshness` | ⚠️ 符号存在，行号区间不准 |
| 7 | `tools.ts:321` `createLocalTools` | `tools.ts:321` 正是该函数，当前只有 readOnly 旗标、无 writeScope、无 delete | ✅ |
| 8 | `tools.ts:28` 是 `resolveSandboxed` 根沙箱 | `tools.ts:28` 正是该函数，做路径逃逸检查 | ✅ |
| 9 | 本地写 `writeFileSync` 非原子（`tools.ts:115`）| `tools.ts:115` 正是 write_file 里的 `writeFileSync(resolved, content, "utf-8")` | ✅ |
| 10 | `node-ops.ts:320` updateNode 仿 status 分支处理 compression | status 分支在 319-321，updateNode 整页替换逻辑集中于此 | ✅ |
| 11 | `index-maintainer.ts` 的 `typeHeading()` 需加 `## Dreams`（现状未知类型落 `## Other`）| `typeHeading()` 在 `index-maintainer.ts:26-38`，对未知类型返回首字母大写（`## Dream`）；批量索引分组的未知类型段确实写死 `## Other`（85-92）| ⚠️ 基本属实，`typeHeading()` 本身返回首字母大写 |
| 12 | deleteNode 事务内原子处理悬空 wikilink/related/index | `node-ops.ts:532-678`，620 行 executeTransaction 原子执行；`danglingWikilink` 处理删除线、related 移除、跳过 INFRA_FILES | ✅ |

### 其他行为断言（抽查均属实）

- facade 方法区 `index.ts:110-268`（readGraph/getNode/getEdges/getStats/getMetrics/scanFreshness/addNode/updateNode/removeEdge 等）✅
- `maintainLog` 预留未用、默认 false（`types.ts:245`、`index.ts:87,101`）✅
- 4 个 spawn 点（check.ts:207 / purge.ts:229 / reason.ts:254 / research.ts:212）都传 `SELECTED_WIKI`；ingest 的 spawn 方式不同 ⚠️ 属实，设计稿如实标注 ✅
- dry-run 措辞（`safety.ts`）、首次写前 git snapshot、DryRunExecutor 拦截 ✅
- `needs-verification` tag（`check.ts:158`）、`scan_freshness` MCP 工具、read_graph 只搜 title/slug ✅
- 13 个 MCP 工具中 6 个只读（get_stats/read_graph/get_node/get_edges/metrics/scan_freshness），列表吻合 ✅
- `metrics/topology.ts` hub（degree > p95，cap 20）✅
- `.llm-wiki-ops` 状态目录已存在（锁与 inflight 同住）、写路径 proper-lockfile 全局串行化 ✅
- `INFRA_FILES` 按 basename 匹配（`types.ts:285`）✅
- `WikiPage` 接口（`types.ts:97-112`）无 compression/theme 字段，`get_node` 返回 WikiPage ✅
- 测试约 247 例（设计稿称「约 251」）⚠️ 数量级准确，误差 1.6%

---

## 七、优先级建议

| 优先级 | 事项 | 一句话 |
|---|---|---|
| **拍板（阻断 P2）** | #1 | compression 写路径二选一：扩 MCP schema 或给知识节点本地写路径 |
| **开工前必修** | #2 | `.gitignore` 忽略 `.llm-wiki-ops/`，否则 usage/journal 污染 git 快照 |
| **开工前必修** | #3 | 明确 dream 的 resident/trustWindow 策略，多进程下不能 trust0 |
| **开工前必修** | #4 | `wikiRoot` 大小写归一化，防 scanCache 双缓存 |
| **拍板前定义** | #5 #6 #7 | 压力对比基准、hypothesis 标记机制、thread 闭合判据 |
| **P1 前处理** | #8 #9 #10 | touch 自污染、usage 总前提措辞、核验回路闭环标记 |
| **P2/P3 前** | #11 | list_directory 过滤 INFRA_FILES |

---

## 八、开工建议

1. 先落 `.gitignore` 补 `.llm-wiki-ops/`（无争议、零风险、立刻生效）。
2. 拍板 compression 写路径（唯一结构性阻断点）。
3. 明确 dream 实例的 resident/trustWindow 策略 + `wikiRoot` 大小写归一化。
4. 把 §4 总前提措辞、§5 各机制空白逐条补定义后，再进入 P0（usage log 底层）实施。