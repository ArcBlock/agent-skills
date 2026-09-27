# Review-receipt protocol — bot findings and inline review threads (shared)

> The **single home** of the bot / inline-review receipt protocol for agentloop. It was
> `epic-conductor` §6 (#7105 extracted it). [`epic-conductor`](../skills/epic-conductor/SKILL.md) §6,
> [`pr-review`](../skills/pr-review/SKILL.md) Step 0.4, [`pr-sweep`](../skills/pr-sweep/SKILL.md) Step 5 and
> [`land`](../skills/land/SKILL.md) Step 4/5 all point here. Do not fork a second wait policy or receipt rule.
>
> Section references below: "the fix batch" = epic-conductor §5 / land Step 4; "record the Change Set" =
> `record-change-set.sh` (epic-conductor §3 / land Step 3); "pre-merge re-check" = item 5 below, run
> once before the merge (epic-conductor §7 item 4 / land Step 5 item 0 / pr-sweep Step 5).

## Part A — wait, fetch, resolve (was epic-conductor §6)

**Vendors are one class** (this org; treat similarly):
- `chatgpt-codex-connector[bot]` — P1/P2 badges, or a single **👍** = no suggestions (positive, not "still thinking")
- `cursor[bot]` (Bugbot) — High / Medium / Low
- any future connector that posts **inline** findings after open / ready / push

**Severity and communication are separate:** Codex **P1** and Cursor **High** block merge until resolved. Every actionable inline comment—human or bot, P0/P1/P2, High/Medium/Low—still needs a same-thread resolution before merge. P2 / Medium / Low may be fixed, REJECTed, or deferred to a follow-up issue; they do not require a long re-review wait, but they must never be silently fixed or dropped.

**No inline wait.** Do not sit and wait for bots after `gh pr create` or after a fix push — move on to the next sub-issue. The bots are checked **once**, at the pre-merge re-check (item 5), with pr-review's `bot-clean.ts`. Poll once more (a single short wait, ≤10 minutes) only when the last push is younger than 10 minutes **and** `bot-clean.ts` reports the vendor `running`, `incomplete`, `stale` (its 👍 points at an older commit — the usual state right after a fix) or `absent` (not heard from yet on a new PR); otherwise proceed on what it reports. Use `created_at >= last_push` only to notice **new arrivals**; GitHub often reassociates old comments onto the new `commit_id`, so `commit_id == HEAD` is not "new." The final resolution inventory is all actionable threads, not a timestamp-filtered subset.

**Fetch (must succeed or you have no evidence):**
```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate
gh api repos/{owner}/{repo}/pulls/<n>/reviews --paginate
```
If REST 404s / flakes, fall back to GraphQL `pullRequest { reviews, reviewThreads { comments } }` or `gh pr view <n> --comments`. **A fetch error is not "no findings."**

**Procedure (workers, fixers, and conductor all obey):**

1. After `gh pr create` or a fix commit, do not wait. Bot findings that are already there when you next look at the PR (or that `bot-clean.ts` reports at item 5) are handled like any other finding:
   - **👍 / review shell with no new inline findings** → clean. Proceed to the addressed check (item 4) and the merge. Do **not** wait longer "just in case."
   - **New actionable inline finding** → handle it in the next fix batch (item 3). Do not open the next wave with any OPEN P1/High, and do not merge until every smaller finding has a same-thread resolution.
   - **Silence** → **proceed**. Do not park the epic. The pre-merge re-check still re-fetches (item 5).
2. **Hard ban:** multi-hour `sleep`/poll; an inline wait after every push; "waiting for re-review" as a status past the one short wait in item 5; blocking wave *N+1* because wave *N*'s bot has not 👍'd; asking the human to wait for a bot.
3. **On findings:**
   - **Agree + fix** → fold it into the round's fix batch (epic-conductor §5 / land Step 4): one commit on the PR branch per batch; record the new head's Change Set (`record-change-set.sh`; a non-zero exit stops); run `<verification_entry> --comment <PR#>` once for the new HEAD; **reply in-thread** with sha + what changed. No per-finding push, no per-push bot wait.
   - **Disagree (by design / wrong layer / false positive)** → **in-thread REJECT** with reasoning + architecture pointer. Thread left open ≠ block. Record REJECT for backlog if useful.
   - **Out of scope but real** → open a **follow-up issue**; in-thread pointer; never silently fold in; never drop.
   - **In-thread only.** Do not open a new top-level PR comment to "address" a review thread.
     ```bash
     gh api -X POST repos/{owner}/{repo}/pulls/<n>/comments/<comment_id>/replies \
       -f body="$(cat reply.md)"
     ```
4. **Addressed** = every actionable inline comment in the current complete inventory has a same-thread conclusion: **fixed** in a later commit + reply with full SHA, change, and verification; or **REJECT** with reasoning. Only P2/Medium/Low may instead **defer** with a follow-up issue / owner / re-entry condition; P1/High can never defer their way to merge. A top-level verdict, verification sticky, or "already pushed" is not a reply. Timestamps may optimize detection of new arrivals but never remove an older unresolved thread: replying to A or pushing a later unrelated commit cannot close B.
5. **Pre-merge re-check (once, cheap):** run `bot-clean.ts` once (Part B: `bun "${AGENTLOOP_ROOT:-…}/skills/pr-review/scripts/bot-clean.ts" --pr <n> --repo <owner/name>`), then re-fetch and enumerate all inline comments. Any actionable thread without its conclusion → fixer/conductor posts the required same-thread resolution; an OPEN P1/High blocks until fixed or REJECTed. `running` / `incomplete` / `stale` / `absent` with a push younger than 10 minutes → the one short wait in the "No inline wait" rule above, then decide on what is there. Do not wait hours for a second bot pass after a valid resolution. **Bot reviews are not human `CHANGES_REQUESTED`** — pr-sweep's human Review 闸 does not apply; you own bots via this section.
6. **Late findings after merge** → do **not** reopen the wave; [`codex-review-backlog`](../skills/codex-review-backlog/SKILL.md) (and the same backlog for Cursor High if it lands late). Closeout may note OPEN_HARD.

**Anti-patterns:**
- Treating "no bot comment yet" as blocked, or waiting ≤10m after every commit "for the bot".
- Waiting hours for a second pass after you already fixed and replied.
- Holding merge because a disagreed-by-design thread is still open.
- A new top-level comment instead of an in-thread reply.
- Shipping a fix that satisfies finding 1 by creating finding 2, then flipping back and forth (epic-conductor §5 synthesis).

## Part B — the receipt inventory and the `bot-clean` criterion (was pr-review Step 0.4)

**Vendors:** `chatgpt-codex-connector[bot]`(P1/P2 或 👍)、`cursor[bot]`(Bugbot High/Medium/Low)、以及任何在 open/push 后发 **inline** finding 的 connector。

从 Step 0 的 ② inline comments + ③ reviews 里筛这些 login。REST `pulls/<n>/comments` 若 404,改 GraphQL `reviewThreads` 或 `gh pr view --comments`——**取失败 ≠ 没有 finding**。

GitHub 会把旧 inline comment 的 `commit_id` 改挂到新 HEAD。**不要**用 `commit_id == HEAD` 当「这条是针对本 SHA 的新意见」。`created_at` 只可用于识别本轮新增输入或减少重复抓取，**绝不可**拿「晚于上次 addressing commit」当 OPEN 判据：每条仍无同-thread 结论的 actionable inline comment 都持续 OPEN，直到该 thread 获得 fixed / REJECT / defer 回执；回复 A 或之后的 unrelated commit 不能让更早的 B 自动消失。

**全量 thread 回执(严重级别不替代沟通):** 每条要求改动、澄清或取舍的 actionable inline review comment——人或 bot、P0/P1/P2、High/Medium/Low——在 verdict 或 merge 前都必须在**同一 GitHub thread** 留下结论。已修复的回复必须写当前完整 SHA、改动路径/要点、验证命令和结果；拒绝必须写理由。只有 P2/Medium/Low 可以 defer，并必须给出 tracking issue / owner 与何时再处理的条件；P1/High 只能 fixed 或带理由 REJECT，不能用 follow-up issue 换取 merge。顶层 verdict、verification sticky、"已 push" 或另发一条 PR comment 都**不算**原 thread 回执。

```bash
# inline thread 的确定性回复；不要把同样文字改发到顶层 comment
gh api -X POST repos/{owner}/{repo}/pulls/<n>/comments/<comment-id>/replies \
  -f body='Fixed in <full-sha>: <path + what changed>. Verified: <command> (<result>).'
```

对每条 **P1 / High**：

| 状态 | 判据 |
|---|---|
| **fixed** | 其后有 commit,且该线程有 in-thread 回复写了完整 sha + 改了什么 + 验证结果 |
| **REJECT** | 该线程有不同意的理由(设计层 / 错层 / 假阳性)；P1/High 不得以 tracking/defer 代替 |
| **OPEN** | 以上都没有 |

- 任一 P1/High **OPEN** → 不得 `MERGE`。安全/正确性 → `BLOCK`;已有明确修法、该 conductor/fixer 去干 → `COMMENT`(写清 comment id + 修法)。
- P2/Medium/Low 不必因严重级别本身阻断，但**绝不可静默修完或丢弃**：缺原 thread 回执时 verdict 至少为 `COMMENT`，`pr-sweep` 不得合入，直到该 thread 有上述结论；它们才可以附 tracking/owner/重新处理条件后 defer。
- 最新 commit 若只是为了消一条 bot finding:核验**原来的 accept-path 还在不在**(修 A 搞出 B、来回翻,是假 addressed)。

#### ★「bot clean」的判据 —— 跑脚本,别读 summary 表(#6013)

**`✅ Completed` 不是 clean 的证据。** 它只表示「这一轮 review 跑完了」。Codex 自己在同一条
summary comment 的折叠说明里写着真正的判据:

> Codex reacts with 👀 while any review is running, comments if it has suggestions, and
> **reacts with 👍 once all reviews finish with no findings**.

即 **👍 reaction(`issues/<n>/reactions` 上 vendor 的 `+1`)才是权威的「无 finding」信号**;
`Completed` 从来不是。但 👍 单独也不够,还有两件实测出来的事:

- **finding 不只在 inline face。** Codex 挂不上 diff 行时,会把整篇 review 发成**顶层
  comment**(`### 💡 Codex Review` + P1/P2 徽章),落在 `issues/<n>/comments`——**不在**
  `pulls/<n>/comments`。实测 #5978(P1+P2)、#6015(P2)的 inline face 都是**空的**。
  只数 inline face,就会在一条活着的 P1 旁边印出 `botFindings=0`。
- **👍 是挂在 PR 上的,不带 commit,而且永不清除。** 它指哪个 commit 只能从 summary 表的
  Commit 列读。实测最近 100 个 PR:13 个有 codex 👍,其中 **5 个指向已被 rebase 掉的
  commit**(#6070 的 👍 是给 `44b4546` 的,head 早已是 `041fce5`)。「审过这个 commit」与
  「审过一个已经不存在的 commit」在 👍 上完全同色。

**不要用眼睛读这几个面,跑判据脚本**:

```bash
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/skills/pr-review/scripts/bot-clean.ts" \
  --pr <n> --repo <owner/name>            # 不给 --vendor 就判 RECOGNISED_REVIEW_VENDORS 花名册上**每一个**（含没留下痕迹的，state=`absent`），不是只判 PR 上出现过的
# → bot-clean: vendor=… state=… botFindings=<n|UNAVAILABLE> inline=… conversation=… \
#              thumbsUp=… summaryCompleted=… reviewedSha=… reviews=…
# → bot-clean: vendorsSeen=<n> vendors=<a,b> overall=<每个 vendor 的 state>
# exit 0 = 全部 clean · 1 = 有 vendor 不 clean（含 `absent`） · 2 = 用法错 / 取不到面(fail-closed)
```

> `${AGENTLOOP_ROOT:-…}` 的**默认**落点是发布镜像 clone。脚本随本 skill 发布,所以在镜像
> 发到含本文件的版本**之前**,默认路径下没有 `bot-clean.ts`(实测:镜像停在 `0.34.0`)。
> 那之前用真相源那棵树跑,或显式设 `AGENTLOOP_ROOT`。发布之后自愈。

| state | 含义 | verdict 里怎么写 |
|---|---|---|
| `clean` | 👍 **且**它指的 sha == head **且**没有 review 在跑 **且**五个 face 都取到 **且**没有 *live* finding（更早的 finding 会被这次 head-bound 👍 顶掉） | 记「bot clean」 |
| `findings` | inline face 或顶层 comment 有 n 条**未被顶掉的** finding | 按上面的 P1/High 表走,**`Completed` 不改变这一行**;顶层 comment 的 finding 与 inline 同等对待。comment 永不删除,所以 raw `total > 0` 是**吸收态**——一次后来的 head-bound `Completed` + 👍 必须把更早的 finding 顶掉,形状与 `blocked` 相同(#6164 F3) |
| `blocked` | vendor 说它跑不了(usage limit,实测 #5982),且**之后没有跑完一轮 head 上的 review** | **不是「还在跑」**,等下去没有结果。要么恢复额度重跑,要么写清为什么不等它。恢复额度后拿到指向 head 的 `Completed` + 👍,这条通知就被顶掉——否则 `blocked` 会变成**吸收态**:一个曾经撞过限额的 PR 永远回不到 `clean`,而它给的指示恰恰是「恢复额度重跑」 |
| `running` | 有 👍,但**这一轮 review 还在跑**(有 👀,或 Status 格还不是 `Completed`) | **不是 clean**。那个 👍 是上一轮留下的、马上会被顶掉。等这一轮跑完 |
| `stale` | 有 👍,但它指的 commit 不是 head | **不是 clean**。在 head 上重新触发 review,拿到新的 👍 再说 |
| `unbound` | 有 👍,但读不到它指的 commit | 同上,fail-closed |
| `incomplete` | vendor 在场(有 summary / 👀)但没有 👍 | 记「未完成/未知」——**不是 clean** |
| `absent` | vendor 一个字都没说（花名册里有、本 PR 没留下痕迹） | 「未知」。**仍会判、仍会印、仍进 exit**——「Codex 被判过且没问题」和「Codex 根本没被判」不许同色(#6164 F2)。等不等由 Part A「No inline wait」决定,不由本步决定 |
| `unavailable` | 某个面取失败（五个面:`pulls/<n>` head.sha / `issues/<n>/reactions` / `pulls/<n>/comments` / `issues/<n>/comments` / `pulls/<n>/reviews`） | **fail-closed**,不是 0。取失败 ≠ 没有 finding。`pulls/<n>/reviews` 上 Codex 会发 `COMMENTED` review,正文带 `**Reviewed commit:**`——finding 不藏在这面,但这面仍必须取;未取与空数组不许同色(#6164 F4) |

- **verdict comment 必须逐字带上这一行的 `botFindings=<n>`**,含 `0`,取不到就写
  `botFindings=UNAVAILABLE` 并降级判决。「数出来是 0」和「根本没数」不许同色。
- **同样要带上 `vendorsSeen=`**。不给 `--vendor` 时脚本自己枚举 `RECOGNISED_REVIEW_VENDORS`
  花名册上**每一个**已识别 review connector 并逐个判——包括本 PR **没留下痕迹**的,它的
  state 是 `absent`(不是 clean)。别只判默认那一个,否则 `cursor[bot]` 挂着 5 条 finding
  也不会有任何东西变红;也别只判「出现过的」,否则另一个 connector 的 `absent` 会藏在
  `overall=cursor[bot]=clean` 后面。**认不出的 bot 会单独打一行 `unknownBot=`**:不判、
  不计数、不阻断,但也**不静默**——一个新的 review connector 如果就这么消失了,「看过、没问题」
  和「压根没看」就又同色了。看到 `unknownBot=` 且它确实会发 finding,把它加进
  `RECOGNISED_REVIEW_VENDORS`。

> **为什么是脚本而不是一条纪律:** 这段话的前身(「👍 / 无 inline finding → 记 bot clean」)
> 和「取失败 ≠ 没有 finding」在两次误判**之前**就已经写在这里了,没挡住——
> #6009 与 #6011 各自在 finding 已存在 10+ 分钟后写下「bot clean」,共漏 9 条(4 条 P1)。
> 判据现在住在 `scripts/bot-clean.ts`,配 `bot-clean.test.ts` 的真实 PR fixture(accept 臂
> #6097 = 真 clean 且 👍 指着 head,必须仍判 clean)与 mutation pair(把判据改回
> 「`Completed` ⇒ clean」,六条 reject 臂必须红)。
> **本 PR 自己的 pre-PR 对抗 review 在这个脚本上又抓到两条 P1**(顶层 comment 的 finding 看不见、
> 👍 不绑 commit)——两条都已在实测 PR 上复现、写成 reject 臂,再修的实现。

