# epic-conductor — worker brief, PR body, Change Set N/A

> On-demand reference for [`epic-conductor`](../SKILL.md) (§3, §6).

## Worker brief

Launch an Agent (`isolation: "worktree"`, model by weight). Every brief includes:

- **Spec = the work DID.** `arc --json afs read /work/<id>.json` plus the `/work` query on
  `meta.objectId`. `gh issue view <n> --comments` only after a `/work` miss, or to read human
  comments on `sourceUrl`. Also pass the epic's scope comment.
- **Invariants**: strict TDD; the repo's I/O and architecture rules; reuse existing primitives (name
  them and their files); no new error classes unless the repo lacks one; the accept-path law (a
  check that rejects bad input also has a test that admits good input).
- **Order**: implement → run the changed package's tests → hand back (branch + worktree). The
  review comes before the PR. Never `--no-verify`.
- **Report back**: work DID, head sha, test command + counts, decisions, deviations and concerns.
  Raw facts, no marketing.

When the worker returns, re-assert `agent:hold` + `epic-managed` + `epic:<n>`.

## PR create

The window between `gh pr create` and the conductor learning the PR number is when an hourly
`pr-sweep` can grab an unlabeled PR (arc#3558), so the create carries `epic-managed`,
`epic:<epic#>` and `agent:hold` in one call. A bare PR gets `gh pr edit --add-label …` before
anything else.

Title: Conventional Commits. Body: identity line (`agent_identity_script`), summary, design
decisions, tests run, review outcome, `Closes #<n>`.

## Change Set ledger

`record-change-set.sh` hands the repo's work-ledger command the pushed head, the PR base and the
changed files. `--work` is the member work this PR serves, never the epic (the ledger refuses an
epic run that names none). The same head again is a replay; a new push is round + 1. Non-zero
means not on the ledger: stop and report, never `|| true`.

N/A shapes, none a defect: the profile key is `none` (no ledger); outside a factory run the ledger
command prints its own N/A; `Change Set: not recorded (N/A: arc <ver> lacks work changeset)` on a
host whose `arc` predates `work changeset` (arc#7081).
