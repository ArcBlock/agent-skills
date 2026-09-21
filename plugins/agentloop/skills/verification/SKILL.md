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

Run the gate with `--comment <pr#>` so "run" and "post" are one step. Exit codes:
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
- **A scenario may inherit another scenario's PASS when it is the same question.**
  `ScenarioConfig.equivalentEvidenceFrom: ["pre-pr"]` on pre-merge lets it reuse
  pre-pr's record at the **same sha, same resolved base, same capabilities** — which
  is exactly the merge-base == default-branch-tip case, where the two doors run the
  same checks over the same diff on the same tree (measured: 33 of 88 pre-merge runs
  on one machine, all re-PASS, ≈81 min). The engine still requires the donor to be a
  full PASS whose executed checks **cover every check this scenario would select**
  at that base; a FAIL never crosses scenarios (and an `--na` exemption is local-only,
  never in the shared store, so it cannot donate); a check the donor lacks turns it
  off and is named on stderr (`does not cover: <id>`). One-way: pre-pr never inherits
  from pre-merge (#6239). The report header says `♻️ Equivalent evidence` and names
  the donor; the local `.verify/<sha>.metadata.json` carries `equivalentFrom`. The
  lane peek honours it too, so an equivalent run never queues behind another gate.
  Agents: **always invoke the entrypoint** — the sticky marker carries neither base
  nor scenario, so "read the fact off the sticky" is not something you can do.
- **…and by WHAT THE HOST COULD DO while it was produced** (#5386). `location`
  answers *where*, not *with what*. Some checks' answers depend on an
  environment fact — can this host reach the upstream it mirrors, does
  `*.localhost` resolve — and an input outside the identity gives one identity
  two correct answers. A repo declares those facts as `capabilities` next to
  its check list (`{ id, probe }`); the vector is probed once per run, recorded
  on every artifact, and forms the record's slot. A verdict produced **without**
  a capability is never served to a host that has it, and — the direction that
  actually launders failures — a green produced **because a check could not
  run** is never served to a host that would really have run it. Refusals name
  the capability and both its states.
  - **Only a fact that can be PROBED ahead of the run is eligible to be keyed.**
    A gap a check *reports* (`stats.envGap` / `failure.class = "ENV_GAP"`) is
    knowable only afterwards, so it never enters the key: the slot a reader
    computes could never be the slot such a run publishes into, and that host
    would be unable to read back its own artifact, which livelocks `pre-push`.
  - **A run an env gap decided publishes no reusable evidence at all.** It still
    writes its LOCAL artifact — that is this host's own answer for its own push
    gate — but nothing is banked for anyone to inherit, and the run says so.
    Disclosure alone was not enough: the notice is prose while the gate parses
    `result=`, so a host that HAS the capability would inherit a green this gate
    never measured there. This is a publish-time decision, not an identity input,
    and it is the same shape as the dirty-tree rule beside it. The price is that
    a gapped host re-runs every time; declare the capability to get reuse back.
  - **A check can also opt out of reuse without claiming an env gap (#6420).**
    `CheckResult.reusable: false` is the other publish-time withhold. Use it when
    this round's answer is host-local (a true timeout, a machine-bound
    measurement) but the host is not missing a capability — lying `ENV_GAP` to
    get the withhold was the hole this field closes. Colours, `passed()`, and
    the sticky-gate accept set do not move (taxonomy R2); only publish-or-not.
  - **`unknown` is an equality class.** A probe that throws records `unknown`,
    and two hosts whose probes threw for *different* reasons will reuse each
    other's evidence. That is a named residual, accepted deliberately: the
    alternative — `unknown` matching nothing — lets one broken probe silently
    switch the broker off, which looks identical to a working broker. A repo
    that wants a hard answer should return `false`, which is its own class.
  - **Bumping `EVIDENCE_SCHEMA_VERSION` costs one full gate per runner.** Every
    banked record is invalidated, so on the release that carries a bump each
    fleet runner re-runs its whole gate once, per in-flight (sha, scenario,
    base, location). Real, one-time, and worth stating before you bump.
