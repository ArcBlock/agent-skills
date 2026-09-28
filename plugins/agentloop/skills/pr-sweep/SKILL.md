---
name: pr-sweep
description: >-
  Batch-review all open PRs to a terminal state: clean-context pr-review per PR, dedup-close
  same-issue twins, gated auto-merge of verified non-breaking PRs; escalate only security,
  breaking or direction calls. Flags: --merge, --dry-run. Built for scheduled unattended runs.
---

# PR Sweep — batch-review + dedup-close + gated auto-merge

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> **arc is the reference implementation.** Use the profile's values wherever this doc shows an
> arc default: `repo_slug` (the `gh -R` target), `gate_mode` (arc = `scripts`: no CI on PRs,
> so `gh pr checks` is empty and the same-SHA `verification_entry` report + `merge_gate_entry` are the gate; `ci`/`both`
> repos ALSO require `gh pr checks` green), `verification_entry` / `merge_gate_entry` (`pre_merge_entry` is not part of the PR loop).
> Arc's own provenance for the lessons below is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

A **batch driver** over [`pr-review`](../pr-review/SKILL.md). `pr-review` handles
ONE PR (read → verify against code → read the verification fact → detect conflicts → verdict).
`pr-sweep` runs that engine across **all open PRs**, then does the two things a
single-PR engine can't: **resolve cross-PR duplicate/conflict clusters** (keep
one, comment + close the rest) and **gated auto-merge** the clean ones.

This is the thing a cron schedules: one run = sync + review-all + dedup-close +
(optionally) merge. It is the PR-world twin of [`issue-sweep`](../issue-sweep/SKILL.md);
together they let an independent machine keep both issues and PRs moving with no
human in the loop — escalating only the genuinely human-only decisions.

> **输出语言按 profile `comment_language`。** 所有面向团队的产出——verdict comment、去重/关闭说明、升级给人的「需人确认块」、
> 本 sweep 自己开的 PR(verification-fix 等)的**描述正文**——按 body 语言写;代码标识符、路径、
> 命令、`path:line`、`gh` 输出保持原样。**PR 与 commit 标题**按 `comment_language` 的标题语言部分,
> 不得混用。
> **不堆砌**:先一句话结论,再最少但足够的证据(文档 / 代码 `path:line` / 真实测试输出,**UI 相关
> 必附截图**——ui-verify 的截图/录屏就是这类证据);长日志折叠进 `<details>`。

> **目标(为什么存在):** 让"定时机器"把 PR 从开放推进到终态——review、去重、合并——
> **尽量不需要人 review**。PR 上已无 CI,门控是同 SHA 的 verification
> 报告 + merge gate;失败看根因,门控/脚本坏了就修脚本。人只在不可逆的高风险拍板点介入。

## Usage

```
/agentloop:pr-sweep              # 全量 review + 评论 + 去重关闭(不自动 merge)
/agentloop:pr-sweep --merge      # 以上 + 对通过「合并闸」的低风险 PR 自动 merge
/agentloop:pr-sweep --dry-run    # 只报告 WOULD-DO,不发 comment / 不关 / 不合
/agentloop:pr-sweep <pr#…>       # 限定到指定 PR
```

`--dry-run` 语义与所有 loop skill 一致 —— 见插件 README 的 **Dry-run contract**。

Repo 是 `<repo_slug>`。本地有 `gh` CLI 时直接用;无则用 `mcp__github__*`,ToolSearch 加载。

## Step 0 — 先 sync 本地 `<default_branch>`(不可跳过)

下游一切——`git grep` 安全检查、`check-types`、`gh pr diff` 对照、每个 rebase——都必须跑在**最新
`<default_branch>`**(全篇「main」指 `<default_branch>`;部分仓库用 `master`)上,不是容器碰巧
clone 的陈旧树。上一轮 sweep 可能已 merge 了 PR、移动了 `<default_branch>`。

当作**朴素命令**逐条跑、读结果——**你就是控制流**,别包成 shell 循环/条件/`$(…)`(沙箱的
Bash guard 会拒,这一步会在 sweep 开始前就硬失败——实盘踩过)。

```bash
git fetch origin <default_branch>   # 偶发失败就再跑一次(你自己就是重试循环)
git reset --hard origin/<default_branch>
git log --oneline -1                # 确认在真正的 tip
```

