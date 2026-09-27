# epic-conductor — design hand-off and fence-off labels (full text)

> On-demand reference for [`epic-conductor`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### 0. (Optional) Design hand-off — when the epic has a visual/UX surface
If the epic ships user-facing UI, split the design BEFORE decomposing:
- Hand the **display layer** to a design tool (e.g. Claude Design): give it a clean, self-contained brief — neutral/themeable shell, and **multiple concrete example datasets** so it produces genuinely different layouts per data type. Do NOT ask it to design config/settings pages that the platform's **auto-surface** can generate from a declared schema — scope those out; one source of truth.
- The design output becomes the **visual basis** for the display sub-issue. Read it (via the design MCP / artifact) and pass the real design reference into that worker's brief.

### 2. Group + fence off (prevent fleet collisions, keep epics untangled)
This repo may have `issue-sweep`/`pr-sweep` cron runners that will otherwise grab your issues and open duplicate PRs — and once this mechanism exists you'll run *several* epics whose issues/PRs must not tangle. Two standing labels do both jobs (the load-bearing fix; the old advisory `agent:processing` lock is racy — add-then-check, 30min TTL — and has really collided, e.g. a fleet runner opening a duplicate PR seconds before the lock landed):

- **`epic-managed`** (standing, epic-agnostic) — the **fleet-exclusion key**. Apply it to the epic + every sub-issue + every PR your pipeline opens, the moment each exists. `issue-sweep`/`pr-sweep` skip anything carrying it ENTIRELY (not triaged, not claimed, not reviewed, not commented) — the conductor is the sole driver. One rule covers all epics, present and future. This is stronger than `agent:hold` (which only freezes *terminal* actions but still responds to human comments): `epic-managed` means "another agent owns this end-to-end."
- **`epic:<epic#>`** (per-epic) — the **grouping/filter key**. Apply to the epic + every sub-issue + PR. `gh issue list --label "epic:<n>"` / `gh pr list --label "epic:<n>"` pulls exactly one epic's items — so multiple concurrent epics stay cleanly separable.
- Create both labels up front (`gh label create`). Optionally also open a **milestone** per epic and assign the sub-issues to it — purely for the GitHub UI's native progress bar (X/Y closed); the machine mechanism is the labels, not the milestone.
- Keep `agent:hold` on each opened PR too as belt-and-suspenders (and as the human-facing "reserved" signal), and remove it at merge time — but `epic-managed` is the primary fence. `agent:processing` becomes optional (only meaningful if two *conductors* could run the same repo); the standing exclusion, not the TTL lock, is what keeps the fleet out.
- Keep the label list / epic number in a file a small background refresher reads; the refresher re-asserts labels periodically and exits when you clear the list at closeout. At closeout, remove `epic-managed` (and `agent:hold`) as each item reaches terminal state; the `epic:<n>` label stays as a permanent grouping record.
