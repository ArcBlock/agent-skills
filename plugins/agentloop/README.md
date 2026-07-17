# agentloop

Repo-agnostic engineering-loop engine, extracted from `ArcBlock/arc`'s
`.claude/skills/`. The engine holds the mechanics; each repo keeps its specifics
in `.claude/verify/config.ts` and `.claude/repo-profile.md`.

Status: **work in progress** (issue [ArcBlock/arc#1037](https://github.com/ArcBlock/arc/issues/1037)).
Shipped: the **verification gate** engine + the loop-engine skills (verification /
issue-sweep / issue-review / pr-sweep / pr-review / impact-check).

## What's in the plugin

```
.claude-plugin/plugin.json     # manifest (name: agentloop)
lib/report.ts                  # CheckResult contract + deterministic run/render helpers
lib/comment.ts                 # sticky PR-comment upsert (marker-keyed, gh REST)
lib/gate.ts                    # requireStickyGate — the merge-gate primitive
lib/scenario.ts                # runScenario() + cmd() — the config-driven gate runner
lib/*.test.ts                  # engine unit tests (report / comment / gate)
skills/verification/SKILL.md   # the verification contract (repo-agnostic)
skills/issue-sweep …           # loop-engine skills (issue/PR sweep + review + impact-check)
```

These skills still contain arc-specific case-law and paths; de-arc-ifying them into
`repo-profile` keys is a later #1037 step. They are hosted here (single source) and
loaded into any repo via `--plugin-dir`.

## Loading in headless routines (reliability note)

A moved skill only loads when the plugin is loaded. Marketplace auto-install does
**not** run under `claude -p` (verified), so every routine invocation must pass
`--plugin-dir .claude/plugins/agentloop`. arc's `setup-routines` bakes this
into the generated crontab. A bad `--plugin-dir` path fails **silently** (exit 0,
skill just absent) — guard it with an existence check on `.claude-plugin/plugin.json`.

## The engine/config/checks split

- **Engine** (here): report kernel, comment delivery, `runScenario`. No pnpm,
  turbo, or repo paths.
- **Repo config** (`.claude/verify/config.ts` in the consuming repo): the check
  list. Command-checks are pure config (`cmd({ command: "pnpm build" })`);
  logic-checks (Swift/Kotlin parity, MCP-tool parity, …) import a repo-local
  module.
- **Repo checks** (repo-local): the arc-specific `check-*.ts` implementations.

## How a repo consumes it (two mechanisms)

- **Deterministic runner** — a repo's thin `.claude/verify/pre-pr.ts` imports
  `runScenario` from this engine and calls `runScenario(config, process.argv)`.
  During in-repo development the import is a relative path into
  `.claude/plugins/agentloop/`; once this engine moves to its own repo the
  import points at a pinned checkout.
- **Prompt skills** — the `skills/` here load into Claude Code. For headless /
  cron use the reliable path is `claude -p --plugin-dir <this-dir> …` (a committed
  `extraKnownMarketplaces` in project settings does **not** auto-install in
  headless mode — verified). Guard every invocation with a hard existence check on
  `<dir>/.claude-plugin/plugin.json`, because `--plugin-dir` with a bad path
  **succeeds silently**.

## Dry-run contract

Every skill that makes an outward write (comment / issue / PR / close / merge / label /
push) supports a **dry-run**: a preview that makes **zero outward writes**, acquires
**no lock**, and still produces the full report of what it *would* do. The canonical
flag is **`--dry-run`**, and it means the same thing everywhere — so a repo adopting the
plugin never has to remember a per-skill variant.

| Skill | Flag | Notes |
|---|---|---|
| issue-sweep / pr-sweep | `--dry-run` | report WOULD-DO; no post/PR/close/merge; no trace |
| issue-review | `--dry-run` | preview; no comment/spin-off/label; **no lock**. (`--no-post` = deprecated alias) |
| verification | `--dry-run` | alias of `--comment-dry-run`. The **checks always run** (no side effect); dry-run only suppresses posting the report, printing it instead |
| issue-graph `producer.ts` | `--dry-run` | print the intended graph writes |
| bootstrap `sync-labels.sh` | `--dry-run` | preview the coordination labels; create nothing |

**Two deliberate exceptions (not inconsistencies):**

- **Bulk writers default to dry-run.** `issue-graph`'s `backfill.ts` is dry-run *by
  default* and needs `--execute` to actually write sub-issue links — safety-by-default
  for a bulk mutation. Same concept, flipped default, on purpose.
- **verification's dry-run is comment-scoped.** Its checks have no side effect, so
  `--dry-run` there only governs the one outward write (the PR comment); a bare
  "don't run anything" would be meaningless.

Read-only skills (impact-check) and local-only execution (build-phases) make no outward
write, so they have no dry-run flag.