**别用 `git checkout <default_branch>`**:在 git worktree(如 fleet checkout)里该分支被
主 worktree 占着,checkout 必失败;上面的 fetch + reset 在分支上或 detached 都能用。
工作树有上一轮残留 → `git reset --hard` + `git clean -fd`。一次 sweep 从干净、最新的树开始。

## Step 1 — 枚举所有开放 PR + 元数据

```bash
gh pr list --state open --limit 100 \
  --json number,title,author,headRefName,baseRefName,mergeable,files,labels,body,createdAt,updatedAt,isDraft
```
> **`updatedAt` 不是可选字段**——Step 1.5 的**冻结集**完全靠它判定,而且靠的就是**这一次**调用
> 的结果(整个机制的意义就是不为「要不要跳过」再花 per-PR 的 API)。漏掉它,冻结集要么失效、
> 要么退化成每个 PR 多三次调用,那正是它要消灭的开销。
> 门控形态由 profile `gate_mode` 决定:arc = `scripts`(删了 `ci.yml`/`pr-title.yml`,`gh pr checks` 恒为空,同 SHA 的 `<verification_entry>` 报告是唯一门控信号);`ci`/`both` 的 repo 还要 `gh pr checks` 绿——
> 门控信号来自 PR 上同 SHA 的 verification 报告(Step 3 读、Step 5 由 merge gate 核),不再从 status check 读红绿。

## Step 1.5 — 轮次感知:只处理"有新输入/新可执行"的 PR(定时 routine 的命脉)

**Order is the rule.** (1) Drop `epic-managed` PRs entirely (the conductor owns them: no review, comment, dedup-close or merge). (2) Compute the **freeze set** from Step 1's single `gh pr list` result (`updatedAt`, no extra requests) and drop frozen long-idle `awaiting-*` PRs before anything else costs an API call; a PR frozen longer than `pr_sweep_stale_escalation_days` (default 30) is named in the run report `summary`, never nagged on the PR. (3) `agent:hold` = terminal freeze, not a processing freeze: never merge / close / remove the label; a new human comment or commit is still reviewed and answered (verdict `MERGE (held)`).

**needsReview** (start an agent) when any holds: never reviewed; head sha ≠ the last verdict's sweep-trace `sha` (timestamp fallback for old traces); a **human** comment after the last agent comment on **any of the three surfaces** (conversation, inline `pulls/<n>/comments`, `pulls/<n>/reviews`); a bot-review connector comment after it; a Draft→Ready event after it. Agent comment = carries a **machine marker** (sweep-trace / `Generated by [Claude Code]` footer / Bot author), never the `> 🤖` header. Mechanically regenerated PRs (release-please shape) already `awaiting-*` / held: a new commit alone is not a trigger.

Otherwise: `awaiting-*` → 0 actions; `blocked-deps` → only the cheap Step 5 gate re-check.

**Disposition labels** (controlled set, refreshed after every review; never re-post an unchanged conclusion): `pr-sweep:needs-fix` (a known fix route → the agent fixes; **at most 3 consecutive repair rounds**, counted by `<!-- pr-sweep-attempt: N -->` in the verdict; round 3 still red → `awaiting-direction` with a per-round summary) · `pr-sweep:awaiting-glance` (all verified, a human confirms) · `pr-sweep:awaiting-direction` (a high-level A/B) · `pr-sweep:awaiting-judgment` (an uncertain risk, stated concretely) · `pr-sweep:awaiting-caution` (security / breaking / irreversible / gate semantics) · `pr-sweep:blocked-deps`. Never add the retired `pr-sweep:awaiting-human`. **A change request is not a merge approval**: implement it, post evidence + one `<verification_entry> --comment <n>`, set `awaiting-glance`, and wait for explicit approval words.

**One agent comment per PR**: every sweep comment (verdict or disposition) is a marker-located upsert ([`pr-review`](../pr-review/SKILL.md) Step 6); before posting, re-fetch and skip if the same `gate`+`val`+`sha` trace already exists. Only needsReview PRs go on to Step 2/3.

The full text (the needsReview script, the label table, the repair-round format, the freeze-set criterion and its incident): Read [reference/round-awareness.md](reference/round-awareness.md).

