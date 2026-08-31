---
name: issue-sweep-batch
description: Form dispatchable epics out of unassigned open issues. Where issue-sweep triages ONE issue that a human replied to, and epic-conductor drives an epic that already exists, this skill fills the gap between them — it clusters unclaimed issues by defect layer, measures each cluster's file-level path surface against every in-flight epic, and emits epics that several agents can work in parallel without colliding. Disjointness is three-state (disjoint / overlap / unproven); an issue whose body names no files is NOT proven disjoint and must have its landing files located in code before dispatch. Keeps an incremental ledger so each run only reclassifies what changed. Produces epics only — it never dispatches, never merges, never touches existing epics.
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
| `untyped` | **无轴** | 必须先定类型，不能硬分 |

把 bug 的判据套到 feature 上，会把「同一个产品面的两个不同主张」当成一簇。
`untyped` 单列不是洁癖：arc 实测近 14 天新建的 770 条里 **268 条（34%）没有任何类型标签**，
默默当 bug 处理会污染缺陷层的聚簇。

### 三种模式

```bash
--types bug              # 默认；也可 feature,idea,research,untyped（逗号分隔）
--mode new               # 只处理**从未分类**的 —— 反复归类没动的东西是纯浪费
--mode revalidate        # 只重验**已分类**的 —— 世界变了之后旧结论还成立吗
--mode all               # 两者（默认）
```

`--mode revalidate` 的用处：一批人的建议进来了、或一批改动合了，
需要看的是**过去的分类是否还成立**，而不是重新扫一遍全量。

### 失效有三个来源，不只是「自己变了」

| 来源 | 信号 | GitHub 能给吗 |
|---|---|---|
| 自身变了 | fingerprint（正文 + label） | ✅ |
| **邻域变了** | 邻居关闭 / 被解锁 | ❌ 需 `issue-graph` 的 `graph-scan` 补算 |
| 从未分类 | 记录里没有 `layer` | ✅ |

**第二条是 label 给不出的**：一条 issue 可以一个字没改，而它依赖的那条已经合了——
过去的分类可能已经不成立。这正是 graph（将来是 work object 的关系边）
相对 label 的不可比优势。源若 `capabilities.neighborhood === false`，
脚本会明确警告**这一类失效会整类漏掉**，不装作看得见。

### 增量实测（accept-path，不是设计意图）

```
全部已分类 · 无变化   → 选中 0 / 跳过 42     （三种模式都是）
改一条的指纹          → 选中 1 / 跳过 41     （且正是改动的那条）
```

## 工厂健康 —— 让人 5 秒钟知道需不需要管

页面顶部与 CLI 首行都是**一个状态 + 至多三条解释**：

```
🔴 ACTION REQUIRED        需要人介入
🟡 DEGRADED               有信号但不需要人介入
🟢 HEALTHY                工厂产出正常，不需要人介入
```

### 分两层，第一层不是 LLM

1. **硬 detector**（`health.ts`）：确定性、便宜、可测。每条给出**证据**，不给结论。
2. **健康判读**（`assess`）：把信号合成一个状态 + ≤3 条解释。

**agent 读 `--json`，不读截图。** 渲染 → 视觉理解 → 推理会再加一层不必要的噪声，
而我们已经在验证信号上吃过噪声的亏。

### 每个 detector 必须有 accept 臂

> **一个从不触发的 detector 与一个健康的工厂完全同色。**

所以 `detectors()` 在健康基线上必须返回**空数组**，`assess()` 必须**能说
healthy 且 humanAttention=false**——只会说黄/红的系统等于没有系统，
它会退化成另一个骚扰人的 micro-manager。这两条在测试里钉死了。

### 单信号不足以判定

`backlog-expansion` 要求**进出比高**且**存量在涨**同时成立。只看比值会在
「正在恢复」时误报——arc 实况正是比值仍高但净值开始转负。

### 斜率必须算自无偏输入

