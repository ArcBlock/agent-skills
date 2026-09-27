---
name: build-phases
description: >-
  Execute a phased implementation plan (tasks.md) autonomously, one phase at a time: implement,
  then verify (static + dynamic + adversarial) before advancing. Use for a multi-phase build of one
  issue, attended or unattended.
---

# Build Phases — Automated Phase-by-Phase Implementation + Verification Loop

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic; arc is the reference implementation. Toolchain commands below are written as `<package_manager> <script>` (arc: `pnpm build` / `pnpm check-types` / `pnpm test`) and `<formatter>` (arc: `biome check --write`) — map them to your repo via the profile's Toolchain keys. Arc's issue-number provenance for any lessons is not inlined here.

Execute a planning document's phases sequentially, with mandatory three-layer verification, code simplification, and design review at each phase.

> **Drive to completion.** Finish **all** phases in one run (Phase 0 → last → final PR). **Do not pause for a merge between phases**, and do not ask "shall I continue?" The loop stops only when (a) **all phases are complete**, or (b) a **genuine must-human escalation** (Escalation Rules). Next phase, respawn, and rebase are the loop's job. An unnecessary pause strands the feature. When you must stop, escalate (issue comment if issue-native, inline if a human is present) — never idle.

## Usage

**Recommended:** `/loop /agentloop:build-phases <planning-dir> [--start-phase <N>] [--review-target <score>]`

`/loop` with no interval is self-pacing. The executor's task-notification is the primary wake; `ScheduleWakeup` (1800s) is only the stall fallback. See Rule 4.

**Direct** (one spawn, no watchdog): `/agentloop:build-phases <planning-dir> [...]`. Prefer `/loop`.

- `<planning-dir>` — directory with `tasks.md` (phases) and optional `design.md`
- `--start-phase <N>` — default 0
- `--review-target <score>` — default 95

### Issue-driven plans (no `planning/` file)

If phases live in a **GitHub issue** (a human confirmed the TDD plan), the issue is the source of truth. Do **not** commit a `planning/` doc.

1. Render ephemeral `tasks.md` (+ optional `design.md`) into a **scratch / gitignored** dir. `.build-progress.json` and `logs/sN-e2e.log` live there. Nothing is committed.
2. Put phases on the issue as a **checkbox task-list** and/or sub-issues — the durable tracker.
3. Run `/agentloop:build-phases <scratch-dir>`. **Per phase = one commit** (TDD + 3-layer verification together), tick that checkbox, post a one-line progress comment.
4. Durable record = issue thread + checkboxes / sub-issues + merged PR(s) + git history.

**PR shape follows coupling, not phase count.** A phase is the commit unit; the PR is the review + merge unit.

- **One feature PR** (phases as commits; only the last commit `Fixes #N`) when phases are tightly coupled and early phases have **no standalone value** (a Phase 0 seam nothing consumes yet). Default for a coherent feature: one review, one merge, main never carries a half-feature.
- **One PR per phase** (`Refs #N`, final `Fixes #N`) only when each phase **independently ships** (unrelated doc deletions, or a step that can go live alone), or the diff is too large to review at once.

Autonomous mode: apply that test and state the choice in the PR body. A human present: you may ask.

**Autonomous escalation → issue comment, not an inline wait.** Post the blocker, the options, and your recommendation on the source issue; record `executor_status: "error"` + `executor_error` in the scratch progress file; stop that item without waiting in-session. Inline prompt only when a human is demonstrably present.

## How It Works

For each phase, in order: **1 IMPLEMENT** (TDD) → **2 VERIFY** (three layers; Layer 2 writes `logs/s{N}-e2e.log` — hard gate) → **3 COMMIT** `phase N: implement` → **4 SIMPLIFY** → **5 RE-VERIFY** Layer 1 (revert simplify on failure) → **6 COMMIT** `phase N: simplify` → **7 DESIGN REVIEW** (parent dispatches a **different** clean-context agent; below target → respawn the executor with the findings) → **8** a ≤3-line completion, then Phase N+1 immediately.

