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
log (stdout mirroring is turned off so N outputs don't interleave), and cadence-state +
`fleet.jsonl` are written after the barrier so nothing races. Trade-off: N concurrent
headless sessions and N× the API burst against one token — a **GitHub App token**
(per-installation limits) is the real headroom fix (P5), a shared personal token can hit
GitHub's *secondary* (concurrency) rate limit under heavy parallelism.

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
forever.

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
