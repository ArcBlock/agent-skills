---
name: epic-conductor
description: >-
  Attended end-to-end implementation of a whole epic: decompose into sub-issues, one isolated
  worker each, independent review before the gate, one batched fix, one gate (≤2 heavy at once),
  bot-clean once, merge-gate, merge, next wave. Use to build an epic with a reachable human.
allowed-tools: Agent, Bash, Read, Grep, Glob, Edit, Write, Task, AskUserQuestion, Skill
---

# epic-conductor — drive a whole epic to merged, autonomously

> **Repo profile — read `.claude/repo-profile.md` first.** Gate commands (`verification_entry`, `merge_gate_entry`, `additional_merge_gates`) and the identity script come from that profile. Arc paths below are examples.

You are the **conductor**. You decompose, dispatch, review-route, gate, and merge. You do not write the feature code. You stay for the whole epic.

Hired factory/worker children still `status=running` (pid alive) make it **forbidden** to `end_turn` / close the session. Allowed: true closeout after each hire has GitHub evidence (PR URL or skip-comment) **or** the child was explicitly `stop`ped. Watch pid + `runs/*.json` + cwd, not `lastTurn` alone. Before treating yourself as done:
```bash
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/skills/epic-conductor/scripts/assert-no-live-children.ts" \
  --runs-dir "$(arc service status --print home 2>/dev/null || printf '%s' "$HOME")/.afs/code-agents/runs" \
  --ids <hired-id>,<hired-id>
```
Exit 0 only when none of those ids are live. Ghost `status=running` with a dead pid does not block (recover-territory). Factory cockpit rows are `pid=-1`; the watchdog must fail-closed on them (live, not ghost).

Live workers are that watchdog. A PR of yours still blocked on someone else's red is §9.

## When this skill applies

USE IT when a reachable human hands you an epic (or decomposable multi-issue work) to build end-to-end. They stay reachable for high-level calls ("safe default + object-if-wrong"), not per-step approval.

