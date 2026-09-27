---
name: issue-sweep-batch
description: >-
  Form dispatchable epics from unassigned open issues: cluster by defect layer, prove file-level
  disjointness against in-flight epics (disjoint / overlap / unproven), keep an incremental
  ledger. Produces epics only; never dispatches or merges.
---

# issue-sweep-batch — 把 epic 的形成做成一步

> **Repo profile — 先读 `.claude/repo-profile.md`。** 本 skill 与仓库无关；
> arc 是参考实现。`repo_slug`、label 集合、树的划分都从 profile 取，别硬编码。

## 它在哪一层

```
issue-sweep          逐条处理「人回复了的」issue          per-issue triage
issue-sweep-batch    把一堆无人认领的 issue 聚成可派 epic  ← 本 skill
epic-conductor       把一个已定义的 epic 推到合并          per-epic execution
```

`/agentloop:issue-sweep` 的候选集**主动排除** `epic-managed` / `epic:<n>`——它明确不管
已归 epic 的东西。`/agentloop:epic-conductor` 的 Step 1 是 `Decompose`——它假设 epic 已存在。
**中间这层此前没有 skill 负责。**

## 只产出 epic，不碰任何既有机制

- **不派工**、**不合并**、**不修改既有 epic 的成员**、**不动任何 issue 的状态标签**
- 唯一的写操作是：建新 epic issue + 给候选挂 `epic:<新号>` + 写 ledger
- 因此它是**纯增量**的：不跑它，工厂的行为和今天完全一样

## 它其实是全局分类器，epic 只是一种输出

真正在做的事是：**给存量里每一条工作项确定它属于哪一类、在那类的哪一簇，
并知道这个结论什么时候失效。** epic 是「一簇 bug 且路径面不相交」时的产物，不是全部。

### 分类轴按类型不同（不可混用）

| 类型 | 轴 | 聚簇判据 |
|---|---|---|
| `bug` | `defectLayer` | 这几条能不能被**同一个修复方向**覆盖？ |
| `feature` / `idea` | `capabilityArea` | 这几条会不会被**同一次设计决定**一起决定掉？ |
| `research` | `openQuestion` | 这几条会不会被**同一次调查**一起回答？ |
| `symptom` | `openQuestion` | 这几条会不会被**同一次诊断**一起回答？ |
| `untyped` | **无轴** | 必须先定类型，不能硬分 |

When classifying a `symptom`, or when an item has no type label, read [reference/symptom.md](reference/symptom.md).

### 三种模式

```bash
--types bug,untyped      # work-object 默认（导入无 keywords → untyped）；`--types bug` 仍只扫 bug
--mode new               # 只处理**从未分类**的 —— 反复归类没动的东西是纯浪费
--mode revalidate        # 只重验**已分类**的 —— 世界变了之后旧结论还成立吗
--mode all               # 两者（默认）
```

When running `--mode revalidate`, or when a classification can expire because a neighbor changed, read [reference/invalidation.md](reference/invalidation.md).

## 工厂健康

页面顶部与 CLI 首行：`🔴 ACTION REQUIRED` / `🟡 DEGRADED` / `🟢 HEALTHY`。硬 detector 在 `health.ts`，`assess` 合成至多三条解释。**agent 读 `--json`，不读截图。**
门槛住在 `health.ts` 的 `T`。When changing them, read [reference/health.md](reference/health.md).

## 可视化：`--html`

```bash
bun .../sweep-batch.ts --dry-run --html sweep.html && open sweep.html
```

四个视图（概览 / 全局 / 按 epic / 单条追溯），自包含 HTML。When changing the page (type filter, age bars, color, the two overview charts), read [reference/html.md](reference/html.md).

## 契约：一个 epic 可派，当且仅当五条同时成立

1. **单一主题** —— 每个成员是同一个**缺陷形状**，不是同一个症状
2. **路径面与所有在飞 epic 不相交** —— 文件级，且三态判定为 `disjoint`
3. **纯 bug** —— 无 feature 混入
4. **无成员卡在人身上**
5. **逐成员写明验收** —— mutation pair：弄坏必须红，恢复必须绿

任何一条不成立就不是 epic，是一袋 issue。**宁可少形成一个 epic，也不要形成一个假 epic**——
假 epic 的代价是两个 agent 撞在同一个文件上，比不派更贵。

## 机械 / 判断的分工（不可混淆）

`scripts/sweep-batch.ts` **只做可判定的部分**，其余显式交回给你：

| 机械（脚本做） | 判断（你做） |
|---|---|
| 存量拉取、候选过滤 | 给每条候选赋 **layer** |
| ledger 增量 | 读代码定位 `unproven` 的落点 |
| 路径面抽取 | 按 layer 聚簇 |
| 三态不相交判定 | 写 epic 正文、成员取舍 |
| 在飞 PR 排除 | |

