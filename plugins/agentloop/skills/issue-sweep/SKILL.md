---
name: issue-sweep
description: Sweep open GitHub issues for unprocessed human input and act on each via the issue-review skill — delete-PRs for human-approved deprecated docs, doc-update PRs for approved drifted docs, fix-PRs for approved bugs, analysis+TDD-plan comments for feature/design requests (then implement after confirmation), close issues whose PR merged, comment-only on conditional/security/needs-decision ones. The actionable signal may be a comment OR the issue body. With --autofix-green, also auto-fixes "green" issues that have no human reply yet (unambiguous + verifiable-here + low-risk + non-security) — reproduce→fix→test→PR, never auto-merge. Run manually (/agentloop:issue-sweep) or on a schedule. Designed for a doc-audit + spin-off + feature workflow.
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

> **★ 无人值守铁律(cron routine / /loop——本 skill 的默认运行形态):绝不调用任何会等待用户的工具——`AskUserQuestion`、`Workflow`(需交互式 opt-in 确认)、`EnterPlanMode`(退出需用户批准)。** 无人应答 → 整条 routine 永久挂死(实测:sweep routine 整夜卡在「是否运行 workflow」的提问上)。需要人拍板的问题,照 [`design-review` Autonomous escalation](../design-review/SKILL.md) 范式处理:把选项 + 你的推荐 + 被 block 的内容作为 comment(挂 `needs-human-confirm`)落到对应 issue,**然后继续处理下一项**;编排一律串行 inline(同 [`pr-sweep` Step 3 铁律](../pr-sweep/SKILL.md))。repo hook(`.claude/hooks/deny-interactive-unattended.py`)会在无人值守 session 硬 deny 这三个工具兜底——被 deny 即说明你在无人值守环境,按本条纪律走,不要重试。

> **输出语言与写作规范(中文,信雅达),同 `issue-review`。** 所有面向团队的产出——issue/PR comment、**PR/issue 描述正文**、issue 标题、triage 说明——一律中文;代码标识符、路径、命令、`path:line`、测试输出保持原样。**PR 与 commit 标题必须全英文**——完整 Conventional Commits(`type(scope): english description`,冒号后的描述也用英文),不得留中文;issue 标题保持中文。**不堆砌**:先一句话结论,再最少但足够的证据(文档 / 代码 `path:line` / 真实测试输出,**UI 相关必附截图**);长日志折叠进 `<details>`。

## Usage

```
/agentloop:issue-sweep            # scan all candidate labels, process every unprocessed human reply
/agentloop:issue-sweep --dry-run  # report what WOULD be processed; do not post/PR/close
/agentloop:issue-sweep <label…>   # restrict the candidate set to specific labels
/agentloop:issue-sweep --autofix-green   # ALSO auto-fix "green" issues that have NO human reply yet (Step 3b)
```

Repo is `<repo_slug>`. Use the `gh` CLI when it's available (as the `gh …`
examples below do); if it's absent, use the `mcp__github__*` tools instead
(load them via ToolSearch).

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

## Step 0.5 — 确定性图计算（[`issue-graph`](../issue-graph/SKILL.md)，每轮必跑）

label 扫描之前先跑一次图计算（只读，REST-only，秒级）：

```bash
bun <plugin_root>/skills/issue-graph/scripts/graph-scan.ts --window-hours 2
```

消费它的三个输出：

- **`kicks` → 直接并入候选集，无需人类 comment。** 这是对 Step 2 谓词的结构性补丁：
  子 issue 关闭是状态变化、不产生人类 comment，旧谓词永远看不见「孩子做完了，父该
  收尾 / 兄弟被解锁」。kick 让关闭事件确定性传播。
- **`rollupCandidates`（全部孩子已关的 open 父）→ 走 [`issue-review` ★父级 rollup](../issue-review/SKILL.md)**
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

## Why a windowed "recently updated" scan is NOT enough

The naive scan — "list issues by `UPDATED_AT` desc, take the top N" — **misses
early human replies that were never re-bumped**. Real misses this caused: one
issue whose only human reply came early and was never re-bumped (archetype:
`test/sweep-golden/fixtures/328-early-human-reply-sank.json`), and another
labeled only `P3` — no `doc-audit`/`bug` — so it wasn't even in the label
union. **Scan by label coverage + the unlabeled catch-all + last-comment,
not by an updated-at window.**

## Step 1 — Build the candidate set (by label, not by recency)

`mcp__github__list_issues` with `state: OPEN`, once per label, union the results.
Candidate labels = the **Label Vocabulary** in `.claude/repo-profile.md`
(Priority + Work-type rows; arc: `doc-audit`, `bug`/`P0`-`P3`,
`enhancement`/`feature`, `research`, `idea`). Case-law: a priority-only label
is exactly how a real issue slipped through; `research`/`idea` issues are
often created unlabeled entirely — Step 3 has the
per-work-type dispatch row for each, and the unlabeled catch-all below closes
the discovery hole by triaging and backfilling the label.

De-dup by issue number. Optional args override this default label list.

**Unlabeled / off-label catch-all(每轮必扫——label 并集对它们天然失明):**
founder/人随手开的 issue 常常 **0 label、0 comment**,actionable 信号全在 body。
真实 miss:一条 feature issue(无 label)、一条 research issue(无 label——创建后
2 小时内 hourly sweep 照常跑了,但 label 扫描永远看不见它,只能靠人手工 `/agentloop:issue-review`
点名)。上面 research/idea 行写的「扫到就补 label」在纯 label 扫描下是**循环依赖**
(没 label 就扫不到,扫不到就没人补 label)——这条 catch-all 通道打破它。**别依赖
人打 label**,每轮追加一次全量 open 列表,把「不带任何候选 label」的捞出来:

```bash
# 一次列全部 open issue,本地滤出没有任何候选 label 的。
# doc-audit-kb(KB/repo-map 基础设施 issue,即 kb_issue)不是工作项,一并排除;
# 下一节的 reserved 规则仍然适用——带 agent:hold 的冻结终态动作(人类新评论仍要响应)。
# -R <repo_slug> from repo-profile.md.
gh issue list -R <repo_slug> --state open --limit 500 --json number,title,labels --jq '
  .[] | select(([.labels[].name] | map(select(
    . == "doc-audit" or . == "bug" or . == "P0" or . == "P1" or . == "P2" or . == "P3"
    or . == "enhancement" or . == "feature" or . == "research" or . == "idea"
    or . == "doc-audit-kb")) | length) == 0)
  | "#\(.number) \(.title)"'
```

> 这条命令稳定捞出两位数条对 label 扫描不可见的 open issue,全是 founder 直开的
> 工作项——系统性缺口,不是单条偶发个案(archetype:
> `test/sweep-golden/fixtures/869-research-no-labels.json`)。

对捞出的每条:读 title+body 判 work-type(`调研`/`研究`/`[research]` → `research`;
`idea:`/提案语气 → `idea`;带 spec/验收标准 → `feature`;报错/复现步骤 → `bug`),
**先补上对应 label**(可逆 triage,自动做——这样它下轮起进入正常 label 扫描,且
Step 3 的分派行有了正确的 work-type),再并入本轮候选集走 Step 2/3。**判不出类型
的也不静默跳过**:挂 `needs-human-confirm` + 留一条 triage comment 列出你的猜测让
人一键确认——静默跳过 = 这条 issue 对自动化永久不可见,这正是本通道要消灭的状态。

**Then drop the reserved/locked ones (并发协调,见 [`issue-review` ★并发锁](../issue-review/SKILL.md)):**

- **`agent:hold`** — 人类保留 = **终态冻结,不是处理冻结**("没我反馈别做不可逆动作",不是"别理它")。hold 期间**绝不 close / 绝不代表它做终态处置**,直到人摘掉 label;但**人类新评论照常进 Step 2 候选**——人专门在 hold 的条目上说话,恰是最高优先级输入,必须读并响应(回 comment / 按人类明确要求干活)。无人类新输入的 hold 条目才跳过。
- **`agent:processing`(新鲜)** — 正被另一个 run 处理。每候选读它有没有这个 label;有就查锁龄(见下),**TTL 30min 内 → SKIP**(别人在做),**过期 → 不跳**(上一个 runner 崩了,Step 3 会重新 acquire 抢锁)。锁龄取该 label 最后一次 `labeled` 事件时间:
  ```bash
  gh api --paginate repos/{owner}/{repo}/issues/<N>/timeline \
    --jq '[.[]|select(.event=="labeled" and .label.name=="agent:processing")]|last|.created_at'
  ```
  (无 `gh` 时用 `mcp__github__*` 读 timeline。)`agent:processing` 是 advisory——**硬去重仍靠 Step 4 的确定性分支 + 认领检查**;这一步只是早点短路、省掉重复的读/核验/测试。

## Step 2 — Keep only "last comment = unprocessed human reply"

For each candidate, read comments (`mcp__github__issue_read method:get_comments`).
**Critical detail of this repo:** the AI audit/agent posts under the *same*
account as humans. So
distinguish by **content, not author**:

- A comment is **agent-authored** only if it carries a **machine-emitted marker**: a
  `<!-- sweep-trace: … -->` (every autonomous sweep/review comment MUST carry one — see
  §sweep-trace), **or** the `_Generated by [Claude Code]` footer, **or** its GitHub author is
  a **Bot** (`user.type == "Bot"` — cloud runners post as `claude[bot]` via the GitHub App
  token). Markers can arrive HTML-escaped (`&lt;!-- … --&gt;`, the #1278 double-escape bug) —
  **decode entities before matching**.
- **The `> 🤖 AI Agent` header and the `runner:… · skills@…` identity line are NOT sufficient
  on their own.** `scripts/agent-identity.sh` generates that exact header for **both agents
  and humans**, so a human posting locally (e.g. a design/decision comment from your own
  machine) produces a byte-identical opener. Keying on the header misread **arc#1722**'s
  human Phase-4 directive as an agent verdict and skipped the issue for 19h. So a `> 🤖`
  comment **without** a machine marker is treated as **human** — respond to it. (Pre-convention
  comments predating the sweep-trace mandate also fall here; that is the intended new norm,
  old data is not specially handled.)
- **Exception — the presence board `> 📡` heartbeat**: script-authored WITHOUT a trace, so
  recognize it by its `> 📡` opener and treat it as non-human; otherwise a content check
  reads it as fresh human input and re-processes the board every round (#1361).
- A **human comment** is anything else (including a `> 🤖`-headed comment with no marker).

Keep the issue only if the **last comment is a human comment that the agent has
not yet responded to** (i.e. no later `🤖 AI Agent` comment, no PR-link/close
note answering it). Cheap pre-filter: `doc-audit` issues with `comments == 1`
are AI-audit-only (no human) — skip. But do NOT rely on count alone: human-first
spin-offs have a single human comment and no audit. When in doubt, read.

**The actionable signal can be the issue BODY, not a comment.** A human-authored
**feature / design request** (archetype:
`test/sweep-golden/fixtures/367-body-only-no-labels.json`) often has **zero
comments** — the directive lives in the body itself ("analyze this, discuss
unclear points, then write an executable TDD plan; implement after I confirm").
Treat such an issue as unprocessed when there is **no `🤖 AI Agent` comment yet**.
So the real predicate is: *"the latest human input — last comment, or the body
of a fresh design issue — has no agent response."* Don't require a comment to
exist.

**A non-TERMINAL agent comment does NOT count as "responded" — re-pick it up.** Skip
only when the last agent comment is a **terminal** state with a real unlock condition:
done→PR, closed, or an explicit needs-human/needs-design/security/not-verifiable-here
verdict. **An agent comment that says it deferred its own work — "🟢 排队中 / 本轮未做 /
留开放 / candidate-queued / in-progress" — is UNFINISHED, not terminal → treat the issue as
still to-process and DO it this run** (per Step 3b: 可做即做,不排队;archetype:
`test/sweep-golden/fixtures/533-non-terminal-deferred.json`). This is the fix for the
self-freeze the user hit: a "我会晚点做" comment was making the next sweep skip forever, so a
whole class of doable issues never advanced. Cheap detection — **do these IN ORDER; the
order IS the rule** (a live arc sweep proved that getting it backwards inverts the intent):

1. **Strip fenced/inline code first.** A marker word inside a snippet is not a deferral —
   a live sweep called an issue "deferred" because the YAML key `cancel-in-progress: false`
   inside a code block matched `in-progress`.
2. **TERMINAL WINS.** If the comment carries a real unlock condition (`PR #…` / closed /
   `needs-human-confirm` / `needs-design` / `security-sensitive` / `not-verifiable-here`)
   → terminal → **skip**, even if some other word looks deferral-ish. A live sweep
   re-picked a *terminal security escalation* because its prose ("不在本轮自动修") tripped
   the deferral regex, which used to be evaluated first.
3. Only then: a last agent comment matching `排队中|本轮未做|留开放|不在.{0,8}范围|非单 PR|多.?phase.*(留开放|不在)|candidate-queued|queued|in-progress|稍后|will do|TODO`
   → re-process. Note **`排队中`, not bare `排队`** (bare 排队 matched prose describing
   GitHub Actions queueing), and **no bare `不在本轮`** (it matched the terminal
   `不在本轮自动修`).

The executable form of all three predicates lives in `test/sweep-golden/lib.ts` and is
unit-tested (`golden.test.ts`, incl. each live misclassification above as a regression).
(Going forward the skill no longer emits these; this clause also unsticks the backlog already
frozen by old runs.)

## Step 3 — For each kept issue, run the issue-review engine + act

Hand the issue to `issue-review` (read issue + referenced docs + **verify each
claim against live code/tests**, `path:line` or NOT FOUND). Then act per the
human's latest comment — this is `issue-review`'s resolve phase:

| Human's latest reply | Action |
|---|---|
| Agrees to **delete** a `deprecated` doc-audit ("可以删除"/"同意删除") | **Delete PR**, but **safe-delete only** — `git grep` for live refs first. Live code/test/doc dependency, a still-needed sub-package, a pending third-party confirm, or a blocking precondition → **do NOT delete; leave a comment** explaining the blocker. Relabel `status:*`→`status:deprecated` if needed. |
| Asks to **update** a `drifted` doc ("update 文档"/"补齐发 pr") | First decide **doc-drift vs code-drift** (verify the shipped surface). If doc-drift: edit the doc to match shipped reality, each addition checked against `path:line`. **Doc-update PR**, no code change. If another human is already drafting a PR for the same cluster, **skip to avoid collision**. |
| Approves a **bug fix** ("同意"/"easy fix") | Implement the fix; verify locally where possible (typecheck / targeted test). **One PR per bug.** |
| **Feature / design request**(multi-phase / 架构 / feature) | **评估 → 能做就做,绝不冻结。** 旧的「(1) 只发计划、不写码 →(2) 等 human 确认才执行」是 bug:卡在等确认,而那个确认基本会变成「你先评估试试」,于是永远不动。改为:**(a) 评估(必做)** —— 读 issue + 引用代码,判「本环境能否自主起步」:issue 自带 spec/验收标准 + 代码可触达 = 能起步(绝大多数 feature 属此)。**(b) 能起步就直接跑 pipeline,不等确认**:`/agentloop:design-review` 定/优化方案(精炼计划 post 回 issue;**post 的设计必须 grounded:现状断言 `path:line` 坐实、代码权威优先于文档并指出文档过时、数字实测或显式标注估计——design-review 的事实+数字 grounding 是 HARD GATE,别手 post 未审的设计**)→ `/agentloop:build-phases` 分阶段实现(phase = issue checkbox;每 phase 一 commit + 进度评论;PR 按耦合切——见 design-review/build-phases「Issue-driven plans」)。issue 即 source of truth;**drive 能做的 phase 到完成**;跨 hourly run 的用 **in-progress** 续做(round-aware 接力 phase N→N+1,不重做、不冻结)。**(c) 只有真正 human-only fork 才停**(无法判定的架构 A-vs-B、安全、不可逆),且停时给**评估结论 + 具体待决项 + 你的推荐 + 已完成的 phase**,**绝不写「不在本轮范围 / 留开放」**那种冻结性 disposition。**(d) 撞墙 → 给详细问题**:实现中卡住,贴**具体 blocker(试了什么、什么失败、确切缺哪个决定/信息)**作为 in-progress 续做点,不是含糊的「需人定方向」。Never skip 评估;never freeze。 |
| **Research 请求**(`research` label / `[research]` 标题,如「研究 perkeep 和 did space 的结合点」;actionable 信号常是 **body 本身、0 comment**) | 走 [`issue-review` ★ Research](../issue-review/SKILL.md):**绝不改 repo 代码、不开 PR**。并行 fan-out 两个 subagent 双侧代码级调研(外部 repo shallow clone 到 scratchpad + 本 repo `path:line`)→ 综合成一条证据化 comment(TL;DR 逐条答 issue 问题 + 对照表 + 冲突面 + 结合点分档 ⭐/◐/✗ + 待拍板选项 + 外部链接)→ 挂 `research,needs-human-confirm`。**默认只留 comment + 链接,不下载保存数据**;仅当 issue 明确要求收集数据入库时才在 `research/<task-slug>/` 开目录(走人签名 PR)。**不自动开 spin-off**(research 结论天然 needs-decision);人选定方向后下一轮按选项拆自足 feature issue 或转 `/agentloop:design-review`→`/agentloop:build-phases`。 |
| **Idea 提案**(`idea` label / `idea:` 标题;actionable 信号常是 **body 本身、0 comment**) | 走 [`issue-review` ★ Idea](../issue-review/SKILL.md):**不当指令,当提案——绝不改 repo 代码、不开 PR、不开 spin-off**。理解复述(价值主张分解)→ 对照代码找「地基已有/真实缺口/与现有矛盾」(每条 `path:line`)→ 价值分档 ⭐/◐/✗ → **具体到能拍板的澄清问题** + 下一步选项(不预设)→ 挂 `idea,needs-human-confirm`。信息不足就请人下一轮补 context,多轮收敛;人拍板方向后才拆自足 feature issue 或转 `/agentloop:design-review`。**拿不准「指令还是想法」就按 idea 处理**(clarify 的代价远低于执行错方向)。 |
| PR already **merged** but issue still open | **Close** it (`completed`). `Fixes #N` usually auto-closes; close manually if it didn't. |
| **父级 rollup**（Step 0.5 `rollupCandidates`：open 父 issue 的孩子已全部关闭） | 走 [`issue-review` ★父级 rollup](../issue-review/SKILL.md)：`claim.ts` fencing 抢到才做 → 核对父 issue 验收标准/问题清单（逐条对应到子 issue/PR 证据）→ 综合 comment（带 rollup marker）→ **全覆盖则 close**（这是「自动 close」的显式例外，但 **`agent:hold` 一票否决 close**：hold 禁止一切终态动作，优先级高于本例外——照常综合 comment，但留开等人摘 label），有残留 gap 列出并留开。research/idea 类父 issue 同样综合后 close——结论已在子 issue 落地，父级只是收口。 |
| Conditional / asks a third party to confirm / **security-sensitive** (e.g. P0 security) / needs an A-vs-B decision / "要人类 review 不要完全用 ai" | **Comment only** — surface the finding + the decision needed; do not act. |

Every finding/action carries reproducible evidence (`path:line`, grep hit, real
test output). One verdict/PR-link comment per issue — don't stack duplicates.

## Step 3b — Autonomous autofix (`--autofix-green`): no human reply needed

The default sweep only touches issues with an **unprocessed human reply**. With
`--autofix-green`, *also* consider open issues that have **no human input at all**
— e.g. the auto-generated audit spin-offs — and **fix the ones the
agent can fix end-to-end without a human in the loop**. The whole idea: many small,
unambiguous, *verifiable* gaps don't need a person to approve them — reproduce →
fix → test → PR, one at a time. But the bar for "no human needed" is high, and
**verifiability is the gate**, not cleverness.

### Triage every candidate into 🟢 / 🟡 / 🔴

A 🟢 issue must pass **all four** gates:

1. **Unambiguous** — the fix is determined; no design decision, no A-vs-B, no "should we even do this".
2. **Verifiable in THIS environment** — there is a test or repro you can *actually run* and watch go fail → pass. No runnable proof ⇒ not green. (This is the gate that disqualifies most things — see below.)
3. **Low blast radius** — a leaf fix (one handler, one wire field, a missing test, a polyfill). Not core-architecture, not a cross-cutting contract, not a public API shape.
4. **Not security-sensitive** — crypto, auth, token compare, access control, path-traversal guards stay human even when "obvious".

🟡 = mechanical but **fails gate 2 or 3**: e.g. native Swift/Kotlin code in a sandbox with no Xcode/Android SDK (can't build/test), or a change that touches CI/build config or a broad surface. → write the fix, open a **draft PR** with evidence, label `needs-human-review`, and **say plainly it is not verified here**. Never auto-merge, never claim a green check you didn't run.

🔴 = needs design direction / architecture / security → **comment only** (the existing Step 3 red row). Do not touch code.

### The verifiability gate is environment-dependent (and that's the leverage)

The same issue can be 🟡 in one environment and 🟢 in another. In a **TS-only sandbox**, `bun test`/`tsx` run, so TS-side issues with a conformance/unit test are 🟢 — but every Swift/Kotlin parity issue is 🟡 (can't compile). On a **machine that can build all platforms** (`swift test`, `./gradlew test`, YAML-runner-vs-native-server), those native parity issues move 🟡 → 🟢. So the realistic auto-fix coverage ≈ *the fraction of the backlog you can prove a fix for right here*. State which environment you're in and which gate it opens.

### Env-capability probe (multi-machine claiming)

Multiple machines run this sweep (cloud routine + one or more local checkouts), and they don't all
have the same toolchains — one local Mac may have a full Swift+Android native build/test
environment, a cloud sandbox is typically TS-only. Before claiming a candidate whose verifiability
depends on a toolchain, run `<capability_probe_script>` (probes actual usability, not just
binary presence — e.g. `native-android` checks the SDK dir + `java`, not just `$ANDROID_HOME` being
set, because that env var is commonly unset in a fresh shell even when the SDK is installed) and
compare against the issue's declared requirement, marked in its body as:

```
<!-- requires: native-ios,native-android -->
```

- **Capability present** → proceed normally (🟢/🟡 gates above still apply).
- **Capability declared but missing here** → this is a *this-environment* verifiability gap, not a
  design gap: leave the issue untouched and silent (per the "🟢 candidate, no capacity this round"
  silence rule below) rather than downgrading it to 🟡/`needs-human-review` — a different machine's
  next sweep run may have the capability and should still find it as a fresh candidate.
- **No `requires:` marker** → assume TS-only (the safe default); a human or a prior agent run can
  add the marker retroactively once a capability gap is discovered (as this issue-sweep run just did
  for several native-parity spin-offs it dispatched with a fully-available Swift+Kotlin toolchain).

This is Phase 1 (the probe script + the marker convention). Wiring automatic skip/claim logic into
Step 1/2's candidate loop, and adopting the same convention in `pr-sweep`, is Phase 2 — not yet done.

### The 🟢 pipeline (one issue at a time, serial)

0. **Verify the issue's PREMISE first — this is a hard gate (a real
   false-premise trap; archetype: `test/sweep-golden/fixtures/535-false-premise-trap.json`).**
   AI-authored spin-off issues carry their own evidence (`grep`/`path:line`)
   and a stated framing ("this is dead code" / "pure placeholder" / "3 lines,
   just delete"). **Re-run the issue's own grep AND broaden it** before
   trusting the framing: search for *who else depends on the thing the issue
   wants to change* (snapshot fixtures, importers, callers, generated refs).
   If reality contradicts the premise, **STOP and downgrade to a comment**
   carrying the counter-evidence + safe options, do NOT execute. A false
   premise turns a "🟢 mechanical" task into a regression. The issue author
   (an agent) did not run the broader grep; you must.
1. **Reproduce first.** Write/locate a test that fails *for the reason the issue states*, run it, capture the real failing output. If you can't make it fail on demand, you can't prove a fix — downgrade to 🟡.
2. **Fix** minimally; prefer backward-compatible (`x ?? legacy`) over a swap.
3. **Verify**: the new test passes, the package's full suite shows **no regression**, `check-types` is clean. Paste the real before/after numbers into the PR. **Isolate pre-existing red from your red:** packages here are often already failing (e.g. afs-ui had 88 CSS-snapshot failures; runtimes/node had a pre-existing `auth/index.ts:151` type error). Before attributing a failure to "pre-existing", *prove* it — either `git stash` your change and re-run (count must be identical) or show it's logically untouchable by your diff (a one-line test-mock edit cannot break CSS snapshots). Then say so explicitly in the PR with the real numbers.
4. **One branch + one PR per issue**, body references the issue (`Part of #N`; use `Fixes #N` only if the PR fully closes it — partial fixes leave the issue open and say which part was handled).
5. **Never auto-merge.** 🟢 means auto-*PR*, not auto-*merge* — the `pre-merge` verification gate + a human gate the merge (there is no CI on the PR path). "No human intervention" is about the fix work, not the merge decision. This is a categorical, non-negotiable assertion — see `test/sweep-golden/fixtures/1025-forbidden-auto-merge.json` for the forbidden-action regression test.

### White-list, not black-list

Only auto-touch code for explicitly safe categories: TS/pure-function bug with a test, wire-format/field-name mismatch with a conformance spec, a missing-test addition, a doc/type/lint fix, a dependency-already-in-repo polyfill. Anything outside the list defaults to 🟡/🔴. When unsure, downgrade.

**Proven 🟢 patterns and run history:** see this repo's case-law appendix
(repo-profile Case Law References) for the white-list categories that have actually landed (dead not-found
branch → explicit error, empty `catch{}` in test mocks, env-gate cleanup with
a human directive) and the run-by-run track record.

### AI-agent spin-off issues (`<!-- spinoff-of: #N -->`) — the primary autofix target

The bulk of this backlog is **agent-authored spin-off issues**: their body opens with a `<!-- spinoff-of: #N … -->` HTML comment and follows a fixed shape (目标 / 现状证据 with grep / 参考实现 with `path:line` / 具体任务 / 验收标准). They are almost always **0-comment** (no human ever replied) — so they are invisible to the default sweep and only get picked up under `--autofix-green`. **This class is the whole reason `--autofix-green` exists; process it aggressively but gated.**

Per spin-off issue:

1. **Read the `spinoff-of` parent.** The parent (the original doc-audit) often carries the human directive that makes a child green (e.g. a parent issue that had already said "可以彻底清理"). A human "go" on the parent counts as approval for the unambiguous child.
2. **Run premise-verification (🟢 pipeline step 0).** The issue's own grep is necessary but not sufficient — broaden it.
3. **Triage by environment, then by the four gates.** In a TS-only sandbox the realistic green set is: TS/pure-function fixes, test-file fixes, wire-format/conformance mismatches, doc/type/lint, env-gate cleanups. The rest of the standard backlog clusters stay non-green *here*:
   - **Native parity** (`[parity]`, Swift/Kotlin) → 🟡 (can't build/test in TS sandbox; becomes 🟢 only on a full-platform host).
   - **`security` / `P0,security`** → 🔴 always (crypto/vault/ACL/const-time/path-traversal), comment-only even when "obvious".
   - **Multi-phase feature/arch plans** (`feature`, `enhancement` with Phase N) → 不是单 PR,但**也要尝试自动推进,不是冻结**。走 Step 3 feature 行的「评估 → 能起步就 `/agentloop:design-review` → `/agentloop:build-phases`」管道,**一 issue 一条 in-progress 接力线**:每个 hourly run 推进它能推进的 phase(round-aware 续做),撞到真正 human-only fork 才停并给具体待决项。**绝不发「🟠 不在本轮范围 / 留开放」把它冻死**——那一类正是曾经真实出现过『永不被处理』的根因。`design-review`/`build-phases` 本身就是自动流程,feature issue 该用它们跑,而不是甩回给人。
4. **可做即做,不排队 —— `🟢 candidate-queued` 这个 class 删除(它是自锁死循环的根源)。** 一个 issue 判成 🟢(过四关 + **在本环境可验证**)就**当场认领 + 当场做**:cut 确定性分支 `claude/issue-<N>`(Step 4 的认领检查)→ reproduce→fix→test→PR。disposition = **PR 链接**(终态)。
   - **绝不发"🟢 排队中 / 本轮未做 / 留开放 / candidate-queued"这类注释。** 它是**未完成的活穿了终态的衣服**:下一轮轮次感知看到"最后一条是 AI 评论、人没回",就判"已处理、跳过",这条活**永远不做**。用户实测:大量 issue 被这种注释冻死、只剩一堆"我会晚点做"却再不推进。**判得可做,就此刻做完;不要承诺未来。**
   - **本轮容量不够、没轮到的 🟢:不留任何注释**,保持"未处理"——下一轮自然被重新发现、再认领去做。这是**唯一正确的"沉默"**(没有 AI 注释的 🟢 不会被冻结)。
   - **只有真有外部 unlock 条件的才发"终态 disposition + 跳过"**:🟡 not-verifiable-here(本环境建不了/测不了 → draft PR + `needs-human-review`)、🟠 needs-design、🔴 security-human。这些跳到 unlock(换环境 / 人拍板)才合理。
   - 每条 disposition 写清:class + 具体 blocker + unlock 条件。**"silence 是失败模式"只针对你判了『此处做不了 / 要人』却一声不吭的 issue**(那 31 个无注释的就是这类被漏掉的);对『可做但本轮没轮到』的 🟢,沉默反而是对的——**别用一条注释把它冻死**。Group 同理由的(全 native-parity、全 security)一起写,但每个仍各发一条。

> Run history (first two `--autofix-green` runs, both TS-only sandbox — proof
> that the pipeline works end-to-end): see this repo's case-law appendix
> (repo-profile Case Law References).

## Step 4 — Discipline (non-negotiable)

- **防重复:确定性分支名 + 创建前认领检查(根除多机重复 PR）。** 多台机器并行跑本
  sweep 时,若 branch 名是模型自创的描述性 slug(旧规则 `claude/fix-331-…`),两台机器
  对**同一个 issue** 会算出**不同**分支名 → 不碰撞 → 各开一个 PR → 重复(五条真实
  案例见本 repo 的 case-law 附录,repo-profile Case Law References)。
  修法两条,缺一不可:
  1. **分支名必须确定性、只由 issue 号(+ phase)派生**,不含模型自创 slug:
     `claude/issue-<N>`(单 PR);多 phase 用 `claude/issue-<N>-p<phase>`。两台机器算出
     **同名**分支 → 第二个 `git push` / `gh pr create` 自然碰撞、不再双开。
  2. **开 PR 前先认领检查**——已有开放 PR 指向 #N 就 **SKIP**(别人/别的机器在做):
     认领检查——**把它当一条普通命令跑,然后读输出**;别塞进 shell 变量、别包 `[ … ] && { …; exit 0; }`
     (沙箱 guard 会拒这类命令替换/复合结构,这一步会直接失败——实盘踩过;而且你本来就能读输出):

     ```bash
     gh pr list --state open --json number,headRefName,body --jq '.[] | select((.headRefName|test("(^|[-/])issue-<N>([-/]|$)|-<N>-")) or (.body|test("(Fixes|Part of) #<N>\\b"))) | .number'
     ```

     把 `<N>` 换成 issue 号再跑。**有输出 = 已有开放 PR 指向 #N → SKIP**(别人/别的机器在做);
     **无输出 → 认领,从最新 tip 切确定性分支**:

     ```bash
     git checkout -B claude/issue-<N> origin/<default_branch>
     ```
     **早层 advisory 锁已就位**:`issue-review` 一开工就 acquire `agent:processing`(TTL 30min,见其
     ★并发锁),Step 1 也据此跳过新鲜锁的候选——撞车在"读/核验/测试之前"就短路了。这里的
     **确定性分支 + 认领检查是收尾的硬去重兜底**(锁是 advisory、有残留竞态时它顶上)。两层互补,缺一不可。
  3. **清理由 [`pr-sweep`](../pr-sweep/SKILL.md) 兜底**:已经产生的重复对,sweep 的去重
     关闭步骤会留一个、comment + 关其余。源头修好后这类清理会趋于零。
- **开任何派生/spin-off issue 必须写原生边(图精确性的来源)。** body 首行
  `<!-- spinoff-of: #N -->` 标记之外,**同时**执行
  `bun <plugin_root>/skills/issue-graph/scripts/link.ts --parent <N> --child <新号>`(幂等);
  phase 之间有硬次序的再加 `--issue <后> --blocked-by <前>`。标记是 provenance,
  **原生边才进 Step 0.5 的确定性图计算**——不写边 = 这个 spin-off 对 close-kick /
  rollup 永久不可见,回到"要人 bump"的旧病。
- 一个 issue 一个 PR(确定性分支),`body references the issue（`Part of #N`;完全闭合
  才用 `Fixes #N`,部分修复留 issue 开放并说明处理了哪部分)。不要把无关改动塞一个 PR。
- PR body ends with `Fixes #N` so merge auto-closes the issue.
- **PR body 顶部带标准身份 header**（延伸到 PR 的同一套身份行约定；即 `agent_comment_marker`）：整行由
  `<agent_identity_script> --header "PR"` 生成
  （→ `> 🤖 AI Agent PR @ <hostname> · runner:<runner> · skills@<hash>`），
  不能手拼/占位符。归属、环境、skills 版本从此 PR 本体可溯源，不用翻 comment。
- Commit messages follow **Conventional Commits**. **Never reach for `git commit
  --no-verify` as a default** — the pre-commit hook here is `simple-git-hooks`
  (not husky; this repo has no husky dependency), wired via the root
  `postinstall` script. A hook that fails to spawn (`biome: ENOENT` / the
  command not found at all) almost always means **`<package_manager> install`**
  hasn't run yet in this checkout — **run it (or, if
  that's impractical, `node node_modules/simple-git-hooks/cli.js` to just
  re-link the hook) and retry the real commit** before ever bypassing it. Only
  fall back to `--no-verify` if the hook is confirmed broken *after* install
  (rare), and even then keep changes clean by hand via the `<formatter>` per CLAUDE.md's "别随手
  `--no-verify`" rule — it also skips the formatter, so formatting/lint issues
  silently leak into the PR (there's no CI gate to catch them).
- **Safety before any deletion/edit:** `git grep` confirms no external code
  importers; `<package_manager> --filter <pkg> check-types` (or a
  targeted test) shows no
  *new* errors from the change (pre-existing/unbuilt-dep errors don't count —
  call them out). Adding/removing a dep → update `pnpm-lock.yaml` with
  `pnpm install --lockfile-only`, confirm the diff is scoped, **and `git add`
  it alongside `package.json`** — staging the manifest without the lockfile
  breaks `--frozen-lockfile` everywhere else. Conversely, if you didn't touch
  deps but the lockfile still shows a diff, it's a concurrent/unrelated change
  → don't stage it.
- **Deletion provenance:** content is recoverable via git history; the audit
  comment preserves it. AI **never** auto-merges; humans merge.
- Push: `git push -u origin <branch>`; retry on network error with backoff.
- **★ Verification 强约束(proposing 侧,机制而非纪律):** PR 路径**不再有
  任何 CI**(`ci.yml`/`pr-title.yml` 已删),verification 脚本是唯一 pre-submit 门控。
  - push 前**必须**跑 `<verification_entry>`,硬门控未过
    **不得** push / 开 PR。
  - **开 PR 后用一条命令把「跑 + 贴」焊死**——`--comment` 让脚本自己把报告 upsert 到 PR,
    agent 无法只跑不贴、也无法手改数字:
    ```bash
    <verification_entry> --comment <PR#>
    ```
    (报告 = 状态 + 耗时 + 可折叠完整日志,数字由脚本测出;marker sticky comment,重跑
    只编辑同一条不刷屏。)见 CLAUDE.md「Self-Verification」+
    [`verification` skill](../verification/SKILL.md)。
- **★ 验收点名的集成验证不可预先开脱:** 当 issue 的验收标准 / human **点名** `/e2e-verify`
  等集成验证(blocklet render / mount / serve),proposing 侧**必须真跑**——`<cli_binary>`
  CLI 缺失/陈旧就先 `/setup-local-cli`,**不得**以「需要 daemon / 本环境无法执行」开脱,**也不得**拿 `pre-pr.ts` 的 unit
  test 顶替点名的 e2e。缺依赖 = 多一步 setup(编译原生插件、link CLI),只有实际撞上硬工具链缺失(无
  Xcode/Android SDK/Playwright)才算跑不动,且贴**确切报错** + 标注跳过层。见 [`e2e-verify` skill](../../../../skills/e2e-verify/SKILL.md)。
- **★ UI 改动的截图左移(proposing 侧生图,不留给 review 侧):** diff 命中
  **UI Face Paths**(`.claude/repo-profile.md`;arc: `blocklets/**` |
  `providers/runtime/ui/**` | `packages/aup/**`)时,**开 PR 前必须生成
  UI 运行截图**——renderer/widget 级用 `<ui_shot_script>`(真实 shipped
  bundle 渲染 fixture;参数矩阵 / 前后对比 / 状态序列三型按需多幅),
  页面级流程用 [`/ui-verify`](../../../../skills/ui-verify/SKILL.md)。三个硬要求:
  1. **先自查再提**:生成后用 vision 看图过 ui-shot README 的 checklist(裸样式 =
     css.ts 没配套、hover/点击前后两幅无变化 = 交互失效、Unknown 降级框 = 类型没注册、
     布局叠压)——任何一条命中先修再提。单测全绿看不出这些,别把它们留给 reviewer 或人。
  2. **截图内嵌进 PR body**(`<ui_upload_script>` 上传,
     `ASSET_CONTEXT=pr{N}`;开分支阶段还没有 PR 号就先用 `issue-{N}`),开 PR 时就带图,
     不是事后 comment。脚本自带两道硬自检:**exit 3** = 脚本与
     `origin/<default_branch>` 不一致(陈旧 checkout——曾经破图的真实根因)→
     `git checkout origin/<default_branch> -- <ui_upload_script>`
     后重跑;**exit 4** = raw URL 匿名不可达 → 禁止内嵌。内嵌前的通用验收:URL 必须
     **无凭据 curl 200**(camo 视角;脚本路径已内置,MCP 路径手动验)。
  3. **同一组截图回贴关联 issue**(一条简短 comment:图 + 一句话说明),让人在 issue
     里一目了然,不必点进 PR。
- **PR 继承来源 issue 的 milestone(+ labels/assignee 的 provenance)。** 开 PR 后立刻把
  issue 的 milestone 复制到 PR——否则 PR 不进 release/批次的里程碑视图,看板就漏了它。
  milestone 命名/归类约定见 **Milestone Conventions**（`.claude/repo-profile.md`）。
  ```bash
  ms=$(gh issue view <N> --json milestone --jq '.milestone.title // empty')
  [ -n "$ms" ] && gh pr edit <PR#> --milestone "$ms"
  ```
  对**每一个**由 issue 派生的 PR 都做(fix / doc-update / delete / feature-phase PR 一视同仁)。
  issue 无 milestone 就跳过(别瞎设)。
- **PR 的 assignee/reviewer 继承来源 issue 的人。** 开 PR 后把来源 issue 的 **author +
  assignees**(去重)设为 PR 的 assignee——他们是这件事的知情人和责任人,PR 出现在他们的
  待办里才不会漏。**需要 human review 的 PR**(🔴 高风险 / security / A-vs-B 待拍板 /
  🟡 draft `needs-human-review`)**同时把这些人设为 reviewer**;判断**不需要人确认**的
  (🟢 机械修复、低风险档,pr-sweep 闸内可自动合)可不指定 reviewer,免得制造无意义的
  review 请求。
  ```bash
  people=$(gh issue view <N> --json author,assignees \
    --jq '([.author.login] + [.assignees[].login]) | unique | join(",")')
  [ -n "$people" ] && gh pr edit <PR#> --add-assignee "$people"
  # 仅当 PR 需要 human review 时:
  gh pr edit <PR#> --add-reviewer "$people"
  ```
  指派失败(reviewer 恰是 PR 作者本人 / bot / 非协作者)就跳过并记一句,别 block——
  与 issue-review 的 assignee 纪律一致。

## Step 5 — Be quiet when there's nothing

If no issue has an unprocessed human reply this round: **post nothing, open no
PR, message nothing.** A no-op sweep is silent. Only speak when you acted.

## --dry-run

Do Steps 1–2 and report the candidate list + what each *would* trigger. Make **no**
outward writes (no comments, PRs, labels, closes). For previewing before a real run.
Same `--dry-run` semantics as every loop skill — see the **Dry-run contract** in the
plugin README.

## Memory MCP（可选，当已配置时）

如果运行环境的 MCP 工具列表包含 AFS 命名空间（`afs_read` / `afs_write` / `afs_search`，来自已连接的 ARC instance MCP 端点），在每轮 sweep 的 Step 0（sync `<default_branch>` 之后）增加两步：

**Scan 前 recall（与读取 issue 列表并行）：**
```
afs_search /user/memory 关键词:<本轮重点 label / 子系统 / 常见问题域>
```
返回的 observations / patterns / principles 补充进 sweep 的初始上下文（「已知约束/规律快速热启」）。

**每条 issue 处理完毕后 store（追加）：** 跨 issue 有价值的发现（同类 bug 根因、代码隐藏约束、团队决策）写入 memory。粒度三层：
- `observation`：具体事实 + `path:line`
- `pattern`：跨 issue 归纳出的规律
- `principle`：推断出的工作原则

路径：`afs_write /user/memory/<memory_namespace>/<namespace>/<id>`;caller 身份隔离，loop agent 间互不干扰。

**未配置 MCP = 本节跳过**，sweep 其余行为完全不变。

## Key principles

0. **Sync `<default_branch>` before anything** (Step 0). Safety greps, type checks, and
   branch-offs are only trustworthy against the latest tree; a stale clone
   silently invalidates them.
1. **Scan by label + last-comment, never by an updated-at window** — that window
   is exactly what dropped issues with early, never-re-bumped human replies or
   priority-only labels before.
2. **Human vs AI is by content (`🤖 AI Agent` marker present near the top, not
   necessarily the literal first line — see Step 2), not author** — both post
   under the same account here.
3. **`issue-review` does the per-issue work; this skill only decides what to feed
   it and enforces the resolve-action + discipline rules.**
4. **Safe-delete only; comment on what can't be cleanly/safely done** — live deps,
   pending third-party confirm, security, A/B decisions stay human.
5. **两层并发协调:advisory 锁(早)+ 确定性分支(硬,兜底)。** (a) `agent:hold` = 人类保留 =
   **终态冻结**(绝不 close/终态处置,只人摘;但人类新评论仍要响应);`agent:processing` = 处理中互斥锁(TTL 30min),
   Step 1 跳过新鲜锁的候选,`issue-review` 开工 acquire、收尾 release——把撞车提前到读/核验/测试之前。
   (b) **确定性分支 `claude/issue-<N>` + 开 PR 前认领检查 + 一 issue 一 PR + `Fixes #N` + never
   auto-merge** 是收尾硬去重:描述性 slug 分支名是多机重复 PR 的根因,必须只由 issue 号派生、创建前
   查重 SKIP。锁是 advisory(有残留竞态),分支claim 顶上;残留重复由 `pr-sweep` 去重关闭兜底。
6. **Silent no-op when nothing is pending.**
6b. **图计算决定候选与传播,LLM 只负责做。** 每轮 Step 0.5 跑
   `graph-scan`:kicks/rollupCandidates 注入候选(无需人类 comment),blocked 确定性
   SKIP;开 spin-off 必写原生边(`link.ts`);无分支兜底的终态动作(rollup)用
   `claim.ts` fencing 互斥。图只增强、不替代 label 扫描。
7. **`--autofix-green`: verifiability is the gate, never auto-merge.** Auto-fix
   only issues that pass all four gates (unambiguous + verifiable-in-this-env +
   low-blast-radius + non-security); reproduce-first, one PR per issue, white-list
   categories only. Can't run a test that proves it here → 🟡 draft PR + human, not
   green. The set of 🟢 issues grows with the environment (TS-only vs full-platform
   build). 🟢 = auto-PR, **not** auto-merge — the `pre-merge` verification gate + a human still gate the merge (no CI on the PR path).
8. **Autonomous = ask on the issue, never block in-session.** This sweep runs
   unattended — no human is babysitting. Any time the per-issue work (including
   `design-review` / `build-phases` escalations) would normally stop and wait for
   a human answer, **post the question as a comment on that issue** (options +
   recommendation + what's blocked) and move on; don't sit on a blocking inline
   prompt. The human answers async on the issue and the next sweep resumes it.

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
