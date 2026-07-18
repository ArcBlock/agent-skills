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

## Publishing / Release (how a change here reaches the fleet)

**Distribution model.** `arc/.claude/plugins/agentloop/` is the **source of truth** —
develop here. `ArcBlock/agent-skills` is a **one-way published mirror** (the Claude Code
marketplace). The cron/fleet loads skills from the **marketplace clone** at
`~/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop` (this path is the
`agentloopRoot` in the fleet deployment config). Each cron fire is a fresh
`claude -p --plugin-dir <agentloopRoot>` that reads those files live, so **no restart is
needed for the cron** — the next fire uses whatever is on disk there (only an *interactive*
session needs a restart to pick up an update).

**⚠️ Two gotchas that have bitten before:**
- **`git pull` on the marketplace clone ≠ updating the plugin.** Use `claude plugin update`
  (step 3) — it git-pulls the clone AND installs the version.
- **You MUST bump the version on any content change.** `publish-agentloop.sh` warns if
  content changed but the version didn't; the marketplace/cache won't reliably pick up a
  same-version change.

Verified flow (2026-07):

```bash
# 0. edit arc/.claude/plugins/agentloop/**  (source of truth)

# 1. bump + sync to the marketplace repo (default DEST = ~/Develop/arcblock/agent-skills).
#    Bumps arc plugin.json + agent-skills marketplace.json TOGETHER, then rsync-mirrors.
#    Does NOT auto-commit/push (semver is deliberate; agent-skills main is protected).
bash scripts/publish-agentloop.sh --bump patch|minor|major   # pass a repo path arg if DEST differs

# 2. commit + push the marketplace repo. agent-skills main is protected
#    ("Changes must be made through a pull request"); the repo owner has admin bypass,
#    so a direct push to main goes through ("Bypassed rule violations").
DEST=~/Develop/arcblock/agent-skills
git -C "$DEST" add plugins/agentloop .claude-plugin/marketplace.json
git -C "$DEST" commit -m "chore(agentloop): sync from arc — <what> (<new-version>)"
git -C "$DEST" push origin main

# 3. install into the local cache + the marketplace clone the cron reads
claude plugin update agentloop@arcblock-agent-skills

# 4. VERIFY the cron's agentloopRoot actually updated (don't trust the update message alone)
ROOT=~/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop
grep -m1 '"version"' "$ROOT/.claude-plugin/plugin.json"     # == the new version
# + grep the specific content you changed to confirm it's present in $ROOT

# 5. source-of-truth hygiene: commit the arc side on its branch too
#    (publish-agentloop.sh already bumped arc's plugin.json).
```

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