## CRITICAL: Execution Continuity

### Rule 1: A phase is atomic

Do not summarize or report until all 8 steps of the phase are done. The only mid-phase output is an escalation (hard stop).

### Rule 2: Do not stop between phases

When a phase completes, start the next. Do not ask the user to confirm. One short completion line, then the next phase.

### Rule 3: Final report only at the end

Stop only when (1) every phase is done → final report, (2) an escalation fires → ⏸ report and wait, or (3) the user interrupts.

### Rule 4: The parent session is the only spawner

Each invocation is **Init** (no `.build-progress.json`: pre-flight, write the checkpoint, spawn the first phase, schedule a wake) or **Watchdog** (file exists: read it, take **one** action, schedule the next wake or stop).

**The parent session is the only spawner.** One background sub-agent (`run_in_background: true`, `general-purpose`) executes exactly one phase and must not spawn the next. The parent schedules, runs the E2E log gate, and dispatches review. Primary wake is the executor's task-notification; `ScheduleWakeup(1800s)` is the stall fallback (heartbeat ≥ 30 min → `TaskStop` + respawn). The same phase at `executor_respawn_count ≥ 3` stops the loop and escalates. Do not trust the executor's self-report. On every wake, emit the tick report **before** acting (including `WAIT`). All phases done → final report, delete the progress file, do not reschedule.

When running the watchdog / executing a phase, read [reference/watchdog.md](reference/watchdog.md) and [reference/execute-phase.md](reference/execute-phase.md).

## Implementation Instructions

### Step 0: Dispatch by mode (this session never writes implementation code)

Read `<planning-dir>/.build-progress.json`. Missing → **Init**. Present → **Watchdog**.

**Init.** No design review on record, or last score < 95% → **STOP and run `/agentloop:design-review` first.** Parse `tasks.md` for `total_phases`. Write the initial progress file (`current_phase` = `--start-phase` or 0, `completed_phases: []`, `executor_status: null`). Spawn the first phase. `ScheduleWakeup(delaySeconds: 1800, prompt: "/loop /agentloop:build-phases <planning-dir>")`. Emit the init tick and `tail -f <executor_log>`.

**Watchdog.** One action from the state machine: spawn / gate+review / respawn (`TaskStop` the stale executor first) / stop. The parent's own hands are bookkeeping, the E2E log gate (bash), and dispatching the review agent. Findings go back to a respawned executor — the parent and the reviewer do not fix. Not done → `ScheduleWakeup(1800)`. Done → Step 3 final report, delete `.build-progress.json`, do not reschedule. Escalation (`respawn_count ≥ 3` on this phase, or `executor_status === "error"` with an unresolvable reason) → escalation report, do not reschedule.

### Step 0.5: Pre-code check (executor, every phase)

Before any code: **AFS-Only I/O**, **abstraction reuse**, **provider boundary**. A violation in `tasks.md` or in code you are about to write → **STOP and escalate**, even mid-phase.

### Step 1: Parse `tasks.md`

Collect each `## Phase N:` / `## Task N:` / numbered implementation section: name, acceptance criteria, test files, files to modify, dependencies. Two phases with no dependency (both marked 独立, or no cross-references) may run as parallel subagents — build the graph first.

### Step 1.5: Skip work that already exists

If the phase's files exist, have real content, and tests pass → SKIP ("already done"). Partial → implement only the gap. Do not redo another session's work.

### Step 2: Execute the phase

Independent phases: parallel subagents, then verify together. Otherwise sequential. Order inside a phase:

