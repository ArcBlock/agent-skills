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
ls ~/.agentloop-fleet/env 2>/dev/null && echo "envFile present"  # credentials; installer scaffolds it if absent
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
   (A repo must have been through `/agentloop:repo-setup` — repo-profile + labels — first.)
   **If a covered repo's conventions live in ANOTHER covered repo** — a content/blocklet repo
   whose page format and examples belong to the repo that builds it — give it
   `referenceRepos`, or its agent works blind and re-invents conventions that already exist.
   In the `--repos` spec that is the `+` tail: `Owner/site=issue-sweep@240+Owner/core`.
   Do not ask about this when no such pairing is apparent; it is rare.
3. **where** (header "Where"): Local (crontab) / Cloud (routines) / Both. Default = Local if a
   crontab exists and the machine stays on; else Cloud.
4. **cadence + model** (header "Cadence"): cadence minutes per repo (default 120 = every 2h under
   an hourly cron) + model (default `claude-sonnet-5`).

**Also ask, when the machine is special (B6):** is this deployment **full-coverage** or a
**capability-restricted specialist**? "Local only does what only local can do" is the entire
reason to run local at all — a cloud sandbox is TS-only, it cannot run Xcode or gradle. The seam
for that is `promptDir` (`fleet/driver.ts:161`), and it is the ONLY seam: `renderPrompt` is a
whole-file replace (read the prompt file, substitute `{{RUNNER}}`), there is no append/addendum
hook. Per the plugin CLAUDE.md, a per-machine preference belongs in a local prompt, never in the
shared `fleet/prompts/*.md`.

The recipe that was measured to work: point `promptDir` at `~/.agentloop-fleet/prompts/` holding a
**thin wrapper** per skill — a SCOPE GATE at the top, then an instruction to read the upstream
`<plugin>/fleet/prompts/<skill>.md` verbatim at the bottom, so a plugin upgrade never leaves a
stale copy running. Both directions were verified on a native-capable Mac: with zero in-scope
issues, a 62-second no-op round left 12 PRs' comments / `updated_at` / labels **line-for-line
identical**; with in-scope work it closed two `macos-26` / `native-ios` issues on
"real Apple-Intelligence-eligible hardware evidence that other fleet machines lacked", and 5
spot-checked out-of-scope issues were untouched.

Honor any value the user typed in an option's note. **Ask once, then execute — the questions are
the confirmation.**

## Step 2 — LOCAL (if "Local" or "Both")

> **★ B1 — a verification run from YOUR OWN shell is a FALSE POSITIVE. Never treat a
> `--force` round you launched from your terminal as evidence that setup works.**
>
> Measured, 2026-07-29 first real deployment: with `CLAUDE_CODE_OAUTH_TOKEN` set to an **empty**
> value, and again to a **deliberately corrupted** one, `claude -p` still **exited 0 with correct
> output** in a GUI session — the macOS keychain backstops it, so the env var is not what decides.
> A cron session cannot read that keychain, so the identical config fails every round with
> `Not logged in`. The installer's own dry-run/apply output says nothing about this either.
>
> **The only valid verification is a real cron tick** (or a context with the keychain stripped).
> Tell the user that plainly, and don't call setup complete on the strength of a hand-run round.

Run the installer **dry-run first**, show the user the plan, then apply:

```bash
bun "$PLUGIN/fleet/setup.ts" \
  --runner <runner> \
  --repos "<slug=skill,skill@cadence;…>" \
  --checkout-base-dir <base with your clones, e.g. ~/Develop/arcblock> \
  --env-file ~/.agentloop-fleet/env \
  --model <model> \
  --local                       # dry-run: prints deployment.json + repos.json + crontab block
bun "$PLUGIN/fleet/setup.ts"  … same flags …  --local --apply     # writes config + installs crontab
```

- The installer merges over any existing config (preserves hand-added `skillEnv`/`env`), reconciles
  the crontab marker-block (never touches other cron), and is idempotent.
- **envFile — the installer writes it for you.** It derives `GH_TOKEN` from the machine's own
  `gh` session, leaves a marked `FILL` line for `CLAUDE_CODE_OAUTH_TOKEN` (an interactive
  browser login is the human's to run, never a script's), and writes mode 600. It NEVER
  overwrites an existing file — an env file holds someone's credentials. If its output shows a
  `RUN:` line, relay it and do not call setup complete: a round that sources 0 vars aborts on
  the first fire, which is loud but wastes a cycle.

  ```bash
  claude setup-token          # only if the installer asked for it, then paste into the envFile
  ```

  **Why `setup-token` is not optional on macOS (B2).** Measured on one machine, same day: a cron
  session running `security find-generic-password -s "Claude Code-credentials"` is **refused
  (exit 44)**, while the GUI session on that same machine reads it fine. Someone who uses
  interactive `claude` happily will reasonably assume cron inherits that login — it does not, and
  the failure surfaces only as a `Not logged in` round an hour later. Say the reason, not just the
  command. (The other route is a launchd **LaunchAgent**, which runs inside the GUI session and
  needs no token at all — at the cost of stopping when the user logs out, and the installer does
  not recognize it.)
