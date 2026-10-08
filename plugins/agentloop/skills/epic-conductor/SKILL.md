---
name: epic-conductor
description: >-
  Attended end-to-end implementation of a whole epic: decompose into sub-issues, one isolated
  worker each, package tests, one clean-context review, one batched fix, PR, merge, next wave.
  Use to build an epic with a reachable human.
allowed-tools: Agent, Bash, Read, Grep, Glob, Edit, Write, Task, AskUserQuestion, Skill
---

# epic-conductor — drive a whole epic to merged

Read `.claude/repo-profile.md` first (`repo_slug`, `default_branch`, `plugin_root`,
`package_manager`, `test_runner`, `agent_identity_script`, `change_set_record_entry`).

You are the **conductor**: you decompose, dispatch, route reviews and merge. You do not write the
feature code, and you stay for the whole epic. Use it when a reachable human hands you an epic; not
for one issue (`land` / `build-phases`) or unattended batches (`issue-sweep` / `pr-sweep`).
Why independent review is the point: [reference/background.md](reference/background.md).

## Invariants

- **Resident, serial-inline.** React to completions; no nested Workflow, no plan mode; decisions
  live in issue/PR comments.
- **Live hired children.** Hired factory/worker children still `status=running` (pid alive) make
  it **forbidden** to `end_turn` / close the session. Allowed: true closeout after each hire has
  GitHub evidence (PR URL or skip-comment) **or** the child was explicitly `stop`ped. Before
  treating yourself as done:
  ```bash
  bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/skills/epic-conductor/scripts/assert-no-live-children.ts" \
    --runs-dir "$(arc service status --print home 2>/dev/null || printf '%s' "$HOME")/.afs/code-agents/runs" \
    --ids <hired-id>,<hired-id>
  ```
  Exit 0 only when none is live. A ghost (`running`, dead pid) does not block; factory cockpit rows
  are `pid=-1` and the watchdog must fail-closed on them (live, not ghost).
- **Factory run** (`ARC_CODE_AGENT_RUN_ID` set): one turn; tests in the foreground; block-poll child
  runs. **Merge authority is human**: stop at ready to merge, report "ready to merge, human
  decision", end the run; dispatch only members whose dependencies are already merged
  ([headless-factory-run.md](../../reference/headless-factory-run.md)).
- **Workers ~3**, each `isolation: "worktree"`. Workers never merge. Model by weight: runtime /
  security / data-model → opus; docs / mechanical → sonnet.
- **Identity = work DID**, not the issue number:
  `arc --json afs exec /.actions/query --args '{"path":"/work","where":{"field":"meta.objectId","eq":"<DID>"},"limit":8}'`

## The loop

**0. UI design first** (user-facing UI only) — see [reference/loop-detail.md](reference/loop-detail.md).

**1. Decompose** into dependency-ordered, PR-sized sub-issues, in waves; one GitHub issue each
(spec, accept-path acceptance criteria, constraints, file pointers, dependencies, "one PR; do not
merge"). Human decisions not yet recorded → `/agentloop:design-review <path> --max-rounds 2` first.
Pin a scope comment (this wave / deferred / handled). Safe-default ratchet: "proceeding with X,
object if wrong"; ask only on a real fork; never package decomposable work as a menu.

**2. Fence off.** `epic-managed` + `epic:<epic#>` on the epic, every sub-issue and every PR;
`agent:hold` until merge (sweeps skip them). Detail: [reference/loop-detail.md](reference/loop-detail.md).

**3. Dispatch** one worker per ready sub-issue. Brief: the work DID as spec (`gh issue view` only
after a `/work` miss), the scope comment, strict TDD, the accept-path law, reuse named primitives,
run the changed package's tests (`<package_manager> --filter <pkg> test`) and report command +
counts, never `--no-verify`, **stop and hand back before opening the PR**. Template:
[reference/dispatch.md](reference/dispatch.md).

**4. One clean-context review** per sub-issue, by an agent that is not the worker:
`/agentloop:pr-review` on `merge-base..HEAD`, read-only. Auth/authz, exec authorization,
secrets/vault, sandbox boundaries → a panel, `correctness` + `security`, the security reviewer
reproducing the exploit against the code; then one synthesis. A crashed reviewer is uncertain, never a pass.

**5. One batched fix.** Run the findings through `compact-findings.ts` against the current head:
```bash
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/skills/epic-conductor/scripts/compact-findings.ts" <raw-findings.json>
```
The fixer (the worker, or a fixer on its worktree): every still-valid **P0–P2** in one batch, the
package tests; once the PR exists, one push, then `record-change-set.sh --work <member DID>` for the
new head; **P3 → a follow-up issue**. Re-review only a substantive or security fix delta.
Detail: [reference/fixer.md](reference/fixer.md).

**6. PR.** Push; `gh pr create` with `--label epic-managed --label "epic:<epic#>" --label agent:hold`
in the same call; body = identity line, summary, tests run, review outcome, `Closes #<n>`. After the
create and every later push:
```bash
bash <plugin_root>/scripts/record-change-set.sh --entry "<change_set_record_entry>" --work <member work DID> --pr <PR URL>
```
`--work` is the member DID, never the epic. Non-zero = not recorded: stop (no `|| true`). Bot
inline comments arriving later are review input: fix real ones in the next batch, reply in the
thread; never wait on a bot.

**7. Merge** (the conductor only; never inside a factory run; a hired factory child's PR only once
`arc work` shows it `ready-to-merge`; `merge-verified-pr.sh` then runs the factory merge check —
independent approve + producer path-compliant at the head — and its refusal is final): review clean (no open P0–P2), the
package tests green on the head, every actionable thread answered, `mergeable=MERGEABLE` (rebase
only on `CONFLICTING`; `record-change-set.sh` the new head after the push). Security-sensitive PRs get a short risk
summary (opens / why safe / residual / revert) first. Then drop `agent:hold` and
```bash
bash <plugin_root>/scripts/merge-verified-pr.sh <PR#>
```
delete the branch, dispatch the next wave.

**8. Hazards** — duplicate PR, lost transcript, main moved, out-of-scope finding, a red that is not
this PR's, provider capacity (429): [reference/hazards.md](reference/hazards.md),
[reference/capacity-retry.md](reference/capacity-retry.md).

**9. Closeout.** Read the nightly result covering the last merge (green → record it; red → link its
issue, not cohesive yet). Drive the epic's thesis end to end on real infrastructure; say
user-reachable vs mechanism-level. UI → screenshots of every real surface in one walkthrough
comment. Close the issues, clear the labels, report URLs. Detail: [reference/closeout.md](reference/closeout.md).

## Mental model

Decompose → fence → { worker → package tests → one review → one fix batch → PR → merge } →
nightly → closeout.
