# issue-sweep-batch — 为什么换源是效率问题

> On-demand reference for [`issue-sweep-batch`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

默认源与 `--source github` 的命令、以及 pushdown / fail-closed / string id / AFS I/O 纪律，在 SKILL.md。
改适配器，或要理解这层抽象为什么不是整洁问题，读这里。

### 为什么这个抽象是效率问题，不只是整洁

GitHub 适配器**必须**把全部 open 工作项拉下来再本地过滤。`gh issue list --label`
只能收窄一部分，而本 skill 需要的是「label + 认领状态 + epic 关系 + 变更时间」的
**联合**过滤，GitHub 侧给不出。所以它每轮读 300 条正文——而正文是本 skill 最贵的
读取成本（路径面要扫全文）。这正是仓库 CLAUDE.md 点名的反模式：
**大集合自己做 client 过滤 → 应当用 collection query 下推。**

work object（arc #5540）落地后三件事同时变便宜：

| | GitHub 源（`--source github`） | 默认 WorkObjectSource |
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

`WorkObjectSource` 走 AFS `/.actions/query` 下推、`member-of` 真边、分类 ifMatch 写回。
构造注入 `WorkLedgerOps`；sweep-batch 默认 `arc afs`。AFS 不可用必须 throw（`exit ≠ 0`），
不得返回空数组冒充「成功的 0 items」。id 是 string（GitHub `String(issue.number)`，
work object 是 `w_<32hex>`），禁止把 DID 哈希成 number。

**所有 I/O 走 AFS API**（`afs.read` / `afs.list` / `afs.exec`），不得直连后端——
见仓库根 CLAUDE.md「AFS-Only I/O」第一原则。
