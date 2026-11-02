# Self-check before ending: every acceptance item landed

The goal is to land every acceptance item. Opening a PR does not finish the job (ArcBlock/arc#9214).
The factory counts a run as delivered only when every acceptance item of its work has a receipt
on the recorded Change Set round. If an item has no receipt, or the round is not recorded at all,
the run is `incomplete`. The factory then resumes the same coder with the missing items, a bounded
number of times. After that, a person decides.

## Before the last step (ready to merge, or the end of a factory run)

1. **Read the acceptance list.** For a work, read its `acceptance` (`arc afs read`). For an issue,
   read its acceptance / 验收 section. Number the items 1..N in the order given.
2. **Conclude every item.** Each one is either:
   - `done`, with evidence: the test name and its counts, a command and a summary of its output,
     or a screenshot path / URL. "Tests pass" is not evidence. Name the test.
   - `blocked`, with the reason and what it needs: a dependency that is not merged yet (name the
     PR), a missing environment, a credential. Use this only for things outside the run's reach.
     Hard work is not a reason to mark an item blocked.

   An item that is neither is not finished. Go back and do it. Do not hand over a half-done PR.
3. **Record the receipts with the round.** Write one JSON array and pass it to the record step:

   ```json
   [
     { "item": 1, "status": "done", "evidence": "test work-x.test.ts › rejects y (12 pass)" },
     { "item": 2, "status": "blocked", "reason": "#5144 not merged", "needs": "merge #5144" }
   ]
   ```

   ```bash
   bash <plugin_root>/scripts/record-change-set.sh --entry "<change_set_record_entry>" \
     --pr <PR URL> --acceptance-from <receipts.json>
   ```

   Record after the create and after every push. A new commit is a new round and needs its
   receipts again. Recording the same head again only updates its receipts. Use this when an item
   is finished without a new commit, such as a pre-pr run or a screenshot.
4. **A failed record is not a delivery.** It can fail on the network or on credentials (e.g.
   `Bad credentials`). Fix the cause and record again. Non-zero means stop. An open PR without a
   recorded round is never "done".
5. **Say it in the PR body.** List every item with its conclusion. Put blocked items under
   **Blocked acceptance**, with the reason and what unblocks each one. The factory briefs each
   blocked item and flags the work for a person. The other items still go on to review and merge.
   `Fixes #N` only when every item is `done`. With a blocked item, use `Refs #N` and keep the
   issue open.

Outside a factory run (no work ledger: the record step prints N/A), the self-check still applies.
The PR body list is the receipt.
