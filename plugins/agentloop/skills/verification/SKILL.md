---
name: verification
description: Run a repo's deterministic verification gate (build/lint/types/tests/etc.) and post one measured report to the PR. Use before opening or merging a PR. The engine is repo-agnostic; the check list comes from the repo's own .claude/verify/config.ts.
---

# verification (agentloop engine)

> **Repo-agnostic.** The check list and gate commands come from the consuming repo:
> `.claude/repo-profile.md` (`gate_mode`, `verification_entry`, `pre_merge_entry`) and
> `.claude/verify/config.ts`. Paths shown as `.claude/verify/...` are arc's defaults.

Deterministic gate whose numbers the scripts measure — the agent chooses *which*
scenario to run and *reads* the result, but never hand-fills a stat. This is the
guardrail: a check's exit code decides pass/fail, not a narrative.

## Two layers

- **Engine (this plugin, repo-agnostic):** `lib/report.ts` (CheckResult + render),
  `lib/comment.ts` (sticky PR-comment upsert), `lib/scenario.ts` (`runScenario` +
  `cmd()`). Knows nothing about pnpm/turbo/paths.
- **Repo config (in the consuming repo):** `.claude/verify/config.ts` declares the
  check list. Command-checks are pure config (`cmd({ command: "pnpm build" })`);
  logic-checks import a repo-local module. A thin `.claude/verify/pre-pr.ts` calls
  `runScenario(config, process.argv)`.

## How to run

The repo exposes a scenario entry (`<verification_entry>`). Common flags:

```
--comment [<pr#>]   upsert the report onto the PR (run + post = one step)
--json              machine-readable
--na "<reason>"     write an N/A exemption (docs-only / native-only PRs)
--only a,b / --skip x,y   scope the check set (unknown id → hard error, exit 2)
                          → a scoped run is a DIAGNOSTIC, never a gate (see below)
--deliver-cached    post the cached PASS report without re-running
```

Run the gate with `--comment <pr#>` so "run" and "post" are one step. Exit codes:
**0** = PASS (and, when `--comment`/`--post` was requested, the report WAS delivered);
**1** = verify FAIL; **2** = empty check set / unknown `--only`/`--skip` id (fails
loud, never silent-green); **4** = verified PASS but the requested report was NOT
delivered — the remedy is to retry / fall back the comment post (e.g. paste the
stdout sticky body via MCP), NOT to touch the diff. Do not hand-write the report or
substitute a single `tsc`/`build` command for the scenario script.

## Discipline

- Numbers are measured, never hand-filled. If you typed a stat into a PR, you
  bypassed the gate.
- A verification failure means **do not merge/push** — fix, then re-run.
- Empty check set or unknown `--only`/`--skip` id fails loud (exit 2), never
  passes silently — a gate that verified nothing must not look green.
- **A scoped run (`--only` / `--skip`) can never be the gate** (#5067). Use it to
  debug ONE failing check; its report is still written and readable, but a green
  scoped run is recorded as `PARTIAL`, not `PASS`, so `--deliver-cached`, the
  pre-push hook and the merge gate all refuse it. Coverage (`fullScenario` + the
  executed check ids) lives in `.verify/<sha>.metadata.json` — before #5067 that
  file carried identity only, so a two-check PASS and a full-gate PASS were
  indistinguishable and the push gate accepted both.
- **A report is only delivered to a PR the sha belongs to** (#5060). `--comment`
  refuses a sha with no relationship to the PR's branch (naming both sides),
  labels an older-but-on-branch sha **NOT THE PR HEAD**, and reads the posted
  comment back to confirm the sha GitHub ends up holding is the one just sent.
  That read-back is the manual ritual (`compare the sticky's sha= to
  git rev-parse HEAD`) made structural — you no longer have to remember it.
- **PR scenarios are light; daily/release is thorough** (#5223). A repo may
  `when`-gate expensive standing checks on the PR doors and fail-fast after the
  first blocking red. Reused broker evidence is named on the report itself
  (same checkout too — silent reuse is how agents re-wait a cache). Full tool
  logs land at `.verify/<sha>.<check>.log`; the comment keeps the table and
  failure tails. Do not treat the 24h wall-clock of a polluted machine as a
  savings baseline.
- **Evidence is keyed by WHERE it was produced, not just by sha** (#5339). Each
  record carries `location` (tree + host clone) and the report says so on a
  `📍 Produced at` line. Same location reuses (that is #5223's benefit);
  a DIFFERENT tree at the same sha gets its own slot and therefore a real run,
  so re-verifying from a clean checkout is a working move again rather than one
  the cache silently swallows. Single-flight still spans locations — two trees
  never run the same gate concurrently, the second one just runs after. When a
  sibling location already holds a record, the report names it instead of
  implying its own answer is the only one. To force a re-run, follow the
  **resolved** path the reuse notice prints (`Shared record: …`): the store
  lives in the git COMMON dir, so in a linked worktree it is NOT under the
  worktree's own `.git`. A cached FAIL is not retried on its own — pass
  `--retry-failed`, which the reuse line now says out loud.
