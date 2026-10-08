# Step 4 in a Factory run: review in the run's own tree (arc#7707)

> Read from land Step 4 when `ARC_CODE_AGENT_RUN_ID` is set. The one-line rule lives in
> [SKILL.md](../SKILL.md); this file holds the why and the exact sequence.

## The rule

A Factory run keeps Step 4 as written: one **independent clean-context review** before the PR, its
findings fixed in one batch. What changes is **where the reviewer works**: it opens **no new
worktree**.

- The reviewer reads the **run's own tree** (the tree the run was dispatched into / its bound tree):
  `cwd` = that tree, reviewing `git diff origin/main...HEAD` (or `merge-base..HEAD`).
- It is **read-only**: no edits, no commits, no checkout. Run it as a clean-context subagent **without** `isolation: "worktree"`, or, when a
  separate run is wanted, a reviewer run whose `cwd` is the run's own tree. Never
  `git worktree add` a review tree (`.claude/worktrees/review-*`), never a copy of the clone.
- The fixer is the implementer's tree, as usual; the reviewer never writes there.

After delivery, the host reviews again: the approval drain (armed-epic members) or `arc work review
<change-set DID> --engine <an engine outside the coder set> --cwd <the run's tree>` (any other
Factory work; the ready-to-merge checklist names it) does the cross-engine review. The factory's
own ready-to-merge judgement (its cross-engine review check: a same-head review with
`reviewer.engine ∉ coderEngines`; its allowed-paths check) needs it. Land's review does not replace it, and it does not replace land's
review: the host's review comes after delivery, too late for land's fix batch.

## Why no new worktree (incident)

E1 round 3 (epic #7696): the #7691 coder ran land Step 4 and created two review trees inside the
factory clone (`git worktree add --detach .claude/worktrees/review-7691-2afbcf6` and `…-c`), hired
reviewer runs into them, then removed the trees before exiting. The host's W2 measurement saw the
trees appear and attributed them to whichever runs' windows covered them: an unrelated manual
review registered both, one reviewer registered another reviewer's cwd. Both registrations were
then refused at reclaim (`ownership-unproven`, `shared-registration`), correctly but forever.

The review itself was right; the trees were the defect. A reviewer that only reads the run's own
tree creates nothing for the host to attribute. W2 now also refuses a tree that is another run's
cwd or binding, so a stray tree no longer lands on the wrong run.

## Security panel

Where the diff touches auth / exec authorization / secrets / sandbox boundaries, the review is the **correctness + security** panel, both
reviewers read-only in the run's own tree. The host's cross-engine review is a single generic
reviewer and does not stand in for the panel.

## Everything else

Unchanged from Steps 4–5: one fix batch, package tests in the foreground
([headless-factory-run.md](../../../reference/headless-factory-run.md)), PR, the Change Set record,
then **ready to merge, human decision** (arc#7662). When the host review later asks for changes,
the drain resumes the run with the findings: one batch, tests, push, record the new head, end.

Outside a Factory run (attended), Step 4 is unchanged; a worktree for the reviewer is allowed there.