**不要**把 `stockSeries` 直接喂进 detector：它由「当前 open + 窗口内已关闭」推出，
更早关闭的项不在窗口内，曲线左端**系统性偏低**。用 `netToCumulative(每日净值)`——
开与关同源同窗口，作差后偏差抵消。

### 当前门槛（集中在 `health.ts` 的 `T`）

| detector | 条件 |
|---|---|
| `backlog-expansion` | 7d 进出比 > 1.25 **且** 存量斜率 > 1/天 |
| `classification-debt` | untyped ≥ 15%（warn）/ ≥ 25%（bad） |
| `stale-work` | >7d 的占 open ≥ 40% |

## 可视化：`--html`

四个视图。**概览**是首页——整个仓库的 work object 一目了然：

| 视图 | 回答 |
|---|---|
| **概览** | 按类型的存量分布 + 流量图（开 vs 关）+ 存量线，粒度可切小时/天/周/30天 |
| **全局** | 按类型筛（点概览的类型卡，或顶部类型 chip），每种类型展示**它自己的分类轴与聚簇判据** |

```bash
bun .../sweep-batch.ts --dry-run --html sweep.html && open sweep.html
```

产出一份**自包含**的 HTML —— 无 CDN、无构建、断网可用、从 `file://` 双击就开。
是 HTML 不是 SVG，因为要能**操作**：切视图、点开详情、顺着关系走；只能看的图看不出判断。

三个视图对应三种真实问题：

| 视图 | 回答 |
|---|---|
| **按 epic** | 在飞 epic 各占哪些文件？谁和谁撞？——逐条点名撞的文件 |
| **单条追溯** | 这一条和谁同车道、属于哪个 epic、和谁共享文件？——从一个点顺关系走 |

顶部常驻**能力自述**（`pushdown` / `incremental` / `writableClassification` / `neighborhood`），
以及源不支持邻域时的警告——**页面不装作看得见它看不见的东西**。

### 类型筛选带全部类型，不只是本轮扫的那批

页面模型带**所有**开着的工作项，不只是 `--types` 选中的——否则点「feature」卡片
会得到一张空页（实测的 UI bug：原来的处理器只切视图不过滤，六个类型给出同一张页）。

未进本轮分类流程的项**仍然展示**，但标淡，并在顶部写明：

> 本轮 `--types bug` 没有扫 **feature**，下面只是存量展示：路径面已算，
> 但没有进本轮分类流程。要分类它：`--types feature` 重跑。

**别让透明度独自承担这个语义**——只调淡而不写明，看起来像页面坏了。

### 概览页的两张图回答两个不同问题

- **流量（开 vs 关，按桶）** —— 进货和出货哪个快？这是「修了这么多为什么总数不降」的
  **直接**答案。实测某 14 天窗口：开 770 / 关 612，净 +158——关闭吞吐并不低，是进货更快。
- **存量（每桶末还开着的数）** —— 常说的 burn-down 那条线。它是流量的**积分**，
  好看但**滞后**：净值转负好几天后这条线才明显下弯。**先看流量再看存量。**

### 画这两张图必须拿到已关闭项

`list({state:"open"})` 没有 `closedAt`。所以源要实现 `timeline(sinceDays)`：

- **GitHub**：额外一次昂贵拉取（open 全量 + closed 按 `closed:>=<date>` 收窄）
- **work object**：一次带时间范围的查询 —— **又一处具体优势**

页面底部常驻窗口说明（「已关闭项只取最近 N 天，更早的关闭不在窗口内，
存量线左端会因此偏低」）——**不装作那条线是完整历史**。
源不提供 `timeline` 时概览显示「未采集」，而不是画一张空图。

数据契约是 `html.ts` 的 `Model`。将来做成 web component 集成进 factory / work object 时
**契约不变，只换渲染宿主**。

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

**为什么必须是三态**：这是 accept-path 铁律作用在测量本身上——
**「没测到冲突」与「测过了没冲突」完全同色。** arc 实测：一轮里 #5554 / #5417 / #5617
的正文都抽出 0 个路径；把 `unproven` 当 `disjoint`，它们会被当作安全并行派出，
而 #5554 要扩的能力声明面正是在飞 epic 的另一条成员在动的面。

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

