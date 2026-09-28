---
name: issue-sweep
description: >-
  Sweep open issues for unprocessed human input (comment or body) and act via issue-review: doc
  delete/update PRs, bug fixes, feature pipelines, closes after merge, comment-only for security
  or real decisions. --autofix-green also fixes unambiguous verifiable issues. Manual or
  scheduled.
---

# Issue Sweep — batch-process issues with new human replies

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> **arc is the reference implementation.** Use the profile's values wherever this doc shows an
> arc default: `repo_slug` (the `gh -R <owner/repo>` target), `gate_mode` (arc = `scripts`: no
> CI on PRs), `verification_entry` / `pre_merge_entry` (gate commands),
> `kb_issue`, the UI Face Paths, and `plugin_root` (where issue-graph's scripts live). Arc's own provenance for the lessons below (issue numbers,
> war-stories) is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

A **batch driver** over [`issue-review`](../issue-review/SKILL.md). `issue-review`
handles ONE issue (read → verify against code → act). `issue-sweep` finds *which*
issues need handling right now — the ones whose **latest comment is a human reply
the agent hasn't acted on yet** — and runs the per-issue engine on each.

This is the thing a cron should schedule: one run = scan + process a batch. In
environments without a working scheduler, run it by hand: `/agentloop:issue-sweep`.

> **★ 无人值守铁律(cron routine / /loop——本 skill 的默认运行形态):绝不调用任何会等待用户的工具——`AskUserQuestion`、`Workflow`(需交互式 opt-in 确认)、`EnterPlanMode`(退出需用户批准)。** 无人应答 → 整条 routine 永久挂死(实测:sweep routine 整夜卡在「是否运行 workflow」的提问上)。需要人拍板的问题,照 [`design-review` Autonomous escalation](../design-review/SKILL.md) 范式处理:把选项 + 你的推荐 + 被 block 的内容作为 comment(挂 `needs-human-confirm`)落到对应 issue,**然后继续处理下一项**。**禁止的是会等待确认的交互式编排,不是并行本身**:无人值守环境优先使用无需 opt-in、不会等待用户的 subagent/agent fan-out;若当前 runtime 没有这种能力才串行 inline fallback。repo hook(`.claude/hooks/deny-interactive-unattended.py`)会在无人值守 session 硬 deny 这三个工具兜底——被 deny 即说明你在无人值守环境,按本条纪律走,不要重试。

> **输出语言与写作规范(中文,信雅达),同 `issue-review`。** 所有面向团队的产出——issue/PR comment、**PR/issue 描述正文**、issue 标题、triage 说明——一律中文;代码标识符、路径、命令、`path:line`、测试输出保持原样。**PR 与 commit 标题必须全英文**——完整 Conventional Commits(`type(scope): english description`,冒号后的描述也用英文),不得留中文;issue 标题保持中文。**不堆砌**:先一句话结论,再最少但足够的证据(文档 / 代码 `path:line` / 真实测试输出,**UI 相关必附截图**);长日志折叠进 `<details>`。

## Usage

```
/agentloop:issue-sweep            # scan all candidate labels, process every unprocessed human reply
/agentloop:issue-sweep --dry-run  # report what WOULD be processed; do not post/PR/close
/agentloop:issue-sweep <label…>   # restrict the candidate set to specific labels
/agentloop:issue-sweep --autofix-green   # ALSO auto-fix "green" issues that have NO human reply yet (Step 3b)
/agentloop:issue-sweep --concurrency 2   # override this repo's configured active-issue limit
```

Repo is `<repo_slug>`. Use the `gh` CLI when it's available (as the `gh …`
examples below do); if it's absent, use the `mcp__github__*` tools instead
(load them via ToolSearch).

## Step 0 — Sync the local repo FIRST (do not skip)

Run as PLAIN commands and read each result (no shell loops / `$(…)` — the sandbox guard refuses them):

```bash
git fetch origin <default_branch>
git status --porcelain              # any output = dirty tree
git stash push -u -m "issue-sweep preempted"   # only if dirty: the checkout may be shared — stash, never discard
git reset --hard origin/<default_branch>
git log --oneline -1
```

