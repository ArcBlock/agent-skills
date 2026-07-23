---
name: setup-routines
description: Interactive one-shot setup/update of a runner's repo-declared cloud routines and durable local cron jobs, driven by the consuming repo's .claude/routines/ catalog (canonical names, base crons, prompt templates). Reconciles cloud triggers via RemoteTrigger (create-or-update by canonical name, per-runner minute stagger, per-trigger sources), prints the one-time environment prerequisites that have no API (plugin-install setup script, network access, env vars), and reconciles a crontab marker block for local routines in a dedicated worktree/clone (never the shared checkout). The generic issue-sweep/pr-sweep loop is scheduled by fleet-setup, NOT here — this skill owns everything a repo declares beyond that loop. Interactive (AskUserQuestion is core) — never run unattended.
---

# Setup Routines — one Q&A pass, a repo's custom routines fully reconciled

Any team member runs `/agentloop:setup-routines` **inside a repo that ships a routine
catalog** (`.claude/routines/`), answers a few all-defaulted questions, and gets:

- **Cloud routines** (via the RemoteTrigger tool): create-or-update by canonical name,
  per-runner stagger, per-trigger git sources, prompt rendered from the repo's templates
- **Durable local cron jobs** (system crontab + dedicated worktree/clone, optional)
- **Reconciliation of what already exists**: canonical-name matches are updated in place;
  unknown routines are listed for the human (the API has no delete)

> **★ Interactive skill — never run unattended.** Denied by a `deny-interactive-unattended`
> hook = you are in an unattended environment → stop and say "/agentloop:setup-routines
> needs a human present". Do NOT silently apply defaults: registering schedules is a
> durable outward action.

> **Scope split**: `/agentloop:fleet-setup` owns the generic per-repo issue-sweep/pr-sweep
> loop (driver-based, multi-repo). This skill owns the routines a repo declares in its own
> catalog — producers, QA sweeps, nightly deploys, GC jobs, anything repo-shaped. Never
> schedule issue/pr-sweep from here (it would double-fire against the fleet and the
> templates have long since diverged).

## The catalog contract (what the consuming repo provides)

Everything repo-specific lives in the repo, not in this skill:

```
.claude/routines/
  catalog.json        # the machine-readable routine list (schema below)
  templates/*.md      # one prompt template per routine, {{RUNNER}} etc. placeholders
```

`catalog.json` schema (all routine fields except `name`/`template`/`cron` optional):

```jsonc
{
  "repo": "Owner/repo",                     // canonical slug, used for trigger sources
  "envSetupScript": ["line1", "line2"],     // the environment's setup-script lines (printed, see Step 2c)
  "identity": { "gitUserName": true },      // Step 2 renders `git config --global user.name <runner>` advice into report
  "presenceRegister": "CMD {{RUNNER}} {{ROUTINES}} {{MODEL}} {{LOCAL}}",  // optional post-reconcile hook, run from repo root
  "routines": [
    {
      "name": "issue-graph producer hourly",  // canonical trigger name — the reconcile key
      "template": "templates/producer.md",
      "cron": "{{MIN}} * * * *",              // {{MIN}} = (minBase + runner offset) % 60
      "minBase": 45,
      "allowedTools": ["Bash", "Read", "Glob", "Grep"],
      "model": "claude-sonnet-5",             // default; Step 1 lets the user override
      "extraSources": ["Owner/other-repo"],   // additional git sources → per-trigger scope (see doctrine below)
      "clearMcpConnections": true,            // script-only routines don't need inherited MCP connectors
      "singleton": true,                      // team should run exactly one — affects Step 1 default
      "singletonProbe": "some read-only shell command",  // optional; output shown to inform the default
      "defaultOn": false,                     // Step 1 pre-selection when the runner has no existing trigger
      "vars": { "ENV": ["test", "staging"] }, // extra template placeholders; user picks/notes a value in Step 1
      "localOnly": false,                     // true = never a cloud trigger (crontab only), e.g. GC jobs
      "local": {                              // optional local-crontab form of this routine
        "command": "bun scripts/foo.ts",      // run inside the dedicated checkout; pure-script routines skip `claude -p`
        "lockName": "foo.lock"
      },
      "envPrereqs": ["Network Access: *.example.dev", "env var FOO_BAR (optional)"],
      "note": "one per team; shown in Step 1 option description"
    }
  ]
}
```

**No catalog → stop.** Tell the user this repo declares no routines and point at this
schema. Do not invent routines.

## Core design (why it looks like this)

1. **Prompt templates are the single source of truth**, versioned in the consuming repo.
   Updating a template + re-running this skill = the team-wide upgrade path. This is what
   ends per-person prompt drift.
2. **Stagger is built in**: minute offset = `cksum(runner) % 13`, added to each routine's
   `minBase`. N runners of the same routine start on different minutes; pair with any
   in-repo ordering rotation for processing-order diversity.