## Step 2 — 聚类(去重 + 冲突的基础)

**两把主键,先算簇,再 review——这样每个 review agent 能带着"它的 peer 是谁"上下文。**

1. **同 issue 簇**(去重关闭的主战场)。从 `headRefName` 抽 issue 号(`claude/<verb>-<N>-<slug>` → `<N>`),并从 body 抽 `Fixes #N` / `Part of #N`。**同一个 `<N>` 的多个开放 PR = 重复嫌疑簇。**
   ```bash
   gh pr list --state open --json number,headRefName,body --jq '
     .[] | {n:.number, br:.headRefName,
	     issue:(.headRefName|capture("-(?<i>[0-9]+)-")?.i
		    // (.body|capture("(?:Fixes|Part of) #(?<i>[0-9]+)")?.i))}' \
   | python3 -c "import json,sys,collections; \
       d=[json.loads(l) for l in sys.stdin]; \
       m=collections.defaultdict(list); [m[x['issue']].append(x['n']) for x in d if x['issue']]; \
       [print('issue #%s -> PRs %s'%(k,v)) for k,v in m.items() if len(v)>1]"
   ```
2. **同文件簇**(行级冲突 / 共享配置风险)。算 `file -> [PRs]` 倒排,>1 的即重叠。**排除噪音**:release-please 自动 PR 会触碰每个 `package.json` + `CHANGELOG.md`,这类全局重叠不算冲突,单独识别 release 簇。

把每个 PR 的 peer 列表喂给它的 review agent(Step 3)。

## Step 3 — 扇出 pr-review(clean context,每 PR 一个)

每个开放 PR 交给 [`pr-review`](../pr-review/SKILL.md) 引擎,**干净上下文、独立判断**,带上它的 peer 簇信息。返回**结构化 verdict**(5 类 + verification 结果 + 冲突结论 + 证据 + 问题件的 comment 草稿)。每个 pr-review **读** PR 上同 SHA 的 verification 事实并纳入 verdict(PR 上已无 CI),**reviewer 不跑闸**(pr-review Step 3)。缺事实的 PR 由 sweep 自己(它是这些 PR 的推进者)跑 `<verification_entry> --comment <n>`——**同一时间最多 2 个重闸**(`<verification_entry>` / e2e-gate / ui-verify / 全量 build/test 都算;无人值守是串行,天然满足;交互式扇出时由主控发闸位)。闸位按正在跑的闸计数,不看 `load1`。同一 SHA 已有 PASS 时用 `--deliver-cached --comment`,不要再执行。不跑 `pre-merge`:它和 pre-pr 贴同一个 marker,一次 FAIL 会覆盖有效的 PASS,重型覆盖归仓库的 main 捕网。独立代码审查、diff 核验和 verdict 绝不因读证据而跳过。

