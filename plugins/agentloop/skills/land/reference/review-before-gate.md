# land — why review is a different context, before the gate

> On-demand reference for [`land`](../SKILL.md) Step 4 (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the rationale and incident history.

## 不同的 subagent

**reviewer 必须与 implementer 是不同的 subagent。** 同一个上下文既实现又评审，等于自己审自己——它会把实现时的假设当成已验证的事实带进评审。

## verdict 的 sha 是被审的那个，不是 PR head

PR 开出来后贴第 1 轮 verdict 时，sweep-trace 的 `sha` 必须是**被审的那个（修复前的）sha**，不是 PR head。否则 pr-review Step 0.6 会把没审过的修复批次当成已审。

## 不要另立一份回执协议

inline review 的回执协议只有一处真相（`../../reference/review-receipt-protocol.md`，原 `epic-conductor` §6）。在 land 里再抄一份，两份一定会漂。

## 刷新 verdict，否则这一轮看不见

修完之后两件事都要做：重跑 gate，**并且**刷新 verdict（pr-review 的 canonical comment，原地 upsert）。只重跑 gate 不刷 verdict，轮次计数器就看不见这一轮。

## 第 1 轮 verdict 怎么贴

PR 开出来后，把 reviewer 的结论作为**第 1 轮** verdict 贴上（pr-review 的 canonical comment，经 `post-verdict.ts`，sweep-trace `round:1`、`sha` = **被审的那个（修复前的）sha**，不是 PR head）。逐条注明哪个 commit 修了、哪条 REJECT 了及理由。reviewer 的 findings 照贴，你补修复列、读到的同 SHA verification 事实，并在合并前的 bot 检查时补上 `bot-clean.ts` 那一行（`botFindings=` / `vendorsSeen=`）；两项事实没齐之前判决写 `COMMENT（待闸事实 / bot-clean）`，不写 `MERGE`。修复批次是实质性或安全相关的（§4B 的 panel findings 一律算）→ 对 `<被审 sha>..<head>` 做一次增量复审，记第 2 轮。

已有 PR 没有「先于闸」的机会：reviewer 照常审 PR，读现有的 verification 事实，同样不跑闸。之后每一轮**只复审修复的那部分**（pr-review Step 0.6 的增量复审），不从头再审。

命中分类时以 `epic-conductor` §4 为准（repo-profile 的 Backend Face Paths，或鉴权 / exec-gate / 密钥 / 沙箱边界 / 支付），不在 land 里另抄一份定义。reviewer **不跑** `verification_entry`、`pre-merge`、e2e-gate / ui-verify。