**脚本刻意不猜 layer。** 用关键词猜会重演这个真实错误：#5487「共享 worker 槽位」与
#4749「独占 heavy lease」症状同为并发争用，**修复方向相反**，捆一起产出的是「既共享又独占」。

> **同层判据一句话：两条能不能被同一个修复方向覆盖？** 不能就不是同一层。

## 三态不相交（本 skill 的核心）

| 态 | 含义 | 动作 |
|---|------|------|
| `disjoint` | 两边文件集都已知，交集为空 | ✅ 可并行 |
| `overlap` | 已知且交集非空 | 串行化，或重切；脚本会点名撞哪个文件 |
| **`unproven`** | **一边或两边正文里没有任何文件路径** | **❌ 不是 disjoint。必须读代码定位后再判** |

**`unproven` 不是 `disjoint`。** 「没测到冲突」与「测过了没冲突」完全同色。

### 抽取器认哪些根目录 —— `source_roots`（#5723）

路径面从 issue 正文里抽，靠的是一份**根目录白名单**，住**消费仓库的** `.claude/repo-profile.md`：

```
| `source_roots` | `core did statedb indexdb ledger rollup apps examples` |
```

缺键回退到 arc 的缺省列表（零行为变化）。**缺键、且存量里出现「`unproven` 但正文有
路径样 token」时，机械层会直接报警**并提示去 profile 里声明——不让「没配」和
「配了但真的没路径」同色（`lib.ts` 的 `looksLikeMissingRoots`）。

⚠ 别往缺省列表里加 `.github`：`lib.test.ts` 的 `MIXED` fixture 正是靠它落在白名单外
来验证 `partial` 臂，收进来会让那条 accept 臂恒真。

When `unproven` may be the instrument (unrecognized roots) rather than a missing path, read [reference/source-roots.md](reference/source-roots.md).

## 步骤

### Step 0 — 同步 + 读 profile
沿用 `/agentloop:issue-sweep` 的 Step 0。

### Step 1 — 跑机械层
```bash
bun <plugin_root>/skills/issue-sweep-batch/scripts/sweep-batch.ts --dry-run \
    [--types bug|feature|idea|research|untyped] [--mode new|revalidate|all]
```
读它的输出：候选集、排除理由分布、已测路径面按车道分组、`unproven` 清单、
以及**每个在飞 epic 的 disjoint / overlap / unproven 计数**与撞点。

### Step 1.5 — 邻域信号（GitHub 源必需）

GitHub 源自述 `neighborhood=false`。跑一次 issue-graph 补上，否则
「邻居合了导致旧分类不成立」这一类失效**整类看不见**：

```bash
bun <plugin_root>/skills/issue-graph/scripts/graph-scan.ts --window-hours 24
```

把它的 `kicks` / `blocked` 喂给重验判定。work object 源不需要这一步——
关系是边，邻域变化是一次图查询。

### Step 2 — 处理 `unproven`（不可省）
对每条 `unproven` 的候选，**读代码定位落点**：`grep` 它描述的机制、找到会被改的文件。
定位不出来就**不要纳入本轮 epic**——落点未知的成员会让整个 epic 的不相交声明失效。

### Step 3 — 赋 layer，按 layer 聚簇
一个簇 = 一个 epic 候选。簇内成员必须能被同一个修复方向覆盖。

### Step 4 — 簇内与簇间再验一次不相交
簇形成后，用同一个判定重算：簇 × 每个在飞 epic、以及簇 × 簇。任何 `overlap` 或
`unproven` 都要在 epic 正文里显式声明合并序，或把该成员移出。

### Step 5 — 写 epic 正文
必须包含（缺一不可）：

- **主题一句话** —— 说清这是哪个缺陷形状，不是列举症状
- **成员表** —— 每条一句话 + 落点
- **只碰 / 不碰** —— 逐文件写死；点名其他在飞 epic 占着哪些文件
- **逐条验收** —— mutation pair 的两臂都写出来（弄坏 → 必须红；恢复 → 必须绿）
- **误拦一侧** —— 若本 epic 在修「假红」，必须要求配一条证明真红仍红的测试
- **round 上限 3**（第二轮警告，第三轮未收敛即停机挂起并 @ 人）
- **flake 处置** —— 看到红先查机器负载，别盲目重跑整条闸
- **scrum 派工** —— 成员由 agent **自认领**（`claimed_by`），不是 `assigned_to`
- **成本闸四问** —— 见下。epic 是本 skill **唯一**的写出物，也是工厂里最贵的一种工作项，
  所以开 epic 这一步在 `scripts/lint-issue-cost-gate.ts` 的 `ISSUE_OPENING_ROUTINES`
  里申报为 `gated`（不是豁免：它没有 env / 窄标签凭据，也不该有）。

正文里必须带这一段并**如实填写**：

