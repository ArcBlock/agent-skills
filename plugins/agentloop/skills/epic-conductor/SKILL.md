---
name: epic-conductor
description: >-
  Attended multi-agent implementation of a WHOLE epic. One resident conductor
  decomposes an epic into dependency-ordered sub-issues, fans out an isolated
  worker per sub-issue (implement, verify, open PR), spawns an independent
  clean-context reviewer per PR, routes review and bot findings to a fixer,
  then gates and merges each PR and unlocks the next wave. Bot review (Codex +
  Cursor Bugbot) is short-wait (≤10m): findings or 👍 or silence-then-advance —
  never multi-hour stall. P1/High are fixed or REJECT-replied in-thread; every
  fix re-stamps SHA-matched gates before merge. Human stays for high-level
  forks only (safe-default ratchet). Distinct
  from issue-sweep and pr-sweep (unattended batch over existing items) and
  build-phases (single agent phases of one issue). Use when implementing a whole
  epic end-to-end with a reachable human. Composes pr-review, verification, and
  the repo merge gate.
allowed-tools: Agent, Bash, Read, Grep, Glob, Edit, Write, Task, AskUserQuestion, Skill
---

# epic-conductor — drive a whole epic to merged, autonomously

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic; the concrete gate commands (verification, e2e-gate, ui-verify, merge-gate) and identity-line script come from the consuming repo's profile. Where this doc names arc paths (`.claude/verify/pre-pr.ts`, `merge-gate.ts`, `scripts/agent-identity.sh`, `scripts/gh-upload-media.sh`) they are EXAMPLES — substitute the repo's own.

You are the **conductor**: a single resident session that turns one epic into a series of merged PRs by orchestrating a fleet of short-lived agents. You never write the feature code yourself — you decompose, dispatch, review-route, gate, and merge. You stay alive across the entire epic.

Hired factory/worker children still `status=running` (pid alive) make it **forbidden** to `end_turn` / close the session. Allowed: true closeout after each hire has GitHub evidence (PR URL or skip-comment) **or** the child was explicitly `stop`ped. Watch pid + `runs/*.json` + cwd, not `lastTurn` alone. Before treating yourself as done:
```bash
bun .claude/plugins/agentloop/skills/epic-conductor/scripts/assert-no-live-children.ts \
  --runs-dir "${ARC_HOME:-$HOME}/.afs/code-agents/runs" \
  --ids <hired-id>,<hired-id>
```
Exit 0 only when none of those ids are live. Ghost `status=running` with a dead pid does not block (recover-territory). Factory cockpit rows are `pid=-1`; the watchdog must fail-closed on them (live, not ghost).

## When this skill applies (and when it doesn't)

USE IT when: a human hands you an epic (or a decomposable body of multi-issue work) and wants it implemented end-to-end, and **they remain reachable** for high-level decisions ("safe default + object-if-wrong"), not per-step approval.

Do NOT use it for:
- **A single issue / single PR** → that's a plain worker, or `build-phases` (phases of one issue).
- **Unattended batch over existing issues/PRs** → that's `issue-sweep` / `pr-sweep`.
- **No human reachable at all** → downgrade to the sweeps' `needs-human-confirm` discipline; this skill assumes an attended principal.

The distinction is the point: this is the **epic factory** — decompose a NEW body of work, then give every sub-issue its own isolated worker + its own independent reviewer + its own fix loop + its own merge.

## Relationship to the neighboring skills (compose, don't replace)

epic-conductor does not supersede the others — it **reframes them as composable parts** at different altitudes and attendedness. Know which to reach for:

