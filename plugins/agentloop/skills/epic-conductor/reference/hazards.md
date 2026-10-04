# epic-conductor — hazards

> On-demand reference for [`epic-conductor`](../SKILL.md) (§8).

## Fleet collision

Another runner opened a duplicate PR for your sub-issue. Keep the better one; close the twin with a
comment naming which PR continues and why.

## Worker transcript lost

Spawn a fixer on the existing worktree (it inherits the branch). Do not start over unless the tree
itself is gone.

## Main moved under a branch

Rebase only when `mergeable=CONFLICTING`, when the PR needs a feature that landed on main, or when a
red on the branch is already fixed on main. Being behind is not a reason: a rebase costs a new sha
and another test + review pass. Record the new head after the push. Document overlap and merge
order in the PR body.

## Out-of-scope findings

Open a follow-up issue. Never fold it in silently, never drop it.

## A red that is not this PR's

Root-cause it: bisect to the smallest red set and fix that, or open an issue with the evidence and
link it from the PR. "Flaky", "load" or "env" is not a cause; never re-run until green and never
raise a timeout to make it green.

## Bot review silence

A bot that has not commented is not a blocker. Late findings after merge go to
[`codex-review-backlog`](../../codex-review-backlog/SKILL.md); do not reopen the wave.

## Provider capacity (429)

A worker that dies on a capacity limit and one that fails its task both arrive as `status=failed`.
Classify, record, retry after the reset with `agent-retry.ts` ([capacity-retry.md](capacity-retry.md)).
Have workers WIP-commit partial work.

## Worktree cleanup

`git worktree remove` / `prune` leftovers at the end; never one whose PR is still open.
