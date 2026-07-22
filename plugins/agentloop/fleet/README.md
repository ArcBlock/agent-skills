# agentloop fleet — decentralized multi-repo driver

Run the agentloop loop across many repos, from **many independent deployments** (cloud,
local, anywhere). Each deployment covers **all or a subset** of repos; deployments do not
coordinate with each other directly.

## How coordination works (no central coordinator)

Coordination is **GitHub labels**, not a central service. The loop skills acquire an
`agent:processing` advisory TTL lock per issue/PR before working it, and skip items that
are already freshly claimed; deterministic branch names (`claude/issue-<N>`) + claim
checks catch the residual race. So any number of deployments can cover overlapping repo
sets — whichever grabs an item first processes it, the rest skip. **GitHub is the shared
claim substrate.** This is the same mechanism that already lets a cron sweep and several
humans work one repo without stepping on each other.

> Caveat: label-claiming is advisory, not atomic. Under very high concurrency two
> deployments can briefly double-claim; the deterministic branch + pre-open claim check
> converge it. Good enough (it's the existing multi-actor design), not a distributed lock.

## The two config files

- **`repos.json`** — the *catalog*: every repo that COULD be covered, with its
  `defaultBranch`, the `skills` to run (invoked as `agentloop:<skill>`), and a `cloneUrl`.
  Shared/canonical (copy `repos.example.json`).
- **A deployment config** (per deployment, local) — `runner` id, `checkoutBase`, and
  `cover: "all" | [slugs]` (+ optional per-slug `overrides`). This is where a deployment
  declares "I handle all repos" or "I handle just these" (copy `deployment.example.json`).

## Config field reference

Authoritative schema is `driver.ts` (`DeploymentConfig` / `RepoEntry`); this table mirrors it.

### deployment config
| field | required | default | meaning |
|---|---|---|---|
| `runner` | ✅ | — | runner id, carried into every comment's identity line (`runner:<x>`) |
| `checkoutBase` | ✅ | — | where per-repo checkouts live; a checkout is `<base>/<owner>__<name>` (`~` expanded) |
| `cover` | ✅ | — | `"all"` (every catalog repo) or an explicit slug list |
| `agentloopRoot` | | this plugin's dir | `AGENTLOOP_ROOT` + `--plugin-dir`. **Must be ABSOLUTE** — `~` is NOT expanded here (it isn't shell-evaluated). Point it at the marketplace clone the cron reads. |
| `checkout` | | `{ mode: "clone" }` | `{ mode: "worktree", baseDir }` reuses existing clones (preferred on a dev machine) — see Checkout modes |
| `checkoutPerSkill` | | `false` | give each (repo × skill) its own tree — set `true` when a repo runs >1 skill on a schedule, else the skills serialize and chained sweeps miss the cadence window |
| `permissionMode` | | `acceptEdits` | `skip` = `--dangerously-skip-permissions` (codex: `--dangerously-bypass-approvals-and-sandbox`), the workable posture for fresh checkouts — see Permission posture |
| `engine` | | `{ kind: "claude" }` | which CLI drives runs — `{ kind: "claude" \| "codex", bin?, model? }`. Omit for the original claude behaviour. **codex needs the plugin GLOBALLY installed** (`codex plugin add`) and `agentloopRoot` pointed at that install (no per-invocation `--plugin-dir` on codex) — see Engine. A repo overrides via its own `engine`. |
| `envFile` | | — | shell file sourced before every run — **where credentials live** (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`). Effectively required for a scheduled deployment; a round that sources 0 vars aborts LOUD |
| `env` | | — | extra env for **every step** of a run — checkout (`git clone`/`fetch`), `setupCommand`, and the skill; `{{CHECKOUT}}` expands to the run's checkout path. Use it for anything those steps must see (`npm_config_store_dir`, registry/proxy, `GIT_SSH_COMMAND`): pointing a store-dir at the wrong disk fails *silently* — the install still "succeeds", just against the wrong config |
| `skillEnv` | | — | per-skill env keyed by skill local name — how two concurrent skills avoid colliding (daemon ports / `ARC_HOME`); `{{CHECKOUT}}` expands. **Needed for any repo whose skills boot a daemon** (arc: issue-sweep :4910/:8797, pr-sweep :4920/:8807) |
| `model` | | CLI default | LEGACY/claude — the claude model (`--model`, e.g. `claude-sonnet-5`). For codex set `engine.model` (emitted as `-m`); the id namespaces don't overlap, so one shared field can't serve both |
| `parallel` | | `false` | run the covered repos of one skill concurrently (a slow arc won't block did/site); costs N sessions + N× API burst on one token |
| `staggerSeconds` | | `30` | seconds to space apart each repo's START (API-burst courtesy). Serial: waits between runs. Parallel: launches repo _i_ at _i_×stagger, all still concurrent. `0` = all at once |
| `logDir` | | `<checkoutBase>/logs` | per-(repo,skill) `.log` + `fleet.jsonl` |
| `promptDir` | | this plugin's `fleet/prompts` | override the unattended prompt dir (e.g. a dry-run variant) |
| `overrides` | | — | per-slug `Partial<RepoEntry>` merged on top of the catalog (e.g. narrow `skills` for one repo) |

### repos.json (catalog) entry
| field | required | meaning |
|---|---|---|
| `slug` | ✅ | `owner/name` |
| `defaultBranch` | ✅ | branch each checkout resets to per round |
| `skills` | ✅ | agentloop skill local names to run — `["issue-sweep","pr-sweep"]` |
| `cloneUrl` | | clone URL (clone-on-demand; optional if the checkout already exists) |
| `cadenceMinutes` | | per-repo throttle — the driver skips a (repo,skill) that ran within this window (stamped on SUCCESS only; `--force` ignores). `120` = every 2 h under an hourly cron |
| `setupCommand` | | run inside the checkout after materialize, before the skill — dependency install (`pnpm install …`); runs every round (cheap on a warm tree) |
| `engine` | | override the deployment `engine` for THIS repo — `{ kind: "claude" \| "codex", bin?, model? }`. Run one repo on codex while the rest stay claude (e.g. to compare them under a live schedule) |
| `referenceRepos` | | other **catalog** slugs this repo must be able to READ — shallow-cloned once to `<checkoutBase>/.reference/<owner>__<name>` (shared by all referrers, reset each round) and handed to the skill as extra `--add-dir` roots. For a repo whose conventions/examples live elsewhere (a content repo built by another repo's CLI). Always cloned, never a worktree — `--add-dir` grants **write**, and an unattended agent must not get a writable path into a developer's tree. Unknown slug throws; a failed mount fails the round rather than running blind |

### Reading the telemetry — `scripts/fleet-report.ts`

`fleet.jsonl` is the fleet's own record of itself. To turn it into numbers:

```bash
bun <plugin_root>/scripts/fleet-report.ts                 # terminal summary (all records)
bun <plugin_root>/scripts/fleet-report.ts --days 7        # a window
bun <plugin_root>/scripts/fleet-report.ts --html out.html # self-contained dashboard, light+dark
bun <plugin_root>/scripts/fleet-report.ts --json          # for further processing
```

It answers what the mechanical fields alone cannot: how many rounds actually RAN vs were
skipped (and why), what they produced, how long each repo×skill takes at the median/P90, and
whether any round left processes behind.

**Every number is computed from the file — no model counts anything.** A wrong number that
looks plausible is worse than no number, so interpretation (a skill, a human) reads this
output; it never generates it.

The report always states **field coverage**. Records written before a field existed cannot
answer questions about it, and a rate computed over a partial window silently understates
everything — so `produced 7/212` is shown rather than a bare "0 PRs opened", which would read
as a fleet doing nothing rather than a fleet that only recently started reporting.

**Env precedence** (later wins): `process env` < `envFile` < `env` < `skillEnv[skill]`; then the driver forces `ARC_UNATTENDED=1`, `AGENTLOOP_ROOT`, `ARC_AGENT_RUNNER` last (identity + unattended-hook arming are never overridable).

## Checkout modes (`checkout` in the deployment config)

Each covered repo gets a fresh, ISOLATED working tree per round. How it's materialized:

- **`{ "mode": "worktree", "baseDir": "/Users/you/Develop/arcblock" }`** — *preferred on a
  machine that already has the repos cloned*. Reuses each repo's existing clone
  (`<baseDir>/<repo-name>`) via `git worktree add --detach` under `checkoutBase` — shares
  the object store (no duplicate clone), isolated from your dev checkout. This is the
  `~/.arc-routines/wt` model.
- **`{ "mode": "clone" }`** (default) — a fresh shallow clone per repo (for cloud /
  ephemeral runners with no base clone).

Safety in both: a `.agentloop-fleet` marker is dropped in trees the driver creates, and it
**refuses to `reset --hard`/`clean` any tree without it** — so a mis-pointed path (e.g. a
`checkoutBase` overlapping your dev workspace) can never nuke a checkout it didn't create.
In worktree mode the dev clone is only ever the *base* (fetched into), never reset.

## Parallel repos (`parallel` in the deployment config)

The repos covered by ONE skill invocation are independent — each sweeps its own repo's
issues (or PRs). By default they run **serially** (a slow arc blocks did/site). Set
`"parallel": true` to run them **concurrently**: each still writes its own per-(repo,skill)
log (stdout mirroring is turned off so N outputs don't interleave). Trade-off: N concurrent
headless sessions and N× the API burst against one token — a **GitHub App token**
(per-installation limits) is the real headroom fix (P5), a shared personal token can hit
GitHub's *secondary* (concurrency) rate limit under heavy parallelism.

## Per-repo run lock (`fleet/runlock.ts`) — why cron has no `shlock`

`parallel` handles concurrency WITHIN one invocation. But invocations OVERLAP across cron
fires, and that used to be the starvation trap:

- The cron row no longer wraps the driver in a `shlock`/`flock`. Instead the **driver holds a
  per-(repo,skill) advisory lock** (`<checkoutBase>/.locks/<owner>__<name>__<skill>.run.lock`,
  containing `<pid> <epochMs>`) around each repo's run.
- When a fire lands while a **slow repo is still running** from an earlier invocation, the new
  invocation finds that repo's lock held by a **live pid** and **skips just that repo**, running
  the others that are due. A cron-wide lock instead serialized the WHOLE invocation, so one lone
  slow repo (blockchain's ~2h pr-sweep, alone in its fire because cadence desynced the others)
  blocked every subsequent fire — starving arc even though they never share an invocation.
- Liveness is PID-based (`process.kill(pid, 0)`): a lock owned by a **dead** pid (a killed
  driver) is **stolen**, so nothing wedges forever. The atomic `wx` create closes the acquire
  race; a stale-steal has a tiny window — advisory, same philosophy as the GitHub-label claiming
  above, not a distributed lock.
- The shared writes overlapping invocations both touch (`.fleet-state.json` cadence stamps +
  `fleet.jsonl`) run under a short cross-process lock (`withFileLock`), which spins briefly then
  proceeds advisory (a contended stamp that times out just reruns that repo next fire).

Net: a very slow repo throttles only *itself*, never the fleet. Migration note — a deployment
whose crontab still has the old `shlock` rows keeps the old behavior until it re-runs
`/agentloop:fleet-setup` (or `fleet/setup.ts --local --apply`), which regenerates lock-free rows.

## Permission posture (`permissionMode` in the deployment config)

Headless has **no human to approve a tool call**, so anything missing the repo's own
`.claude/settings.json` allowlist is silently DENIED (that is how the first live smoke
lost Step 0's sync and Step 4's claim check). Which trade-off to accept is a
**per-deployment blast-radius decision — the driver does not hardcode it**:

| value | flag | when |
|---|---|---|
| `acceptEdits` **(default)** | `--permission-mode acceptEdits` | Safe but often not *working* on a fleet checkout: auto-accept edits; every other tool needs the repo's allowlist — which an untrusted fresh checkout ignores entirely (see below). Use when the deployment pre-trusts the checkout path, or for a read-only smoke. |
| `skip` | `--dangerously-skip-permissions` | **Unrestricted tool access.** An autonomous fix-and-PR sweep often needs it (it runs the repo's arbitrary build/test commands, which no allowlist enumerates) — this is what the proven cron routines use. Real blast radius: only for an isolated, disposable checkout on a runner you trust. |
| `default` | *(none)* | Strictest; mostly for debugging. |

Two measured facts decide this choice (both verified by isolated experiment, not inferred):

- **A `deny` rule still blocks under `skip`.** `--dangerously-skip-permissions` bypasses the
  allowlist and the trust prompt, but a `permissions.deny` entry in the repo's own
  `.claude/settings.json` is STILL enforced. So a repo keeps hard guardrails that hold even
  in the unrestricted posture — e.g. did denies `gh pr merge` / `pnpm release` / `npm publish`,
  and an unattended sweep there cannot merge or publish no matter what it decides to do.
  **Put anything a sweep must never do in `deny`, not merely outside `allow`.**
- **A fresh checkout is an UNTRUSTED workspace, so its `allow` list is ignored.** Claude Code
  says so out loud (`Ignoring N permissions.allow entry … this workspace has not been trusted`)
  — trust is per-directory (`~/.claude.json` → `projects[path].hasTrustDialogAccepted`), and a
  path the driver just created was never trusted. Under `acceptEdits` such a checkout therefore
  runs only what the read-only sandbox auto-approves; the repo's carefully-written allowlist
  buys nothing. That makes **`skip` the practically-required posture for fresh fleet checkouts**
  (which is why the proven cron routines use it — their worktrees also happen to be trusted),
  and it is why `acceptEdits` should not be read as "safe *and* working".

Every run also gets `ARC_UNATTENDED=1`, which arms the repo hook that hard-denies
`AskUserQuestion` / `Workflow` / `EnterPlanMode` — a waiting tool call would hang the run
forever. (Those are Claude Code tools; `codex exec` is non-interactive by construction and,
under the `skip` posture above, never blocks on an approval either — so the same "can't hang
waiting for a human" guarantee holds, by a different mechanism.)

## Engine (`engine` — claude or codex)

The driver spawns one CLI per run. It was claude-only; codex is now a first-class engine,
selected per-deployment (`DeploymentConfig.engine`) or per-repo (`RepoEntry.engine`), default
claude — an existing config with no `engine` behaves exactly as before. This was validated by
a live write-back probe: a real `issue-sweep` on `codex exec` created three translation files,
committed, pushed a branch, opened a draft PR (`Fixes #`), ran the verification gate and
attributed its one failure honestly — using the SAME shipped prompt, unchanged.

The CLIs differ in only a few flags (`buildArgv` is the single source of truth for both the
spawn and the dry-run string); everything else in the driver is engine-agnostic:

| | claude | codex |
|---|---|---|
| prompt | `-p <prompt>` | `exec <prompt>` (positional) |
| plugin | `--plugin-dir <root>` per invocation | **none** — loaded from the GLOBAL install (`codex plugin add`) |
| extra roots | `--add-dir` | `--add-dir` (identical) |
| `permissionMode: skip` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| `permissionMode: acceptEdits` | `--permission-mode acceptEdits` | `-s workspace-write` |
| model | `--model <id>` | `-m <id>` (own id namespace — set `engine.model`) |

**The one real asymmetry is plugin loading.** claude loads the plugin per-invocation from
`agentloopRoot`; `codex exec` has no such flag and sees only globally-installed plugins. So a
codex deployment needs the plugin globally installed and `agentloopRoot` pointed at that
install (so the prompt + the skill's own scripts, both read from `agentloopRoot`, are on the
same version codex loads — no skew).

`/agentloop:fleet-setup --engine codex` handles the alignment: it resolves the current codex
install (`detectCodexPluginRoot` — the highest-semver dir under `~/.codex/plugins/cache`) and
writes it as `agentloopRoot`. It does NOT install the plugin for you (symmetric with claude,
where setup detects the marketplace clone rather than running `claude plugin install`) — if no
codex install is found it FAILS LOUD with the two commands to run first:

```bash
codex plugin marketplace add https://github.com/ArcBlock/agent-skills.git
codex plugin add agentloop@arcblock-agent-skills
# then: /agentloop:fleet-setup --engine codex … (re-run after any codex plugin update to re-align)
```

Re-run setup after a `codex plugin add` update so `agentloopRoot` tracks the new version.

## Running

```bash
bun fleet/driver.ts --config <deployment.json> --catalog repos.json            # dry-run: print the plan
bun fleet/driver.ts --config <deployment.json> --catalog repos.json --only ArcBlock/did
bun fleet/driver.ts --config <deployment.json> --catalog repos.json --run      # (P4) execute
```

The driver resolves *which repos × which skills I run*, and for each emits:
`cd <checkout> && AGENTLOOP_ROOT=<root> ARC_AGENT_RUNNER=<runner> claude -p --plugin-dir <root> "<prompt: /agentloop:<skill>>"`.
Per-item claiming is inside the skills, not the driver.

## Status / phases

- **P1 registry** ✅ — catalog + deployment schema + resolver (`driver.ts`, tested).
- **P2 driver (dry-run)** ✅ — plan resolution + WOULD-RUN output.
- **P3 checkout lifecycle** ✅ — per-repo worktree/clone under `checkoutBase`, reset to
  `origin/<defaultBranch>` each round, marker kept OUT of the tree, isolated from any shared
  dev checkout (`ensureCheckout`, tested).
- **P4 live run** ✅ — `--run`: real headless execution, unattended per-skill prompts
  (runner-parameterized), stagger, envFile credential loading, per-(repo,skill) checkouts.
- **P5 scale-out** ◐ — **cadence enforcement** ✅ (`.fleet-state.json`), **run logging** ✅
  (per-(repo,skill) `.log` + `fleet.jsonl`), **mount guard** ✅. Still open: GitHub App auth
  (a local deployment uses a personal token; cloud runners already post as `claude[bot]`),
  per-run presence-board heartbeat (currently emitted by the skill's own profile hook, not
  the driver).
- **P6 scheduling** ✅ — wired to cron; a deployment is one row in a catalog, not a special
  case. arc's hand-written setup-routines can be retired onto this path.