- **design-review** reviews a *plan/design document* (multi-perspective, clean-context per round) — it does not build. It is epic-conductor's **plan gate**: run it on the epic's design and your proposed decomposition (step 0/1) *before* you dispatch workers. Complementary, upstream, not replaced.
- **build-phases** drives *one* issue as checkpointed phases in a *single* context — **no independent review between phases**. Its distinct niche survives: an **unattended** complex single issue (issue-sweep calls it), or one issue too big for a single shot yet not worth splitting into sub-issues. Inside a well-decomposed epic each sub-issue is already one-PR-sized, so a plain worker handles it and you rarely need build-phases *within* conductor — but it remains the right tool *outside* it. Where conductor's model dominates (attended + decomposable work): it inserts an independent clean-context review per unit, which build-phases' single-context phasing cannot.
- **pr-review** reviews *one* PR — it is literally the engine conductor spawns at step 4 (`agentloop:pr-review`).
- **issue-sweep / pr-sweep** are the *unattended batch* over *existing* issues/PRs, single runner inline. conductor is the *attended* driver of a *new* epic with per-sub-issue fan-out. If no human is reachable, don't run conductor — use the sweeps' `needs-human-confirm` discipline.

Altitude ladder: **design-review** (a plan) → **epic-conductor** (an epic = many sub-issues) → { plain worker | **build-phases** } (one issue) → **pr-review** (one PR).

## The load-bearing idea (why it works — do not skip)

**Independent, clean-context review is the whole point.** A worker that just wrote the code cannot see the class of defect that a green test suite also cannot see: the **accept/reject-same-color** bugs — a check that rejects everything (so all reject-tests pass), a path that was only ever tested with text (so a binary bug hides), a gate installed on two of three doors (so the untested door is wide open), a value that can be forged through an untested channel. A separate agent that starts from zero context, reads the diff adversarially, verifies every claim against live code, and **reproduces security findings against the code**, catches these. In practice this pattern has caught, per epic: an `exec` bypass letting any app write a user's whole space, a binary-content hash collapsing to one constant hash (forgeable signatures), a canonical-hijack via forged front-matter, a truncated scan silently deleting a subset. None had a failing test. Budget for the review; it is not optional overhead, it is the mechanism.

Corollary you enforce on every worker and reviewer: **the accept-path iron law** — any check that rejects bad input MUST also have a test asserting it admits good input, because "reject everything" satisfies every reject-only test.

## Orchestration invariants (how you run)

- **Resident + serial-inline.** You stay in one session and orchestrate by launching agents and reacting to their completion notifications. Do NOT nest a Workflow inside the conductor; drive it inline. (Unattended-ops norm: no plan mode for the epic; decisions live in issue/PR comments.)
- **No `end_turn` with live hired children.** `status=running` and pid still alive → stay. Assert with [`assert-no-live-children.ts`](./scripts/assert-no-live-children.ts) before you treat yourself as done. True closeout after PR URL / skip-comment evidence or explicit `stop` is allowed; a ghost dead pid is not a live child.
- **Concurrency ~3.** Local machines build under contention; 3 in-flight agents is a sane default. Cloud/remote can go higher.
- **Model by task weight.** Runtime / gates / security / data-model → opus. Docs / mechanical / small blocklet → sonnet. State it per dispatch.
- **Isolated worktree per worker** (`isolation: "worktree"` on the Agent call) so parallel workers never collide on files.
- **Every worker DOES NOT MERGE.** Merging is the conductor's gated act, always.

## The loop

### 0. (Optional) Design hand-off — when the epic has a visual/UX surface
If the epic ships user-facing UI, split the design BEFORE decomposing:
- Hand the **display layer** to a design tool (e.g. Claude Design): give it a clean, self-contained brief — neutral/themeable shell, and **multiple concrete example datasets** so it produces genuinely different layouts per data type. Do NOT ask it to design config/settings pages that the platform's **auto-surface** can generate from a declared schema — scope those out; one source of truth.
- The design output becomes the **visual basis** for the display sub-issue. Read it (via the design MCP / artifact) and pass the real design reference into that worker's brief.

### 1. Decompose
Break the epic into **dependency-ordered, PR-sized sub-issues**, grouped into **waves** (a wave = issues with no unmet dependency, runnable in parallel). Open a GitHub issue per sub-issue. Each issue body MUST carry: the spec, **acceptance criteria written to the accept-path iron law**, the discipline constraints it must respect (the repo's architecture rules), concrete file pointers, its dependencies, and an explicit "this is one PR; do not merge."

Before dispatching, gate the plan: run **`agentloop:design-review`** on the epic's design and your proposed decomposition to settle it clean-context (especially if step 0's design hand-off happened). Decompose only what survives that review.

