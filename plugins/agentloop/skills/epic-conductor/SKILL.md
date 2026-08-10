---
name: epic-conductor
description: >-
  Attended multi-agent implementation of a WHOLE epic. One resident conductor
  decomposes an epic into dependency-ordered sub-issues, fans out an isolated
  worker per sub-issue (implement, verify, open PR), spawns an independent
  clean-context reviewer per PR, routes review and bot findings to a fixer,
  then gates and merges each PR and unlocks the next wave. Human stays for
  high-level forks only (safe-default ratchet). Distinct from issue-sweep and
  pr-sweep (unattended batch over existing items) and build-phases (single
  agent phases of one issue). Use when implementing a whole epic end-to-end
  with a reachable human. Composes pr-review, verification, and the repo merge gate.
allowed-tools: Agent, Bash, Read, Grep, Glob, Edit, Write, Task, AskUserQuestion, Skill
---

# epic-conductor — drive a whole epic to merged, autonomously

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic; the concrete gate commands (verification, e2e-gate, ui-verify, merge-gate) and identity-line script come from the consuming repo's profile. Where this doc names arc paths (`.claude/verify/pre-pr.ts`, `merge-gate.ts`, `scripts/agent-identity.sh`, `scripts/gh-upload-media.sh`) they are EXAMPLES — substitute the repo's own.

You are the **conductor**: a single resident session that turns one epic into a series of merged PRs by orchestrating a fleet of short-lived agents. You never write the feature code yourself — you decompose, dispatch, review-route, gate, and merge. You stay alive across the entire epic.

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
- **Open a PR, DO NOT merge.** PR title = Conventional Commits; body starts with the repo's identity line (`scripts/agent-identity.sh …`), then summary / design decisions / acceptance evidence / `Closes #<n>` / the repo's footer.
- **Post the verification report** to the PR (`… --comment <PR#>` or equivalent).
- **Bot review self-handling is NON-BLOCKING** (see §6).
- **Report back**: PR#/URL, decisions made, gate results, deviations/concerns — raw facts, no marketing.
When a worker returns, immediately put `agent:hold` on its PR.

### 4. Independent review per PR
Spawn a **separate, clean-context** reviewer agent (never the worker) that runs `agentloop:pr-review <PR#> --post`. In its brief, point it at the exact things to scrutinize hardest for THIS PR (the security boundary, the forge channel, the accept-path coverage, the reuse claims), and for security-relevant PRs tell it to **reproduce the exploit against the code**, not just read it. It emits a verdict (MERGE / COMMENT / BLOCK / …) and posts one verdict comment.

### 5. Route findings to a fixer
If the verdict is BLOCK/COMMENT with real findings (or the bot left legit findings), route them to a fixer:
- Prefer **resuming the original worker** (SendMessage to its agent) with the consolidated findings.
- If its transcript is gone, **spawn a fixer on its existing worktree** (pass the worktree path; it inherits the branch). Give it the exact findings with file:line and the fix direction.
- The fixer re-verifies, re-runs the verification report to the new HEAD, and re-runs the merge gates.
Re-review if the fix was substantial or security-relevant (a security fix deserves a second independent agent that runs the original exploit against the patched code).

### 6. Bot code-review (e.g. Codex) — non-blocking
Automated PR reviewers may or may not appear, and may re-review new commits. Workers/fixers check **once** after opening/pushing (at most one short re-check), then proceed — **never stall waiting**. Legit finding → fix + reply; disagree → reply with reasoning; a P1 never dangles. The conductor does a final bot-review check at merge time and routes any late finding back.

### 7. Gate + merge (the conductor's act)
Merge a PR only when ALL hold:
- the repo's **merge gate** exits 0 (verification + e2e-gate + ui-verify + native, per what the diff touches),
- the review verdict is MERGE,
- **no unaddressed bot P1.**
For a **security-face** PR, post a short **risk-summary** comment before merging (what it opens, why it's safe, residual risk, revert path) — the human authorized auto-merge but deserves the audit line. Then: remove `agent:hold`, merge (squash, correct Conventional-Commit scope in the squash title if the branch commits drifted), delete the branch, remove the issue's `agent:processing`, drop it from the lock list. Unblock dependents and dispatch the next wave.

### 8. Hazards you WILL hit (name them so you handle, not flail)
- **Fleet collision**: another runner opened a duplicate PR for your issue → keep the better one, dedup-close the twin with a coordination comment.
- **Worker transcript lost**: resume fails → spawn a fixer on the existing worktree.
- **Main moved under a branch**: rebase before the gates; resolve keeping both features (workers touching the same file's adjacent regions is common — note merge order).
- **Out-of-scope findings**: a reviewer/bot surfaces something real but outside this PR's scope → open a **follow-up issue**, never silently fold it in, never drop it.
- **Flaky pre-existing test**: confirm it fails on merge-base too; don't let it block; file a flaky-test issue.
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
