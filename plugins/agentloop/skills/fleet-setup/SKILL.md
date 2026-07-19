---
name: fleet-setup
description: One-command setup/update of an agentloop FLEET on a teammate's machine or cloud — asks a few defaulted questions, then generates/reconciles the two config files (deployment.json + repos.json) and installs the schedule. LOCAL = a crontab marker-block wiring fleet/driver.ts (one row per skill; the driver fans out to every covered repo). CLOUD = one claude routine per (repo×skill) via RemoteTrigger, batch-created from the same catalog. Idempotent — re-run to upgrade. This is the SCHEDULING side that `bootstrap` (repo adoption) deliberately leaves out. Interactive — never runs unattended.
---

# Fleet Setup — one command, a few questions, the fleet is live

Any teammate runs `/agentloop:fleet-setup`, answers ≤4 defaulted questions, and gets a running
fleet — **local (crontab) and/or cloud (claude routines)** — from **one catalog** covering
**multiple repos**. Re-running reconciles (idempotent upgrade path). Config is generated, never
hand-written.

> **★ Interactive skill (AskUserQuestion is core) — never run unattended.** Denied by the
> `deny-interactive-unattended` hook = you are in an unattended environment → stop and say
> "/agentloop:fleet-setup needs a human present"; do NOT silently apply defaults (setting up a
> schedule is a durable, outward action that must be human-confirmed).

## How it splits (why local is code, cloud is you)

- **LOCAL** — a deterministic installer (`fleet/setup.ts`) does everything: generate/reconcile
  `deployment.json` + `repos.json`, then reconcile the `# agentloop-fleet:` crontab block (one
  row per skill; each row runs `driver.ts --skill X` which handles checkout/install/cadence/
  parallel across every covered repo). You just collect answers and run it.
