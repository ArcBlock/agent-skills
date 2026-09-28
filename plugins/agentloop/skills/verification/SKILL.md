---
name: verification
description: >-
  Run a repo's deterministic verification gate (build/lint/types/tests) and post one measured
  report to the PR. Use before opening or merging a PR. The check list comes from the repo's
  .claude/verify/config.ts.
---

# verification (agentloop engine)

> **Repo-agnostic.** The check list and gate commands come from the consuming repo:
> `.claude/repo-profile.md` (`gate_mode`, `verification_entry`, `pre_merge_entry`) and
> `.claude/verify/config.ts`. Paths shown as `.claude/verify/...` are arc's defaults.

## Where this gate sits (tiers)

A repo may split verification into tiers; arc does (epic #7019):

- **L0 — the PR gate** (`<verification_entry>`, arc: `pre-pr`). Run it
  **once per fix batch**, after the independent review's findings are fixed — not
  before review, not once per finding. Its same-SHA PASS is what the merge gate reads.
  The package `tests` row is the diff's packages plus one dependent layer.
  `rootTests` and `plugins` run the test files that import or read a changed file,
  and fall back to the whole tree when a changed file has no static reader. L1 runs
  those trees in full. `tests`, `build` and `format` carry forward across an
  in-place `reference/*.md` edit that nothing reads; architecture still runs.
- **Merge** (`<merge_gate_entry>`). Reads the same-SHA L0 sticky and adds merge-load
  (the merge judged against the current default-branch tip). It does **not** need a
  `<pre_merge_entry>` run, even after the default branch advanced.
- **L1 — the post-merge catch-net** (arc: `docs/guides/main-catchnet.md`). Full
  dependents, heavy tests, e2e fleet, native, binary smoke, UI smoke — on main, in
  batches, with its own bisect and absence alarm. Nobody in the PR loop runs its work
  "just in case", and nobody in the PR loop writes or confirms its verdicts.

Reviewers **read** a verification fact (the PR's same-SHA verification sticky, or
`--deliver-cached` on the producing machine); only the branch owner runs the gate. The
merge gate is **not** a read: its exit 0 writes the verdict record that authorizes the
merge, so only the merger runs it, immediately before merging. At most two heavy gates
run on one machine at once (the conductor schedules them; the machine-wide lane
lock stays off). A `TIMEOUT` with `failed=0` may be re-run once with the repo's
raise-only timeout override (arc: `ARC_VERIFY_TEST_TIMEOUT_MS`), stating the value;
`failed>0` is a real red — fix it or let the gate attribute it with `--blocked-by`.

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
--comment [<pr#>]   post the report. The first run executes; a later same-SHA
                    post is `--deliver-cached --comment` and does not re-run
--json              machine-readable
--na "<reason>"     write an N/A exemption (docs-only / native-only PRs)
--only a,b / --skip x,y   scope the check set (unknown id → hard error, exit 2)
                          → a scoped run is a DIAGNOSTIC, never a gate (see below)
--deliver-cached    post the cached report without re-running. Three states
                    (#5635), carried in `AGENTLOOP_CACHE_STATE=` and the exit
                    code — do not parse the prose:
                      current           exit 0 (PASS/NA) or 1 (FAIL/TIMEOUT/PARTIAL)
                      stale-identity    exit 5 (THIS scenario's base/location/
                                        capabilities moved; `.result`/`.md`/`.class`
                                        are retired so existence is not currentness)
                      missing           exit 1 (no current token for this scenario —
                                        including a leftover for a different
                                        scenario, which is NOT retired)
```

First run: `<verification_entry>` (add `--comment <pr#>` when the PR already exists; that invocation still executes). Same SHA already PASS: `--deliver-cached --comment <pr#>` posts the record and does not execute. Exit codes:
**0** = PASS (and, when `--comment`/`--post` was requested, the report WAS delivered);
**1** = verify FAIL (or `--deliver-cached` missing); **2** = empty check set / unknown `--only`/`--skip` id (fails
loud, never silent-green); **4** = verified PASS but the requested report was NOT
delivered — the remedy is to retry / fall back the comment post (e.g. paste the
stdout sticky body via MCP), NOT to touch the diff; **5** = `--deliver-cached`
stale identity. Do not hand-write the report or
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
  indistinguishable and the push gate accepted both. `fullScenario` is execution,
  not argv (#6399): a `failFastSkip` jump is the same colour as `--skip`, even
  when attribution later flips the aggregate. `coverage.checks` is the ids that
  actually ran (in run order), not the pre-loop selected list.
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
- **Evidence carries WHERE it was produced** (#5339), and **PASS from a sibling
  location in the same git common-dir store is reusable** when sha + scenario +
  resolved base + capabilities match (#5875). Each record still carries
  `location` (tree + host clone) and the report says so on a `📍 Produced at`
  line — location is on the artifact, not a refuse-to-reuse key for PASS.
  Same-location reuse stays (#5223). A sibling FAIL is never laundered into a
  PASS; re-verifying a red from a clean checkout is still a working move
  (`--retry-failed` at the producing tree). Single-flight still spans
  locations — two trees never run the same gate concurrently. To force a
  re-run, follow the **resolved** path the reuse notice prints (`Shared
  record: …`): the store lives in the git COMMON dir, so in a linked worktree
  it is NOT under the worktree's own `.git`. A cached FAIL is not retried on
  its own — pass `--retry-failed`, which the reuse line now says out loud.
- Evidence identity, the retired pre-merge donor, carry-forward, and host capabilities: Read [reference/gate-evidence.md](reference/gate-evidence.md).
