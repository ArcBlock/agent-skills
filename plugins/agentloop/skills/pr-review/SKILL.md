---
name: pr-review
description: >-
  Independent clean-context review of ONE open PR or branch range: verify every claim against live
  code, run the changed package's tests, check cross-cutting impact, bot threads and sibling
  conflicts, then a verdict (MERGE / COMMENT / SUPERSEDE / BLOCK / CLOSE). --post writes it. Never merges.
---

# pr-review — one PR, reviewed against the real code

Read `.claude/repo-profile.md` first (`repo_slug`, `default_branch`, `plugin_root`,
`package_manager`, `test_runner`, `agent_identity_script`, `comment_language`). Output language =
`comment_language`; identifiers, paths, commands and test output stay verbatim. Lead with a
one-line verdict, then the minimum evidence (UI: screenshots); long logs go in `<details>`.

```
/agentloop:pr-review <pr-number-or-url> [--post]
```

Default is read-only. `--post` writes one comment and may adjust labels; it **never merges, never
closes, never pushes to someone else's branch**. Batch + dedup-close + merge is
[`pr-sweep`](../pr-sweep/SKILL.md). No `gh` (cloud routine) → `mcp__github__*` via ToolSearch.

This is the one clean-context review an agent PR gets. Run it in a context that did not write the
code. Auth/authz, exec authorization, secrets/vault or sandbox boundaries → two reviewers,
`correctness` + `security`; the security one reproduces the exploit (or the claimed security
property) against the code. A crashed or silent reviewer is uncertain, never a pass.

## Verdicts

| verdict | meaning |
|---|---|
| `MERGE` | claims verified, tests of the changed package pass, no open P0–P2, no unresolved conflict |
| `COMMENT` | mergeable with notes (a missing edge test), or the keeper of a duplicate pair |
| `SUPERSEDE` | the weaker side of a duplicate / contradicting pair → points at the keeper |
| `BLOCK` | a real defect (P0–P2), failing tests caused by this PR, or an unresolved conflict |
| `CLOSE` | stale, already superseded by merged work, no longer needed |

Severity: **P0–P2 block** and are fixed in one batch by the author; **P3 → noted, not filed**
(`MERGE` + notes, listed for the PR body, never an issue, never a block). Only findings in the PR's own
diff (`merge-base..head`) count ([issue closure](../../../../../docs/architecture/issue-closure-discipline.md)).

## Steps

**0. Read the PR** — all three surfaces, each with an output even when empty:

```bash
bun scripts/gh-rest/gh.ts pr view <n> --json title,body,author,headRefName,baseRefName,headRefOid,mergeable,files,labels
bun scripts/gh-rest/gh.ts pr view <n> --comments
bun scripts/gh-rest/gh.ts api repos/{owner}/{repo}/pulls/<n>/comments --paginate --jq '.[]|{user:.user.login,path,line,body}'
bun scripts/gh-rest/gh.ts api repos/{owner}/{repo}/pulls/<n>/reviews --paginate --jq '.[]|select(.body!="")|{user:.user.login,state,body}'
```

Record each review `state`. Read the linked issue (`Fixes #N`). Bot inline comments (Codex,
Cursor, …) are review input: verify each, keep the real ones as findings. A failed fetch is not
"no comments". MCP equivalents and the rebase rule: [reference/steps-detail.md](reference/steps-detail.md).

**1. Diff + current code.** `bun scripts/gh-rest/gh.ts pr diff <n>`, then read the touched files on the current
`<default_branch>`, not only inside the diff. To run the PR's code use a worktree under
`$AGENTLOOP_WORKTREE_BASE/pr-<n>.$$` (never the shared checkout, never a hardcoded `/tmp`) and remove it after.

**2. Verify every claim.** Each claim → `path:line` or NOT FOUND. Bug fix: does the diff fix it and
is there a test? Test-only: do the assertions fail when the code breaks? Docs: does each statement
match shipped code? Feature: scope, correctness, shared config touched. If `<lesson_ledger_dir>` in
`.claude/repo-profile.md` is not `none` and `<lesson_ledger_dir>/absorbed.yaml` exists, check
`status: absorbed` / `promoted` entries for the touched surface and read their `rule_home`
(`candidates/pending/` is not grounding; if an entry conflicts with shipped code, shipped code wins —
flag `ledger stale: <id>`).

**2.5 Cross-cutting.** Reverse references ([`impact-check`](../impact-check/SKILL.md)),
cross-package parity, end-to-end use, performance on request/init paths, test coverage, test quality
(`/agentloop:test-audit` diff mode + reading the tests: can they fail? is the accept path there?),
cleanup of what the PR replaces. Each dimension: evidence or "n/a". Table: [reference/cross-cutting.md](reference/cross-cutting.md).

**3. Run the changed package's tests** on the PR head (`<package_manager> --filter <pkg> test`,
or `<test_runner> <files>`); record the exact command and counts. A red caused by this PR →
`BLOCK` with the failing test and output tail. A red that is not this PR's → root-cause it (bisect),
never re-run until green; say so in the verdict and link the open issue for that test (open one
only when none exists).

**4. Sibling PRs.** Same issue (`Fixes|Part of #N`, issue number in the branch) → exact duplicate or
contradiction; keep the more complete > more correct > tested > newer base > first, the other is
`SUPERSEDE`. Same file → line conflict / independent / semantic contradiction; shared config
overlap → state the merge order.

**5. Verdict.** Claim table, cross-cutting rows, test command + counts, conflicts, findings with
severity, the verdict. Escalate to a person only for security, breaking change, an undecided
architecture A/B, or an explicit human objection — and first ask whether a safe default exists (if
so, take it). An escalation carries the human-confirm block: [reference/escalation.md](reference/escalation.md).

**6. Post (`--post`).** A **new** comment per round, never a PATCH (an edited verdict is ignored),
rendered by `lib/verdict.ts`: `<!-- pr-review-verdict -->`, identity, canonical `v1`
line, `HEAD <sha>`, `Verdict: <VERDICT>`, evidence ([detail](reference/verdict-comment.md)):

```bash
hdr=$(bash <agent_identity_script> --header "PR Review" --skill pr-review)
bun <plugin_root>/lib/verdict.ts --head <headRefOid> --verdict <V> --identity "$hdr" --body-file ev.md >d.md
bun scripts/gh-rest/gh.ts pr comment <n> --body-file d.md
```

`--lens security` for the security reviewer (own comment); `--held` under `agent:hold`. Nothing
after a MERGE: a later comment stales it. One review per head; a new head or human comment is a
new review (delta-only if the last still holds).

## Fix now

A deterministic defect is fixed, not just reported, when four doors hold: evidence is solid, the
fix is unambiguous, it is not security, it needs no direction call. Introduced by this PR → fix on
the PR branch (`--post`) or give the exact patch (read-only). Pre-existing on main and bounded →
tracking issue + its own fix PR. Security door fails → the panel; direction / size / semantic dispute → the
review jury; `needs-human-confirm` only for an R2 decision ([r2-admission.md](../../reference/r2-admission.md)). Detail:
[reference/fix-now.md](reference/fix-now.md).
