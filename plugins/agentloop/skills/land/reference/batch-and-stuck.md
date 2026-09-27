# land — batch mode, when stuck, output format

> On-demand reference for [`land`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## 批量模式

`land 5649 5651 5652`：

- **每件一个 subagent，各自 `isolation: "worktree"`**，互不共享上下文。
- 编排**串行 inline**——不要用 Workflow。
- **同一台机器上同时最多 2 个重闸**（`verification_entry` / pre-merge / daily、advisory 门、全量
  build/test 都算）。subagent 实现和 review 可以并行，跑闸前等你放行；放行前先看机器负载
  （`uptime`，`load1` ≥ 核数就先不放）。这是调度，不是锁——仓库的机器级闸锁保持关闭。
- 逐件独立汇报，一件失败不影响其余；**最后统一报一次**：哪些合了、哪些绿着待合、
  哪些卡住了、卡在哪。
- 开工前检查各 PR 之间的**文件重叠**（`<plugin_root>/scripts/check-pr-path-overlap.ts`）。
  有重叠时必须在 PR 正文里互相引用、写明合并序，**未声明的重叠 PR 不得合并**。

## 卡住时怎么办

**不要静默降级，也不要反复重试同一个失败动作。**

| 情况 | 动作 |
|---|---|
| 实现 agent 反驳了诊断且理由成立 | 采纳，更新 issue，不要将就着实现 |
| review 出了 P1 而 fixer 修不动 | 停在「已开 PR、未合」，报告清楚 |
| 闸持续红 | 不盲目重跑：二分找根因，或带 witness issue 走 `--blocked-by` 让闸自己判；都不成立就停，报告失败的具体检查和 rawTail |
| 一致性闸判 `multiple` / `unclear` | 报枚举结果，不派工 |
| 目标其实是 epic | 转 `/agentloop:epic-conductor` |
| 一轮里开的单比关的多 | 进 Step 6 开单复盘，先塌缩再决定要不要继续 |
| 连续三轮净未决数没下降 | **停止派工**，按 Step 6 停止协议给人账本 + 三轮数字 + 一条建议 |
| 一个 PR 审到第 3 轮还有 finding | 按 Step 4 的表：同类塌缩 / 开新单 / REJECT / fail——**不许开第 4 轮** |

**报告要说实话**：测试红了就贴输出，跳过了哪步就说跳过了，只有真的做完并验证过才说完成。

## 输出

结束时给出：每个目标的**终态**（merged / 待合 / 卡住）、PR 号与链接、
gate 的实际结论、review findings 的处置、以及下一条命令（如果还需要人做什么）。

**外加 Step 6 的收敛账本，无条件**（哪怕一条单都没开——那正是要看见的那种好结果）：

```
RUN_START=<ISO 时间戳>            ← run 开始时记下，账本靠它数出来
review_rounds=<n>（PR #<num>，已完成轮数，脚本读出，上限 3）
开单账本：decisions=<n>（其中 issue=<i>，其余为 TODO/KNOWN MISS/正文/comment）
          因修好而关=<m>   本 run 自开且仍 OPEN=<k>
  #<num>  kind=<文件路径>:<症状动词>  理由=<闭集里的值>   ← 每条一行
kind 家族：<f> 类 / <n> 条
收敛判定：converging | collapsible | spiral
```

`review_rounds` 与开单账本同理：**数出来的，不是记得的**。少印这一行，与
「这个 PR 一轮就干净了」在读者眼里同色。

`decisions` 与「仍 OPEN」是**两个不同的量**（前者含四种载体，后者只数 issue），
分开印，不要相加。

**`opened=0` 必须是数出来的，不是没写。** 报告里少一行和「这一轮很干净」在读者眼里同色——
这是本 skill 自己的度量对偶，别在自己身上犯。