```markdown
<!-- cost-gate -->
- substrate: no — <换个地基为什么不会自动消失：给一个与地基无关的凭据（文件路径 / 复现命令 / #issue / SHA）>
- duty-log: no — <为什么这是一个工作项，而不是「本轮跑了什么、看到什么」的叙事>
- normal-state: no — <为什么这个状态是故障而不是正常态：干净机器上、清理之后也这样吗>
- cheaper-rung: <lint-rule|pre-pr-check|pr-template|doc|config|none-cheaper> — <便宜一档的解法是什么，为什么不够>
```

⚠️ 无人值守时，四问缺段落或原样复制占位符**不会被 hook 拦住**。这一段要自己守。
When comparing how hard each enforcement face is, read [reference/cost-gate.md](reference/cost-gate.md).

### 一个 epic 的四问答的是**这一簇**，不是某一条成员

- `substrate` 的凭据用簇内最具体的那条落点（Step 2 定位出来的文件路径），
  不要用症状描述——「换个地基就消失」的那一类恰恰是本 skill 最容易聚出来的假簇。
- `cheaper-rung` 问的是「这一簇能不能被**一条 lint / 一个 pre-pr 检查**一次性覆盖」。
  能，就**不该形成 epic**——去写那条 lint，那比派 N 个 agent 便宜一整个量级。
  这一问因此不是手续——它问的正是「这一簇到底该不该以 epic 的形态存在」。

### Step 6 — 自检（G1–G6，全部来自真实事故）

| G | 守卫 | 事故 |
|---|------|------|
| **G1** | 建完**校验 body 长度 > 0** | `gh issue create` 返回 URL、退出码 0、标签挂上，**body 是空的**。「创建成功」与「创建了空壳」完全同色 |
| **G2** | epic 的**动机若依赖一次测量，该测量必须先有 mutation pair** | 「77 条依赖版本钉全部失效」源自一处 `.split("@").pop()` 取到了 peer 版本；基于它开了个 P1 epic，被认领者用 fixture 推翻 |
| **G3** | 交集算**文件级** | 目录级把 `.claude/verify/checks/` 下的不同文件判成相交 |
| **G4** | 摘掉 epic 给自己挂的 `epic:<self>` | 成员计数虚高 |
| **G5** | 纳入前查**在飞 PR** | 差点重复派一条已有 PR 的 issue |
| **G6** | **conductor 有权否决成员**，否决写回 ledger | 一次真实否决的理由比形成者的判断更准 |

### Step 7 — 写 ledger
去掉 `--dry-run` 重跑，或手工写回。ledger 是**下一轮效率的全部来源**。

### Step 8 — 无簇则静默
形不成合格的簇就什么都不做、不发 comment。沿用 issue-sweep 的「无事则静默」。

## 来源可换：默认 WorkObjectSource，GitHub 是 opt-in

工作项从 `WorkItemSource`（`scripts/source.ts`）来，判定核心不绑 GitHub。
默认 `--source` 是 `WorkObjectSource`（AFS `/work`）。GitHub 只做投影 alias。

```bash
bun .../sweep-batch.ts --dry-run                     # WorkObjectSource（默认）
bun .../sweep-batch.ts --dry-run --source github     # GitHubIssueSource（opt-in）
```

两个适配器过**同一套** `source.conformance.test.ts`——与本仓 provider conformance
同构：**换源不得静默改变行为**。

`capabilities.pushdown` 声明了就必须**真的**在源侧过滤（conformance 诚实臂：带过滤的调用必须**严格**少读）。
`WorkObjectSource` 走 AFS `/.actions/query`。AFS 不可用必须 throw（`exit ≠ 0`），
不得返回空数组冒充「成功的 0 items」。id 是 string，禁止把 DID 哈希成 number。
**所有 I/O 走 AFS API**（`afs.read` / `afs.list` / `afs.exec`）。

When changing a source adapter, or when asking why the abstraction is an efficiency problem, read [reference/source.md](reference/source.md).

## ledger

默认 `.claude/state/sweep-batch-ledger.json`。每条 issue 一条记录：
`fingerprint`（body + 排序 label 的 hash）、`layer`、`pathSurface`、`surfaceState`、
`classifiedAt`、`epic`、`outcome`、`exclusionReason`。

三条效率来源：

- **增量**：fingerprint 未变且未过 TTL（14 天）→ 跳过，不重读正文、不重抽路径
- **负结果也存**：「#N 曾被考虑进 epic #M，因爆炸半径过大排除」——下轮不重新论证
- **veto 回流**：conductor 剔除成员时写回，下次不再塞进同类 epic

长期这份 ledger 迁进 work object（arc #5540），本文件是它的前身。

## 埋点

沿用 `sweep-trace`，`gate` 取 `cluster`，`val` 取
`epic-formed` / `unproven-blocked` / `no-cluster`。dry-run 不发 comment、不附 trace。

## 一句话心智模型

> **issue-sweep 问「这条该怎么办」；本 skill 问「这几条能不能一起办，而且不撞别人」。**