Do **not** `git checkout <default_branch>` (fails in a worktree). Cut every fix branch from the freshly synced `origin/<default_branch>`.

Why, and what a shared checkout means: Read [reference/sync-and-graph.md](reference/sync-and-graph.md).

## Step 0.5 — 确定性图计算（[`issue-graph`](../issue-graph/SKILL.md)，每轮必跑）

```bash
bun <plugin_root>/skills/issue-graph/scripts/graph-scan.ts --window-hours 2
```

- `kicks` → 并入候选集(无需人类 comment)。
- `rollupCandidates` → [`issue-review` ★父级 rollup](../issue-review/SKILL.md);**`agent:hold` 一票否决 close**。
- `blocked` → 确定性 SKIP。
- `agent:ready` 只是索引提示:领取后回 GitHub 重验;处理完由消费方摘掉;producer 挂了就退化回 graph-scan。
- `agent:ready` 与 `needs-human-confirm` 并存 → 读 label 事件时序,**最后贴的赢**(`labelStance()`,`test/sweep-golden/lib.ts`)。

When you need the detail (ordering, producer contract, the arc#1722 case): Read [reference/sync-and-graph.md](reference/sync-and-graph.md).

## Step 1 — Build the candidate set (by label, not by recency)

1. `state: OPEN` once per candidate label (the **Label Vocabulary** in `.claude/repo-profile.md`), union, de-dup.
2. **Unlabeled catch-all, every run**: list all open issues and keep those with **no** candidate label, excluding `epic-managed` / `epic:<n>` / `doc-audit-kb` / `test-sweep-failure` / `test-sweep-report` in the jq itself. For each: infer the work-type and **add the label** (reversible triage); if it cannot be inferred, `needs-human-confirm` + a triage comment with your guess — never skip silently.
3. **Drop reserved/locked**: `agent:hold` = terminal freeze, not a processing freeze (never close / terminal-dispose; a new human comment is still answered); fresh `agent:processing` (last `labeled` event < 30 min) → SKIP, stale → do not skip; `epic-managed` → excluded entirely (no triage, claim, work or comment — the conductor owns it).

The exact catch-all command, lock-age query and case law: Read [reference/candidates.md](reference/candidates.md).

## Step 2 — Keep only "last comment = unprocessed human reply"

Keep an issue only if **the latest human input — last comment, or the body of a fresh issue with no agent response — has no agent response**. Decide by **machine marker, not author or header**:

- agent-authored = carries a `<!-- sweep-trace: … -->` (decode HTML entities first), **or** the `_Generated by [Claude Code]` footer, **or** a Bot author. The `> 🤖 AI Agent` identity header alone is **not** a marker (humans produce the same bytes) → treat as human.
- `> 📡` presence heartbeat = non-human. Zero-comment `test-sweep-failure` / `test-sweep-report` issues are not human-reply candidates (Step 3b handles them).
- A **conclusion-style batch-disposition list** ("建议关闭/合并/删除") is evidence, **never** authorization: an item in it is actionable only after a human removed its `agent:hold` or explicitly confirmed that specific action.
- A **non-terminal** agent comment (排队中 / 本轮未做 / 留开放 / in-progress / queued …) is unfinished → re-process. Order is the rule: (1) strip code, (2) **terminal wins** (PR / closed / needs-human-confirm / needs-design / security-sensitive / not-verifiable-here), (3) only then the deferral regex.

Executable form of every predicate: `test/sweep-golden/lib.ts` (unit-tested in `golden.test.ts`).

Full predicate text, the regex, and each live misclassification: Read [reference/detection.md](reference/detection.md).

## Step 3 — For each kept issue, run the issue-review engine + act

Hand the issue to `issue-review` (read issue + referenced docs + **verify each
claim against live code/tests**, `path:line` or NOT FOUND). Then act per the
human's latest comment — this is `issue-review`'s resolve phase:

### Bounded per-issue orchestration（无人值守默认并行）

**Concurrency:** `--concurrency <N>` → env `AGENTLOOP_SKILL_CONCURRENCY` (the fleet driver injects `skillConcurrency["issue-sweep"]` from `repos.json`) → default `3`; integer `1..16` else config error; shrink to the runtime's free agent slots; 没有非交互 agent 能力时降到 `1`. It caps **active issue workers**, not issues per run.

**重闸另算,同一台机器最多 2 个。** Workers may be 3, but at most 2 heavy gates (`<verification_entry>` / e2e-gate / ui-verify / full build/test) run at once: a worker asks the controller for a gate slot; the controller counts running gates, not `load1`. Scheduling, not a lock. Inside a worker, **review before the gate**, fix the findings in one batch, then gate once; `design-review` is skipped when the human already recorded the decisions, else `--max-rounds 2`.

1. **主控分配,worker 即时 claim。** The controller keeps the deduped queue and free slots and does **不预加** `agent:processing`; the worker's first act is `issue-review` Step 0 (re-verify + acquire); lost race → `SKIP_LOCKED`.
2. **One worker owns one issue** and writes only that issue's comment/label/PR/branch.
3. **会改 repo 的 worker 必须使用独立 worktree** from the latest `origin/<default_branch>`, under `$AGENTLOOP_WORKTREE_BASE` (never a hard-coded temp dir, never a harness worktree under `<repo>/.claude/worktrees/`):
   ```bash
   git -C "$(pwd)" worktree add --detach \
     "$AGENTLOOP_WORKTREE_BASE/$(basename "$(pwd)")-issue-<N>.$$" \
     origin/<default_branch>
   # when done (success, failure or skip):
   git worktree remove --force "$AGENTLOOP_WORKTREE_BASE/$(basename "$(pwd)")-issue-<N>.$$" 2>/dev/null || true
   ```
   Before writing, run `bun <plugin_root>/scripts/check-pr-path-overlap.ts --run-args '{"allowedPaths":[...]}'` with structured `allowedPaths` from the verified plan: `overlap` → report PR/files; `clean` → continue; `unavailable` → stop. Then run `AGENTLOOP_SETUP_COMMAND` in the worktree; no successful setup → no edit/test/verification claim.
4. **共享 KB 由主控单写,worker 仍贡献 KB**: workers return structured results incl. a KB delta; the controller writes the KB body, the run summary and the heartbeat after the barrier.
5. **Failure isolation**: one worker failing cancels none; the worker releases its own lock (`issue-review` Step 7); the controller **绝不代删** a lock it does not own (TTL recovers crashes); a dirty failed worktree is kept and reported, never force-deleted.
6. **嵌套 fan-out 也受 runtime 总 slot 限制** — an issue that fans out again checks free slots first, else runs inline.

**Action by the human's latest reply** (full table with each row's detail in the reference):

