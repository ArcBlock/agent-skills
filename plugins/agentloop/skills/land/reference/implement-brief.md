# land — implementer brief (why)

> On-demand reference for [`land`](../SKILL.md) Step 3.

## Worktree isolation

The current checkout may carry unrelated uncommitted changes; working in place rolls them into the
branch. Isolation is not optional.

## Why the traps belong in the brief

The wrong fixes you ruled out while diagnosing — especially the obvious-but-wrong one — are the most
valuable part of the brief. Left out, the implementer walks the same dead end again.

## accept-path

Testing only "bad input is refused" proves nothing: a refuse-everything implementation passes every
reject assertion. Each rejection needs a test that the good input is accepted.

## prior-engines (arc#6184)

The identity line comes from `agent_identity_script`. Writing onto an **existing** PR body passes
`--prior-engines <existing engine: set>` so a later engine is appended, not substituted (overwriting
let another coder engine's reviewer read a false pass). A new PR has no prior set; a comment's
identity is this session only.

## Tests: the changed package, run for real

The implementer runs the changed package's own tests and reports the exact command and the counts.
`tsc` or a build is not a test run. Nightly full build + test on the default branch is the catch-net
for everything wider.

## Change Set replay

`record-change-set.sh` hands the repo's ledger command the pushed head, the PR base and the changed
files. The same head again is a replay; a new push is round + 1. A non-zero exit means not recorded:
never swallow it with `|| true`.

## Root cause before fix (#4323) and approved lessons (#4328)

- After 2 failed fix attempts on the same failure, stop patching — trace the failure to its root cause (input → state → failure site) and state the root-cause hypothesis in 1 line before trying fix #3.
- When `<lesson_ledger_dir>/absorbed.yaml` exists, include matching `status: absorbed` / `promoted` entries (`id` + `rule_home` + 1-line trap) in the implementer brief (`candidates/pending/` is never grounding; if an entry conflicts with shipped code, shipped code wins — flag `ledger stale: <id>`).
