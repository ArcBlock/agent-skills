# issue-sweep-batch — 三态为什么不能塌成两态，以及 `source_roots`

> On-demand reference for [`issue-sweep-batch`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

三态表、`unproven` ≠ `disjoint`、以及 profile 里 `source_roots` 的写法，在 SKILL.md。
这里是那两条规则各自消灭过的同色。

**为什么必须是三态**：这是 accept-path 铁律作用在测量本身上——
**「没测到冲突」与「测过了没冲突」完全同色。** arc 实测：一轮里 #5554 / #5417 / #5617
的正文都抽出 0 个路径；把 `unproven` 当 `disjoint`，它们会被当作安全并行派出，
而 #5554 要扩的能力声明面正是在飞 epic 的另一条成员在动的面。

### 抽取器认哪些根目录 —— 白名单没覆盖时的假 `unproven`

路径面从 issue 正文里抽，靠的是一份**根目录白名单**。这份清单曾经写死为 arc 的布局
（`providers/ runtimes/ blocklets/ …`），于是别的仓库整类抽不到落点：

> **`unproven` 的语义应当是「正文里没有路径」。** 白名单没覆盖时它实际表示
> 「正文里有路径，但我不认识这些根目录」——**两件事被折叠成同一个值，
> 量具自己制造了它被设计来消灭的那种同色。**

实测 ArcBlock/blockchain（根目录是 `core/ did/ statedb/ …`）：**100 条 `unproven` 里
44 条是量具产物**；那一轮因此得出「形不成任何 epic」，而那是假的。
**一个坏掉的量具让工厂静默停摆，且停摆看起来像「没有工作可派」。**

所以清单住消费仓库的 `.claude/repo-profile.md`（缺键回退 arc 缺省列表；缺键且正文有
路径样 token 时 `lib.ts` 的 `looksLikeMissingRoots` 报警）。别往缺省列表里加 `.github`：
`lib.test.ts` 的 `MIXED` fixture 靠它落在白名单外验证 `partial` 臂。