Record scope decisions on the epic as a pinned comment: what's in this build wave, what's deferred and why (e.g. gated on an unbuilt primitive), what's handled by an existing mechanism (don't rebuild). Use the **safe-default ratchet**: for any choice you can make safely, decide it and note "proceeding with X, object if wrong." Reserve the human for genuine forks only (irreversible, security, undecidable A-vs-B, aesthetic, resource-level). **Never package decomposable work as a decision menu** — if the "options" are not mutually exclusive, they're a dependency order, not a question.

### 2. Group + fence off (prevent fleet collisions, keep epics untangled)
This repo may have `issue-sweep`/`pr-sweep` cron runners that will otherwise grab your issues and open duplicate PRs — and once this mechanism exists you'll run *several* epics whose issues/PRs must not tangle. Two standing labels do both jobs (the load-bearing fix; the old advisory `agent:processing` lock is racy — add-then-check, 30min TTL — and has really collided, e.g. a fleet runner opening a duplicate PR seconds before the lock landed):

- **`epic-managed`** (standing, epic-agnostic) — the **fleet-exclusion key**. Apply it to the epic + every sub-issue + every PR your pipeline opens, the moment each exists. `issue-sweep`/`pr-sweep` skip anything carrying it ENTIRELY (not triaged, not claimed, not reviewed, not commented) — the conductor is the sole driver. One rule covers all epics, present and future. This is stronger than `agent:hold` (which only freezes *terminal* actions but still responds to human comments): `epic-managed` means "another agent owns this end-to-end."
- **`epic:<epic#>`** (per-epic) — the **grouping/filter key**. Apply to the epic + every sub-issue + PR. `gh issue list --label "epic:<n>"` / `gh pr list --label "epic:<n>"` pulls exactly one epic's items — so multiple concurrent epics stay cleanly separable.
- Create both labels up front (`gh label create`). Optionally also open a **milestone** per epic and assign the sub-issues to it — purely for the GitHub UI's native progress bar (X/Y closed); the machine mechanism is the labels, not the milestone.
- Keep `agent:hold` on each opened PR too as belt-and-suspenders (and as the human-facing "reserved" signal), and remove it at merge time — but `epic-managed` is the primary fence. `agent:processing` becomes optional (only meaningful if two *conductors* could run the same repo); the standing exclusion, not the TTL lock, is what keeps the fleet out.
- Keep the label list / epic number in a file a small background refresher reads; the refresher re-asserts labels periodically and exits when you clear the list at closeout. At closeout, remove `epic-managed` (and `agent:hold`) as each item reaches terminal state; the `epic:<n>` label stays as a permanent grouping record.

