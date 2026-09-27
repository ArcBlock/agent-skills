# issue-sweep — Step 0 sync and Step 0.5 graph detail

> On-demand reference for [`issue-sweep`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## Step 0 — Sync the local repo FIRST (do not skip)

Everything downstream — `git grep` safety checks, `check-types`, and every
branch you cut for a fix/deletion — must run against **the latest
`<default_branch>`** (some repos use `master` instead of `main`), not whatever
stale tree the container happened to clone. A prior
sweep may have merged PRs that moved `<default_branch>`; processing against a
stale checkout risks branching off old code, deleting a file someone else
already changed, or a safety grep that misses a freshly-added reference.

Before scanning, bring the local clone current. **⚠️ The checkout may be SHARED
with a human or another live agent session** (this repo runs several actors on
one machine) — uncommitted changes are possibly someone's in-flight work, NOT
necessarily "leftover junk from an aborted run". Never blind-`reset --hard`:
stash first (reversible), so a human can recover with `git stash list` / `pop`.

Run these as PLAIN commands and read each result — **you are the control flow**; do not
wrap them in shell loops/conditionals/`$(…)` (a sandboxed Bash guard refuses those, and
this step then hard-fails before the sweep even starts — seen live).

```bash
git fetch origin <default_branch>   # transient failure? just run it again (you are the retry loop)
git status --porcelain              # READ this: any output = dirty tree → stash on the next line
```

- **Do NOT `git checkout <default_branch>`.** In a git worktree (e.g. a fleet checkout) the
  branch is held by the PRIMARY worktree and checkout hard-fails; the fetch + reset below
  works whether you're on the branch or detached.
- **Dirty tree → stash (recoverable), never discard**: it may be a concurrent session's
  uncommitted work (a blind hard-reset here has previously destroyed in-flight edits from
  another session — arc case-law). Only if the `git status --porcelain` above printed
  something:

```bash
git stash push -u -m "issue-sweep preempted"
```

Then, tree clean:

```bash
git reset --hard origin/<default_branch>   # only moves the ref now
git log --oneline -1                       # confirm you're at the real tip
```

Then cut every fix branch from the freshly-synced `origin/<default_branch>`
(`git checkout -B <branch> origin/<default_branch>`), as Step 4 already requires. A sweep
starts from a clean, current tree — but "clean" is achieved by stashing, not
destroying.

## Step 0.5 — 确定性图计算（[`issue-graph`](../../issue-graph/SKILL.md)，每轮必跑）

label 扫描之前先跑一次图计算（只读，REST-only，秒级）：

```bash
bun <plugin_root>/skills/issue-graph/scripts/graph-scan.ts --window-hours 2
```

消费它的三个输出：

- **`kicks` → 直接并入候选集，无需人类 comment。** 这是对 Step 2 谓词的结构性补丁：
  子 issue 关闭是状态变化、不产生人类 comment，旧谓词永远看不见「孩子做完了，父该
  收尾 / 兄弟被解锁」。kick 让关闭事件确定性传播。
- **`rollupCandidates`（全部孩子已关的 open 父）→ 走 [`issue-review` ★父级 rollup](../../issue-review/SKILL.md)**
  （fencing 互斥 + 验收核对 + 综合 comment + close）。
  **`agent:hold` 一票否决 close**：带 hold 的父 issue 仍可综合 comment，但**绝不 close**——
  hold 禁止一切终态动作，优先级高于 rollup 的「全覆盖则 close」例外（实盘发现：#1104 同时是
  rollup 候选且带 hold，两条规则直接冲突）。留开，等人摘 label。
- **`blocked` → 确定性 SKIP**（有 open blocker 的连候选都不进，本轮记录原因即可）。
  被 block 的 issue 不再靠模型猜「是不是还没轮到」。

`ready` 的顺序已按 hostname 旋转（多机同分钟起跑时错峰，降低锁竞争）。图只决定
「谁进候选、谁跳过」——注入的候选照常走 Step 2 谓词、Step 3 分派、锁与认领检查，
不绕过任何既有纪律；无边的 issue（人手开的）= 图中孤立点，照常走 label/catch-all。

**`agent:ready` label 消费（producer routine 在维护它时）**：producer 定期跑
`producer.ts` 把 kick/rollup 事件物化成 `agent:ready` label（人可观察的 queue 视图）。
sweep 可以**优先**从 `gh api "repos/{owner}/{repo}/issues?state=open&labels=agent:ready"`
领取，但三条铁律：① **label 只是索引提示，领取后必回 GitHub 重验**（仍 open、图上
仍成立、无 hold、无未处理人类输入——重验就是本轮 graph-scan + Step 2 谓词）；
② **处理完（终态 disposition 落定）由消费方摘掉 `agent:ready`**——producer 只加和
清理失效（closed/hold/blocked），不知道"事做完没"；③ producer 挂了 = label 陈旧或
缺失,**退化回本节的 graph-scan 自算**,行为不变、无单点。

**`agent:ready` vs `needs-human-confirm` 矛盾——按【贴标签的先后】裁决(权威信号)。**
一个 issue 同时带 `agent:ready`(该做)和 `needs-human-confirm`(等人)时,**不要靠评论内容猜**
(人和 agent 的评论格式无法区分,见 Step 2)——读 **label 事件时序**:
`gh api "repos/{owner}/{repo}/issues/{n}/events"`,取 `labeled`/`unlabeled` 事件(带 actor +
`created_at`,GitHub 权威记录、不可伪造)。**谁最后贴的谁赢**:
- `agent:ready` 晚于 `needs-human-confirm`(尤其人类亲手贴)→ **人已确认/解锁 → 开干**(接手实现)。
- `needs-human-confirm` 晚于 `agent:ready` → **人在 ready 之后按下暂停 → 等人**,本轮不做终态动作。
- 只有其一 → 按其一;一个被后来的 `unlabeled` 摘掉 → 不再计入。
参考实现 `labelStance()`(`test/sweep-golden/lib.ts`)。**实盘 arc#1722**:Phase 4 方案已就绪、
带 `agent:ready`,但 `needs-human-confirm` 更晚贴 → 正确判为"等人拍板轴 B 决定",人一确认(摘标
或贴 ready)即接手。

Why the candidate set is built by label, not by recency: Read [candidates.md](candidates.md).
