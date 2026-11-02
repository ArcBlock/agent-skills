---
name: factory-dispatch
description: >
  Staged factory dispatch (epic #6896, superseding the retired #4289
  topology). Stage 1 — current dispatch path — is one local ARC instance
  scheduling locally installed code-agents via work-board Schedule →
  /dev/code-agents/.actions/dispatch-work (work + engine only; the host
  creates the run's worktree under the factoryRepo setting, #6911; the CLI
  `arc work dispatch` calls the same action, from inside a code-agents run
  only — a human CLI dispatch fails closed until #8733); no worker clone or :4900
  cockpit required. #6596's acceptance item 4 (a real GitHub commit/comment
  from the run) is still unmet; end-to-end is tracked by #6896 / #6928
  (acceptance command). Stages 2-4 (simulated-remote / LAN / cloud workers,
  contract in #4643) add capacity without blocking stage 1 — use the
  worker-clone procedure in this file only from stage 2 onward.
---

# factory-dispatch — staged dispatch (#6896)

Dispatch is staged; a later stage never blocks an earlier one (#6596).

| Stage | Shape | Entry point | Blocks stage 1? |
|---|---|---|---|
| **1 · local (current)** | one local ARC instance dispatches locally installed code-agents | work-board Schedule (work + engine) or `arc work dispatch` (an agent inside a code-agents run; a human CLI dispatch is refused until #8733) → `/dev/code-agents/.actions/dispatch-work` → `run` in a host-created `<factoryRepo>/.claude/worktrees/<name>` | — |
| 2 · simulated remote | same machine runs several ARC instances, some acting as remote workers | `scripts/factory-worker.sh` (rest of this file) | no |
| 3 · LAN remote | an ARC instance on another LAN machine acts as worker | #4643 | no |
| 4 · WAN / cloud | ChatGPT Work VM, Claude Code routine VM, Grokbot cloud, other self-hosted machines | #4643 | no |

**Stage 1 is the current work-board-driven dispatch path.** It needs no
worker clone and no `:4900` cockpit, and is not blocked by #4643. It is
**not** what the attended `/agentloop:epic-conductor` / `/agentloop:land`
skills use today — those dispatch a worker directly via the `Agent` tool
with `isolation: "worktree"`, a separate, human-facing path. Unifying human
manual dispatch and stage-1 factory dispatch onto the same action is the
explicit goal of epic #6898 (B — "派活复用 agentloop"), not yet landed. See
epic #6896 (parent: the "Factory v1" work; #6596 is the stage-1 topology
decision) for current work.

**Status caveat — do not infer this runs end to end today.** Since #6910
and #6911 the Schedule dialog takes only a work and an engine: the
instruction is generated (`/<skill> <work DID>`), and the host creates the
worktree from the `factoryRepo` setting (code-agents Settings). The start
directory, skill and instruction are folded "Advanced" overrides, recorded
on the run as `dispatchSource.override`. #6596's acceptance item 4 — a real
GitHub commit/comment produced by the run — is still unmet. A real
end-to-end run (import → dispatch → landed PR) is tracked by epic #6896 and
its acceptance command #6928.

**Everything below this point is the stage-2+ procedure** (worker clones,
`~/.arc-workers/*`, the Instances HUD): use it only when a human has asked
for simulated-remote / LAN / cloud capacity. It is not the primary topology
and does not check stage-1 dispatch.

---

You are the **attended conductor**. A worker runs its own ARC daemon and its
own `/dev/code-agents`, then exports that provider to the conductor with a
separate code-agent attach bridge. The human's long-lived `purpose=observe`
ARC instance exposes the **Instances HUD**, which is the visual observer of
every local worker instance. It is not an implicit remote scheduler.

A factory agent that itself runs `epic-conductor` (decompose, design-review,
hire, merge) remains the desired shape (#4432). Do not force-split that at
the factory layer.

## Topology (stage 2+)

| Role | State | Responsibility |
|---|---|---|
| Observer | one long-lived `purpose=observe` ARC instance | Instances HUD: inspect workers and blocklets |
| Worker | `arc service start --instance worker-{claude,codex,grok}` (home `~/.arc-workers/{engine}`), **own clone at `<home>/repo`** | one supervisor and engine family |
| Control bridge | worker `attach --as-host` → conductor `:4900` `/peers/w-*` | dispatch a managed code-agent from the conductor |
| Local control | worker-local `/dev/code-agents` | direct health and run-state inspection on that worker |

`scripts/factory-worker.sh` is the only factory entry point for a worker. Each
worker is a named instance (`arc service start --instance worker-{claude,codex,grok}`),
started with `--home ~/.arc-workers/<engine>`, `--purpose observe` (arc#5202 —
`ARC_INSTANCE_PURPOSE` is retired, ignored-with-warning; do not set it),
`AFS_PROJECT_DIR`, and the blocklet source together. Never copy a worker's
home or process table into another worker.

**Locate first; never scan HOME.** Before looking for a routine directory,
code-agent run record, source tree, or any other Factory-owned path, query the
authoritative surface:

```bash
bash scripts/factory-worker.sh paths <claude|codex|grok>
```

Its `routineRoot`, `runRecords`, and `sourceTree` fields name those three
locations (alongside the existing worker facts). Traverse only the returned
subtree. Never run `find` / recursive `rg` / `grep` / `ls` at `$HOME` or
`/Users/<user>`; granting TCC access only hides the same privacy violation.

**Each worker owns its own clone (#5015).** `~/.arc-workers/<worker>/repo` is a
real repository, not a linked worktree: its dispatch trees hang off it, its
daemon execs the `runtimes/node/dist/cli.mjs` *it* built, and its `fetch origin`
touches only its own refs. The primary checkout hosts no factory tree at all —

```bash
git -C /Users/robmao/work/arcblock/arc worktree prune                        # drop stale registrations first
git -C /Users/robmao/work/arcblock/arc worktree list | grep -c 'factory/'    # must be 0
```

**The prune is not cosmetic.** `worktree list` reports registrations whose
directory is already gone (`prunable`), and a real machine carries them from
before this change — measured at **8** on this runner, cleared exactly by
`worktree prune`. Without the prune the first operator sees `8` and **cannot
tell failure from residue**. (These tests leak none: the count held at 8 across
two full suite runs.)

### Clone state is THREE states, and `absent` is normal

`bash scripts/factory-worker.sh paths <worker>` reports it as `cloneState` /
`cloneClass`, and carries the `remedy` with it so nobody has to remember one:

| `cloneClass` | `cloneState` | meaning | who fixes it |
|---|---|---|---|
| `provisioned` | `provisioned` | an independent clone at `<home>/repo` | — |
| `absent` | `absent` | **normal.** A fresh machine, or after a cleanup. | `start` self-heals it |
| `broken` | `broken-linked-worktree` | the path is a worktree of another repo | a human |
| `broken` | `broken-not-a-repo` | the path exists but is not a clone | a human |
| `broken` | `broken-partial` | an interrupted provision left `<repo>.partial` | `rm -rf` that path |
| `broken` | `broken-foreign-repo` | a healthy clone — of a **different repository** | move it aside, re-provision |
| `broken` | `broken-unverified-origin` | which repo the factory manages could not be established | set `FACTORY_ARC_ROOT` or `FACTORY_EXPECTED_ORIGIN` |

A clone must be a clone **of the repository this factory manages**, not merely a
repository. "A git repo is rooted exactly here" admitted an independent clone of
an unrelated project, and `add` then created `factory/<id>` inside it.

### The seed is a DIFFERENT question from the destination

Three questions get asked about a path, and conflating any two of them is how
this area collected opposite review findings on the same `if`:

| # | question | asked of | answered by | a linked worktree is |
|---|---|---|---|---|
| Q1 | is there an **independent clone rooted here**? | `<home>/repo`, the destination | `factory_clone_state` | **broken** — its trees land in its host repo |
| Q2 | is this a **checkout rooted here**, of any kind? | `FACTORY_ARC_ROOT`, the seed | `factory_seed_state` | **fine** — `git clone <worktree>` works |
| Q3 | **which repository** is this? | both | the `origin` comparison | irrelevant — identity is a separate axis |

So `FACTORY_ARC_ROOT` may be a clone **or a linked worktree**, as long as a
checkout is rooted at that exact path and its `origin` is the repository this
factory manages. What is still refused, with a named reason and exit `2`: a
directory whose only repository is an **ancestor** (a git-managed `$HOME` is the
realistic instance), and a checkout of a **different** repository.

**`absent` is not an error.** It is where every machine starts and where it
returns after each cleanup, so `start` provisions the clone itself — idempotent,
refused when disk headroom is `constrained`, and it never touches a `broken`
one. Exit codes make the distinction callable — one meaning each, because a
caller acts on them:

| exit | meaning | what a caller should do |
|---|---|---|
| `0` | ok | proceed |
| `1` | provisioned but not built | run the build (step 1b below) |
| `2` | broken, or misconfigured | stop; a human must look |
| `3` | absent | provision, then retry |
| `75` | denied, may clear on its own (disk headroom, failed clone/fetch) | **do not retry in a loop** — retry after capacity recovers |

`75` is deliberately not `3`: the disk case used to return `3`, and an agent
obeying "provision and retry" then retries forever on a full disk. `75` is what
this repo already means by `FACTORY_ADMISSION_DENIED`
(`factory-commit-worktree-bootstrap.sh`, `factory-health-snapshot.sh`).

### Migration / first run — the full path for all three workers

There are no clones on a machine until this runs. It is safe to re-run.

```bash
# 1. clone + build each worker. `start` does step 1a on its own; it is spelled
#    out here because the BUILD is manual and takes minutes.
for w in claude codex grok; do
  bash scripts/factory-worker.sh provision "$w"                                  # 1a. clone
  ( cd ~/.arc-workers/"$w"/repo && pnpm install && pnpm --filter '@aigne/arc-cli...' build )   # 1b. build
done

# 2. confirm all three: cloneState=provisioned AND built=true
for w in claude codex grok; do bash scripts/factory-worker.sh paths "$w"; done

# 3. start them
for w in claude codex grok; do bash scripts/factory-worker.sh start "$w"; done

# 4. the acceptance command — prune FIRST, see below
git -C /Users/robmao/work/arcblock/arc worktree prune
git -C /Users/robmao/work/arcblock/arc worktree list | grep -c 'factory/'   # 0
```

**Every provisioned clone is pinned to upstream `main`, whatever branch the seed
was on.** `git clone <seed>` inherits the seed's current branch and its local
commits as the new clone's HEAD, and neither repointing `origin` nor fetching
moves it — so before this pin, step 1b compiled every new worker daemon from
whatever experimental branch the human checkout happened to have active
(measured 2026-08-25: the primary sat 46 commits behind `origin/main` on a `fix/`
branch). Provisioning now checks out `main` tracking `origin/main`, and says so:
`provisioned worker claude: … (origin=…, branch=main at <sha>)`. Set
`FACTORY_UPSTREAM_BRANCH` to run workers off another branch; if that branch does
not exist upstream, provisioning exits `2` naming it rather than silently keeping
the seed's HEAD.

**Provisioning needs network, and a failed attempt re-clones from scratch.**
Step 1a ends in a mandatory `git fetch --prune origin`; without egress to the
real origin it exits **75** having cleaned up after itself (verified: no clone
and no `.partial` left behind). The fetch is deliberately fatal — it is what
repoints the clone at the true upstream and drops the primary's local branches
from `refs/remotes/origin/*`, and a clone that skipped it would be a
half-provisioned state with no name. The cost of that choice is that a retry
after a network failure pays for the whole clone again; run step 1a somewhere
with egress.

> **Stated plainly: step 1b is the one part not covered by any test.** The suite
> proves absent → `start` → provisioned → (simulated build) → running, because a
> real `pnpm install` + turbo build twice is minutes of wall clock per run. If
> the build fails in a fresh clone, that failure is unproven territory — check
> `paths <worker>` shows `"built": true` before trusting a worker. That field is
> now safe to lean on: `built` can only be true beside `cloneState:
> provisioned`, so it can no longer report a CLI file sitting in a broken or
> foreign clone.
>
> Also unproven: **no test has ever run a real ARC daemon out of a fresh clone
> with `AFS_PROJECT_DIR=$ROOT`.**

Budget: a clone hard-links the primary's object store, so the pack is nearly
free; the working tree (~14k files) plus `node_modules` is order **2 GB per
worker**. `start` refuses to auto-provision when the health snapshot says
`constrained` (`FACTORY_MIN_HEADROOM_KB`).

The script also reconciles its selected single-engine settings on `start`.
For a legacy home, restart that *specific idle worker* once after the settings
migration; the code-agent provider snapshots settings during daemon boot. A
normal `start` never restarts an already-live observer or interrupts a task.

`/peers` and `/dev/instances` are deliberately different datasets. The first
is the conductor's dispatch graph and must show `w-claude` / `w-codex` online
before a managed run is hired. The second is the human observation catalog of
ARC daemons. A worker needs both an instance row and an online code-agent peer.
The bridge retries after a conductor restart or transport bounce; only a fresh
remote `preflight` proves that an online peer is callable.

```bash
# Start or inspect independent worker ARC instances.
bash scripts/factory-worker.sh start grok       # also: claude | codex
bash scripts/factory-worker.sh status grok

# Address exactly one worker's code-agent control plane. Refuses (exit 1) if
# that worker's own daemon is not running, rather than silently forwarding to
# a throwaway standalone AFS that shares nothing with the real worker state.
bash scripts/factory-worker.sh arc grok afs list /dev/code-agents/dispatch-targets
bash scripts/factory-worker.sh arc grok afs exec /dev/code-agents/.actions/run --args '<run args>'

# Build and hot-swap only that worker daemon from a checked-out source tree.
bash scripts/factory-worker.sh upgrade grok /path/to/factory-worktree   # source tree is REQUIRED

# Refresh local admission facts, then make a hydrated commit-capable worktree.
# The health writer is also run by every worker `start` and `status`.
bash scripts/factory-health-snapshot.sh
bash scripts/factory-worktree.sh add <id> origin/main --worker grok --commit-capable
```

The hot swap delegates to `arc upgrade --from`: it builds the target CLI,
refuses an accidental debug downgrade unless forced, and preserves the
worker's existing bind, blocklet dirs, and project source during restart.

`upgrade` exit codes (#5660) — **verdict** codes, reached once the lease is held
and the worker may have been touched: `0` reached the target build, `4` did
**not** and the previous build was restored (usable, still on OLD code —
investigate, do not treat as success), `1` state not proven, needs a human.
**Refusals before the lease** touch nothing and never borrow those: `2` refused,
do not retry unchanged (bad/unbuilt source tree, broken clone); `3` refused,
retryable exactly as issued (clone absent, or another upgrade holds the lease).
Every post-lease run prints one verdict line naming the target sha, the sha the
daemon actually reports and the phase trail; `upgrade-status <worker>` keeps the
whole trail. `failed-link-verification` means the daemon IS on the target and
only the link is unproven — `reattach`, do not re-run the upgrade. See
[factory-worker-upgrade-recovery.md](../../../docs/guides/factory-worker-upgrade-recovery.md).

`stop` only reaps active engine children. Observe daemons are intentionally
long-lived: session end is not daemon shutdown. `shutdown` is deliberately
checked by `FACTORY_ALLOW_OBSERVE_STOP=1` and requires explicit human approval.

## Before every `run`

1. `git fetch origin`. Skip issues already on `origin/main`.
2. Start the selected worker if it is not already up. Do not start a second
   daemon against the same worker home.
3. Probe the conductor's `/peers/w-<engine>` and its
   **`afs list /dev/code-agents/dispatch-targets`** (not `afs exec`). The
   worker-local target verifies the daemon; the conductor target verifies the
   attach bridge. A process or stale log alone is not proof of dispatchability.
4. Refresh the local fact with `bash scripts/factory-health-snapshot.sh`, then
   create `bash scripts/factory-worktree.sh add <id> origin/main --worker <engine> --commit-capable`
   (`--worker` is required — there is no default; `FACTORY_WORKER` is equivalent)
   unless finishing an existing factory tree or the bug is only on an
   unmerged branch. **Never** use the primary checkout. The admission reads
   that fact again under its capacity lease, rejects a stale/constrained/disk
   poor worker, and hydrates only via the sanctioned wrapper — never raw
   `pnpm install` (#4851/#4863). If `node_modules` is missing, that wrapper
   performs the sanctioned `pnpm install` before tests; do not run it raw.
   A plain non-commit-capable worktree may still
   use `add <id>` when no dependency hydration is needed.
5. Briefs live in `~/.arc-workers/briefs/<id>.md`; point the task at that
   file. Never write `FACTORY_TASK.md` into a worktree and never `git stash`.
   When `<lesson_ledger_dir>` in `.claude/repo-profile.md` is not `none` and
   `<lesson_ledger_dir>/absorbed.yaml` exists, include matching `status: absorbed` /
   `promoted` entries (`id` + `rule_home` + 1-line trap) in the brief (`candidates/pending/`
   is never grounding; if an entry conflicts with shipped code, shipped code wins — flag
   `ledger stale: <id>`).
6. Do not hire an implementer when remaining work is deploy/ops after the
   code is already on `origin/main`: post a skip comment with SHA and live
   evidence instead.

## Sprint planning — issue cost as a triage report

The sieve is **sprint planning**, not backlog entry
(`docs/architecture/factory-labor-discipline.md`). When planning, skip rows whose
body never answers the four questions (substrate / duty-log / normal-state /
cheaper-rung) and `factory round:` duty logs — those are triage input, not sprint
work; duty logs go to the run record / brief. (#7729 removed the automated detector
and its hook; the four questions remain the checklist.)

## Dispatch and review

- A dispatch targets one worker's `/dev/code-agents/.actions/run`, with the
  issue, accept-path, worktree, engine, and memo in its arguments.
- A plain implementer opens a PR but does not merge it. An `epic-conductor`
  may merge its own sub-issue PRs after independent review and green package tests.
- Independent review means a clean context that did not write the diff.
  Same-session self-review does not count.
- **Vendor diversity IS required for Factory-dispatched work** — the factory's own
  cross-engine review requirement (its ready-to-merge judgement) applies to exactly the PRs whose branch has a Factory
  run record, and to nothing else. That door was narrowed to this scope on purpose:
  cross-engine review buys an outside view for work no human is watching, which is
  what the Factory is; on attended paths (`land`, a local `epic-conductor`) it
  instead produced an unterminating loop, because every fix stale-dates the very
  review that found it (arc#6255: three rounds in one hour, zero findings closed).
  A runner that cannot see Factory run records (`ARC_WORKER_HOMES` /
  `ARC_CODE_AGENT_STATE_DIR` unset) reports a DISTINCT N/A — "not a factory run"
  and "cannot see the factory" must never read the same.
- A Factory reviewer is a durable run, not a session-local `Task`/`Agent`.
  Dispatch it with all three relations: `owner: <manager run id>`,
  `role: "reviewer"`, and `reviewOf: { run: <subject run id>, sha: <exact SHA> }`
  (add `pr` or `range` when known). The reviewer must post its verdict to the
  PR/issue; an `exited` process row only proves lifecycle, never that a review
  passed. The fleet HUD exposes `role`/`reviewOf` and the subject's reviewer
  lifecycle so the conductor can reconcile it before merge.
- Run adversarial pre-PR review before `gh pr create`; fix findings in the
  same worktree. Post-open review remains independent.
- Filtered tests only, with `AFS_TEST_CODE_AGENTS_FAKE` where appropriate.
  Do not run two full test suites concurrently on one machine.
- A Factory-created linked tree is owned only when its worker run was started
  with `factoryWorktree: true` plus its `work` and `workPath`. The worker's
  durable run record stores the canonical path, worktree Git identity, branch,
  head, and host identity; manager-side `remoteId` projections only observe
  that record and must never delete a worker tree.
- An explicit `allowedPaths` array of repo-relative prefixes is required for every
  new implementation or review task. Omit it only for a consciously legacy
  unconstrained run; never describe an omitted contract as protected. The only
  documented dispatch entry, `scripts/factory-worker.sh arc <worker> afs exec
  /dev/code-agents/.actions/run`, invokes the plugin's
  `check-pr-path-overlap.ts` admission before `run_arc` can spawn the child, using
  the exact `allowedPaths` in those run args. A prefix contains concrete files:
  `scripts/` therefore overlaps an open PR that changes `scripts/foo.ts` (exact
  file equality also overlaps; lexical siblings such as `scripts/foo` and
  `scripts/foobar.ts` do not). `overlap` is a named advisory warning with PR
  numbers and files; `clean` proceeds without a warning; `unavailable` (missing
  paths, missing `gh`, network/auth failure, or unparseable PR data) blocks the
  dispatch rather than collapsing into clean. Before
  PR/review/merge handoff, call that worker's `/.actions/path-policy` for the
  run. It checks staged, unstaged, untracked, and run-owned committed changes,
  rejects a borrowed `node_modules` root symlink, and judges every commit
  since the binding (both sides of renames, what a merge commit itself
  changed) against `allowedPaths`; no pre-commit record is required (#7729).
  `arc work merge-check` re-runs it at merge time. On any refusal, retain the worktree and the
  durable diff evidence: never reset, stash, or silently widen the allow-set.
- After a settled run and an
  explicit `landed` or `abandoned` lifecycle decision, invoke the worker-local
  `/.actions/finalize` for that run. It records a reasoned `deleted` or
  `retained` result on the same run, and retains on every unknown, live,
  revivable, dirty, locked, held, unmerged, or unresolved-PR condition.
- Do not `end_turn` while a background test or hired child is `status=running`;
  let the `epic-conductor` retain or hand off that live child first.
- **Record the owner edge and the ledger — prose alone did not hold (#4711).**
  Dispatch a child with `owner: <your run id>` so the relation exists in the
  process table, and call `/dev/code-agents/.actions/ledger` with the pending
  child ids, `nextTransition`, `sha` and `recovery` *before* you yield. If you
  do finish while a child is live, `/.actions/handoff` must name a successor
  that is provably running; anything else leaves the ledger **orphaned**, which
  the HUD flags and `/.actions/recover` reports. `/.actions/recoverOwner`
  relaunches one manager from a persisted orphaned ledger (exactly one — the
  handoff is claimed before the spawn).
- A Grok run quiet for at least eight minutes with neither cwd diff nor
  `lastTurn` growth is stuck: stop the run, reap its children, then resume the
  same cwd/brief. Do not start a second process in that worktree.

## Watch and self-cycle

Every wave must reconcile three sides before it is done: the conductor's run
JSON (cockpit `status` + `lastTurnAt`), the **hired worker worktree** (`cwd`
still there and `git log -1` is this run's commit from `progress.head`, or
an explicit no-commit reason — the conductor checkout is not disk evidence),
and a GitHub comment or PR URL whose body has the `scripts/agent-identity.sh`
header (`> 🤖 AI Agent`) **and** whose `created_at` is at or after this
conductor `startedAt` (fallback `lastTurnAt`). A leftover identity comment
from a previous wave does not latch DELIVERED. `lastTurn-only is not done`.
Cockpit `success` / `exited` is lifecycle, not delivery. Watch paginates
issue comments (`gh api --paginate --slurp`); the oldest 100 is not the
whole thread.

A `list-timeout` result with `LIVE=none` is not death without checking pids
and the durable worker run record; retain the worktree and reconcile rather
than dispatching a replacement.

```bash
bun scripts/factory-watch.ts once \
  --conductor-run ~/.arc-workers/grok/.afs/code-agents/runs/<id>.json \
  --homes ~/.arc-workers/claude:~/.arc-workers/codex:~/.arc-workers/grok
# stdout: OK | ORPHAN | UNDELIVERED | DELIVERED
# exit 0 = OK (keep watching) or DELIVERED (may next wave)
# exit 1 = ORPHAN (not delivery) or UNDELIVERED (do not dispatch the next wave)
```

- `OK`: conductor is live; keep watching.
- `ORPHAN`: conductor settled while a worker child is live; resume the same
  cwd and brief. This is not delivery.
- `UNDELIVERED`: no live children, but the three sides are not all present.
  Do not dispatch the next wave. A comment without the identity header is
  not delivery. `gh` unreachable is UNDELIVERED (unread ≠ delivered).
- `DELIVERED`: no live children and all three sides are present. May
  dispatch the next wave.

The observer HUD may be temporarily unavailable without invalidating a
worker's active run. Restore it independently; do not restart or reattach
workers merely to repair the visual surface.

## Do not

- Dispatch into `/Users/robmao/work/arcblock/arc`.
- Kill a `purpose=observe` daemon without explicit human authorization.
- Treat an observer HUD as a cross-machine command plane; use `/peers` only
  when an intentional remote control relationship is required.
- Write `FACTORY_TASK.md`, `git stash`, or leave an engine orphaned on PID 1.
- Treat a remote `pid=-1` / `remoteId` run as dead without the run-state check.
- Hire implementers for deploy/ops leftovers already on main.