- **Repos running a daemon** (arc: `arc service`) isolate concurrent skills with named
  instances: `arc service start fleet-issue-sweep` / `fleet-pr-sweep` — the port is
  kernel-allocated, and `arc service url NAME` reads the address back. Leave `skillEnv`
  empty unless a skill genuinely reads a value from it; entries there survive every
  later reconcile.

## Step 3 — CLOUD (if "Cloud" or "Both")

For **each covered (repo × skill)**, materialize a claude routine from the SAME catalog. Canonical
name = `<repo-name> <skill> hourly` (e.g. `arc issue-sweep hourly`). Render the prompt:
`<PLUGIN>/fleet/prompts/<skill>.md` with `{{RUNNER}}` → runner and
`{{CONCURRENCY}}` → the cloud-plan entry's `concurrency` (from this repo's
`skillConcurrency[skill]`, default 3).

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
- **★ B4 — a non-canonical existing routine will be DUPLICATED, not updated.** Canonical matching
  is by name, so an account that already carries e.g. `issue-sweep hourly` / `pr-sweep hourly`
  (no repo prefix) does **not** match this skill's `<repo-name> <skill> hourly`, and picking Cloud
  creates two NEW routines beside them — four overlapping runs on the same repo. Step 0's listing
  must therefore be read for **same-skill-different-name** routines too, not just exact matches,
  and any it finds must be surfaced as an explicit warning before you create anything ("rename
  these to the canonical form, or you will end up with both").

Cloud and local can both cover the same repo safely (advisory lock + deterministic branch +
stagger), but usually pick one — and **be concrete about why (B3)**:

- **The quota is shared with the human's own usage.** Anthropic's support docs state usage limits
  are *shared across Claude and Claude Code*, all activity counting against the same limits. So an
  overlapping fleet does not just burn "double fleet tokens"; it eats the same allowance the
  person is typing against.
- **What overlap actually looks like** (measured, same day, same repo, local + cloud concurrently):
  `#2636 concurrently merged by peer runner, verified independently` — both sides ran a full
  verification pass; `found #2630's bug 2 fix duplicated concurrent PR #2638 so discarded mine` —
  the local side finished the whole implementation before discovering the duplicate, and threw
  the code away. The locks prevent corruption, not wasted work.

## Step 4 — report (one final message, table)

| repo × skill | where | action | schedule | next run |
|---|---|---|---|---|
| arc · issue-sweep | local | installed / cloud updated / unchanged | `17 * * * *` | … |

Plus:
- **Credentials**: the installer writes the envFile (mode 600), deriving `GH_TOKEN` from the
  machine's own `gh` session. It NEVER overwrites an existing one. If it printed a `RUN:` line
  for `CLAUDE_CODE_OAUTH_TOKEN`, say so plainly and stop short of calling setup complete —
  `claude setup-token` is an interactive browser login, so it is the human's to run, and a
  fleet whose envFile sets 0 vars aborts on its first fire.
- **How to watch it**: `/agentloop:fleet-report` reads the fleet's own telemetry back — rounds
  run vs skipped (and why), what each produced, per-repo×skill duration, and whether any round
  left processes behind. Say this every time: a fleet nobody looks at is one whose first
  failure is discovered by accident.
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
- **A covered repo must have been through `/agentloop:repo-setup` first** — repo-profile + labels —
  or the sweep skills can't find its toolchain.

## Troubleshooting — two things that look broken and are not

Say both of these in the Step 4 report of a first-time install. Each cost real debugging time on
the 2026-07-29 deployment, and neither is discoverable without reading source.

- **`skipped-locked` right after install is EXPECTED (B5).** The first rounds clear a backlog and
  can run far longer than the cron interval: measured **63 and 64 minutes** against a 30-minute
  interval, so the next two invocations were `skipped-locked` on the spot. That is the
  per-(repo,skill) lock doing its job — one slow repo delays only itself. Once the backlog is
  drained the same skill took **7 minutes**. Set the expectation up front, or the first hour reads
  as a broken install.
- **The trust warning is noise, not the root cause (B7).** Every round prints
  `Ignoring N permissions.allow entries … has not been trusted`. Under the fleet's `skip`
  permission posture `permissions.allow` is moot anyway, while `permissions.deny` **is still
  enforced** — recorded in `fleet/setup.ts`'s file header and `fleet/driver.ts:169-177`. It was
  misread as the failure's root cause once already; name it as expected output so the next person
  doesn't spend the same time on it.