3. **Local jobs never use the shared checkout** — a cron `git checkout main` inside the
   directory a human is working in destroys their in-flight state (it has happened). Local
   routines run in a dedicated worktree (disk-cheap) or a standalone clone (fully
   isolated — the only safe option when the dev machine IS the routine machine).
4. **Durable local scheduling = system crontab**, not CronCreate (session-scoped,
   7-day expiry — cannot carry a persistent routine).
5. **Identity is config, not env**: `export ARC_AGENT_RUNNER=...` does NOT persist across
   an agent's Bash calls, so identity scripts invoked deep inside skills fall back to the
   sandbox's git `user.name` (e.g. "Claude") and produce phantom-runner attribution.
   Templates should (a) keep inline `<ENV>=<runner>` prefixes on the commands that support
   them AND (b) run `git config --global user.name <runner>` once at session start — the
   config file persists across Bash calls and every fallback chain ends there. Safe for
   routines that never commit; for committing routines weigh the author-name change first.

## Multi-repo doctrine (measured 2026-07-23, arc#2293)

- **Environments are shells; sources are per-trigger.** The platform provisions each
  session from the trigger's `session_context.sources`: those repos get cloned AND define
  the session's GitHub credential scope. One environment (setup script pasted once)
  serves any number of repos' routines.
- **Credential scope is frozen per session** — a running session cannot widen it, and
  ad-hoc cloning of undeclared private repos is refused by design. A routine that needs a
  reference repo must DECLARE it (`extraSources`); "clone whatever whenever" does not port
  from local. Cross-repo reporting equally requires the target repo in sources.
- **Consequence for presence**: a worker scoped to repo X cannot write a heartbeat to a
  board issue living in repo Y. GitHub-issue-based presence boards are structurally
  incomplete in a multi-repo fleet; a space-based presence sink (reachable from any scope)
  is the uniform channel. Catalog `envPrereqs` should include its network-access entry.
- **Trigger-level plugin fields** (`enabled_plugins`: array of `"plugin@marketplace"`
  strings; `extra_marketplaces`: array of `{name, source:{source:"git", url}}`) validate
  but do **not yet persist** server-side. Each reconcile run, set them anyway and check
  the `get` echo: the day they persist, tell the user the environment setup-script lines
  are obsolete.

## Step 0 — collect facts (all cheap, before any question)

```bash
git config user.name; whoami        # runner default: lowercased first name, else whoami
uname -s                            # Darwin → shlock, Linux → flock (Step 3)
crontab -l 2>/dev/null | sed -n '/# <slug>-routines:begin/,/# <slug>-routines:end/p'
cat .claude/routines/catalog.json   # the contract; stop if absent
```

Load `RemoteTrigger` (ToolSearch) and `{action:"list"}`:

- **Canonical hits** (exact name match against the catalog) → update set. Keep their
  `id`, `environment_id`, `events[].data.uuid`, `mcp_connections`.
- **Everything else** → legacy set: report name + cron + one-line summary; the API has no
  delete — the human handles them at claude.ai/code/routines.
- **environment_id default**: any existing trigger's value. None at all (first-time
  user) → obtain via the `/schedule` skill's environment injection, then return here.
- Tool unavailable (pure-local CLI) → skip cloud entirely, do local only, and say so.

For each catalog routine with `singleton: true`: run its `singletonProbe` (if any) and
inspect the trigger list for other holders. Held by someone else and fresh → default
unselected, name the holder. Held by this runner → default selected (update path).

## Step 1 — AskUserQuestion (≤4 questions, all defaulted, ask once)

1. **runner** (header "Runner"): derived value (Recommended) / whoami.
2. **routines** (header "Routines", multiSelect): one option per non-`localOnly` catalog
   entry. Default = `defaultOn`, overridden to ON where Step 0 found the runner's own
   existing trigger. Descriptions come from `note` + `envPrereqs` + singleton status.
   Routines with `vars`: the option description names the default value; the user
   overrides via the option note (each var value = its own canonical name, e.g.
   `deploy staging nightly`).
