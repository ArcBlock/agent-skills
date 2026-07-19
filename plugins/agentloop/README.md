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

## Running the fleet on your own machine (teammate quickstart + debug)

The **fleet** (`fleet/driver.ts`) runs the loop across many repos from an *independent*
deployment on your machine — cloud or local, covering all-or-a-subset of repos. Nothing
coordinates centrally: deployments contend only through GitHub labels (whoever claims an
item first works it; the rest skip), so your local fleet safely runs alongside the cloud
routines and other teammates. Full driver semantics (coordination, checkout modes,
permission posture, parallel) live in [`fleet/README.md`](fleet/README.md); this is the
practical get-it-running-and-debug guide.

### The one-command path — `/agentloop:fleet-setup`

Don't hand-write any of the config below. Run the interactive setup skill:

```
/agentloop:fleet-setup
```

It asks ≤4 defaulted questions (runner / which repos+skills / local·cloud·both / cadence+model),
then **generates & reconciles** `deployment.json` + `repos.json` and **installs the schedule** —
**LOCAL** = the `# agentloop-fleet:` crontab block (one row per skill wiring `driver.ts`), **CLOUD**
= one claude routine per (repo×skill) batch-created from the same catalog via RemoteTrigger. It's
idempotent: **re-run it to upgrade** (change the catalog / bump the plugin → re-run). Under the hood
it calls the installer, which is also runnable directly for scripted bootstrap:

```bash
bun fleet/setup.ts --runner me --repos "ArcBlock/arc=issue-sweep,pr-sweep@120" \
  --checkout-base-dir ~/Develop/arcblock --env-file ~/.arc-routines/env --local   # dry-run
bun fleet/setup.ts … same … --local --apply                                       # write + install
```

The rest of this section is **what that does under the hood** — read it to debug or to configure by
hand. `fleet-setup` is the scheduling counterpart to `/agentloop:bootstrap` (which adopts a repo:
repo-profile + labels + verify gate, but deliberately does not schedule anything).

### 1. Prereqs
- **Install the plugin:** `claude plugin install agentloop@arcblock-agent-skills` (or
  `update`). The cron reads it from
  `~/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop` — that path is
  your **`agentloopRoot`**.
- **Clone the repos you'll cover** under one base dir (e.g. `~/Develop/arcblock/{arc,did,…}`)
  — `worktree` checkout mode reuses these clones (shares the object store, isolated tree).
- **A GitHub token** with repo write in an env file (`gh` uses it). Reuse
  `~/.arc-routines/env` if you already have one.

### 2. Two config files — live, per-deployment, NOT committed
Copy `fleet/deployment.example.json` + `fleet/repos.example.json` into `~/.agentloop-fleet/`
and edit. Minimal `~/.agentloop-fleet/deployment.json`:
```json
{
  "runner": "<your-name>",
  "agentloopRoot": "/Users/<you>/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop",
  "checkoutBase": "~/.agentloop-fleet/checkouts",
  "checkout": { "mode": "worktree", "baseDir": "/Users/<you>/Develop/arcblock" },
  "checkoutPerSkill": true,
  "cover": "all",
  "permissionMode": "skip",
  "model": "claude-sonnet-5",
  "envFile": "~/.arc-routines/env",
  "env": { "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS": "0" },
  "parallel": true,
  "logDir": "~/.agentloop-fleet/logs"
}
```
`~/.agentloop-fleet/repos.json` — the catalog (one entry per repo you cover):
```json
[
  { "slug": "ArcBlock/arc", "defaultBranch": "main", "skills": ["issue-sweep","pr-sweep"],
    "cloneUrl": "git@github.com:ArcBlock/arc.git", "cadenceMinutes": 120,
    "setupCommand": "pnpm install --frozen-lockfile --prefer-offline" }
]
```
- `cover: "all"` covers every repo in the catalog; use `["ArcBlock/did"]` for a subset.
- `cadenceMinutes` throttles per repo — the hourly cron **skips** a repo that ran within its
  cadence (so `120` = every 2 h even though the cron fires hourly).
- `permissionMode: "skip"` (= `--dangerously-skip-permissions`) is what the proven setup uses;
  a fresh checkout is untrusted so its allowlist is ignored — see the permission section in
  [`fleet/README.md`](fleet/README.md) before choosing anything else.
