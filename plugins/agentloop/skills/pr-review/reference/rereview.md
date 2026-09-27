# pr-review — Step 0.6 re-review dedup (full text)

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Step 0.6 — ★ 复审去重(跨 runner:先查既有 verdict,别重复劳动)

**真实事故(PR #1812):三个 runner 的 agent 先后 full review 同一个 PR,每轮各发一条新 comment,6 条评论里没有一条对当前 HEAD 有效的拍板块——人要自己从评论堆里拼状态,结果谁也没法拍板。** 根因两个:①新鲜度靠时间戳比对,跨 runner 无法机器判重;②结论以**追加式**落盘——旧 verdict 不刷新,后续轮只发增量 FYI。修法:verdict 以 **HEAD sha 为机器键**(sweep-trace 的 `sha` 字段),以**每 PR 唯一的 canonical comment 为载体**(Step 6)。

Step 0 已拿到全部评论;取 HEAD oid,与最近一条 verdict trace(**任何 runner 发的都算**)比对:

```bash
head=$(gh pr view <n> --json headRefOid --jq .headRefOid)
# 从已取回的会话 comments 里抓最近一条 gate:"verdict" 的 sweep-trace,读其 sha + val + round
# (旧格式 trace 无 sha → 一律视为 stale;无 round → 见文末 sweep-trace 一节)
# round 也可以直接问脚本(它自带分页与 fail-closed,别手写 jq):
#   bun <plugin_root>/scripts/pr-review-round.ts --pr <n>
```

**★ 新鲜度键是二元组 `(sha, val)`,不是单看 sha。** `sha` 答「输入变了没」,`val`(上一轮的
verdict 结论)答「**结论会不会变**」。真正决定该不该再说话的是后者:一个已经升级给人、结论恒定
的 PR,输入天天变还是压根不变,**都不该再发第二条同样的话**。只看 sha 会在下面这两种 PR 上
退化成刷屏机(实盘:一个自动发版 PR 攒了 29 条评论,其中 22 条结论逐字相同 `MERGE (held)`,
横跨 26 个 skills 版本——说明这不是某一版的 bug,是键选错了维度)。

| 判定 | 动作 |
|---|---|
| **fresh**(`sha == HEAD`,且其后无人类新评论) | **不重复 review。** 只在能「推进」时行动:把新证据(新贴出的 verification 报告、作者补的截图)并入 canonical verdict(Step 6 upsert)。什么都推进不了 → 报告「HEAD `<sha7>` 已有 fresh verdict(runner:`<x>`),跳过」,**结束,零产出是正确产出**。 |
| **fresh + 人类新评论** | 进「响应人类反馈」:读三个面的人类意见(Step 0),针对性处理,**刷新同一条 canonical verdict**(不新开)。 |
| **★ sha 变,但属于机械重生成**(见下「机械重生成 PR」) | **视同 fresh。** sha churn 不是新工作。只 upsert canonical verdict 的 `sha` 字段(让下一轮认得出),**不重跑核验、不改结论、绝不新发 comment**。报告「机械重生成,结论不变,静默刷新 sha」。 |
| **★ stale,但增量复审后结论与上一轮 `val` 相同,且 PR 已处于升级等人状态**(disposition 为 `awaiting-*` / `agent:hold`) | **静默**:upsert canonical verdict 的 sha(+ 必要的一两句「本轮新增 commit 不改变结论」),**不重述理由、不新发 comment、不再 @ 人**。人没回话之前,重复升级只是噪音——**升级过一次就够了**。 |
| **stale**(`sha != HEAD` 或无 sha) | **增量复审,不从零重做**:`git diff <旧sha>..<HEAD>` 只核验 delta(新 commit 改了什么、旧结论哪几条失效),仍有效的核验结果直接继承(注明「继承自 `<sha7>` 轮」),**upsert 同一条 canonical verdict** 并把 sha 刷成当前 HEAD。**绝不新开一条只写 delta 的 FYI comment——那正是 #1812 的堆叠形态。** |
| **无 verdict** | 首轮,走完整流程。 |

**机械重生成 PR(mechanically-regenerated):** 由工具按固定模板重写分支、内容随上游自动滚动的 PR
——典型是 release-please 一类自动发版 PR。判据(任一即是,**按信号判,别按 PR 标题猜**):

- 分支名带自动发版工具的固定前缀(如 `release-please--*`);
- 带自动发版 label(如 `autorelease: pending`);
- 或 `git diff <旧sha>..<HEAD>` **只**触碰版本号 / CHANGELOG / lockfile 这类机械件,无源码改动。

这类 PR 的 sha 每次上游合入都会变,但**可审的内容形状没变**。对它们:首轮正常出 verdict,之后
除非「diff 形状变了」(触碰的文件集合超出机械件)或**人类说话**,一律走上表的「视同 fresh」。

> `sha` 只免**结论性劳动**,不免**响应义务**——人类新评论永远要读要答(同 Step 0 hold 段)。read-only 模式(无 `--post`)判定逻辑相同,只是产物呈现给用户而非 upsert 到 PR。
>
> **`val` 必须如实反映本轮结论**,它是上面这张表的机器键。gate 词表见文末——verdict comment 的
> trace **必须**是 `gate:"verdict"`;标成别的 gate(实盘见过误标 `needsReview`)会让下一轮的
> verdict 查找漏掉这条,去重**静默失效**、退回刷屏。