3. **local jobs** (header "Local"): none (Recommended when cloud covers it) / dedicated
   worktree (routine-only machines) / standalone clone (dev machine = routine machine —
   the only safe option there; a worktree shares branch refs with the main checkout and
   a cron `git checkout main` will steal `main` from the human's session).
4. **model** (header "Model"): catalog default (Recommended) / alternatives.

Honor any value typed in an option note. **Ask once, then execute — the questions ARE the
confirmation.**

Minute offset (deterministic, replaces `{{MIN}}`):

```bash
off=$(( $(printf '%s' "$runner" | cksum | cut -d' ' -f1) % 13 ))
```

## Step 2 — cloud reconcile (each selected routine)

Render the template: `{{RUNNER}}` → runner, `{{MIN}}` → computed minute, each catalog
`vars` key → chosen value.

- **Exists (canonical hit)** → `{action:"update", trigger_id}` with the **complete**
  `job_config` (original `environment_id` + `events[].data.uuid`, new message content /
  model / cron / sources). Update is whole-object replacement — omitting a field wipes
  it. `{action:"get"}` first if anything is uncertain. Never touch `mcp_connections`.
- **New** → `{action:"create"}`: fresh lowercase v4 uuid, Step 0's environment_id,
  `allowed_tools` and sources (`[repo] + extraSources`) from the catalog. Then for
  `clearMcpConnections` routines: `{action:"update", body:{clear_mcp_connections:true}}`
  (create inherits the account's connectors by default).
- Set `enabled_plugins`/`extra_marketplaces` per the doctrine section and note whether
  they persisted.
- Record each returned `next_run_at` for the report. `run` exists for an immediate
  smoke-fire — offer it, don't force it.

### Step 2b — presence register (only if the catalog declares it)

Run the catalog's `presenceRegister` command from the repo root with `{{ROUTINES}}` =
`name=cron;…` for everything just reconciled. Absent script/board must never block the
main flow.

### Step 2c — environment prerequisites (no API — print, once per environment)

Environments (setup script, Network Access, env vars) have **no API**. Print one
copy-paste block and mark it *one-time per environment, not per routine*:

- the catalog's `envSetupScript` lines verbatim (typically the two-line plugin install;
  suggest `#<tag>` pinning on the marketplace URL when the user wants reproducibility)
- every selected routine's `envPrereqs`, deduplicated
- where to paste: claude.ai/code → the environment → setup script / Network Access

If Step 0 showed existing healthy triggers on this environment, say the block is likely
already applied and this is a checklist, not a to-do.

## Step 3 — local crontab reconcile (only if Step 1 chose local)

Applies to `localOnly` routines and any selected routine with a `local` block.

### 3a. Dedicated working directory

```bash
REPO=$(git rev-parse --show-toplevel); SLUG=$(basename "$REPO"); BASE=~/.${SLUG}-routines
mkdir -p "$BASE/logs"
git -C "$REPO" worktree add --detach "$BASE/wt" origin/main 2>/dev/null || true; WT="$BASE/wt"
# standalone clone variant (dev machine = routine machine):
#   git clone "$(git -C "$REPO" remote get-url origin)" "$BASE/repo"; WT="$BASE/repo"
cd "$WT" && <repo's install command>       # hooks/scripts need dependencies present
```

Then, all still required (details unchanged from long experience — apply as-is):

- **Trust dialog**: mark `hasTrustDialogAccepted` for `$WT` in `~/.claude.json`, else the
  repo's `permissions.allow` is ignored in headless runs.
- **Memory symlink**: auto-memory namespaces by cwd — symlink the main repo's memory dir
  into the worktree's namespace (`/`→`-`, `.`→`-` encoding) or the routine runs blind.
- **Native toolchain allowlist**: append `Bash(<tool> *)` entries to user-level
  `~/.claude/settings.json` for tools actually installed (swift/xcodebuild/gradle/…),
  else headless runs silently skip native work.

### 3b. Credentials on macOS (cron cannot reach the GUI keychain)

`claude setup-token` → extract `sk-ant-oat…` → write `$BASE/env` (mode 600) with
`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN` (`env -u GITHUB_TOKEN gh auth token`), and
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (hard requirement everywhere: the default 600s
ceiling kills long background work mid-round and the round dies without a heartbeat).
Prefer a launchd LaunchAgent over cron on macOS when acceptable — it runs inside the GUI
session and needs none of this.

### 3c. Crontab marker block (idempotent: delete old block, write new)

One `# <slug>-routines:begin/end` block: PATH line, then one row per local routine from
its catalog `local.command`, wrapped in `flock -n` (Linux) / `shlock` (macOS) with logs
under `$BASE/logs/`. Pure-script routines run `bun`/their command directly — no
`claude -p`, no token needed. Never `crontab -r`.

## Step 4 — report (single final message)

| routine | where | action | cron | next run |
|---|---|---|---|---|

Plus: the Step 2c prerequisites block; the legacy list ("API has no delete — handle at
claude.ai/code/routines"); singleton reminders for anything left unselected; and — if the
trigger-level plugin fields persisted this run — the note that the environment setup
script can now be emptied.

## Constraints & sharp edges

- **Cloud cron minimum interval is 1 hour** (`*/30` is rejected); minutes must be
  staggered via the offset formula.
- **Update replaces the whole `job_config`** — always send it complete.
- **Never delete unknown routines** (you can't); list them for the human.
- **Crontab writes use the marker block only**; never touch anything outside it.
- **Local loops merge nothing**: PRs authored by the runner's own gh identity cannot be
  self-approved, so branch-protected repos stop at "PR ready". That is a safety property.
- Re-running this skill after any template/catalog change IS the upgrade path — it
  reconciles, never blindly recreates. Idempotent.