> **UI 改动的 PR:** pr-review 的 Step 3.5 核对 PR body 里的作者截图(命中 profile **UI Face Paths** 时);缺图是 `COMMENT` 级关注点,**arc 上不是合并闸**(merge-gate 的 ui-verify 门自 #7025 起 advisory,L1 捕网的 `uiShotSmoke` 负责)。只有 profile 把 `ui-verify` 列进 `additional_merge_gates` 的仓库,才需要 sticky 证据和下面的 `ui-verify:pending` 补跑闭环(#1205)。

### Step 2.5 — `ui-verify:pending` 补跑扫描(仅当 profile `additional_merge_gates` 含 `ui-verify`,且本 routine 有 daemon 时)

Only when the profile's `additional_merge_gates` contains `ui-verify` and this routine has a daemon: Read [reference/ops.md](reference/ops.md).

## Step 4 — 去重关闭(dedup-close):同 issue 重复对,留一个、关其余

Same-issue cluster with ≥2 open PRs: (1) pick the keeper (more complete > more correct against the authoritative source > has tests > newer base > first); (1.5) a **second, independent fresh-context agent** picks too, returning `{keep, reason}` — disagree → close nothing this round, `pr-sweep:awaiting-direction` on each; (2) contradicting assertions → check the authoritative source first; (3) close each twin with an identity-headed comment pointing at the keeper; (4) note the closed twins on the keeper. Any PR in the cluster with `agent:hold` takes no part. Unsure → keep both, `COMMENT`.

Commands and rationale: Read [reference/ops.md](reference/ops.md).

## Step 5 — 合并闸(`--merge` 时):分风险档自动合,高风险升级给人

Every `MERGE` / mergeable-`COMMENT` verdict passes **all** of these, re-checked on every merge attempt:

- **Verification gate (the merge gate; replaces CI)** — `<merge_gate_entry>` reads the same-SHA `<verification_entry> --comment` sticky (sha = current HEAD, result PASS/NA) and the merge-load door against the **current** main tip; no separate `pre-merge`, even when main moved.
  ```bash
  # --cs-head is the 40-char PR/CS head, must be current HEAD.
  <merge_gate_entry> --cs-head <40-char-sha> <pr#>
  ```
  **只在合并这一步、紧接着 `merge-verified-pr.sh` 之前跑**(after every other gate, same machine, same head): its exit 0 writes the verdict record `merge-verified-pr.sh` treats as the merge authorization. Step 3 reviewers only read the sticky and `bot-clean.ts`, never `<merge_gate_entry>`. `verification fact is not current` → run the printed hint `<verification_entry> --comment <pr#>` (one gate slot), then the merge gate again. **绝不**为了「刷新」去跑 `<pre_merge_entry> --comment` (same marker: a FAIL would overwrite a valid PASS). Advisory gates (e2e-gate / ui-verify / native-verify, `⚠ advisory` lines) are read, never rerun, and block only when listed in the profile's `additional_merge_gates`.
- **Human review gate** — re-fetch `pulls/<n>/reviews` independently; any human reviewer's latest `CHANGES_REQUESTED` not superseded by their `APPROVED` → hard stop (bots are not this gate).
- **Bot / inline-review check (once, never parked)** — protocol: [`reference/review-receipt-protocol.md`](../../reference/review-receipt-protocol.md). **合并前跑一次** pr-review 的 `bot-clean.ts`; one short wait (≤10 min) only if the last push is under 10 minutes old and a vendor is `running` / `incomplete` / `stale` / `absent`. An open P1/High → `pr-sweep:needs-fix` (fold into one fix batch, one push, one `<verification_entry> --comment <pr#>`) or an in-thread REJECT. **Every** actionable inline thread needs its same-thread conclusion before merge (fixed with SHA / REJECT with reason / P2-Medium-Low-only defer with tracking); late findings after merge → [`codex-review-backlog`](../codex-review-backlog/SKILL.md).
- No `agent:hold`; a PR with a human change request merges only after explicit approval words; verdict is `MERGE` or non-blocking `COMMENT`; claims verified; `mergeable == MERGEABLE` (rebase **only** on `CONFLICTING` or a red already fixed on main — merge-load covers "behind"); no unresolved same-issue/same-file conflict.
- UI evidence and backend data-plane gates are **advisory** in arc (L1 catch-net owns them) unless listed in `additional_merge_gates`.

Any FAIL blocks: a defect of this PR is fixed; a red that is not this PR's has exactly two exits — bisect to the root cause, or run `<verification_entry> --comment <pr#> --blocked-by <open issue#>` and let the gate attribute it. **不盲目重跑、不调超时洗绿**; the only exception is `TIMEOUT` with `failed=0`: one re-run with the raise-only timeout knob, value stated. Heavy gates: 同一台机器最多 2 个,按正在跑的闸计数,不看 `load1`。

**Risk tier, recomputed before every merge attempt:** 🟢 docs / tests / comments / release PRs → auto squash-merge; 🟡 bug fixes with tests, non-breaking features, additive protocol → auto-merge when every precondition holds, any reservation → comment; 🔴 security surface, breaking change (incompatible wire / schema without migration / removed public API / destructive data op), undecided architecture, human objection, gate-semantics change → **never auto-merge**: `pr-sweep:awaiting-caution` or `awaiting-direction` with pr-review's human-confirm block, and the source issue's author + assignees set as the PR's reviewers (assignment failure is skipped, never blocks). Before choosing 🔴, ask whether a safe default action exists — if yes, do it (ratchet).

```bash
bash "$AGENTLOOP_ROOT/scripts/merge-verified-pr.sh" <n> --method squash
```

| Failure | Action |
|---|---|
| verification stale (pushed, not re-verified) | `<verification_entry> --comment <n>` → `<merge_gate_entry> --cs-head <40-char-sha> <n>` |
| `CONFLICTING`, or a red already fixed on main | `gh pr update-branch <n> --rebase`, then one `<verification_entry> --comment <n>` |

Small fixes are done on the PR branch by the sweep itself (never an "action item" for a human); a PR is the work unit — the sweep drives it to a terminal state; triggers are state-based, not "who commented last".

The full gate text, the risk-tier table, the breaking-change criteria, the failure table and the self-fix discipline: Read [reference/merge-gate.md](reference/merge-gate.md).

## Step 6 — verification 门控自愈(门控坏了就修门控,不让每个 PR 陪绑)

A broken or over-strict gate is fixed in the gate script (its own PR), not worked around per PR.

How: Read [reference/ops.md](reference/ops.md).

## 限速 / 编排 / 幂等(批量必守)

1. Fan out ~10–14 reviews per round, API ~250–300 POST/h. 2. **并发**:重闸(`<verification_entry>` / advisory 门 / 全量 build/test)同一台机器最多 2 个,按正在跑的闸计数,不看 `load1`. 3. Idempotent: labels + upserted comments, never a duplicate post.

Detail: Read [reference/ops.md](reference/ops.md).

Preventing duplicate PRs at the source (issue-sweep's deterministic branch + claim check): Read [reference/ops.md](reference/ops.md).

Field notes from the first runs: Read [reference/ops.md](reference/ops.md).

## Key Principles

1. Review is independent (clean context per PR). 2. verification 门控是信号不是判官:任何 FAIL 都挡合并;不是本 PR 的红只能二分根治或 `--blocked-by` 由闸自己判定,不盲目重跑、不调超时洗绿. 3. Evidence over assertion. 4. Humans decide only security / breaking / direction. 5. Never merge with `agent:hold`.

Full principles: Read [reference/ops.md](reference/ops.md).

## ★ sweep-trace 埋点（L2 可观测层）

每条本 skill 发出的 AI comment 末尾**必须**附一行 sweep-trace HTML 注释（人不可见、grep 可查、L1 eval 复用为 golden baseline 数据来源）：

```html
<!-- sweep-trace: {"ver":1,"pr":N,"gate":"<gate>","val":"<val>","sha":"<head-oid>","run":"<ISO8601>"} -->
```

字段：
- `ver`：schema 版本，当前 `1`
- `pr`：对应 PR 编号（数字）
- `gate`：决策闸门名称，取受控词表：`needsReview` / `disposition`。
  **★ 标错 gate 会让去重静默失效**——下一轮查的是 `gate:"verdict"`（[pr-review](../pr-review/SKILL.md) 文末），
  一条 verdict comment 若标成 `needsReview`（实盘见过），那次 verdict 就查不到，
  下一轮当作「没 verdict」走首轮全量流程、再发一条。**判据只有一句：这条 comment 承载的是不是
  「本 PR 该怎么处置」的结论**——是 → `gate:"verdict"`（由 pr-review 发）；只是 sweep 自己的
  分流/打标记录 → `gate:"disposition"`。拿不准就按 `verdict` 标（宁可多去重，不可漏去重）。
- `sha`：本判定针对的 PR HEAD（40 位 commit oid）——跨 runner 新鲜度判定的机器键（Step 1.5 sha 优先规则；旧 trace 无此字段视为 stale）
- `val`：决策值，取对应受控词表：
  - `needsReview` gate：`true` / `false`
  - `disposition` gate：`pr-sweep:needs-fix` / `pr-sweep:awaiting-glance` / `pr-sweep:awaiting-direction` / `pr-sweep:awaiting-judgment` / `pr-sweep:awaiting-caution` / `pr-sweep:blocked-deps` / `merged` / `closed`（`pr-sweep:awaiting-human` 仅历史 trace 中存在,已弃用）
- `run`：UTC 时间，`new Date().toISOString()` 格式

**trace 只附在本 skill 实际发出的 verdict comment 末尾；dry-run 模式不发 comment，不附 trace。**
