# land — gate comment delivery and the merge script

> On-demand reference for [`land`](../SKILL.md) Step 5 (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the incident history.

## `--comment <PR#>` 会被静默忽略的那种写法

> ⚠️ **PR 号必须写成 `--comment <PR#>`。** 裸位置参数（`<verification_entry> <PR#>`）会被
> **静默忽略**——`lib/comment.ts` 的 `parseCommentArgs` 只认 `--comment` / `--dry-run` 系列，
> 不报错也不投递。闸照样跑、照样给判决，所以「跑了」和「这一轮结果贴到了这个 PR 上」
> 在终端上完全同色。写错的后果是：fixer 推了新 commit、SHA 变了，你按字面重跑，
> PR 上却一个字都没多，于是**带着过期证据合并**。
>
> `merge_gate_entry` 是**硬闸**（exit 0 才代表可以合），不是「若 profile 声明了」的可选项。

## 红了不要在这里复述闸的判据

**红了不要自己判定是不是 flake，也不要盲目重跑，也不要调大超时让它变绿。** 判据住在闸里，不在 land 里——本 skill 复述一份只会漂移。出路只有两条：二分找到根因修掉，或者带 witness issue 走 `--blocked-by` 让闸自己判定。

`--cs-head` 必须是当前 HEAD 的 40-char sha。CS 有 sourceUrl 时再加 `--source-url`（用 headRefOid 交叉校验）。`--data-file` 模式仍然必须带显式 PR#。

## rebase 的代价

只在 `mergeable=CONFLICTING` 时才 rebase。只是落后 main 不 rebase：rebase = 新 SHA = 整套闸 + 一轮 review 重来。e2e-gate / ui-verify / native-verify 在 arc 是 advisory（`⚠ advisory …` 行，L1 捕网负责），读一眼，不挡合并；profile `additional_merge_gates` 列出的门才挡（arc 为空）。

## 为什么不要裸 `gh pr merge`

`merge-verified-pr.sh` 在**链接 worktree 里是安全的**（不会让 gh 去 checkout 默认分支），而 Step 3 强制 worktree 隔离。它还带 `state=OPEN` / `mergeable` 前置和 head-SHA 原子提交。

记录缺失时不要绕过去手敲 `gh pr merge`：先把闸跑出来。确有不可抗力用 `--no-gate-record "<理由>"`，它会把这件事印在 stdout 上。
