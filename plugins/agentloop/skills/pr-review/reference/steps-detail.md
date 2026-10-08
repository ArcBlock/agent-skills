# pr-review — Step 0 surfaces, rebase, worktree and conflict detail

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Step 0 — 三个面的 MCP 等价

`gh api` 只是一种实现。换成 MCP 时,下面三个调用本轮都必须有对应产出(哪怕是「无结果」),缺一路 = Step 0 未完成。

| 面 | `gh` | MCP 等价(`gh` 不可用时) |
|---|---|---|
| ①会话评论 | `gh pr view <n> --comments` | `pull_request_read(method="get_comments")` |
| ②inline 代码行评论 | `gh api pulls/<n>/comments` | `pull_request_read(method="get_review_comments")` |
| ③review 总评(**含 `state`**) | `gh api pulls/<n>/reviews` | `pull_request_read(method="get_reviews")` |

③ 的 `state`(`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`)必须显式记下,不能只看 `body`。`CHANGES_REQUESTED` 比普通评论更强:未被同一人的 `APPROVED` 取代前不合并([pr-sweep](../../pr-sweep/SKILL.md))。

### 只在真冲突时 rebase

**只有 `CONFLICTING`,或分支上的红在 `<default_branch>` 上已经修复,才 rebase。** 只是落后不 rebase:rebase 换掉 SHA,要重跑测试和 review;落后 main 的组合风险由 nightly 兜。

```bash
git fetch origin <default_branch>
gh pr update-branch <n> --rebase
```

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

### 跨 PR 冲突 / 重复 / 矛盾检测
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