| Reply | Action |
|---|---|
| agrees to **delete** a `deprecated` doc | safe-delete PR (`git grep` live refs first; any blocker → comment only) |
| asks to **update** a `drifted` doc | `planning/` / `intent/` → historical-archive tombstone PR; `docs/` guides → doc-update PR matched to shipped code |
| approves a **bug fix** | implement + targeted test, one PR per bug |
| **feature / design** | small & clear → reproduce→fix→test→PR; multi-phase → evaluate, then `/agentloop:design-review` → `/agentloop:build-phases` without waiting; stop only at a genuine human-only fork, with evaluation + recommendation — never freeze |
| **research** / **idea** | [`issue-review`](../issue-review/SKILL.md) ★Research / ★Idea: first round no code/PR; end with "next round I will do X unless you say no" (ratchet); a stated end goal → go straight to the feature pipeline |
| PR merged, issue open | close (`completed`); multi-phase / acceptance-list issues need a real end-to-end test report first |
| parent rollup candidate | `issue-review` ★父级 rollup (`claim.ts` fencing; `agent:hold` vetoes the close) |
| conditional / third-party / security / genuine A-vs-B | comment only; a dependency order is not an A-vs-B |

Every action carries reproducible evidence; one verdict/PR-link comment per issue.

Full orchestration text (incident history, worktree incidents) and the full action table: Read [reference/orchestration.md](reference/orchestration.md).

