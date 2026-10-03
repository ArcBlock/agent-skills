# epic-conductor — merge-gate doors and the merge authorization

> On-demand reference for [`epic-conductor`](../SKILL.md) (§7). Moved out of SKILL.md in #7105.
> Who may run the gate, when, and that `<pre_merge_entry>` is not part of the PR loop stay in SKILL.md.

Merge a PR only when all of the following hold, in this order. Do not skip to squash.

**In a Factory run (`ARC_CODE_AGENT_RUN_ID` set) you do not merge** (arc#7662): take the PR to items 1, 3 and 4, leave the gate evidence on it, and report "ready to merge, human decision". Steps 2 and 5 belong to the person who merges; `merge-verified-pr.sh` refuses with exit 3 inside a run. Do not wait for that merge: dispatch only members whose dependencies are merged on the default branch, and when every remaining wave needs an unmerged member, report the ready-to-merge PRs and end the run. Override, stamp and why: [headless-factory-run.md](../../../reference/headless-factory-run.md#merge-authority-is-human-arc7662).

1. The independent review verdict is MERGE, or COMMENT with **only** non-blocking notes, **and every actionable inline review thread has its same-thread resolution**. `MERGE (held)` is the expected form while `agent:hold` is on.
2. The repo merge gate exits 0 on the Change Set `head` you are about to merge. Invoke it with `--cs-head <40-char-sha> <PR#>` (`--cs-head` is the 40-char PR/CS head and must be current HEAD; the PR number is the projection handle). Do not drop `--cs-head` and run `merge-gate.ts <PR#>` as GitHub identity.
3. Every actionable inline review thread is addressed (fixed with SHA / change / verification, or REJECTed with reasoning; only P2/Medium/Low may defer, and only with a tracking issue, an owner, and a re-entry condition). Any P1/High that is not fixed or REJECTed is a hard blocker. Lower severity is not a risk blocker, but it is still never mergeable without its in-thread conclusion.
4. The single pre-merge `bot-clean.ts` check has run on the **last** head (thumb, silence, or every finding resolved in-thread). You do not need a green human GitHub review from Codex or Cursor.
5. The merge itself goes through `scripts/merge-verified-pr.sh`, **immediately after** step 2. Run step 2 only once review, bot-clean, and every other item above are done. Its exit-0 verdict record is the merge authorization, so a gate run earlier, or before main advanced, must not be left lying around to be merged on. Re-run it right before merging.

## What the merge gate actually blocks on

Blocking doors:

- **Verification.** A same-SHA PASS/NA sticky. The one `<verification_entry> --comment <PR#>` posted when the PR was opened satisfies it. No separate `<pre_merge_entry>` run is needed, even when main has advanced. `<pre_merge_entry>` is not part of the PR loop and posts under the same marker; a FAIL there would overwrite a valid PASS.
- **Merge-load.** The files both this PR and main touched, parsed as merged against the **current** main tip. This is what covers "the branch is behind main".
- **Profile `additional_merge_gates`.** Arc: none.
- **Cross-engine review**, and only when this branch has a Factory run record — that is, when you are running inside the Factory. Attended runs on a developer machine do not hit it. The gate prints which of the two N/As it means.

e2e-gate / ui-verify / native-verify are **advisory** in arc (`⚠ advisory <gate>=<status>` lines; the L1 main catch-net owns them). Read them. They do not block.

The verification sticky's `sha=` **must equal** the Change Set `head`. A fixer commit stale-dates it. A main advance does not. When the gate says `verification fact is not current`, the branch owner runs the hint it prints (`<verification_entry> --comment <PR#>`). Never `<pre_merge_entry>`.

If you pushed to the branch yourself (a rebase, or a merge of main to clear `CONFLICTING`), record that head first (`record-change-set.sh --work <member work DID>`). A non-zero exit stops the merge.

## Carry-forward is the gate's decision

An advisory e2e-gate PASS at an older sha is carried when every file changed since is off the backend surface. The cross-engine door carries only across an **identical tree**. `verification` never carries, because it is diff-sensitive by construction. All of these decisions are the gate's, computed from git. Do not reproduce the reasoning by hand.

## The verdict file is the authorization

`merge-verified-pr.sh` verifies the gate actually happened. It requires the verdict record `merge-gate.ts` writes on exit 0 — `merge-gate.<sha>.json` under `$ARC_MERGE_VERDICT_DIR`, else `<repo root>/.verify/` (both sides resolve that identically on purpose) — matching this PR and this head. Gate and merge must run on the same machine at the same head.

Before this existed, "the gate ran" and "the gate was skipped" left identical traces, and five arc CLI epic PRs merged on stale or failed evidence.

Only the merger runs the gate, immediately before `merge-verified-pr.sh`. Reviewers read the sticky. They never run the gate to "refresh" it.

## Security-face close

For a security-face PR, post a short risk-summary comment before merging: what it opens, why it is safe, residual risk, and the revert path. Then remove `agent:hold`, squash-merge (Conventional-Commit title if branch commits drifted), delete the branch, and drop the issue from the lock list. Unblock dependents and dispatch the next wave.
