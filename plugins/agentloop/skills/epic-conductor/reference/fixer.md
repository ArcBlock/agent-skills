# epic-conductor — compact findings, then one fixer

> On-demand reference for [`epic-conductor`](../SKILL.md) (§5). Moved out of SKILL.md in #7105.

## Why compact is mandatory

Before a fixer is dispatched, run the raw pile (independent-review findings + bot P1/High + any still-open inline comments) through `compact-findings.ts`. It judges each finding against the **current PR HEAD**, not the commit it was originally posted against — GitHub reassociates stale `commit_id`s onto new HEADs — and returns `still-valid` / `stale` / `duplicate` for every one, never a bare count.

The fixer brief is `fixerBrief(compacted)`: **only** `still-valid` entries. A conductor that skips this step and hands the fixer the raw pile is not following the skill. That is exactly the failure this step exists to close: fixers re-fixing already-patched defects, and two bots on one line producing two fix attempts.

Compact's only permitted failure mode is under-killing. A finding it cannot judge (no expected-snippet to compare, or the file or line is unreadable) stays `still-valid`. Losing a real P1 silently is strictly worse than keeping a stale one one round longer.

## Who fixes, and conflicting Highs

If the verdict is BLOCK or COMMENT with real findings, or a bot left a legit P1/High, route the compacted still-valid findings to a fixer.

- Prefer resuming the original worker with the consolidated findings (comment id + `path:line` + intended direction).
- If its transcript is gone, spawn a fixer on its existing worktree (pass the worktree path; it inherits the branch).
- **Conflicting bot Highs are one synthesis, not a ping-pong.** If fix A (to satisfy finding 1) *is* finding 2, do not undo A and do not ignore 2. Keep the constraint from 1 and the accept-path from 2 in **one** commit.

The fixer fixes every still-valid finding of the round (review + bot + human) in one batch and pushes once, records the new head's Change Set, runs `<verification_entry> --comment <PR#>` once for that head after the conductor releases a gate slot, replies in-thread on every cited comment id (`gh api …/pulls/{n}/comments/{id}/replies` — never a new top-level PR comment), and does not merge.

## What is not a gate run

A finding that only asks to reword prose or a code comment, and is not P1/High, gets an in-thread reply and rides along with the next substantive fix batch, or is deferred with a follow-up per the inline-review rules. Never make a standalone commit and re-run the gate for it alone after a PASS.

Re-review if the fix was substantial or security-relevant — incrementally, on the fix delta only. A security fix deserves a second independent agent that runs the original exploit against the patched code.