Do NOT use it for: one issue or one PR (plain worker or `build-phases`); an unattended batch (`issue-sweep` / `pr-sweep`); no human reachable (sweeps' `needs-human-confirm`). Each sub-issue gets its own worker, reviewer, fix loop, and merge.

## Neighboring skills

Altitude: **design-review** (a plan; `--max-rounds 2`, skip when the human recorded the decisions) → **epic-conductor** → { plain worker | **build-phases** } → **pr-review** (the §3.5 / §4 engine). No reachable human → do not run conductor.

Why each neighbour stays: Read [reference/background.md](reference/background.md).

## Load-bearing idea

Independent clean-context review is the point. Enforce **the accept-path iron law**: any check that rejects bad input also has a test that admits good input.

The full argument: Read [reference/background.md](reference/background.md).

## Orchestration invariants

- **Resident, serial-inline.** React to completions. Do not nest a Workflow. No plan mode; decisions live in issue/PR comments.
- **No `end_turn` with live hired children.** `status=running` and pid alive → stay (script above). A ghost dead pid is not live.
- **Workers ~3; at most 2 heavy gates** on this machine. Heavy = `<verification_entry>`, `<pre_merge_entry>`, a daily run, an advisory gate, or a full suite. No slot while two known gates are already running. Count running gate processes, not `load1`. `ARC_GATE_LANE` stays unset. Gates you did not start count when visible.
- **Model.** Runtime / gates / security / data-model → opus. Docs / mechanical / small blocklet → sonnet.
- **Worktree** (`isolation: "worktree"`). **Workers do not merge.**

When scheduling a slot or picking a model, read [reference/orchestration.md](reference/orchestration.md).

### Identity (work DID)

Dispatch by **work DID**. Issue/PR numbers are a projection (`sourceUrl`), not identity. Do not start at `gh issue view`:

```bash
arc --json afs exec /.actions/query --args '{"path":"/work","where":{"field":"meta.objectId","eq":"<DID>"},"limit":8}'
```

A Change Set is `workType=change-set` and `meta.head` is a 40-char sha. Merge-gate keys off that head. `merge-gate.ts <PR#>` without `--cs-head` is forbidden:

```bash
bun .claude/verify/merge-gate.ts --cs-head <40-char-sha> <PR#>
# --cs-head is the 40-char PR/CS head, must be current HEAD.
# Only the merger runs this, immediately before merge-verified-pr.sh (§7) — its exit 0 writes the
# verdict record that authorizes the merge, so it is never a "read" for reviewers.
# --source-url only when the CS has sourceUrl. --data-file still needs an explicit PR#.
```

## The loop

### 0. Design hand-off (UI only)

User-facing UI: design the display layer first (self-contained brief, several datasets; never auto-surface config pages) and pass that reference into the worker brief.

Detail: Read [reference/loop-detail.md](reference/loop-detail.md).

### 1. Decompose

**Dependency-ordered, PR-sized sub-issues**, in waves. Open a GitHub issue per sub-issue. Body: spec, acceptance criteria to the accept-path iron law, architecture constraints, file pointers, dependencies, "one PR; do not merge."

Human already recorded the design decisions → skip design-review and say so. Otherwise **`agentloop:design-review <path> --max-rounds 2`** before dispatch. Decompose only what survives.

Pinned scope comment: this wave / deferred and why / already handled. **Safe-default ratchet** — "proceeding with X, object if wrong." Human only for a real fork. **Never package decomposable work as a decision menu.**

### 2. Fence off

On create: **`epic-managed`** (sweeps skip it) and **`epic:<epic#>`** on the epic, every sub-issue, and every PR. `agent:hold` until merge. Refresher re-asserts until you clear the lock list. Drop both labels at terminal state; `epic:<n>` stays.

Why labels beat the TTL lock: Read [reference/loop-detail.md](reference/loop-detail.md).

### 3. Dispatch one worker per ready sub-issue

Isolated worktree, model by weight. Every brief:
- **Spec = the work DID** (`arc --json afs read /work/<id>.json` and the `/work` query). `gh issue view` only after a `/work` miss, or for human comments on `sourceUrl`. Include the scope comment.
- **Invariants**: strict TDD; repo I/O and architecture rules; reuse named primitives; no new error class; the accept-path iron law.
- **Order: implement → review → one batch → ONE gate → open the PR** (§3.5). Targeted tests while implementing. Full gate only after findings are fixed and you release a slot. It must PASS before push; never `--no-verify`.
- **Timeout (raise-only)**: `TIMEOUT` and `failed=0` → re-run once (`ARC_VERIFY_TEST_TIMEOUT_MS` on arc) and record the value. `failed>0` → fix or `--blocked-by` (§8). Never raise a timeout to force green.
- **Open the PR; do not merge; labels at create** (a bare PR can be grabbed by `pr-sweep`). Conventional Commits title. Body: identity line, summary, acceptance evidence, `Closes #<n>`.
  ```bash
  gh pr create ... \
    --label epic-managed \
    --label "epic:<epic#>" \
    --label agent:hold
  ```
  If labels were omitted, `gh pr edit <PR#> --add-label epic-managed --add-label "epic:<epic#>" --add-label agent:hold` before any long wait.
- Post `<verification_entry> --comment <PR#>` right after `gh pr create` (same-SHA reuse; runs no checks).
- **Record the Change Set** right after `gh pr create`, and again after **every push** (fixes included):
  ```bash
  bash <plugin_root>/scripts/record-change-set.sh --entry "<change_set_record_entry>" --work <member work DID> --pr <PR URL>
  ```
  `--work` is the **member** DID, never the epic. Same head is a replay, not a new round. A non-zero exit means it is NOT on the ledger: stop (no `|| true`).
- **Bots are not waited on** (§6). One push and one `<verification_entry> --comment <PR#>` per batch; record the new head (`record-change-set.sh`). Do not merge.
- **Report**: work DID, CS `head`, PR URL if any, decisions, gate result, bot P1/High. Facts only. On return, re-assert `agent:hold` + `epic-managed` + `epic:<n>`.

When writing the brief, the PR body, or a Change Set N/A, read [reference/dispatch.md](reference/dispatch.md).

### 3.5 Independent review BEFORE the first gate run (round 1)

Review first, gate once. A gate before review is wasted: a real finding changes the SHA.

| # | Who | Step |
|---|---|---|
| 1 | worker | Strict TDD; targeted tests only. No full gate. |
| 2 | separate clean-context reviewer (not the worker) | `merge-base..HEAD`, class from §4. It **never runs a gate**. |
| 3 | worker | `compact-findings.ts`, then every still-valid finding in **one batch**. |
| 4 | worker, after a slot | `<verification_entry>` once, to PASS. |
| 5 | worker | Push, `gh pr create` (labels, §3), `<verification_entry> --comment <PR#>`, then `record-change-set.sh` for the pushed head. |
| 6 | conductor | Post round 1 (`post-verdict.ts`, `sha` = reviewed pre-fix sha, not the PR head). Stay `COMMENT` until the verification fact you **read** and the `bot-clean.ts` line (`botFindings=` / `vendorsSeen=`) are on it. Never `MERGE` before that. |

Zero findings → step 4 now. Report the reviewer and the fix, or "pre-PR review: zero findings". Re-review the delta only if substantive or security-relevant (always for §4B); it counts toward the cap. A mechanical batch must read `stale` from `compact-findings.ts`. No daemon or poll.

When posting round 1 or re-reviewing a delta, read [reference/review.md](reference/review.md).

### 4. Review class (at §3.5, before the gate)

The §3.5 reviewer is the review. No second full pass after open. Do not panel for symmetry.

**Class** — Backend Face Paths, or auth/authz, an exec gate, secrets/vault, a sandbox boundary, or payment/billing:

- **No:** one reviewer, `agentloop:pr-review` Steps 1–2.5. Security-relevant work must **reproduce the exploit against the code**. Docs, tests, and mechanical edits stay single-reviewer.
- **Yes:** panel, then one synthesis. Members do not post `<!-- pr-review-verdict -->`.

| Role | Reads | Does not |
|---|---|---|
| `correctness` | Behavior, regressions, missing tests | Run any gate |
| `security` | Authz, injection, traversal, forged channels; reproduce the exploit or claimed security property against the code | Emit a verdict |

Synthesis: neither blocking → `MERGE` or non-blocking `COMMENT` (read the sticky and `bot-clean.ts`; never run a gate, including `<merge_gate_entry>`). One role passes through. Both → dedupe, keep `path:line`, `compact-findings.ts`. Synthesis never edits files and never pushes. A crash is a finding, never a pass. The PR branch does not pick reviewers. One verdict comment.

**Round cap per PR: 3.** A round is a refreshed verdict at a new head. Read it:

```bash
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/scripts/pr-review-round.ts" --pr <n>
```

`0`–`2` → another round is allowed. `3` or more → no fourth: fold in, file an issue, REJECT, or stop unmerged. The third fix is single-point or you stop. Non-zero → count unknown; stop.

Why a count: [reference/closeout-gate.md](reference/closeout-gate.md). When the class or the synthesis is unclear, read [reference/review.md](reference/review.md).

### 5. Fixer

**Compact first**, against current PR HEAD:
```bash
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/skills/epic-conductor/scripts/compact-findings.ts" <raw-findings.json>
```
`still-valid` / `stale` / `duplicate`. Brief only `still-valid`. Unjudgeable stays `still-valid`.

Real BLOCK/COMMENT findings, or a legit bot P1/High: resume the worker, or spawn a fixer on its worktree. Conflicting Highs are one commit, not a ping-pong.
- The fixer: fix every still-valid finding of the round in one batch and push once; record the new head (`record-change-set.sh`, §3); run `<verification_entry> --comment <PR#>` once after a slot; reply in-thread; do not merge.
Wording-only nits (not P1/High) ride the next real batch or defer (§6). They are not their own gate. Re-review a substantial or security fix on the delta; a security fix re-runs the exploit.

When compact's classes or a conflicting High need the worked rule, read [reference/fixer.md](reference/fixer.md).

### 6. Inline review, once before merge

Vendors, fallbacks, the `bot-clean.ts` table: [`reference/review-receipt-protocol.md`](../../reference/review-receipt-protocol.md). Read it the first time a PR has an inline comment or bot activity. Every run:

1. **No inline wait.** Check bots once before merge. One short wait (≤10 min) only when the last push is under 10 minutes old and a vendor is `running` / `incomplete` / `stale` / `absent`. Do not block the next wave.
2. A fetch error is not "no findings" (GraphQL `reviewThreads` or `gh pr view --comments`).
3. Every actionable inline comment gets a same-thread conclusion before merge: fixed (SHA + change + verification), REJECT, or — P2/Medium/Low only — defer with owner and re-entry. P1/High never defer. Reply in-thread, never a new top-level comment. A later reply does not close an older thread.
4. Agree + fix joins that round's one batch: one commit, `record-change-set.sh`, one `<verification_entry> --comment <PR#>`, then the replies.
5. After merge → [`codex-review-backlog`](../codex-review-backlog/SKILL.md). Do not reopen the wave.

### 7. Gate + merge

All of these, in order:

1. MERGE, or COMMENT with only non-blocking notes, and every actionable inline thread resolved. `MERGE (held)` while `agent:hold` is on.
2. Merge gate exits 0: `bun .claude/verify/merge-gate.ts --cs-head <40-char-sha> <PR#>`. Doors: same-SHA verification (the PR's `<verification_entry> --comment` satisfies it; `<pre_merge_entry>` is not part of the PR loop), merge-load on current main, `additional_merge_gates`, cross-engine review only for a Factory run. Advisory gates do not block. If you pushed (a rebase or a merge of main to clear `CONFLICTING`), record that head first (`record-change-set.sh --work <member work DID>`, §3; non-zero stops). Do not drop `--cs-head`. `sha=` must equal the CS head. Stale fact → owner re-posts `<verification_entry> --comment`, never `<pre_merge_entry>`. Carry-forward is the gate's call, not yours.
3. Every actionable thread is addressed (§6). Unfixed, unrejected P1/High blocks.
4. The single pre-merge `bot-clean.ts` check has run on the last head. No green human GitHub review is required.
5. `scripts/merge-verified-pr.sh` immediately after step 2. Only the merger runs this gate, immediately before merge-verified-pr.sh. The exit-0 `merge-gate.<sha>.json` for this PR and head is the authorization (same machine, same head).

Security-face: a short risk-summary (opens / why safe / residual / revert), then drop `agent:hold`, squash-merge, delete the branch, clear the lock entry, dispatch the next wave.

When a door or the verdict file is unclear, read [reference/gate-merge.md](reference/gate-merge.md).

### 8. Hazards

- **Duplicate PR**: keep the better one; close the twin with a coordination comment.
- **Transcript lost**: fixer on the existing worktree.
- **Main moved**: rebase only for `mergeable=CONFLICTING`, a needed main feature, or a red already fixed on main (`--blocked-by` needs an open witness; build-input diffs are refused). Record the new head after the push (`record-change-set.sh`, §3). Behind main is not a reason to rebase.
- **Out of scope**: file a follow-up. Do not fold it in.
- **Not this PR's red**: there are exactly two ways forward. (1) Bisect to the smallest red set and fix it. (2) `--blocked-by <issue#>` on `<verification_entry> --comment <PR#>`; the gate attributes it or stays FAIL. Never re-run until green. Timeout exception: §3 only (`TIMEOUT`, `failed=0`).
- **Bot silence** is not a gate. One `bot-clean.ts` check (§6). Late comments → `codex-review-backlog`.
- **429 death, not a task failure**: do not re-dispatch blind. Verbatim harness text, `bump` before retry, WIP-commit. Commands: [reference/capacity-retry.md](reference/capacity-retry.md).
- **Worktrees**: remove / prune at the end.

When the incident or the longer procedure is needed, read [reference/hazards.md](reference/hazards.md).

### 9. Closeout

**Before any wrap step**, no PR of yours may still cite an open witness:

```bash
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/skills/epic-conductor/scripts/assert-no-blocked-prs.ts" --epic <epic#>
```

Exit 0 is required. Exit 1 = witness still open. Exit 2 = unchecked — **fail-closed** (`gh` / `prs` / `evidence` / `issue`); "couldn't check" is never "clear". No bypass. Do not exit on unfinished state you created.

The witness is human-supplied (exists and open only). Scope is `epic:<n>` PRs. Limits: [reference/closeout-gate.md](reference/closeout-gate.md).

- **Cohesion**: read the catch-net covering the last merge. Green → record the id. Red → link its issue. Not covered → wait; no private suite. **You never write, edit or "confirm" a catch-net verdict** or its heartbeat. No catch-net → gate the touched packages on main.
- **End-to-end** on real infrastructure. Say user-reachable vs mechanism-level; file the seam.
- **UI**: screenshots of every real surface, one epic walkthrough.
- **Wrap**: close the issues, clear the lock list, report URLs.

When reading the catch-net, shooting UI, or writing the wrap, read [reference/closeout.md](reference/closeout.md).

## Tracking

Mirror sub-issues (`addBlockedBy`). In progress on dispatch, done on merge, one closeout task blocked by all.

## Mental model

Decompose → lock → { worker → review → one batch → one gate → PR → bot-clean once → merge } → catch-net closeout.