## Step 3b — Autonomous autofix (`--autofix-green`): no human reply needed

The default sweep only touches issues with an **unprocessed human reply**. With
`--autofix-green`, *also* consider open issues that have **no human input at all**
— e.g. the auto-generated audit spin-offs — and **fix the ones the
agent can fix end-to-end without a human in the loop**. The whole idea: many small,
unambiguous, *verifiable* gaps don't need a person to approve them — reproduce →
fix → test → PR, one at a time. But the bar for "no human needed" is high, and
**verifiability is the gate**, not cleverness.

### Triage every candidate into 🟢 / 🟡 / 🔴

🟢 = unambiguous **and** verifiable here **and** low-risk **and** not security → autofix now (可做即做,不排队). 🟡 = doable but needs a human glance → draft PR labelled `needs-human-review`. 🔴 = security / breaking / architecture / not verifiable here → comment only.

Triage rules (🟢 / 🟡 / 🔴): Read [reference/autofix.md](reference/autofix.md).

### The verifiability gate is environment-dependent (and that's the leverage)

Why verifiability is environment-dependent: Read [reference/autofix.md](reference/autofix.md).

### Env-capability probe (multi-machine claiming)

A capability gap must be **proven first-hand this run** (probe it, paste the exact error) — never inherited from an earlier comment or another machine.

Probe commands, multi-machine claiming and the hard rule: Read [reference/autofix.md](reference/autofix.md).

### The 🟢 pipeline (one issue at a time, serial)

One 🟢 issue at a time: reproduce → failing test → fix → targeted test → `<verification_entry>` → PR (`Fixes #N`). Never auto-merge.

Step-by-step: Read [reference/autofix.md](reference/autofix.md).

### White-list, not black-list

What counts as 🟢: Read [reference/autofix.md](reference/autofix.md).

### AI-agent spin-off issues (`<!-- spinoff-of: #N -->`) — the primary autofix target

When the candidate carries `<!-- spinoff-of: #N -->` (the primary autofix target): Read [reference/autofix.md](reference/autofix.md).

### test-sweep 发现的 issue（`test-sweep-failure`/`test-sweep-report` label）— 第二类零人类输入的绿色候选源

When the candidate carries a `test-sweep-failure` / `test-sweep-report` label: Read [reference/autofix.md](reference/autofix.md).

## Step 4 — Discipline (non-negotiable)

- **Deterministic branch + claim check** (kills multi-machine duplicate PRs): branch `claude/issue-<N>` (phases: `claude/issue-<N>-p<phase>`). Before `gh pr create`, run as a plain command and read the output:
  ```bash
  gh pr list --state open --json number,headRefName,body --jq '.[] | select((.headRefName|test("(^|[-/])issue-<N>([-/]|$)|-<N>-")) or (.body|test("(Fixes|Part of) #<N>\\b"))) | .number'
  ```
  output → SKIP; none → `git checkout -B claude/issue-<N> origin/<default_branch>`.
- **Every spin-off writes a native edge**: `bun <plugin_root>/skills/issue-graph/scripts/link.ts --parent <N> --child <new>` (+ `--issue <later> --blocked-by <earlier>` for hard phase order).
- One issue, one PR; `Part of #N`, or `Fixes #N` only when fully closed. PR body starts with the `<agent_identity_script> --header "PR" --skill issue-sweep` line.
- Conventional Commits; never `--no-verify` by default (a hook that fails to spawn usually means `<package_manager> install` has not run).
- Before any deletion/edit: `git grep` for importers + targeted `check-types`/test; dep changes stage the lockfile too. AI **never** merges.
- Push: `git push -u origin <branch>`; after rebase/amend `bun scripts/git-push-lease.ts`.
- **Verification**: `<verification_entry>` before push (red → no push, no PR); after `gh pr create`, `<verification_entry> --comment <PR#>`. Acceptance-named e2e (`/e2e-verify`) must really run.
- **UI diff** (`<UI Face Paths>`): screenshots before the PR (`<ui_shot_script>` / `/ui-verify`), self-checked, embedded in the PR body via `<ui_upload_script>`, and echoed on the issue.
- The PR inherits the issue's milestone and its author + assignees (also as reviewers when human review is needed).