### 3. Dispatch a worker per ready sub-issue
Launch an Agent (isolated worktree, model by weight) with a precise brief. Every worker brief MUST include:
- **Spec = the issue** (`gh issue view <n> --comments`) + the epic's scope-decision comment.
- **Invariants**: strict TDD; the repo's I/O / architecture rules; reuse existing primitives (name them + their files) rather than re-inventing; no new error classes unless the repo lacks one; the accept-path iron law.
- **Verify before push**: run the repo's verification gate to PASS; never `--no-verify`; never skip.
- **Open a PR, DO NOT merge — and label it atomically at create time** (Codex P1 on arc#3558: the window between `gh pr create` and the conductor learning the PR# is when hourly `pr-sweep` can still grab an unlabeled PR). PR title = Conventional Commits; body starts with the repo's identity line (`scripts/agent-identity.sh …`), then summary / design decisions / acceptance evidence / `Closes #<n>` / the repo's footer. **Create command MUST carry all three labels in one shot** (do not open bare then label later as the primary path):
  ```bash
  gh pr create ... \
    --label epic-managed \
    --label "epic:<epic#>" \
    --label agent:hold
  ```
  If create without labels somehow happens (tooling gap), the **first** action after create is `gh pr edit <PR#> --add-label epic-managed --add-label "epic:<epic#>" --add-label agent:hold` before any long verify wait.
- **Post the verification report** to the PR (`… --comment <PR#>` or equivalent).
- **Bot review self-handling is NON-BLOCKING** (see §6). The worker brief MUST require: reply **in-thread** (not a new top-level comment); after any fix commit, re-run verification `--comment` **and** every SHA-matched sticky this diff needs (e2e-gate / ui-verify); do not merge.
- **Report back**: PR#/URL, decisions made, gate results, bot P1/High status (fixed sha / REJECT thread / OPEN), deviations/concerns — raw facts, no marketing.
When a worker returns, the conductor **re-asserts** `agent:hold` + `epic-managed` + `epic:<n>` (idempotent) — that is a safety net, **not** the first time those labels appear.

### 3.5 Pre-PR adversarial review (left-shift, before `gh pr create`)

Right before the worker would run `gh pr create`, dispatch a **separate clean-context agent**
(never the worker itself — same-session self-review does not count, mirrors §4's rule) to review
`merge-base..HEAD` on the worker's own branch/worktree. This is finding-shaped, not the merge
contract:

- **In scope**: correctness bugs, security holes, missing tests, regressions in the diff.
- **Out of scope — this is not a second `pr-review`.** Do not run `pre-merge`, do not emit a
  MERGE/COMMENT/BLOCK verdict, do not post a `<!-- pr-review-verdict -->` comment, do not check
  cross-PR conflicts or bot status. §4's independent `agentloop:pr-review` after the PR opens is
  still mandatory — this step never substitutes for it.
- **Findings** → filter through [`compact-findings.ts`](./scripts/compact-findings.ts) (same
  tool as §5), then the **original worker**, same worktree, fixes and re-runs verification —
  only then `gh pr create`.
- **Zero findings** → `gh pr create` proceeds immediately; do not wait longer "just in case".
- **Worker report must state one of**: the reviewer agent id + what it fixed, or explicitly
  "pre-PR review: zero findings". Missing this line means step 3 is not done.
- No roborev-style daemon, no post-commit hook, no polling GitHub for this — one in-session
  agent round-trip on a branch range, not a running service.

### 4. Independent review per PR

Two paths, chosen by what the PR touches. Do not open a panel for every PR just for
symmetry — the cost only buys something on the face where a single reviewer's
single-lens read is the known failure mode (§0's load-bearing idea: an *accept/reject-same-color*
defect a green suite also can't see).

**Determine the PR's class first** — diff hits repo-profile's **Backend Face Paths**
(`.claude/repo-profile.md`), or touches auth/authz, an exec-gate, secrets/vault,
a sandbox boundary, or payment/billing:

- **No** → **A. Normal PR.** Spawn one **separate, clean-context** reviewer agent (never the
  worker) that runs `agentloop:pr-review <PR#> --post`. In its brief, point it at the exact
  things to scrutinize hardest for THIS PR (the security boundary, the forge channel, the
  accept-path coverage, the reuse claims), and for security-relevant PRs tell it to
  **reproduce the exploit against the code**, not just read it. It emits a verdict (MERGE /
  COMMENT / BLOCK / …) and posts one verdict comment. **This is the common path — docs,
  test-only, mechanical, and anything that doesn't hit the face above stays single-reviewer.**

- **Yes** → **B. Security / data-plane PR.** Fan out **at least two** independent
  clean-context reviewers, each a distinct named role, then synthesize:

  | Role | Reads | Does not need to |
  |---|---|---|
  | `correctness` | Behavior, regressions, missing tests, cross-cutting effects | Re-run the full merge-gate read (§7 still does that) |
  | `security` | Authz, injection, path traversal, forged channels; **reproduce any claimed security property against the code (accept-path + exploit attempt), not just read it** | Write the MERGE/COMMENT/BLOCK vocabulary — its output is an input to synthesis, not a second verdict |

  A member never posts `<!-- pr-review-verdict -->` itself — only the synthesis step does.

  **Synthesis** (one agent; the rules below apply in order):
  1. **Neither role has a blocking finding** → synthesize `MERGE` (or `COMMENT` with
     non-blocking notes). This does not replace §7's gate — the repo's `pre-merge`
     verification, e2e-gate, and ui-verify still run exactly as for a normal PR. Every role
     invokes the verification entrypoint when it needs the fact; a shared broker may make one
     actual run only for the same `{HEAD SHA, scenario, resolved base}`. That efficiency never
     substitutes for the independent code-review roles.
  2. **Only one role produced findings** → pass them through directly as the verdict basis;
     do not spend an agent on synthesis just for symmetry.
  3. **Both roles have findings** → read-only merge: dedupe, order by severity, keep every
     `path:line`. Run the pile through
     [`compact-findings.ts`](./scripts/compact-findings.ts) (same tool §5 uses) before
     handing it to a fixer.
  4. **Synthesis never edits files and never pushes** — it is read-only, exactly like the
     members it merges.
  5. **Any round that errors, or a reviewer that fails to return, is uncertain — uncertain
     stays a finding, never a pass.** A crashed/timed-out reviewer never synthesizes to
     `MERGE` — see the anti-pattern in §0 (a reviewer that silently accepts everything is
     indistinguishable, on green output, from one that works).
  6. Panel roles and the security-face trigger above are defined here (and in
     repo-profile's Backend Face Paths) — **not** configurable from the PR's own branch;
     a feature diff must not be able to change who reviews it.

  The synthesized result still posts as **one** canonical `<!-- pr-review-verdict -->`
  comment, upserted exactly as a single-reviewer verdict would be (§4A's convention,
  [`pr-review`](../pr-review/SKILL.md)'s marker) — members' output is working material, never
  a second canonical verdict.

### 5. Route findings to a fixer
**Compact first — mandatory, no exceptions.** Before a fixer is dispatched, run the raw pile
(independent-review findings + bot P1/High + any still-open inline comments) through
[`compact-findings.ts`](./scripts/compact-findings.ts):
```bash
bun .claude/plugins/agentloop/skills/epic-conductor/scripts/compact-findings.ts <raw-findings.json>
```
It judges each finding against the **current PR HEAD** (not the commit it was originally posted
against — GitHub reassociates stale `commit_id`s onto new HEADs) and returns `still-valid` /
`stale` / `duplicate` for every one, never a bare count. The fixer brief is
`fixerBrief(compacted)` — **only** `still-valid` entries. A conductor that skips this step and
hands the fixer the raw pile is not following this skill: that is exactly the failure this step
exists to close (fixers re-fixing already-patched defects, two bots on one line producing two
fix attempts). Compact's only permitted failure mode is under-killing — a finding it cannot
judge (no expected-snippet to compare, or the file/line is unreadable) stays `still-valid`;
losing a real P1 silently is strictly worse than keeping a stale one one round longer.

If the verdict is BLOCK/COMMENT with real findings (or a bot left legit P1/High), route the
**compacted, still-valid** findings to a fixer:
- Prefer **resuming the original worker** with the consolidated findings (comment id + `path:line` + intended direction).
- If its transcript is gone, **spawn a fixer on its existing worktree** (pass the worktree path; it inherits the branch).
- **Conflicting bot Highs are one synthesis, not a ping-pong.** If fix A (to satisfy finding 1) *is* finding 2, do not undo A and do not ignore 2. Keep the constraint from 1 and the accept-path from 2 in **one** commit.
- The fixer: commit on the existing branch; **reply in-thread** on every cited comment id (`gh api …/pulls/{n}/comments/{id}/replies` — never a new top-level PR comment); re-run verification `--comment` to the **new** HEAD; re-run e2e-gate / ui-verify when those stickies apply (any push makes the old SHA stale); do not merge.
Re-review if the fix was substantial or security-relevant (a security fix deserves a second independent agent that runs the original exploit against the patched code).

### 6. Bot code-review — short-wait, address in-thread, then advance

This is the **single home** of the pre-merge bot protocol. [`pr-sweep`](../pr-sweep/SKILL.md) Step 5 and [`pr-review`](../pr-review/SKILL.md) Step 0.4 point here. Do not fork a second wait policy.

**Vendors are one class** (this org; treat similarly):
- `chatgpt-codex-connector[bot]` — P1/P2 badges, or a single **👍** = no suggestions (positive, not "still thinking")
- `cursor[bot]` (Bugbot) — High / Medium / Low
- any future connector that posts **inline** findings after open / ready / push

**Blocks merge:** Codex **P1** and Cursor **High**. P2 / Medium: fix if cheap and in-scope, else follow-up issue — do not stall the wave.

**Short-wait:** default **≤10 minutes** after `gh pr create` **and after every fix push** (one mid-window re-check is fine; no long poll). Look at activity **created after that push**. GitHub often **reassociates old comments onto the new `commit_id`** — `commit_id == HEAD` is not "new." Use `created_at >= last_push` (or: no in-thread reply after the finding).

**Fetch (must succeed or you have no evidence):**
```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate
gh api repos/{owner}/{repo}/pulls/<n>/reviews --paginate
```
If REST 404s / flakes, fall back to GraphQL `pullRequest { reviews, reviewThreads { comments } }` or `gh pr view <n> --comments`. **A fetch error is not "no findings."**

**Procedure (workers, fixers, and conductor all obey):**

1. After create or a fix push, short-wait, then:
   - **👍 / review shell with no new inline findings** → clean. Proceed to step 4 / step 7. Do **not** wait longer "just in case."
   - **New inline P1/High** → handle **now** (item 3). Do not open the next wave with any OPEN P1/High.
   - **Silence past the short wait** → **proceed**. Do not park the epic. Pre-merge re-check still re-fetches (item 5).
2. **Hard ban:** multi-hour `sleep`/poll; "waiting for re-review" as a status past the short wait; blocking wave *N+1* because wave *N*'s bot has not 👍'd; asking the human to wait for a bot.
3. **On findings:**
   - **Agree + fix** → commit on the PR branch; re-run verification `--comment` to the **new** HEAD; re-run e2e-gate / ui-verify if those stickies apply (**any push stale-dates them**); **reply in-thread** with sha + what changed. Then **one** short re-check (≤10m); if silent, proceed.
   - **Disagree (by design / wrong layer / false positive)** → **in-thread REJECT** with reasoning + architecture pointer. Thread left open ≠ block. Record REJECT for backlog if useful.
   - **Out of scope but real** → open a **follow-up issue**; in-thread pointer; never silently fold in; never drop.
   - **In-thread only.** Do not open a new top-level PR comment to "address" a review thread.
     ```bash
     gh api -X POST repos/{owner}/{repo}/pulls/<n>/comments/<comment_id>/replies \
       -f body="$(cat reply.md)"
     ```
4. **Addressed** (merge-relevant) = every bot **P1/High** whose `created_at` is after the last addressing commit is either **fixed in a later commit + in-thread reply** or **REJECT-replied on that thread**.
5. **Pre-merge re-check (once, cheap):** re-fetch all vendor comments. New unaddressed P1/High since the last fix reply → fixer; else merge. **Bot reviews are not human `CHANGES_REQUESTED`** — pr-sweep's human Review 闸 does not apply; you own bots via this section.
6. **Late findings after merge** → do **not** reopen the wave; [`codex-review-backlog`](../codex-review-backlog/SKILL.md) (and the same backlog for Cursor High if it lands late). Closeout may note OPEN_HARD.

**Anti-patterns:**
- Treating "no bot comment yet" after 10m as blocked.
- Waiting hours for a second pass after you already fixed and replied.
- Holding merge because a disagreed-by-design thread is still open.
- A new top-level comment instead of an in-thread reply.
- Shipping a fix that satisfies finding 1 by creating finding 2, then flipping back and forth (§5 synthesis).

### 7. Gate + merge (the conductor's act)
Merge a PR only when ALL hold, **in this order** (do not skip to squash):

1. Independent review verdict is MERGE, or COMMENT with **only** non-blocking notes. `MERGE (held)` is the expected form while `agent:hold` is on.
2. Repo **merge gate** exits 0 on the SHA you are about to merge (`verification` + e2e-gate + ui-verify + native, per what the diff touches). Every applicable sticky comment's `sha=` **must equal HEAD** — a fixer commit stale-dates all of them; for base-sensitive `pre-merge`, a resolved-base advance also stale-dates the evidence. Re-invoke the gate entrypoint before this step; the broker may reuse only the exact current identity.
3. **No unaddressed bot P1/High** per §6 (fixed **or** REJECT-replied — not "still waiting for bot").
4. Short-wait / 👍 / silence-after-short-wait after the **last** push, per §6. You do **not** need a green human GitHub review from Codex or Cursor.

For a **security-face** PR, post a short **risk-summary** comment before merging (what it opens, why it's safe, residual risk, revert path). Then: remove `agent:hold`, squash-merge (Conventional-Commit title if branch commits drifted), delete the branch, drop the issue from the lock list. Unblock dependents and dispatch the next wave.

### 8. Hazards you WILL hit (name them so you handle, not flail)
- **Fleet collision**: another runner opened a duplicate PR for your issue → keep the better one, dedup-close the twin with a coordination comment.
- **Worker transcript lost**: resume fails → spawn a fixer on the existing worktree.
- **Main moved under a branch**: rebase when `CONFLICTING` or you need main's features; resolve keeping both. **Do not rebase just to "be current"** if `mergeable=MERGEABLE` and main has **pre-existing red tests in files this PR does not touch** (`git diff origin/<default> -- <failing files>` empty) — that turns a green verification into a false FAIL. Document overlap + merge order in the PR body; squash-merge is allowed. Confirm the fail on merge-base / main before treating it as this PR's defect.
- **Out-of-scope findings**: a reviewer/bot surfaces something real but outside this PR's scope → open a **follow-up issue**, never silently fold it in, never drop it.
- **Flaky pre-existing test**: confirm it fails on merge-base too; don't let it block; file a flaky-test issue.
- **Bot-review multi-hour hang**: treating Codex silence (or waiting for re-👍 after a fix) as a hard gate freezes the wave while the real gates are already green. Obey §6 short-wait; late comments → `codex-review-backlog`.
- **Worktree cleanup**: `git worktree remove` / `prune` leftover worktrees at the end.

### 9. Closeout (mandatory — the epic isn't done until this is posted)
- **Cohesion check**: on the merged main, run the deterministic gate / full suites across the touched packages — N PRs merged in sequence MUST cohere; catch integration breakage no single PR's CI saw.
- **End-to-end verification**: drive the epic's actual thesis end-to-end on real infrastructure (real data, real services), as far as the merged code allows. Be HONEST about **user-reachable vs mechanism-level** where a wiring seam remains, and file the seam as a follow-up.
- **Visual verification when there's a UI**: capture **screenshots of every real rendered surface**, upload them so they inline in GitHub (raw host on the default branch — a bare comment post can drop images), and post ONE walkthrough comment on the epic with captioned inline screenshots + the terminal evidence for non-UI steps. If the human asked for a screenshotted closeout, this step is the deliverable, not an extra.
- **Wrap**: close sub-issues + the epic with a summary (deliverables table, closeout verdict, follow-ups filed), clear the lock list (refresher exits), report to the human with the epic + PR URLs and what each screenshot proves.

## Tracking
Keep a task list mirroring the sub-issues with dependencies (`addBlockedBy`), mark in_progress on dispatch and completed on merge, plus one closeout task blocked by all. It's how you and the human both see wave progress.

## One-line mental model
Decompose → lock → (design hand-off) → per sub-issue { isolated worker → independent review → fix → gate → merge → unlock next } → screenshotted closeout. You are the only thing that persists; everything else is a fresh agent with a precise brief.
