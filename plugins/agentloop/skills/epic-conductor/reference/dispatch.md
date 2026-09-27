# epic-conductor — worker brief, PR body, Change Set N/A

> On-demand reference for [`epic-conductor`](../SKILL.md) (§3). Moved out of SKILL.md in #7105.
> SKILL.md holds the dispatch steps; this file holds the brief template, the PR body, and the ledger N/A cases.

## Worker brief

Launch an Agent (`isolation: "worktree"`, model by weight — runtime / gates / security / data-model → opus; docs / mechanical / small blocklet → sonnet). Every brief includes:

- **Spec = the work DID.** `arc --json afs read /work/<id>.json` plus the `/work` query on `meta.objectId`. GitHub `gh issue view <n> --comments` is the projection alias **after** a `/work` miss, or to read human comments on `sourceUrl`. Also pass the epic's scope-decision comment.
- **Invariants**: strict TDD; the repo's I/O / architecture rules; reuse existing primitives (name them and their files) rather than re-inventing; no new error classes unless the repo lacks one; the accept-path iron law (a check that rejects bad input also has a test that admits good input).
- **Order**: implement → independent review → one batched fix → one gate → open the PR. While implementing, run only the targeted tests of the packages touched. The full `<verification_entry>` runs after the review findings are fixed, and only after the conductor releases a gate slot. It must PASS before push. Never `--no-verify`. Never skip the gate.
- **Timeout knob (raise-only)**: if the gate's test row reports `TIMEOUT` with `failed=0`, re-run it once with the repo's test-timeout override (arc: `ARC_VERIFY_TEST_TIMEOUT_MS=<ms>`, which can only raise the budget) and state the value in the report. Never use it when `failed>0`.
- **Report back**: work DID, Change Set `head` (40-char), projection PR#/URL if `sourceUrl` exists, decisions made, gate results, bot P1/High status (fixed sha / REJECT thread / OPEN), deviations and concerns. Raw facts, no marketing. A GitHub PR number is a projection, not identity.

When the worker returns, the conductor re-asserts `agent:hold` + `epic-managed` + `epic:<n>`. That is a safety net, not the first time those labels appear.

## PR create

Codex P1 on arc#3558: the window between `gh pr create` and the conductor learning the PR number is when hourly `pr-sweep` can still grab an unlabeled PR. The create command carries `epic-managed`, `epic:<epic#>`, and `agent:hold` in one shot. Opening bare and labeling later is not the primary path. If a tooling gap creates a bare PR, the first action is `gh pr edit` adding those three labels, before any long verify wait.

PR title is Conventional Commits. The body starts with the repo identity line (`scripts/agent-identity.sh`, or whatever the repo profile names), then summary, design decisions, acceptance evidence, `Closes #<n>`, and the repo's footer.

Post `<verification_entry> --comment <PR#>` right after create. It reuses the same-SHA PASS the gate just produced, so it costs nothing and runs no checks.

## Change Set ledger

`record-change-set.sh` hands the repo's work-ledger command the pushed PR head, the PR base, and the changed files. `--work` is the member work this PR serves (the sub-issue's work DID), never the epic: a Change Set hangs off the member, and the ledger refuses an epic run that names none ("epic run: name the member work"). The same head again is a replay (no new round). A new push is round + 1.

A non-zero exit means the Change Set is not on the ledger. Stop and report it. Never continue as if it were recorded, and never append `|| true`.

Three N/A shapes, none of which is a defect to route around:

- A repo without a work ledger sets the profile key to `none`. The script says "not recorded".
- Outside a factory run the ledger command prints its own N/A.
- **`Change Set: not recorded (N/A: arc <ver> lacks work changeset)`** — this host's installed `arc` predates `work changeset` (arc#7081, a normal in-flight-upgrade state). No Change Set was recorded for this run on this host, and the merge gate's Change Set check does not apply there either.

## Bots and advisory gates during dispatch

Bot review is not waited on (see SKILL §6 and the shared receipt protocol). The worker folds bot findings into the next fix batch: one push and one `<verification_entry> --comment <PR#>` per batch, never per finding, and records the new head. It does not merge.

Advisory gates (arc: e2e-gate / ui-verify / native-verify — profile `additional_merge_gates` is `[]`) are not re-run per push. A UI PR keeps current screenshots in the PR body (author discipline, refreshed once on the final head if the UI changed).
