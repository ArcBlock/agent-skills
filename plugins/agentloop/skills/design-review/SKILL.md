---
name: design-review
description: >-
  Iterative clean-context review of a design / plan document or issue: independent reviewers per
  round, scored and synthesized without prior-round bias. Use to review an implementation plan,
  architecture doc or design proposal before building.
---

# Design Review — Iterative Clean-Context Review Loop

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic; arc is the reference implementation. Where it references repo identity or paths, read the profile (`repo_slug` etc.). Arc's own provenance for any lessons is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

Review a design with clean-context subagents. Each round is a fresh reader: no inherited bias, and the reviewer does not modify files.

## Usage

```
/agentloop:design-review <path> [--target <score>] [--max-rounds <n>]
```

- `<path>` — a design file, or a directory with `design.md` + `tasks.md`
- `--target <score>` — default 95
- `--max-rounds <n>` — default **2**. Raise it only when a human asks.

```
/agentloop:design-review planning/provider-architecture-rethink/
/agentloop:design-review intent/my-feature/INTENT.md --target 90
/agentloop:design-review planning/my-plan/ --target 95 --max-rounds 2
```

**Run it when it earns its cost.** Skip when the human has already recorded the design decisions (a decision list or pinned comment they wrote or approved) — say so where the plan lives. Otherwise run it, capped at 2 rounds. A plan that is not converging after 2 clean-context rounds needs a human decision, not a third reviewer.

### Issue-driven plans (no `planning/` file)

When the plan lives in a **GitHub issue** (the human confirmed it in comments), do **not** commit a `planning/` doc.

1. Render an ephemeral `design.md` / `tasks.md` into a **scratch / gitignored** dir and run `/agentloop:design-review <scratch-dir>` on it.
2. At the target score, **post the final plan back to the issue** — that comment is the durable artifact.
3. Add a short round summary (rounds used, and the key change each round). Discard the scratch file.

