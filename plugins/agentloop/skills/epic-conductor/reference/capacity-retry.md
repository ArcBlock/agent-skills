# epic-conductor — capacity-limit (429) worker deaths

> On-demand reference for [`epic-conductor`](../SKILL.md) (moved out of SKILL.md in #7105).

- **A worker dies on a provider capacity limit (429), not on its task** (arc#6204): both arrive as
  `status=failed`, so the work is dropped unless you happen to be watching. Measured twice in one
  run — one worker had already committed its fix and died queued behind a test run; another died
  mid-edit holding uncommitted work. Do NOT re-dispatch blindly and do NOT treat it as a task
  outcome. Classify it, record it, retry after the reset:
  ```bash
  R="${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/scripts/agent-retry.ts"
  bun "$R" record --agent <id> --target "<owner>/<repo>#<n>" --brief-file <p> --summary-file <p> [--wip <ref>]
  bun "$R" due                                        # prints scanned=/pending=/inFlight= even when nothing is due
  bun "$R" bump --target "<key>" --holder-pid $$      # CLAIM it, then dispatch
  bun "$R" resolve --target "<key>"                   # after the retry lands
  ```
  **`--summary-file` must hold the harness's death text VERBATIM.** Do not paraphrase it, do not
  summarise it, do not reformat it. The classifier keys on the harness's own termination notice and
  reads the capacity error type *inside* that notice; your retelling ("worker o/r#1 died: HTTP 429
  from the provider") is prose and lands on needs-a-human. Capture the text, write it to a file,
  pass the file.
  The classifier is fail-closed: an unrecognised death is NOT retryable, because auto-retrying a
  real failure burns budget and repeats side effects. It needs BOTH an agent-termination notice and
  a capacity error type **within that notice** — a worker reporting that the endpoint *under test*
  answered `HTTP 429` is a task outcome, not a death, and so is a death notice about something else
  that happens to be followed by a sentence mentioning 429. `due` always prints the scanned count —
  an empty ledger and a full one with nothing ripe otherwise render identically, and the first means
  the RECORDER never fired.
  **`bump` before you dispatch, and pass `--holder-pid`.** `bump` CLAIMS the record and takes it out
  of `due`; without that step the next poll hands you the same brief again — duplicate agents,
  repeated PR/comment side effects, the attempt cap burned in seconds. `--holder-pid` must name the
  process that will still be alive while the retry runs (`$$` for your own session), never the
  `bump` invocation itself: that is what lets a crashed retry be offered again within seconds
  instead of waiting out the 6h lease ceiling. A claim is released automatically when its holder
  dies, and `due` prints `reclaimed=` when that happens.
  **Preserve the partial work first.** Put every worker brief on notice: on a capacity limit, stop
  cleanly and WIP-commit to a side branch rather than half-writing, and report the ref. Pass it as
  `--wip`. A classifier cannot recover work an agent never left behind.
