# issue-sweep-batch — 模式、失效来源、增量实测

> On-demand reference for [`issue-sweep-batch`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

三种模式的 flag 在 SKILL.md（`--mode new|revalidate|all`）。这里是它们为什么存在，以及分类什么时候失效。

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
