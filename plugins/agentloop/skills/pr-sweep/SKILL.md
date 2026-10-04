---
name: pr-sweep
description: >-
  Batch-review all open PRs to a terminal state: clean-context pr-review per PR, dedup-close
  same-issue twins, auto-merge reviewed non-breaking PRs whose package tests pass; escalate only
  security, breaking or direction calls. Flags: --merge, --dry-run. Built for scheduled runs.
---

# pr-sweep — review all open PRs, dedup-close, merge the clean ones

Read `.claude/repo-profile.md` first (`repo_slug`, `default_branch`, `plugin_root`,
`agent_identity_script`, `comment_language`, `pr_sweep_freeze_ttl_days`,
`pr_sweep_stale_escalation_days`). A batch driver over [`pr-review`](../pr-review/SKILL.md);
the PR-world twin of [`issue-sweep`](../issue-sweep/SKILL.md). Humans decide only security,
breaking changes and direction.

```
/agentloop:pr-sweep              # review + comment + dedup-close (no merge)
/agentloop:pr-sweep --merge      # … + merge PRs that pass Step 5
/agentloop:pr-sweep --dry-run    # report WOULD-DO only (README "Dry-run contract")
/agentloop:pr-sweep <pr#…>       # only these PRs
```

## Step 0 — Sync the default branch

Plain commands, one at a time (no shell loops / `$(…)`: the sandbox guard refuses them). Never
`git checkout <default_branch>` (a worktree may hold it).

```bash
git fetch origin <default_branch>
git reset --hard origin/<default_branch> && git clean -fd
```

## Step 1 — Enumerate and pick the actionable set

```bash
gh pr list --state open --limit 100 \
  --json number,title,author,headRefName,headRefOid,mergeable,files,labels,body,updatedAt,isDraft
```

In this order, from this one call:

1. Drop `epic-managed` PRs (epic-conductor owns them).
2. Freeze: an `awaiting-*` PR whose `updatedAt` is older than `pr_sweep_freeze_ttl_days` (14) gets
   no API call; older than `pr_sweep_stale_escalation_days` (30) is named in the run summary only.
3. `agent:hold` never merges, closes or loses the label; new human input is still answered.

A PR **needs review** when: no pr-review comment yet; its head sha differs from the `HEAD <sha>`
of the last `<!-- pr-review-verdict -->` comment; a human commented (conversation, inline, or review) after the last
agent comment; a bot left new inline findings; it went Draft → Ready. An agent comment is one with
a Bot author or the identity header of `skill:pr-review` / `skill:pr-sweep`. Nothing new → zero
actions. Nothing actionable at all → exit early.

Disposition labels (controlled set): `pr-sweep:needs-fix` (the sweep fixes it; after 3 of its own
fix pushes still red → `awaiting-direction` with a per-round summary) · `pr-sweep:awaiting-glance`
(verified, a human confirms) · `pr-sweep:awaiting-direction` (an A/B call) ·
`pr-sweep:awaiting-judgment` (a concrete uncertain risk) · `pr-sweep:awaiting-caution` (security /
breaking / irreversible) · `pr-sweep:blocked-deps`. A human change request is not an approval:
implement it, post evidence, set `awaiting-glance`, wait for explicit approval words.

## Step 2 — Cluster

Same issue: issue number from the branch (`…-<N>-…`, `issue-<N>`) or `Fixes|Part of #N` in the
body; ≥2 open PRs on one `<N>` = a duplicate cluster. Same file: a `file → PRs` map; release-bot
PRs (every `package.json` + `CHANGELOG.md`) are their own cluster, not conflicts. Hand each PR its
peers.

## Step 3 — One pr-review per PR

Each actionable PR goes to [`pr-review`](../pr-review/SKILL.md) in a clean context with its peer
list (`--post` unless `--dry-run`). pr-review runs the changed package's tests on the PR head. One
pr-review comment per head; never re-post an unchanged conclusion.

## Step 4 — Dedup-close

For a same-issue cluster: pick the keeper (more complete > more correct against the authoritative
source > tested > newer base > first). A second, independent fresh-context agent picks too and
returns `{keep, reason}`; they disagree → close nothing, `awaiting-direction` on each. Contradicting
claims → check the authoritative source first. Close each twin with an identity-headed comment
naming the keeper (`gh pr close <twin> --comment "superseded by #<keeper>"`) and note the closed
twins on the keeper. Any PR with `agent:hold` takes no part. Unsure → keep both, `COMMENT`.

## Step 5 — Merge (`--merge` only)

All of these, re-checked right before each merge:

- pr-review verdict at the **current head** is `MERGE` or a non-blocking `COMMENT`, its test run
  of the changed package passed, and no P0–P2 finding (review, bot or human) is open;
- no human reviewer's latest `CHANGES_REQUESTED` that their own `APPROVED` has not superseded;
- not a factory-run PR: no `needs-human-confirm` label, no ready-to-merge checklist from a run,
  no Change Set produced by a run. Those are a person's merge (#7662), never the sweep's.
  Mechanically: `merge-verified-pr.sh` runs the factory merge check, which refuses a factory PR
  that is not approved and path-compliant. The sweep never passes `--not-factory`, so on a runner
  with no factory daemon (cloud, another machine) every merge refuses there: the sweep reports
  "needs a runner with the factory" and leaves the PR, it does not merge around the check;
- no `agent:hold`, no `epic-managed`, `mergeable == MERGEABLE` (rebase only on `CONFLICTING`), no
  unresolved same-issue or same-file conflict;
- risk tier, recomputed now: 🟢 docs / tests / release PRs and 🟡 tested fixes, non-breaking
  features, additive protocol → merge; 🔴 security surface, breaking change (incompatible wire or
  schema without migration, removed public API, destructive data op), undecided architecture, human
  objection → never auto-merge: `awaiting-caution` / `awaiting-direction` with pr-review's
  human-confirm block, the source issue's author and assignees requested as reviewers. Before
  choosing 🔴 ask whether a safe default exists; if so, take it.

```bash
bash "<plugin_root>/scripts/merge-verified-pr.sh" <n> --method squash
```

Small fixes are made on the PR branch by the sweep itself (then its tests again), never handed to a
human as an action item. A red is root-caused, never re-run until green.

## Limits and idempotence

~10–14 reviews per round; GitHub content creation ≤500/h, ≤80/min; on a secondary rate limit back
off (≤3 tries), then mark `RATE-LIMITED` and leave it to the next run. Labels plus one comment per
head make a rerun safe. Duplicate PRs are prevented at the source by issue-sweep's deterministic
branch `claude/issue-<N>` and its claim check; a new cluster from a non-deterministic branch name is
noted in the summary.

## Output

Per PR: verdict, disposition, merged / closed / escalated, test command + counts. Then the frozen
and stale-escalation lists.
