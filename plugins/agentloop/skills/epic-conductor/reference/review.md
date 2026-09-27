# epic-conductor — review before the gate, and which class

> On-demand reference for [`epic-conductor`](../SKILL.md) (§3.5 and §4). Moved out of SKILL.md in #7105.
> The order, the class test, the round cap, and "reviewers never run a gate" stay in SKILL.md.

## Why review is round 1, before any gate

A gate run before review is wasted. Every real finding changes the SHA and forces the whole gate again. The order is: implement with targeted tests → a separate clean-context reviewer on `merge-base..HEAD` → one batched fix of every still-valid finding → one `<verification_entry>` after the conductor releases a slot → push, create the PR with labels, comment the same-SHA result, record the Change Set → the conductor posts the verdict as round 1.

Same-session self-review does not count. The reviewer reads code and evidence. It never runs `<verification_entry>`, `<pre_merge_entry>`, e2e-gate, or ui-verify.

Zero findings: go straight to the gate. Do not wait "just in case". The worker report must name the reviewer agent id and what it fixed, or say "pre-PR review: zero findings". Missing that line means the fix step is not done.

There is no roborev-style daemon, no post-commit hook, and no polling GitHub for this. It is one in-session agent round-trip on a branch range, not a running service.

## Posting round 1

Post the reviewer's verdict as round 1: pr-review's canonical `<!-- pr-review-verdict -->` comment through `post-verdict.ts`, sweep-trace `round:1`, and `sha` equal to the **reviewed** (pre-fix) sha — never the PR head. If `sha` is the PR head, pr-review Step 0.6 reads the unreviewed fix batch as already reviewed.

The reviewer's findings are posted as written. The conductor adds the fix column, the same-SHA verification fact it **read** (not a gate it ran), and — at the pre-merge bot check — the `bot-clean.ts` line with `botFindings=` and `vendorsSeen=`. Until both facts are on the comment, the verdict reads `COMMENT (pending gate fact / bot-clean)`, never `MERGE` (pr-review Step 5).

## Re-review is the delta, and it counts

A second clean-context review runs when a fix batch (the one answering round 1, or any later one) is substantive or security-relevant, and **always** for a security / data-plane PR's fixes to panel findings. It is incremental: `git diff <reviewed-sha>..<head>` (pr-review Step 0.6), not the whole PR again, and it counts against the round cap like any other round.

A purely mechanical fix batch is checked by re-running `compact-findings.ts` against the new head. Every fixed finding must now read `stale`. That is not another reviewer.

## Which class, and why not every PR

Two paths, chosen by what the PR touches. Do not open a panel for every PR just for symmetry. The cost only buys something on the face where a single reviewer's single-lens read is the known failure mode: an accept/reject-same-color defect a green suite also cannot see (see [background.md](background.md)).

Class test: the diff hits repo-profile's Backend Face Paths (`.claude/repo-profile.md`), or it touches auth/authz, an exec gate, secrets/vault, a sandbox boundary, or payment/billing.

- **Normal.** One separate clean-context reviewer (never the worker) runs `agentloop:pr-review` Steps 1–2.5 (claims vs code, cross-cutting dimensions, accept-path coverage). Point it at the exact things to scrutinize hardest for this PR (the security boundary, the forge channel, the accept-path coverage, the reuse claims). For security-relevant PRs tell it to reproduce the exploit against the code, not just read it. It returns findings and a verdict (MERGE / COMMENT / BLOCK / …), which the conductor posts as round 1 once the PR exists. Docs, test-only, mechanical, and anything that does not hit the face stay single-reviewer.
- **Security / data-plane.** At least two independent clean-context reviewers, each a distinct named role, then one synthesis. `correctness` reads behavior, regressions, missing tests, and cross-cutting effects; it does not run any gate, including `<merge_gate_entry>` (only the merger runs that, immediately before `merge-verified-pr.sh`). `security` reads authz, injection, path traversal, and forged channels, and reproduces any claimed security property against the code (accept-path plus an exploit attempt), not just by reading it. Its output is an input to synthesis, not a second verdict. A member never posts `<!-- pr-review-verdict -->`.

## Synthesis rules (why they are in this order)

1. **Neither role has a blocking finding** → `MERGE`, or `COMMENT` with non-blocking notes. This does not replace the merge gate. The merge gate still requires a same-SHA verification PASS plus its merge-load door, exactly as for a normal PR. Reviewers and the synthesis step **read** that fact. They never run a gate to obtain it, including `<merge_gate_entry>`, which is not read-only: on exit 0 it writes the verdict record `merge-verified-pr.sh` accepts as merge authorization. The read is the PR's verification sticky whose first-line marker carries `sha=` equal to the head (pr-review Step 3 has the `gh api … --jq` line) plus pr-review Step 0.4's `bot-clean.ts`. When the fact is missing, the branch owner (worker or fixer) runs `<verification_entry> --comment <PR#>` — nobody else. Advisory rows the gate prints (arc: `⚠ advisory e2e-gate|ui-verify|native-verify=…`) are information, not a door. Reading the fact never substitutes for the independent code-review roles.
2. **Only one role produced findings** → pass them through. Do not spend an agent on synthesis just for symmetry.
3. **Both roles have findings** → read-only merge: dedupe, order by severity, keep every `path:line`. Run the pile through `compact-findings.ts` before handing it to a fixer.
4. **Synthesis never edits files and never pushes.** It is read-only, exactly like the members it merges.
5. **Any round that errors, or a reviewer that fails to return, is uncertain. Uncertain stays a finding, never a pass.** A crashed or timed-out reviewer never synthesizes to `MERGE`. A reviewer that silently accepts everything is indistinguishable, on green output, from one that works.
6. Panel roles and the security-face trigger are defined in the skill and in repo-profile's Backend Face Paths. They are not configurable from the PR's own branch. A feature diff must not be able to change who reviews it.

The synthesized result still posts as one canonical `<!-- pr-review-verdict -->` comment, upserted exactly as a single-reviewer verdict would be. Members' output is working material, never a second canonical verdict.

## Round cap

**Round cap per PR: 3.** A round is one re-verification at a new head SHA that refreshed the verdict — whatever produced the findings (panel, bot, a red gate, a human comment). Read the count with `pr-review-round.ts --pr <n>`. Never remember it.

`0`–`2` → another round is allowed. `3` or more → no fourth round. Collapse the finding into the current fix, file it as a separate issue, REJECT it with reasoning, or fail the PR (stop at "open, unmerged" and hand it back). The third round's fix must be single-point or mechanical — otherwise fail rather than review again. A non-zero exit means the count is unknown; stop, and do not read it as round 0.

Why a count rather than judgement: [closeout-gate.md](closeout-gate.md).