1. **2.1 IMPLEMENT** — tests first (they fail), then code. Parallel subagents only for independent sub-tasks.
2. **2.2 VERIFY — three layers, none skippable.** **Layer 1: Static — scoped per phase, the repo gate once at the end.** Per phase: `<package_manager> build`, `check-types`, and `--filter <affected-packages> test`. A dropped pass count → FAIL. **Do not run the full suite every phase.** After the **last** phase — and after that phase's review findings are fixed — run the repo gate **once**: `<verification_entry>` (arc: `pre-pr`). Do not substitute a raw `<package_manager> test`. `TIMEOUT` with `failed=0` → re-run once with the raise-only timeout override (arc: `ARC_VERIFY_TEST_TIMEOUT_MS`) and state the value; never when `failed>0`. **Layer 2:** follow the phase's `### E2E Verification (mandatory)` table (no table → STOP and escalate). **Hard gate:** not `done` unless `<planning-dir>/logs/s{N}-e2e.log` exists, is non-empty, holds raw JSON `afs_*` output (not a paraphrase), covers every call in the table plus one negative case, and admits no deferred work. **Layer 3:** at least one adversarial break (empty, oversize, `../`, kill mid-op, concurrency, prototype pollution); paste the output. Any failure → fix → re-run all three layers.
3. **2.3 COMMIT** — `<formatter>`, then `git add <specific-files>` only (never `-A`, never `git add -f` on ignored logs). A dependency edit **includes** its lockfile; an unrelated lockfile diff stays out. Message: `phase N: implement <description>`.
4. **2.4 SIMPLIFY** — skip under 50 lines of production code. Otherwise clarity only, recent files, no behavior change.
5. **2.5 RE-VERIFY** — Layer 1, scoped, not the full suite. If simplify broke it, revert and commit without simplify. Else `phase N: simplify`.
6. **2.6 DESIGN REVIEW — parent only**, after the E2E log gate, by a clean-context agent that is not the executor. Below `--review-target`, or an E2E log that is missing or unqualified, is NOT APPROVED. Respawn the executor with **all** findings in one batch, re-run scoped Layer 1, then review again. Same `respawn_count ≤ 3` budget. The reviewer does not edit.
7. **2.7 REPORT** — after approval, the completion block must include tests, three layers, the **E2E log path**, simplify, score, and commits. A missing log line means the hard gate failed. Then start Phase N+1 (Rule 2).

### Step 3: Final report

After the last phase: planning dir, N/total, test count before → after, PASSED, and **Repo gate (once, after the last phase):** `<verification_entry>` → PASS/FAIL @ sha7 plus the report path.

## Escalation Rules

Hard stops. Stop, report, and wait. Do not guess around them.

| Condition | When |
|---|---|
| **3 failures** | The same test/build/verify fails three times |
| **E2E log won't write** | After one Layer 2 attempt the log is missing, empty, or has no JSON. Do not forge it |
| **Spec ambiguity** | Two readings that change later phases |
| **External action** | Creds, env, an external service, a system package |
| **Architecture** | A design choice `tasks.md` missed, and it is irreversible |
| **Scope overflow** | Finishing the phase means changing code outside the spec, more than expected |
| **Coverage doubt** | The spec misses an important case you found |
| **Perf** | Layer 2 is >10× worse than expected |

Do **not** stop for a normal type error, a test failure with a clear cause, a bad import, one devDependency, lint, or a bug fixed on the first try. Above ~80% confidence it takes one or two tries: do it. Repeated failure or an unclear direction: stop.

When escalating, read [reference/escalation.md](reference/escalation.md).

## Key Principles

TDD every phase. Three-layer verification is mandatory (paste real output). Each phase leaves the system working. Simplify must not change behavior — revert if it does. Review checks the spec, not style. When unsure, run it. When stuck, escalate.

## ★ sweep-trace (required on every issue comment)

Every phase-progress comment ends with:

```html
<!-- sweep-trace: {"ver":1,"issue":N,"gate":"phase","val":"<val>","run":"<ISO8601>","runner":"<runner>","skills":"<hash>"} -->
```

This machine marker is how issue-sweep tells an agent verdict from human input. The identity header is not a marker. A comment without it is re-processed every round.

Field-by-field: [reference/sweep-trace.md](reference/sweep-trace.md).
