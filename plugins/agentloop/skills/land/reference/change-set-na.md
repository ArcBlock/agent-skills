# land — Change Set N/A forms

> On-demand reference for [`land`](../SKILL.md) Step 5.

None of these is a defect to route around:

- The profile sets `change_set_record_entry` to `none` (no work ledger): the script prints "not recorded".
- Outside a code-agents run the ledger command prints its own N/A (`--skip-outside-run`).
- **`Change Set: not recorded (N/A: arc <ver> lacks work changeset)`**: this host's `arc` predates
  `work changeset` (arc#7081, normal during a rolling upgrade). Nothing was recorded on this host;
  do not retry it as a failure.