- **`skillEnv` (not in the minimal example above):** if a repo's skills boot a daemon — arc
  does — give each skill its own ports + `ARC_HOME` so issue-sweep and pr-sweep don't collide
  when they run concurrently (arc: `:4910/:8797` and `:4920/:8807`). Skip it and the second
  skill's daemon fails to bind. Every field is in the reference table in
  [`fleet/README.md`](fleet/README.md#config-field-reference).

**Each covered repo must have** its own `.claude/repo-profile.md` (the skills read toolchain /
face-paths / labels / verification_entry from it) **and the coordination labels**
(`agent:processing` / `agent:ready` / `needs-human-confirm` / … — run `bootstrap/sync-labels.sh`
once inside that repo). No repo-profile ⇒ the skills can't find the repo's toolchain.

### 3. Dry-run FIRST — zero writes, no cron
```bash
bun <agentloopRoot>/fleet/driver.ts \
  --config ~/.agentloop-fleet/deployment.json --catalog ~/.agentloop-fleet/repos.json
```
Prints the plan (which repos × skills, the exact `claude -p` command, cadence-skips) and
makes **no** GitHub writes. Scope with `--only ArcBlock/did` / `--skill issue-sweep`.

### 4. One real run manually, before wiring cron
```bash
bun <agentloopRoot>/fleet/driver.ts --config … --catalog … --run --only ArcBlock/did --skill issue-sweep
```
Watch it end-to-end and check the log (below) before trusting it unattended.

### 5. Cron — two independent rows (no cron-level lock)
issue-sweep and pr-sweep get separate schedules; each sources your env then runs the driver
for one skill (so each skill has its own cadence lane):
```cron
10 * * * * { . ~/.arc-routines/env; bun <agentloopRoot>/fleet/driver.ts --config ~/.agentloop-fleet/deployment.json --catalog ~/.agentloop-fleet/repos.json --skill issue-sweep --run; } >> ~/.agentloop-fleet/logs/cron-issue-sweep.log 2>&1
40 * * * * { . ~/.arc-routines/env; bun <agentloopRoot>/fleet/driver.ts --config ~/.agentloop-fleet/deployment.json --catalog ~/.agentloop-fleet/repos.json --skill pr-sweep    --run; } >> ~/.agentloop-fleet/logs/cron-pr-sweep.log 2>&1
```
**No `shlock`/`flock` wrapper.** The driver holds a **per-(repo,skill) lock** itself
(`fleet/runlock.ts`), so overlapping invocations coexist: if a slow repo (blockchain's ~2h
pr-sweep) is still running when the next fire lands, the driver **skips just that repo** and
runs the others that are due — a cron-wide lock used to serialize the whole invocation and let
one lone slow repo starve everyone. `cadenceMinutes` is the per-repo throttle. **Cron reads
`agentloopRoot` live each fire — no restart needed after a `claude plugin update`.**

### Debugging
| Symptom | Where to look |
|---|---|
| Which repos ran, ok/fail, duration | `~/.agentloop-fleet/logs/fleet.jsonl` — **authoritative**, one line per (repo,skill) run |
| What a run actually *did* | `logs/<Owner>__<repo>__<skill>.log` — full `claude -p` output (appended per run) |
| Driver-level failure (not agent output) | `logs/cron-{issue,pr}-sweep.log` |
| `envFile set no variables` | your env file wasn't sourced / has no vars — the driver fails **loud** rather than run credential-less |
| exit code **3** | mount guard — `checkoutBase`'s disk isn't mounted/writable |
| A repo silently not running | cadence skip (ran within `cadenceMinutes`) — the **dry-run** prints `skip … due in Nm` |
| Nothing happens / skill "not found" | bad `agentloopRoot` — `--plugin-dir` fails **silently**; verify `<agentloopRoot>/.claude-plugin/plugin.json` exists and its version matches what you published |
| A round "did nothing" but says ok | not a bug — check GitHub (labels/PRs). The tee'd `.log` does **not** echo the agent's `gh` actions; `fleet.jsonl` + GitHub are the truth |

**Golden rule:** trust `fleet.jsonl` (structured, per-run) and **GitHub itself** over the tee'd
`.log`. A "healthy but idle" round (backlog saturated / already claimed) looks identical to a
dead one in the log — only GitHub shows what actually landed.

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
  for a bulk mutation. `fleet/setup.ts` is the same: dry-run by default (prints the config
  + crontab block it would write), `--apply` to actually write config + install the crontab.
  Same concept, flipped default, on purpose.
- **verification's dry-run is comment-scoped.** Its checks have no side effect, so
  `--dry-run` there only governs the one outward write (the PR comment); a bare
  "don't run anything" would be meaningless.

Read-only skills (impact-check) and local-only execution (build-phases) make no outward
write, so they have no dry-run flag.
