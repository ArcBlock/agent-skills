# epic-conductor — how the resident session runs

> On-demand reference for [`epic-conductor`](../SKILL.md) (Orchestration invariants and Identity). Moved out of SKILL.md in #7105.
> The caps (workers ~3, at most 2 heavy gates), the live-child ban, and `--cs-head` stay in SKILL.md.

## Resident and serial-inline

You stay in one session and orchestrate by launching agents and reacting to their completion notifications. Do not nest a Workflow inside the conductor. Drive it inline. Unattended-ops norm: no plan mode for the epic. Decisions live in issue and PR comments, where the next session and the human can both see them.

## No end of turn with live hired children

`status=running` and a pid that is still alive means you stay. Assert with `assert-no-live-children.ts` before you treat yourself as done. True closeout is allowed only after each hire has GitHub evidence (a PR URL or a skip-comment) or the child was explicitly stopped. A ghost row (`status=running` with a dead pid) does not block; that is recover-territory. Watch pid + `runs/*.json` + cwd, not `lastTurn` alone.

Factory cockpit rows are `pid=-1`. The watchdog must fail-closed on them: they are live, not ghost. Do not probe `-1` as a local pid.

## Concurrency

Up to 3 workers (at most 4) may implement and get reviewed in parallel. **At most 2 heavy gates run on this machine at once.** A heavy gate is any `<verification_entry>`, `<pre_merge_entry>`, or daily run, an advisory gate run (e2e-gate / ui-verify), or a full build/test suite.

You hand out the gate slots. A worker reports "ready to gate" and waits for your go before it runs the gate. Before you release a slot, look at machine load (`uptime`). Do not release a slot while `load1` is at or above the core count, or while two gates you know of are already running.

This is scheduling, not a lock. Leave the repo's machine-wide gate lock off (arc: `ARC_GATE_LANE` stays unset). The gates you did not start — other sessions, sweeps — count against the 2 when you can see them. Cloud and remote runners have their own machines and their own 2. Do not try to serialize them from here.

## Model by task weight

Runtime, gates, security, and data-model work use opus. Docs, mechanical edits, and a small blocklet use sonnet. State the choice in the dispatch so a later reader can see why that worker was that weight. Do not default every worker to the heaviest model, and do not put a security-face diff on the light one.

## Isolation and merge

Each worker gets `isolation: "worktree"` on the Agent call so parallel workers never collide on files. Every worker does not merge. Merging is the conductor's gated act, always — after review, the one gate, bot-clean, and merge-gate. See [gate-merge.md](gate-merge.md).

## Identity is the work DID

GitHub issue and PR numbers are an outbound projection (`sourceUrl`), not scheduling identity. Resolve a sub-issue with the `/work` query on `meta.objectId`. Do not start at `gh issue view`.

A Change Set is `workType=change-set` with `meta.head` a 40-character git sha. Merge-gate keys off that `head`. The documented command must carry `--cs-head` when the Change Set exists. Dropping it and running `merge-gate.ts <PR#>` is GitHub-as-truth, and it is forbidden. Add `--source-url <url>` only when the Change Set has `sourceUrl` (the headRefOid cross-check). `--data-file` still requires an explicit PR number.

Only the merger runs merge-gate, immediately before `merge-verified-pr.sh`. Exit 0 writes the verdict record that authorizes the merge, so the command is never a "read" for reviewers.
