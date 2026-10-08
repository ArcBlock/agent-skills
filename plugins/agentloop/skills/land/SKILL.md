---
name: land
description: >-
  Take ONE thing (work DID, issue, PR, or the current topic) all the way to merged: prove it is
  one coherent piece of work, route an epic to epic-conductor, else implement → package tests →
  one clean-context review → PR → merge. Use for "finish this".
allowed-tools: Agent, Bash, Read, Grep, Glob, Skill, AskUserQuestion
---

# land — take one thing to merged

```
/agentloop:land <work DID | w_<32hex> | 40-char sha | issue# | PR# | url>
/agentloop:land <n1> <n2> …      # batch: one isolated subagent per target
/agentloop:land [one-line topic]  # no reference: coherence check first
```

| Flag | Default | Effect |
|---|---|---|
| `--merge=auto` | single target | tests green + review clean → merge |
| `--merge=confirm` | batch | stop at ready to merge, ask |
| `--merge=never` | — | stop at ready to merge |

Read `.claude/repo-profile.md` first (`repo_slug`, `default_branch`, `plugin_root`,
`package_manager`, `test_runner`, `agent_identity_script`, `comment_language`,
`change_set_record_entry`). No profile → `/agentloop:repo-setup`. Never hardcode repo literals.

land is a router plus a single-item driver. An epic goes to `/agentloop:epic-conductor`; a backlog
to `/agentloop:issue-sweep` / `/agentloop:pr-sweep`; a multi-phase plan to `/agentloop:build-phases`.

## Factory run (`ARC_CODE_AGENT_RUN_ID` set)

One turn only: run tests in the foreground and never end the turn waiting on a background shell or
child run. **Merge authority is human**: whatever `--merge` says, stop at ready to merge, post the
checklist comment + `needs-human-confirm`, report "ready to merge, human decision", end the run.
`merge-verified-pr.sh` exits 3 inside a run. Detail: [headless-factory-run.md](../../reference/headless-factory-run.md).

## Step 0 — Resolve the target

Look up `/work` first; GitHub is a projection, not identity:

```bash
arc --json afs exec /.actions/query --args '{"path":"/work","where":{"field":"meta.objectId","eq":"<DID>"},"limit":8}'
# Change Set @ sha:
arc --json afs exec /.actions/query --args '{"path":"/work","where":{"all":[{"field":"meta.workType","eq":"change-set"},{"field":"meta.head","eq":"<sha>"}]},"limit":8}'
```

A `/work` hit wins. A miss falls back to `gh issue view` / `gh pr view` (say it is an alias). An
issue and a PR both match → name both and ask. Argument shapes: [reference/resolve-target.md](reference/resolve-target.md).

## Step 1 — Coherence check (only without an explicit reference)

`single` needs all four: one sentence states it, one PR delivers it, the user pointed at it, it is
the current line of work. Otherwise `multiple` / `unclear`: report the enumeration, dispatch
nothing; never collapse `unclear` into `single`. With an explicit reference still check its state,
labels, and any existing PR or `agent:processing`. Detail: [reference/coherence.md](reference/coherence.md).

## Step 2 — Route

- **PR** → skip implementation; Step 4.
- **Epic** (own `epic` label, `epic:<own#>`, members, or ≥3 `#refs` in the body) →
  `/agentloop:epic-conductor`. `epic-managed` is not a criterion (sub-issues carry it too).
- **Issue** → Step 3 (optionally `/agentloop:issue-review` first when stale or vague).
- **No issue yet** → open one (symptom / root cause / evidence / known wrong fixes), identity line
  from `<agent_identity_script> --header`, `--body-file`; then Step 3.

## Step 3 — Implement (one isolated subagent)

One subagent, `isolation: "worktree"`; unrelated uncommitted changes never ride along. The brief:

- the issue number (the implementer reads it itself) and the wrong fixes you already ruled out;
- strict TDD; every rejection has an accept twin; mutation check (break the code, see red, restore);
- run **the changed package's tests** (`<package_manager> --filter <pkg> test`, or `<test_runner>
  <files>` outside a workspace package) and report the exact command and counts;
- branch `…issue-<N>…`; never `--no-verify` (pre-commit runs Biome on staged files);
- **stop and hand back** branch + worktree before opening a PR, so the review comes first.

Rationale and identity-line rules: [reference/implement-brief.md](reference/implement-brief.md).

## Step 4 — One clean-context review

A **different** subagent runs `/agentloop:pr-review` on `merge-base..HEAD` (or the PR), read-only.
Auth/authz, exec authorization, secrets/vault or sandbox boundaries → a panel:
`correctness` + `security`, the security reviewer reproducing the exploit against the code.

- Fix every P0–P2 finding in **one batch** in the implementer's worktree; re-run the package tests.
- P3 → a follow-up issue (or fold it in when it is the same kind). Never drop one silently.
- Re-review only the fix delta, and only when it is substantive or security-relevant.
- Bot inline comments (Codex etc.) are review input: verify, fix the real ones, reply in the thread.

Factory run: the reviewer reads the run's own tree and opens no worktree; the host's cross-engine
review follows delivery. See [reference/factory-run-review.md](reference/factory-run-review.md).

## Step 5 — Push, PR, record-change-set

Push; `gh pr create` with a Conventional Commits title and a body that starts with the identity
line, then `Fixes #<N>`, the tests run (command + counts), the review outcome. Writing onto an
existing PR body: pass `--prior-engines <existing engine set>` to the identity script. After the
create and after **every** later push, `record-change-set.sh`:

```bash
bash <plugin_root>/scripts/record-change-set.sh --entry "<change_set_record_entry>" --pr <PR URL>
```

Non-zero = not recorded: stop (no `|| true`). N/A forms: [reference/change-set-na.md](reference/change-set-na.md).

## Step 6 — Merge

```bash
bash <plugin_root>/scripts/merge-verified-pr.sh <PR#>   # squash, pinned to the current head sha
```

Rebase only when `mergeable=CONFLICTING` (then `record-change-set.sh` the new head); being behind
is not a reason. A red test is root-caused,
never re-run until green; a red the change did not cause gets an issue, linked from the PR.
Unattended (`AskUserQuestion` denied), or a batch without `--merge=auto`: stop at ready to merge,
comment the checklist, add `needs-human-confirm`. A PR a factory run delivered (`needs-human-confirm`,
its ready-to-merge checklist, a Change Set produced by a run) merges only when a person asked for it
here; never unattended. `merge-verified-pr.sh` then runs the repo's factory merge check
(profile `factory_merge_check_entry`; arc: `arc -i factory work merge-check`): independent approve on
the latest Change Set round AND the producer run path-compliant at the PR head. A refusal is final;
`arc work` state `ready-to-merge` alone does not check allowed paths. A person's fix-up push to a
factory PR moves its head past the reviewed round: hand it back to the factory (a new round), do
not merge around the check. After merging confirm `merged: true` and the
issue closed.

## Batch, stuck, convergence

- Batch: one worktree subagent per target. First run
  `bun <plugin_root>/scripts/check-pr-path-overlap.ts`; overlapping PRs cite each other and state
  the merge order. Report once at the end.
- Stuck: never retry the same failing action. The implementer rebuts the diagnosis with a good
  reason → adopt it. A P1 nobody can fix → stop at "PR open, not merged".
- Convergence: list everything not fixed here (issue, TODO, known gap) as `kind = <path>:<symptom>`.
  The same kind twice → widen the fix or open one class issue. Self-opened issues still open not
  dropping for three rounds → stop dispatching and hand the list to a person.

## Output

Per target: terminal state (merged / ready to merge / stuck), PR link, test command + counts, review
findings and their disposition, the next command, and the not-fixed-here list (print `opened=0` too).