**Autonomous escalation — ask via an issue comment, never block in-session.**
In the issue-native flow nobody is babysitting the session, so an escalation
that would normally call `AskUserQuestion` and wait **must instead be posted as
a comment on the source issue** and the run paused there. If the review loop hits
an unrecoverable point — a genuine design fork, an `AskUserQuestion`-worthy
ambiguity, a needed architecture change, or an AFS-principle conflict (see the
ESCALATION list under "Step 5: Fix Issues") — do **not** sit waiting for an
inline answer. Post a clear, self-contained question comment on the issue (state
the options, your recommendation, and what's blocked), then stop that work item.
The human answers asynchronously on the issue; the next sweep picks it up. Only
fall back to inline `AskUserQuestion` when a human is demonstrably present and
interacting in this session.

**Carve-out:** issue-native rendering is only for *transient* feature plans. Durable specs (`docs/architecture/*`, protocol specs, `intent/*/INTENT.md`, conformance targets) are reviewed in place. (`issue-sweep` drives the feature/design handoff.)

## How It Works

Step order, do not reorder:

0. **Classify** the document (strategy + whether `tasks.md` is required).
0.5 / 3. **tasks.md check** — generate, review without it, or skip.
1. **Clean-context round** — a read-only subagent with no parent history. It reads the docs, checks them against code, dry-runs the plan, and returns a score plus APPROVED / NOT APPROVED.
2. **Stop or fix.** Score ≥ target (and the hard requirements below) → APPROVED, stop. Round == maxRounds → stop and report the score plus what remains. Otherwise fix, commit, next round.

When classifying or scoring, read [reference/dimensions.md](reference/dimensions.md). The loop diagram: [reference/review-loop.md](reference/review-loop.md).

## Implementation Instructions

### Step 1: Parse arguments and discover files

`path` is required. `target` defaults to 95. `maxRounds` defaults to 2. A directory: collect `design.md`, `tasks.md`, `plan.md`, `INTENT.md`, `README.md`, and other planning files in it.

### Step 2: Classify (check in this order)

1. **Post-mortem / Record** if ALL of: mostly past tense or "已完成"; commit refs; no "待做" section of concrete unfinished work.
2. **Implementation Plan** if ANY of: a `tasks.md` beside it; numbered phases with file paths, function names, or test specs; task-level "Add X to Y".
3. **Design / Architecture** if it is problem, alternatives, trade-offs, and decisions ("what and why", not step-by-step). "待做" / "Phase N" here is design-level.
4. **INTENT.md** if the file is named INTENT.md and specifies API, behavior, and boundaries.

Print the classification before continuing: document type, review strategy, test-coverage hard requirement yes/no.

Should have `tasks.md` when the doc describes future implementation that can be decomposed (待做 / Phase N with concrete changes, unimplemented features with enough detail, proposed fixes). Should **not** when the work is already done, the doc is only analytical, or it is a decision record / post-mortem.

### Step 3: `tasks.md` — decide, don't stall

**Unattended (no human; the hook denies `AskUserQuestion`): do not ask. Default to option 1** — generate `tasks.md` from the design with the test-coverage hard requirement ON, then review.

Interactive, when a human is present, ask with three options:

1. Generate `tasks.md`, then review (Implementation Plan strategy, hard requirement ON).
2. Review the current doc only (no test-coverage hard requirement).
3. Generate `tasks.md` and stop.

A document that should not have `tasks.md` skips this step. Generation rules (6 test categories, `⚠️ NEEDS DECISION`, no duplicated rationale): [reference/tasks-md.md](reference/tasks-md.md).

### Step 4: Run the review loop

For each round from 1 to maxRounds, launch a **clean-context, read-only** subagent. The prompt depends on the type from Step 2; `{previousScore}` is empty on round 1 and ` — 上一轮 {score}%` after that.

**Hard requirements (a miss is NOT APPROVED regardless of score):**

- **Implementation plan:** every phase covers 6 test categories (happy path, bad input, security, data loss, data damage, data leak). Missing any category is a must-fix; missing 2 or more → NOT APPROVED. Every phase has a concrete `### E2E Verification (mandatory)` section (named session, real `afs_*` calls, expected JSON, one negative case) — missing or "tests passed" with no call → NOT APPROVED.
- **Implementation plan and design/architecture:** every current-state claim is grounded at `path:line` (**code wins** over planning docs; mark the doc stale) and every number is measured (command + output) or explicitly an unverified estimate. An ungrounded claim or an invented number → NOT APPROVED.
- **Design/architecture:** an AFS-Only I/O, abstraction-reuse, or provider-boundary violation → CRITICAL → NOT APPROVED. Test coverage is a recommendation, not a requirement.
- **Post-mortem:** a factual error (commit, path, signature, behavior) → NOT APPROVED. AFS compliance is informational.

Parse the score and the issue list. Then:

- Verdict is APPROVED (score ≥ target **and** the hard requirements passed; `NOT APPROVED` does not count) → **stop, success**.
- Round == maxRounds → **stop**, report the score and the remaining issues.
- Otherwise → **Step 5**, then the next round.

When running a review round, read [reference/prompts.md](reference/prompts.md).

### Step 5: Fix Issues (between rounds)

Fix documentation accuracy and completeness only. Do **not** change architecture direction.

- Doc-vs-code gaps: correct the claim or the stale reference.
- Consistency: numbering, names, cross-references.
- Dry-run holes: missing dependencies, unclear steps.
- Test omissions (implementation plans only): add the missing cases to that phase in `tasks.md`.
- AFS-Only I/O bypass, or a design that reimplements an existing AFS capability: **must fix** (that is a design error, not a wording nit).

**ESCALATION — stop and ask:**

- You do not know the right design direction.
- The reviewer's alternative and the original design are both reasonable.
- The fix would rewrite a section's design, not a sentence.
- The design seems to require bypassing AFS. Ask — there is almost always another way.

**Do not make the architecture decision yourself.** How you ask depends on mode. Interactive: `AskUserQuestion`. Issue-native: do **not** block in-session — post the question as an issue comment (options, your recommendation, what is blocked) and stop that item. See **Autonomous escalation** above.

After the fix, commit, so the next round's subagent sees the files.

### Step 6: Report

```
## Design Review Complete

**Document:** {path}
**Type:** {document type}
**Rounds:** {roundsUsed} / {maxRounds}
**Score progression:** {round1}% → … → {final}%
**Status:** APPROVED ✓ / NOT APPROVED (best: {score}%)
```

If approved, list remaining non-blocking issues from the last round.

## Key Principles

1. Each subagent is fresh — no prior round and no parent conversation.
2. The reviewer never edits. The main agent fixes.
3. The score is implementability: could a developer with no project background build this from the docs alone?
4. Document type picks the strategy. Do not apply implementation-plan requirements to a post-mortem, and do not skip them on a real plan.
5. `tasks.md` generation is opt-in when a human is present; unattended mode defaults to generate (Step 3). Never invent architecture to fill a gap.
6. For an implementation plan, every I/O phase's tests cover path traversal, prototype pollution, injection, resource exhaustion, namespace isolation, roundtrip, binary, unicode, concurrency, and failure atomicity.
7. Each phase keeps existing tests and behavior working.
8. Grounding is a **HARD REQUIREMENT**: current-state claims need `path:line` (code wins); a number is measured or labeled an unverified estimate, otherwise delete it. A design on a wrong foundation is not APPROVED.

Essays: [reference/principles.md](reference/principles.md).

## ★ sweep-trace (required on every issue comment)

Every design-review comment posted to an issue ends with:

```html
<!-- sweep-trace: {"ver":1,"issue":N,"step":"design","val":"<val>","run":"<ISO8601>","runner":"<runner>","skills":"<hash>"} -->
```

This is the machine marker issue-sweep uses. The identity header is not a marker. Without the trace, the comment is treated as unhandled human input and repeated every round.

Field-by-field: [reference/sweep-trace.md](reference/sweep-trace.md).
