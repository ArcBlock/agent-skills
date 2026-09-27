# issue-sweep-batch — `symptom` 与未定类型

> On-demand reference for [`issue-sweep-batch`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

分类轴表在 SKILL.md。这里是 `symptom` 为什么单列，以及判决闭合词表。

### `symptom` —— 未诊断的观察既不是缺陷也不是报告

走查 / 夜测报出的**单条**失败（`test-sweep-failure` / `nightly-test-failure`）说的是
「出现了预期外的东西」，而**不是**「这里有一个缺陷」。它有自己的类型，因为两个现成的桶
都会制造同色：

- 塞进 `bug`：bug 的轴是 `defectLayer`（能否被同一个修复方向覆盖），而未诊断的失败
  **方向未知**，赋层就是编。并且「已确认缺陷」与「待定项」在计数上同色。
- 塞进 `report`：report 无轴、无跟进通道，于是**「诊断完发现不是缺陷」与「根本没人看」
  同色**（oversight-discipline 的静默≠健康）。

`symptom` 与 `research` **同轴不同 disposition**：research 的产物是知识，可以长期开着；
symptom 的产物是一个**判决**，必须终结成闭合词表里的一个值（`classify.ts` 的
`SYMPTOM_VERDICTS`）：

| 判决 | 处置 |
|---|---|
| `bug` | 确认缺陷 —— **改类型**，此时才赋 defectLayer 并参与 epic 聚簇（唯一继续 open 的） |
| `test-defect` | 走查机具 / fixture 自己错了 —— 关闭 |
| `env` | 环境或部署态，不是产品缺陷 —— 关闭 |
| `stale` | 已被别的改动修掉，复现不了 —— 关闭 |
| `normal` | 是正常态（对应 cost-gate 的 `normal-state` 一问）—— 关闭 |

**闭合词表不是手续**：`undiagnosed-symptom` detector 把「仍然 open 且超期」读成
「还没有人判决」，这个推断**只有在其余判决一律关闭时才成立**。这条前提钉在
`classify.test.ts` 的 `VERDICT_KEEPS_OPEN` 那条测试上。

优先序：`report` > `bug` > `symptom`。挂上 `bug` 就是**判决已做出**，它不再是待诊断观察；
挂上 report label 说明它是一次运行的汇总，不是单条症状。

⚠ 两种形状不要混在一个 label 下：「检测到 N 处失败（timestamp）」是**运行汇总**（report），
里面的 N 处应各自 spin off 成 symptom。混在一起时「1 条 open」与「3 个未诊断的失败」同色
——计数本身就是错的。

把 bug 的判据套到 feature 上，会把「同一个产品面的两个不同主张」当成一簇。
`untyped` 单列不是洁癖：arc 实测近 14 天新建的 770 条里 **268 条（34%）没有任何类型标签**，
默默当 bug 处理会污染缺陷层的聚簇。