- **CLOUD** — routine creation goes through the **RemoteTrigger** tool (an MCP tool is yours to
  call, not a script's), so YOU render the prompt + create/update one routine per (repo×skill)
  from the same catalog. Same catalog + prompts as local; only the scheduling substrate differs.

`fleet/setup.ts` is also runnable directly for scripted/reproducible bootstrap
(`bun fleet/setup.ts --runner me --repos "…" --local --apply`); this skill is the guided wrapper.

## Step 0 — collect facts (before asking; all cheap, read-only)

```bash
# plugin root the cron will read (stable marketplace clone; setup.ts auto-detects the same)
PLUGIN=~/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop
[ -f "$PLUGIN/.claude-plugin/plugin.json" ] || PLUGIN=<the --plugin-dir this session loaded>
# runner default: lowercased first word of git user.name ("Robert Mao" → robert); else whoami
git config user.name; whoami
uname -s                                             # Darwin → shlock, Linux → flock
crontab -l 2>/dev/null | sed -n '/# agentloop-fleet:begin/,/# agentloop-fleet:end/p'  # existing block
cat ~/.agentloop-fleet/repos.json 2>/dev/null        # existing catalog (reconcile, don't clobber)
ls -1 ~/Develop/arcblock 2>/dev/null                 # local clones you could cover via worktree mode
ls ~/.arc-routines/env 2>/dev/null && echo "envFile present"  # credential file for cron
```

Load `RemoteTrigger` (ToolSearch) and `{action:"list"}` to see the user's current cloud routines
**only if** the user will pick cloud. Tool unavailable (pure-local CLI) → cloud path is simply
not offered; local still works. Record canonical matches (update set, keep their `id`/
`environment_id`/`events[].data.uuid`/`mcp_connections`) vs unknown routines (legacy, report to
the human — the API has no delete).

## Step 1 — AskUserQuestion (≤4, all defaulted, ask once)

1. **runner** (header "Runner"): recommended = derived value / whoami. Goes into every comment's
   `runner:<name>` identity line and `ARC_AGENT_RUNNER`.
2. **repos + skills** (header "Repos", multiSelect): the covered set. Default = existing catalog
   if present, else the clones detected under the base dir, with `issue-sweep`+`pr-sweep` each.
   (A repo must have been through `/agentloop:bootstrap` — repo-profile + labels — first.)
3. **where** (header "Where"): Local (crontab) / Cloud (routines) / Both. Default = Local if a
   crontab exists and the machine stays on; else Cloud.
4. **cadence + model** (header "Cadence"): cadence minutes per repo (default 120 = every 2h under
   an hourly cron) + model (default `claude-sonnet-5`).

Honor any value the user typed in an option's note. **Ask once, then execute — the questions are
the confirmation.**

## Step 2 — LOCAL (if "Local" or "Both")

Run the installer **dry-run first**, show the user the plan, then apply:

```bash
bun "$PLUGIN/fleet/setup.ts" \
  --runner <runner> \
  --repos "<slug=skill,skill@cadence;…>" \
  --checkout-base-dir <base with your clones, e.g. ~/Develop/arcblock> \
  --env-file ~/.arc-routines/env \
  --model <model> \
  --local                       # dry-run: prints deployment.json + repos.json + crontab block
bun "$PLUGIN/fleet/setup.ts"  … same flags …  --local --apply     # writes config + installs crontab
```

- The installer merges over any existing config (preserves hand-added `skillEnv`/`env`), reconciles
  the crontab marker-block (never touches other cron), and is idempotent.
- **envFile is where credentials live** (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`). If it's missing, create it before the first fire —
  on macOS cron can't reach the GUI keychain, so drop long-lived tokens to a file:

  ```bash
  BASE=~/.arc-routines; mkdir -p "$BASE"
  T=$(claude setup-token | grep -oE 'sk-ant-oat[0-9A-Za-z_-]+' | head -1)
  G=$(env -u GITHUB_TOKEN gh auth token 2>/dev/null)
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\nGH_TOKEN=%s\nCLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0\n' "$T" "$G" > "$BASE/env"
  chmod 600 "$BASE/env"
  ```
- **Repos running a daemon** (arc: `arc service`) need per-skill isolated ports so issue-sweep and
  pr-sweep don't collide — add `skillEnv` to the generated deployment.json (issue-sweep
  4910/8797, pr-sweep 4920/8807). The installer preserves it once set.

## Step 3 — CLOUD (if "Cloud" or "Both")

For **each covered (repo × skill)**, materialize a claude routine from the SAME catalog. Canonical
name = `<repo-name> <skill> hourly` (e.g. `arc issue-sweep hourly`). Render the prompt:
`<PLUGIN>/fleet/prompts/<skill>.md` with `{{RUNNER}}` → runner.

- **exists (canonical match)** → `RemoteTrigger {action:"update", trigger_id, job_config}`. **First
  `{action:"get"}` for the full `job_config`** — update is a full replace; reuse the existing
  `environment_id` + `events[].data.uuid`, swap only message content / model / cron. Don't touch
  `mcp_connections`.
- **new** → `{action:"create"}`: new lowercase-v4 uuid, an `environment_id` (from an existing
  routine, or via the `/schedule` skill's environment injection for first-time users), the cron
  `<min> * * * *` with the per-runner stagger, `allowed_tools` including `Skill` + `Bash`/`Read`/
  `Glob`/`Grep`, and the rendered prompt as the message. The routine's own working dir must load
  the plugin via `--plugin-dir` (per-environment git source = the plugin's marketplace repo).
- Cloud cron **minimum interval is 1 hour** (`*/30` rejected); minutes must stagger (Step 0
  offset). Record each `next_run_at`.
- **Never delete unknown routines** (the API can't) — list them for the human.

Cloud and local can both cover the same repo safely (advisory lock + deterministic branch +
stagger), but usually pick one to avoid burning double tokens.

## Step 4 — report (one final message, table)

| repo × skill | where | action | schedule | next run |
|---|---|---|---|---|
| arc · issue-sweep | local | installed / cloud updated / unchanged | `17 * * * *` | … |

Plus:
- **Legacy**: canonical-unmatched cloud routines (name + cron + one-line summary) + "the API has no
  delete — handle at https://claude.ai/code/routines"; any old local block that was replaced.
- **Single-identity caveat (local)**: a local cron's PRs are authored by your own `gh` account, and
  GitHub forbids self-approving — so a clean local-loop PR stops at "ready, awaiting human
  approve+merge" (a safety gate, not a bug). Cloud routines posting as `claude[bot]` don't hit this.
- **Re-run = upgrade path**: change the catalog / bump the plugin, re-run `/agentloop:fleet-setup`.
  It reconciles, never rebuilds.

## Constraints & gotchas

- **Config is generated** — don't hand-edit `deployment.json`/`repos.json` and then re-run
  expecting your edits to win on structural fields; the installer merges but explicit answers
  override. Hand-added `skillEnv`/`env`/`cloneUrl` ARE preserved.
- **Crontab uses a marker block** (`# agentloop-fleet:begin/end`) — never `crontab -r`.
- **`--plugin-dir` is mandatory for headless** and fails SILENTLY on a bad path; the cron rows point
  at the marketplace clone the installer detected, whose existence Step 0 verified.
- **A covered repo must be bootstrapped first** (`/agentloop:bootstrap`) — repo-profile + labels —
  or the sweep skills can't find its toolchain.
