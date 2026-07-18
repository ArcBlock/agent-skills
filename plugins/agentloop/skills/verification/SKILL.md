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