Full text of each rule, commands and incidents: Read [reference/discipline.md](reference/discipline.md).

## Step 5 — Be quiet when there's nothing

If no issue has an unprocessed human reply this round: **post nothing, open no
PR, message nothing.** A no-op sweep is silent. Only speak when you acted.

**★ 沉默也是 PER-ISSUE 的,不只是 per-round。** 上面那条只覆盖「本轮一个候选都没有」。
下一层的漏斗:一条 issue 被处理了,不等于这一轮就该在它下面留一条 comment。收尾前过
[`issue-review` 的 Step 5.7 沉默闸](../issue-review/SKILL.md)——**动作 / 新信息 / 都不是**,
第三类零 outward 写,结果只进 `$AGENTLOOP_RUN_REPORT`。判据是**状态变化**,不是**是否处理过**。

**适用面(照抄 Step 5.7,别记反):沉默闸只管 agent 自发的路径**——`--autofix-green` 扫描、
Step 0.5 的 kicks / rollupCandidates、定期复核、状态跟踪。**人类输入触发的必须回应**,
否则 Step 2 的谓词永远看到「未回应的人类评论」,**每轮重新全额核验一遍、一条 comment 都不产出**
——那比刷屏更贵。回应的内容照 ★Idea/★Research 铁律 10 的 ratchet 收尾,不是「复核确认,现状不变」。

**这条和 Step 3b 的三类沉默规则是同一套,别当成两套:**

| 情形 | 发不发 | 出处 |
|---|---|---|
| 🟢 判得可做但本轮没容量 | **不发**(留着下轮重新发现) | Step 3b「唯一正确的沉默」 |
| 判了「此处做不了 / 要人」却一声不吭 | **必须发**(silence 是失败模式) | Step 3b |
| **同一条 disposition 上一轮已发过、本轮判定完全相同** | **不重发**(要更新就 `--edit-last` 原地改) | 本条 + Step 5.7 |
| agent 自发核验完,无动作无新信息 | **不发** | Step 5.7 |
| 人类输入触发 | **必发**(内容走 ratchet) | Step 5.7 适用面 |

第三行是本次新增的那条:🟡 not-verifiable-here / 🔴 security 这类**终态 disposition 只发一次**——
它们本来就是「跳到 unlock 才动」的档位,每轮重贴一遍同样的结论既没有新信息,也不会加快 unlock。

## --dry-run

Do Steps 1–2 and report the candidate list + what each *would* trigger. Make **no**
outward writes (no comments, PRs, labels, closes). For previewing before a real run.
Same `--dry-run` semantics as every loop skill — see the **Dry-run contract** in the
plugin README.

Optional Memory MCP usage: Read [reference/principles.md](reference/principles.md).

## Key principles

The key principles (full text): Read [reference/principles.md](reference/principles.md).

## ★ sweep-trace 埋点（L2 可观测层）

每条本 skill 发出的 AI comment 末尾**必须**附一行 sweep-trace HTML 注释（人不可见、grep 可查、L1 eval 复用为 golden baseline 数据来源）：

```html
<!-- sweep-trace: {"ver":1,"issue":N,"gate":"<gate>","val":"<val>","run":"<ISO8601>","runner":"<runner>","skills":"<hash>"} -->
```

字段：
- `ver`：schema 版本，当前 `1`
- `issue`：对应 issue 编号（数字）
- `gate`：决策闸门名称，取受控词表：`disposition` / `skip`
- `val`：决策值，取 disposition 受控词表：`pr` / `comment` / `close` / `skip` / `research` / `idea` / `feature` / `needs-human-confirm`
- `run`：UTC 时间，`new Date().toISOString()` 格式
- `runner` / `skills`（溯源扩展，v1 兼容可选）：取 `<agent_identity_script>` 输出中的对应段——routine 归属者 + `.claude/skills/` 树版本 hash，用于按版本切分 golden baseline、定位低版本 routine 的产出

**trace 只附在本 skill 实际发出的 comment 末尾；dry-run 模式不发 comment，不附 trace。**
