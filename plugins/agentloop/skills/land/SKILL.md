---
name: land
description: >-
  Use when asked to "finish this" or land ONE target (work DID, issue, PR,
  or topic) all the way to merged, or a batch of explicit targets via
  /agentloop:land.
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
`change_set_record_entry`, `lesson_ledger_dir`). No profile → `/agentloop:repo-setup`.

land is a router plus single-item driver. Epic → `/agentloop:epic-conductor`; backlog →
`/agentloop:issue-sweep` / `/agentloop:pr-sweep`; multi-phase → `/agentloop:build-phases`.

## Factory run (`ARC_CODE_AGENT_RUN_ID` set)

One turn only: run tests in the foreground; never wait on a background shell or
child run. **The host merger merges** (#8182): stop at ready to merge, post
the checklist comment (no label), report "ready to merge — host merger", end run.
`merge-verified-pr.sh` exits 3. Detail: [headless-factory-run.md](../../reference/headless-factory-run.md).

## Step 0 — Resolve the target

Look up `/work` first; GitHub is a projection, not identity:

```bash
arc --json afs exec /.actions/query --args '{"path":"/work","where":{"field":"meta.objectId","eq":"<DID>"}}'
# Change Set @ sha:
arc --json afs exec /.actions/query --args '{"path":"/work","where":{"field":"meta.head","eq":"<sha>"}}'
```

A `/work` hit wins. Unreadable `/work` is not a miss: use the brief from `arc --json afs exec /dev/code-agents/.actions/read-bound-work --args "{\"id\":\"$ARC_CODE_AGENT_RUN_ID\"}"` and do not fall back to `gh issue view`. Details: [reference/resolve-target.md](reference/resolve-target.md).

## Step 1 — Coherence check (only without an explicit reference)

`single` needs all four: one sentence, one PR, user pointed at it,
current line of work. Else `multiple` / `unclear`: report enumeration,
never collapse `unclear` into `single`. With an explicit ref check state,
labels, PR / `agent:processing`. Detail: [reference/coherence.md](reference/coherence.md).

## Step 2 — Route

- **PR** → skip implementation; Step 4.
- **Epic** (`epic` label, `epic:<own#>`, members, ≥3 `#refs`) →
  `/agentloop:epic-conductor`. `epic-managed` is not a criterion.
- **Issue** → Step 3 (optionally `/agentloop:issue-review` first).
- **A work with no GitHub issue** (`/work` hit with no `refs` / `sourceUrl`) →
  Step 3 with the work object as brief. Never open an
  issue for it.
- **No issue yet** → open one, identity line
  from `<agent_identity_script> --header`, `--body-file`; Step 3.

## Step 3 — Implement (one isolated subagent)

One subagent, `isolation: "worktree"`. The brief:

- the issue number — or, for a work with no issue, the delivered brief (`read-bound-work`, not `gh issue view`, when `/work` is unreadable) — and wrong fixes ruled out;
- if `<lesson_ledger_dir>` ≠ `none`, read `<lesson_ledger_dir>/absorbed.yaml` (`status: absorbed`/`promoted` only; never `candidates/pending/`) for matching `<pkg>`/`<domain>`;
- strict TDD; every rejection has an accept twin; mutation check (break, see red, restore);
- run **the changed package's tests** (`<package_manager> --filter <pkg> test`, or `<test_runner> <files>`) and report command + counts;
- branch `…issue-<N>…` (`…<w_id>…` without issue); never `--no-verify`; **stop and hand back** branch + worktree before opening a PR ([reference/implement-brief.md](reference/implement-brief.md)).

## Step 4 — One clean-context review

A **different** subagent runs `/agentloop:pr-review` on `merge-base..HEAD` (or the PR), read-only.
Auth/authz, exec, secrets/vault or sandbox → a panel: `correctness` + `security`, reproducing the exploit against the code.

- Fix every P0–P2 in **one batch** in the worktree; re-run package tests.
- P3 → noted, not filed under **Noted, not filed**; never an issue ([issue closure](../../../../../docs/architecture/issue-closure-discipline.md)).
- Re-review only the fix delta when substantive/security. Verify and fix real bot comments.
- Factory run: reviewer reads the run's own tree ([reference/factory-run-review.md](reference/factory-run-review.md)).

## Step 5 — Push, PR, record-change-set

Push; `bun scripts/gh-rest/gh.ts pr create --repo <repo_slug> --base <default_branch>` with Conventional Commits title, identity line, `Fixes #<N>` (no issue: `Work: <did>`; accept-stage all PASS adds `Fixes #<source>` from `followUpOf`), test command + counts, review outcome. Existing PR body: `--prior-engines <set>`. After create and after **every** later push, `record-change-set.sh`:

```bash
bash <plugin_root>/scripts/record-change-set.sh --entry "<change_set_record_entry>" --pr <PR URL> \
  --acceptance-from <receipts.json>
```

Non-zero = stop (no `|| true`). N/A: [reference/change-set-na.md](reference/change-set-na.md). Every acceptance item `done` + evidence or `blocked` + reason ([acceptance-self-check.md](reference/acceptance-self-check.md)).

## Step 6 — Merge

```bash
bash <plugin_root>/scripts/merge-verified-pr.sh <PR#>   # squash, pinned to the current head sha
```

Rebase only when `mergeable=CONFLICTING` (then `record-change-set.sh` the new head). Root-cause reds, never re-run until green. Unattended or batch without `--merge=auto`: stop at ready to merge, comment checklist (no label). A PR a factory run delivered is the host merger's, not merged here; `ready-to-merge` alone is not enough ([reference/factory-merge.md](reference/factory-merge.md)). Confirm `merged: true` and issue closed.

## Batch, stuck, convergence

- Batch: one worktree subagent per target. Run `bun <plugin_root>/scripts/check-pr-path-overlap.ts`; overlapping PRs cite each other and merge order.
- Stuck: after 2 failed fix attempts, stop patching — trace the failure to its root cause (`input → state → failure site`) and state a 1-line hypothesis before fix #3. Unfixable P1 → "PR open, not merged".
- Convergence: list unfixed items as `kind = <path>:<symptom>`. In scope → `Refs #N`, leave open. Never close it and file the rest as new issues. Out of scope → new issue only for P0–P2 with concrete failure and no duplicate (≤1/PR).

## Output

Per target: state, PR link, test command + counts, review findings, next command, not-fixed-here list, `opened=<n>` (≤1; print `opened=0`), and whether issue closed.
