# epic-conductor — neighbouring skills and the load-bearing idea

> On-demand reference for [`epic-conductor`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## Relationship to the neighboring skills (compose, don't replace)

epic-conductor does not supersede the others — it **reframes them as composable parts** at different altitudes and attendedness. Know which to reach for:

- **design-review** reviews a *plan/design document* (multi-perspective, clean-context per round) — it does not build. It is epic-conductor's **conditional plan review** (step 1): run it on the epic's design and your proposed decomposition *before* you dispatch workers **only when the design decisions are not already recorded by the human**, and then with `--max-rounds 2`. Complementary, upstream, not replaced.
- **build-phases** drives *one* issue as checkpointed phases in a *single* context — **no independent review between phases**. Its distinct niche survives: an **unattended** complex single issue (issue-sweep calls it), or one issue too big for a single shot yet not worth splitting into sub-issues. Inside a well-decomposed epic each sub-issue is already one-PR-sized, so a plain worker handles it and you rarely need build-phases *within* conductor — but it remains the right tool *outside* it. Where conductor's model dominates (attended + decomposable work): it inserts an independent clean-context review per unit, which build-phases' single-context phasing cannot.
- **pr-review** reviews *one* PR — it is the engine conductor's reviewer uses at §3.5 / §4 (`agentloop:pr-review`), before the PR is opened.
- **issue-sweep / pr-sweep** are the *unattended batch* over *existing* issues/PRs, single runner inline. conductor is the *attended* driver of a *new* epic with per-sub-issue fan-out. If no human is reachable, don't run conductor — use the sweeps' `needs-human-confirm` discipline.

Altitude ladder: **design-review** (a plan) → **epic-conductor** (an epic = many sub-issues) → { plain worker | **build-phases** } (one issue) → **pr-review** (one PR).

## The load-bearing idea (why it works — do not skip)

**Independent, clean-context review is the whole point.** A worker that just wrote the code cannot see the class of defect that a green test suite also cannot see: the **accept/reject-same-color** bugs — a check that rejects everything (so all reject-tests pass), a path that was only ever tested with text (so a binary bug hides), a check installed on two of three doors (so the untested door is wide open), a value that can be forged through an untested channel. A separate agent that starts from zero context, reads the diff adversarially, verifies every claim against live code, and **reproduces security findings against the code**, catches these. In practice this pattern has caught, per epic: an `exec` bypass letting any app write a user's whole space, a binary-content hash collapsing to one constant hash (forgeable signatures), a canonical-hijack via forged front-matter, a truncated scan silently deleting a subset. None had a failing test. Budget for the review; it is not optional overhead, it is the mechanism.

Corollary you enforce on every worker and reviewer: **the accept-path iron law** — any check that rejects bad input MUST also have a test asserting it admits good input, because "reject everything" satisfies every reject-only test.
