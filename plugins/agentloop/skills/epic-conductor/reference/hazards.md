# epic-conductor — hazards (full handling)

> On-demand reference for [`epic-conductor`](../SKILL.md) (§8). Moved out of SKILL.md in #7105.
> The decision in each case stays in SKILL.md. This file is the incident shape and the longer procedure.

## Fleet collision

Another runner opened a duplicate PR for your issue. Keep the better one. Dedup-close the twin with a coordination comment that names which PR continues and why. Do not leave two open PRs on the same sub-issue.

## Worker transcript lost

Resume fails because the transcript is gone. Spawn a fixer on the existing worktree (it inherits the branch). Do not open a second worktree and do not start the sub-issue over unless the tree itself is gone.

## Main moved under a branch

Rebase **only** when `mergeable=CONFLICTING`, when the PR genuinely needs a feature that landed on main, or when a red on the branch is **already fixed on main**. The gate cannot attribute that last one by itself: `--blocked-by` needs an open witness issue and refuses diffs that touch build inputs. Resolve keeping both sides, and record the new head after the push (`record-change-set.sh` with the member work DID). A non-zero record stops you.

**Being behind main is not a reason to rebase.** Merge-load judges the merge against the current tip. A rebase costs a new SHA, a full gate, a review round, and every sticky. Document overlap and merge order in the PR body. Squash-merge is allowed. Confirm a red on merge-base / main before treating it as this PR's defect.

## Out-of-scope findings

A reviewer or bot surfaces something real but outside this PR's scope. Open a follow-up issue. Never silently fold it into this PR. Never drop it.

## A red that is not this PR's

There are exactly two ways forward.

1. Root-cause it. Bisect to the smallest red combination and fix that. The repo's flake discipline applies (arc: `docs/architecture/flake-root-cause-discipline.md`). "Flaky", "load", or "env" is not a cause.
2. Let the gate attribute it. File or find the open witness issue and re-run `<verification_entry> --comment <PR#> --blocked-by <issue#>`. The gate itself decides (arc: `PREEXISTING` / `LOAD_FLAKE`) or stays FAIL and says which precondition failed.

Never "just re-run it". Never raise a timeout to make it green. Never treat it as non-blocking — a FAIL sticky blocks the merge gate. The only timeout exception is the raise-only knob for `TIMEOUT` with `failed=0` (SKILL §3).

The witness issue is human-supplied. The gate checks that it exists and is open, not that it caused the red. Read the refusal. Do not route around it.

## Bot-review multi-hour hang

Treating Codex silence, or waiting for a fresh thumb after a fix, as a hard gate freezes the wave while the real gates are already green. Obey the inline-review rules: no inline wait, one `bot-clean.ts` check before merge. One short wait (≤10 min) only when the last push is under 10 minutes old and a vendor is `running`, `incomplete`, `stale`, or `absent`. Late comments go to `codex-review-backlog`. Do not reopen the wave.

## Provider capacity (429)

A worker that dies on a provider capacity limit and a worker that fails its task both arrive as `status=failed`. The work is dropped unless you classify the death. Do not re-dispatch blindly and do not treat a 429 death as a task outcome.

Classify, record, retry after the reset with `agent-retry.ts`: `record` (harness death text **verbatim** in `--summary-file`) → `due` → `bump --holder-pid $$` **before** dispatch → `resolve`. Have workers WIP-commit partial work and pass `--wip`. Commands and the classifier contract: [capacity-retry.md](capacity-retry.md).

## Worktree cleanup

`git worktree remove` and `git worktree prune` leftover worktrees at the end of the epic. Do not delete a worktree whose PR is still open and unmerged.