### 这四问今天有多硬 —— 三个面强度不同，不要读成一回事

| 面 | 强度 | 什么时候 |
|---|---|---|
| `bun scripts/issue-cost-gate.ts --body-file <f> --title <t>` | **硬**：缺段落 / 答案不在封闭词表 / 原样复制占位符 → 退出码 3 | 你自己跑的时候 |
| PreToolUse hook `.claude/hooks/record-ungated-factory-issue.ts` | **只建议**：`permissionDecision` 是 `"allow"`，附一条 advisory reason，**不拦**，只留一条 would-have-blocked 样本给规划期的 `--scan` | 无人值守真开单的时候 |
| `lint:issue-cost-gate`（`pnpm lint:arch`） | **硬**，但它管的是**申报表**——这条开单路径有没有被分类过，**不看任何一条 issue 正文** | PR 时 |

⚠️ **所以：无人值守跑到这里，四问缺段落或原样复制占位符并不会被拦住。**
这一段是你自己要守的纪律，不是一道会替你兜底的闸。把它读成「反正过不去」是错的——
声称的强度与实际强度不符，正是这道闸本身要消灭的东西。

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

## 来源可换：GitHub issue 只是今天的实现

工作项从 `WorkItemSource`（`scripts/source.ts`）来，判定核心不绑 GitHub。

```bash
bun .../sweep-batch.ts --dry-run                     # GitHubIssueSource（默认）
bun .../sweep-batch.ts --dry-run --source work-object # WorkObjectSource
```

两个适配器过**同一套** `source.conformance.test.ts`——与本仓 provider conformance
同构：**换源不得静默改变行为**。

### 为什么这个抽象是效率问题，不只是整洁

GitHub 适配器**必须**把全部 open 工作项拉下来再本地过滤。`gh issue list --label`
只能收窄一部分，而本 skill 需要的是「label + 认领状态 + epic 关系 + 变更时间」的
**联合**过滤，GitHub 侧给不出。所以它每轮读 300 条正文——而正文是本 skill 最贵的
读取成本（路径面要扫全文）。这正是仓库 CLAUDE.md 点名的反模式：
**大集合自己做 client 过滤 → 应当用 collection query 下推。**

work object（arc #5540）落地后三件事同时变便宜：

| | 今天（GitHub） | work object |
|---|---|---|
| **过滤** | 拉全量 300 条正文再本地筛 | `/.actions/query` 按 label / layer / `changedSince` 下推 |
| **分类** | 旁路 ledger 文件，多机各存一份 | `layer` / `pathSurface` / `surfaceState` 是**对象上的字段**，ledger 退役 |
| **关系** | 解析 `epic:<n>` 字符串 label | epic → 成员是**真实关系边** |

三条合起来，把每轮 sweep 从「全量重扫」变成「只读变化的那几条」。

### 纪律：声明即配套

`capabilities.pushdown` 声明了就必须**真的**在源侧过滤。conformance 有一条诚实臂：
声明下推的源，带过滤的调用必须**严格**少读——用「取全量再本地 filter」的实现声明它会红。

> 这条断言最初写成了 `<=`，一个谎称下推的源全绿通过；是变异测试把这个洞照出来的。
> **`<=` 与「真的下推了」在断言上同色。**

`WorkObjectSource` 现在**刻意 fail-closed**（`exit 1`，错误信息指向 #5540），
不给可运行的空桩——一个返回空数组的桩会让 conformance 的 ACCEPT 臂无法区分
「源是空的」和「源坏了」。落地时要兑现的三条写在 `source.ts` 的类注释里。

**所有 I/O 走 AFS API**（`afs.read` / `afs.list` / `afs.exec`），不得直连后端——
见仓库根 CLAUDE.md「AFS-Only I/O」第一原则。

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
