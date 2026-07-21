---
name: repo-setup
description: One-time setup that makes a repo consumable by the agentloop skills — scaffold repo-profile, create the controlled GitHub labels, scaffold the verification gate, and preflight the environment. Run this once when onboarding a new repo to the loop-engine skills. Does NOT schedule routines (that's the repo's own infra).
---

# Repo Setup — adopt the agentloop plugin in a repo

Run once per repo to go from "plugin installed" to "loop skills can actually run here".
The supporting environment the sweep/review skills assume (a repo-profile, the coordination
labels, a verify gate, a working toolchain + gh auth) is otherwise **implicit** — this makes it
explicit and reproducible. All scripts live in `<plugin_root>/bootstrap/` and are idempotent
(the directory keeps its name: there it means "the scripts that bootstrap a repo", which is
unambiguous — the skill was renamed because `/agentloop:bootstrap` alone did not say *what*
it bootstrapped, and now pairs with `/agentloop:fleet-setup`).

This is **hybrid by design**. The split, and why it matters:

- **Deterministic scripts** lay down structure and auto-detect what can be *mechanically probed*
  (repo_slug, plugin_root, default_branch, package_manager, the fixed label set, the env
  assertions). They never guess values they can't ground in a file, and never mutate your system.
- **You, the agent**, do what needs *judgement or side-effects*: install missing tools, fill the
  profile fields that require reading the repo, write the real verification checks. Scripts hand
  you a stable skeleton; you supply the parts a script can't reliably infer.

> This is **adoption**, not **scheduling**. How you run the skills on an interval (cron / CI /
> a cloud routine system) is your repo's own infra — see `docs/scheduling-recipe.md`. Repo-setup
> deliberately does not touch that.

## The flow (run from the consuming repo root, in order)

```bash
PR=<plugin_root>   # from .claude/repo-profile.md, or wherever the plugin is checked out
```

### Step 0 — preflight  ·  *script diagnoses, you repair*

```bash
bash "$PR/bootstrap/check-env.sh"
```

`check-env` is a read-only probe: it reports what's missing and exits non-zero, but it never
installs anything. **If it reports a missing tool, that's your cue to fix it** — install it for
*this* platform (macOS → `brew`, Debian/Ubuntu → `apt install -y`, `bun` → its curl installer),
then re-run until green. The script even prints a suggested command per tool; you judge
platform / permissions / fallback and actually run it. (This mirrors CLAUDE.md's "install missing
CLI deps, don't give up" discipline — repairing the env is an agent action, not a script's.)

### Step 1 — repo-profile  ·  *script scaffolds + detects, you fill the judgement fields*

```bash
bash "$PR/bootstrap/init-profile.sh"          # writes .claude/repo-profile.md (won't overwrite)
```

Auto-fills `repo_slug` / `plugin_root` / `default_branch` / `package_manager`. Then **you open
`.claude/repo-profile.md` and replace the remaining `<FILL: …>` by READING the repo** — these are
exactly the values a script can't reliably infer:

- **toolchain commands** ← `package.json` `"scripts"`, `turbo.json`, `biome.json` / prettier, `tsconfig`
- **UI / Backend face paths** ← the actual source layout (which dirs are renderer/pages vs server/data)
- **gate_mode** ← is there CI? (`scripts` if none, `both` if CI must also be green)
- **cli_binary / kb_issue / comment_language / milestones** ← infer from the repo, or leave `<FILL>` for a human

Rule: **don't invent a value you can't ground in a file.** If you can't determine it, leave the
`<FILL>` in place for a human — a wrong profile value fails silently later.

### Step 2 — coordination labels  ·  *script, mechanical*

```bash
bash "$PR/bootstrap/sync-labels.sh"           # or --dry-run to preview
```

Creates only the loop's **coordination** vocabulary (agent:* / needs-* / pr-sweep:*). This one is
deliberately *not* agentic — the label set is fixed; a script gets colours/names right every time.
Your repo's own work-type / priority / status labels are yours to add to the profile.

### Step 3 — verify gate  ·  *script scaffolds, you write the real checks*

```bash
bash "$PR/bootstrap/scaffold-verify.sh"       # writes .claude/verify/{config,pre-pr,pre-merge}.ts
```

Generates the gate wired to the engine, using the detected `package_manager` + `default_branch`,
with **STARTER** build/test checks. Then **you edit `.claude/verify/config.ts`**: replace the
starters with this repo's real build / lint / type-check / test commands, and add the arch/logic
checks it needs. Verify wiring with `bun .claude/verify/pre-pr.ts --only build`.

### Step 4 — confirm  ·  *script*

```bash
bash "$PR/bootstrap/check-env.sh"             # should now be all green (exit 0)
```

## What each script does (and what it deliberately leaves to you)

- **`init-profile.sh`** — writes a `.claude/repo-profile.md` skeleton with every key the skills read.
  Detects `repo_slug` (git remote), `plugin_root` (its own location), `default_branch` (origin/HEAD →
  current branch → main), `package_manager` (lockfile). Leaves judgement fields as `<FILL>` for you.
  Refuses to overwrite (`--force` to replace).
- **`sync-labels.sh`** — `gh label create`/`edit` for the coordination vocabulary only. Idempotent.
- **`scaffold-verify.sh`** — generates `.claude/verify/` (config + thin pre-pr/pre-merge entries) that
  `import` the engine from `plugin_root`, pre-wired to the detected pm/branch. The check list is a
  starter you replace.
- **`check-env.sh`** — preflight: `bun`/`git`/`gh`/`jq` present, `gh` authenticated (a real REST
  probe, not `gh auth status`), an origin remote, repo-profile present with the required keys, and
  `plugin_root` resolving to a real plugin checkout. Suggests install commands on a miss but never
  runs them. Skills run this at Step 0; non-zero = don't proceed.

## Reference

Arc (`ArcBlock/arc`) is the reference implementation — copy its `.claude/repo-profile.md` and
`.claude/verify/` patterns. The bundled skills (issue-graph / design-review / build-phases) need no
setup; the repo-specific companions (e2e-gate / e2e-verify / ui-verify) you supply or drop.
