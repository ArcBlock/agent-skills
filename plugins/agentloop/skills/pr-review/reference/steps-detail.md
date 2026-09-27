# pr-review — flow diagram, Step 1 worktree and Step 4 conflict detail

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## How It Works(冷启动)

```
┌────────────────────────────────────────────────────────────┐
│ 0. 读 PR 全貌 + 关联 issue + 已有 review/comments            │
│ 0.4 ★ review-thread 回执 + bot P1/High 清单;OPEN 则不得 MERGE │
│ 0.6 ★ 复审去重(sha 机器键):fresh→跳过;stale→增量,不从零   │
│ 1. 读 diff + 受影响文件在「当前 main」里的真实样子            │
│ 2. ★ 逐条核验声明 vs 已落地代码/测试(path:line 或 NOT FOUND)│
│ 2.5 ★ 横切:反向引用/parity/端到端/性能/测试/清理           │
│ 3. ★ 读 current verification fact(同 SHA)—— PR 上无 CI    │
│    reviewer 只读不跑闸;缺失 → 点名分支主人去跑           │
│    简单失败可自修;复杂失败 → BLOCK + 完整日志 context       │
│ 4. ★ 检测与兄弟 PR 的冲突/重复/矛盾(同 issue + 同文件)       │
│ 5. 出判定:5 类之一 + 证据;MERGE = Step3 过 + thread 均有回执 │
│ 6. (--post)落 verdict comment;never merge、never close    │
└────────────────────────────────────────────────────────────┘
```

### Step 0 — 三个面的 MCP 等价

`gh api` 只是一种实现。换成 MCP 时,下面三个调用本轮都必须有对应产出(哪怕是「无结果」),缺一路 = Step 0 未完成。

| 面 | `gh` | MCP 等价(`gh` 不可用时) |
|---|---|---|
| ①会话评论 | `gh pr view <n> --comments` | `pull_request_read(method="get_comments")` |
| ②inline 代码行评论 | `gh api pulls/<n>/comments` | `pull_request_read(method="get_review_comments")` |
| ③review 总评(**含 `state`**) | `gh api pulls/<n>/reviews` | `pull_request_read(method="get_reviews")` |

③ 的 `state`(`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`)必须显式记下,不能只看 `body`。`CHANGES_REQUESTED` 比普通评论更强,merge 前另有硬闸([pr-sweep Step 5](../../pr-sweep/SKILL.md))。

### Step 0.5 — 只在真冲突时同步 `<default_branch>`

**单独运行 pr-review 时自己判；pr-sweep 调用时已在自己的 Step 0 后处理。** `<default_branch>` = profile 字段(部分 repo 用 `master`——下文及全篇「main」皆指该字段,不逐处再注)。

Step 0 已拿到 `mergeable` 字段。**只有 `CONFLICTING`,或分支上的红在 main 上已经修复,才 rebase。** 只是落后 `<default_branch>` **不 rebase**:rebase 会换掉 SHA,让同 SHA 的 verification PASS 作废、再烧一整套闸和一轮 review;而「落后 main 时合并会不会坏」由 `<merge_gate_entry>` 的 merge-load 门对着 main **当前** tip 判(arc Gate 5)。main 已修复、PR 分支上还红的外来红是例外:闸归因不了它(`--blocked-by` 要求 witness issue 仍 open,且三点 diff 碰到构建输入就一律不归因),所以这时 rebase(Step 3 根因 (c))。

```bash
# 仅当 mergeable == CONFLICTING,或红已在 main 上修复
git fetch origin <default_branch>
gh pr update-branch <n> --rebase   # 把 origin/<default_branch> 带进 PR 分支
```

rebase 成功后，重新取一次 `mergeable`（应为 `MERGEABLE`），再进行后续步骤；新 SHA 上的 verification 事实由分支主人重跑(Step 3),reviewer 不跑。

### Step 1 — 读 diff + 受影响代码现状
```bash
gh pr diff <n>
```
本地 checkout 须在**最新 `<default_branch>`**(pr-sweep 已 sync;单跑先 `git fetch origin <default_branch>`)。读 diff 触碰的文件在当前树里的真实样子——**不要只在 diff 内自洽地判断**,要看它落到现实代码里对不对。

> **需要 checkout 出 PR 分支本身来深查(跑某个包的测试、探索 diff 之外的关联文件)时,
> 绝不能直接切分支/改动上面这个共享主 checkout**——它固定在 `<default_branch>`,
> 而且 pr-sweep 批量跑多个 PR 时会被别的 PR review 复用。**必须建独立 worktree,
> 且必须建在 `$AGENTLOOP_WORKTREE_BASE` 下,禁止硬编码 `/tmp/...`**(fleet driver
> 已把这个变量注入 worker 环境,专属 agentloop 的固定目录):
> ```bash
> git worktree add --detach "$AGENTLOOP_WORKTREE_BASE/pr-<n>.$$" "origin/pr/<n>/head" 2>/dev/null \
>   || git worktree add --detach "$AGENTLOOP_WORKTREE_BASE/pr-<n>.$$" "$(gh pr view <n> --json headRefName -q .headRefName)"
> # 本 PR review 结束时(无论 verdict 是什么)务必清理:
> git worktree remove --force "$AGENTLOOP_WORKTREE_BASE/pr-<n>.$$" 2>/dev/null || true
> ```
> 硬编码 `/tmp/...` 会绕开部署方的 `checkoutBase` 配置、在系统盘上越攒越多且用完不清。
> driver 每轮都会兜底清扫 `$AGENTLOOP_WORKTREE_BASE` 下超过 15 分钟、且没有活跃进程的残留,但那是安全网,
> 不是替代——自己建的自己清。**多数 PR 靠 `gh pr diff` + 读当前 default_branch 上的
> 代码现状就够核验,只有真需要跑 PR 分支自己的代码(测试/构建)时才值得建这个 worktree。**

### Step 4 — ★ 跨 PR 冲突 / 重复 / 矛盾检测
两个主键:**同 issue** 和 **同文件**。

1. **同 issue 重复**(最常见,根因见下方"源头治理"):多台机器各自跑 issue-sweep,对**同一个 issue** 各开一个 PR,branch 名形如 `claude/<verb>-<N>-<slug>`——**issue 号 `<N>` 相同、verb/slug 不同**。判据:
   ```bash
   # 找所有 head branch 含同一 issue 号、或 body 同指一个 issue 的开放 PR
   gh pr list --state open --json number,headRefName,body \
     --jq '.[] | {number, headRefName, fixes: (.body|capture("(?<k>(Fixes|Part of) #\\d+)")?.k)}'
   ```
   两个 PR 同指 #N → 比 diff,分类:**精确重复**(一个冗余)/ **矛盾**(断言不同,如同一处 license 一个写 BUSL-1.1 一个写 BSL-1.1)。给出**留哪个**(更完整/更正确/证据更足者),另一个判 `SUPERSEDE`。
2. **同文件冲突**:两 PR 改同一文件。分类:**行级 merge 冲突**(同区段)/ **独立**(同文件不同区段,可共存)/ **语义矛盾**(都改同一配置成不同值)。共享配置文件(`pnpm-lock.yaml`、`wrangler.toml`、`package.json`)重叠 → 提示合并顺序/二次冲突风险。

**留谁的判据(供 SUPERSEDE 决策):** 更完整的 diff > 更正确的事实(对照权威源,如 repo `LICENSE`)> 有测试 > 更新的 base > 先到(同等条件下保留先开的,关后开的)。把判据和证据写进 comment,别只下结论。
