---
name: impact-check
description: Analyze code changes to find related areas that may also need modification. Supports uncommitted changes, specific commits, commit ranges, and branches. Use before committing or opening a PR to catch missed updates.
allowed-tools: Bash(git *), Read, Grep, Glob, Agent
---

# Impact Check — Code Change Impact Analysis

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> **arc is the reference implementation.** The monorepo layout, package naming, and paths
> below (`packages/`, `providers/`, `runtimes/`, `blocklets/`) are arc's — map them to the
> consuming repo's structure via the profile.

Analyze code changes and find related areas in the codebase that may also need modification.

## Input Modes

Parse `$ARGUMENTS` to determine the diff mode:

| Input | Mode | Diff Command |
|-------|------|-------------|
| _(empty)_ | working-tree | `git diff HEAD` |
| `--branch` | current branch vs main | `git diff $(git merge-base <main> HEAD)..HEAD` |
| `--branch <name>` | named branch vs main | `git diff $(git merge-base <main> <name>)..<name>` |
| `--branch <name> --base <base>` | branch vs custom base | `git diff $(git merge-base <base> <name>)..<name>` |
| contains `..` | commit range | `git diff <from>..<to>` |
| other | single commit | `git diff <ref>^..<ref>` |

When detecting the main branch, check which of `main` or `master` exists.

## Analysis Process

### Step 1: Collect Changes

1. Determine diff mode from arguments
2. Run the appropriate `git diff` command (with `--stat` for summary, and full diff for content)
3. List all changed files and summarize: N files changed, +X -Y lines
4. If no changes found, report "Nothing to analyze" and stop

### Step 2: Understand What Changed

For each changed file, read the diff and identify:

- **Interface/type changes**: function signatures, type definitions, exported types
- **Export changes**: added, removed, or renamed exports
- **Behavioral changes**: logic changes that could affect callers
- **Configuration changes**: package.json, tsconfig, linter/formatter config, etc.
- **Schema/model changes**: data structure modifications

### Step 3: Find Related Code

For each significant change identified in Step 2:

1. **Import/reference search**: Use Grep to find every file that references the changed module.
   - For a **deleted or renamed file/export**, grep the bare basename or symbol (e.g. `agent-core`, `deriveAgentTools`) to get the full candidate set — then filter comments in Step 4 by reading. Do **not** rely on a single-line `import … from` / `require(…)` regex: it misses **multi-line imports** (where the `from "…"` line has no `import` keyword) and re-exports, silently dropping real breaks.
   - Also search **string / dynamic references** that no import regex catches: `readSource("…/foo.ts")`, `readFileSync` / `join` / `resolve` with the file path, dynamic `import(…)`, and worker/route path literals. Cross-package breakage most often hides here (e.g. a `runtimes/node/test/**` that `readSource()`s a deleted `providers/**` file).
2. **Symbol usage search**: For changed/removed exports, Grep for their usage across the codebase
3. **Test file check**: For each changed file `src/foo.ts`, check if `test/foo.test.ts` exists and whether it was also modified
4. **Documentation check**: If interfaces or public APIs changed, check if README or docs reference them
5. **Conformance test check**: If the repo's **Custom Impact Checks** (`.claude/repo-profile.md`) declare a provider conformance suite, and a provider changed, verify its conformance fixture was updated
6. **Caller check (new exports)**: For each *added* export/function/param, grep its call sites repo-wide. Zero callers inside the repo — and not a public API/SDK re-export — is a speculative abstraction with no consumer; flag it. A lower layer nothing calls should not land on its own; the author should point to the consumer, or the follow-up change that adds it.
7. **Parity check — mirror & registration**: Two flavors, both cross-file invariants a self-contained diff won't reveal:
   - **Cross-runtime mirror**: multi-target builds must stay in sync — a change that touches one deployment target or a shared cross-target provider means the sibling target(s) need the same semantic. A one-sided change is behavior drift between targets unless intentional. See the repo's **Deployment Environments** section (`.claude/repo-profile.md`) for which targets exist.
   - **Declaration ↔ dispatch/renderer**: the diff adds a variant to an enum / union type / registry / factory (a new widget, message type, provider kind, event, …) in one package → grep the **consumer** that switches on it (dispatch table, `switch`, renderer map, handler registry — often in a *different* package) and confirm it gained the matching `case`/handler. **This is the inverse hazard of reverse-reference: deleting breaks compilation loudly, but adding-without-wiring compiles clean.** A `default`/fallback branch (renders "Unknown", silent no-op, drops the message) swallows the missing case, so `check-types` and build stay green and the gap only shows at **runtime** as a degraded/absent result. Also check the reverse — a new dispatch `case` for a variant the declaration side never added.

Use the Agent tool with subagent_type=Explore to parallelize searches when there are many changed files (>5).

### Step 4: Evaluate Impact

For each related file found in Step 3, Read the relevant sections and assess:

- **Will it break?** Type errors, missing imports, incompatible API calls
- **Will it behave incorrectly?** Logic assumptions that no longer hold
- **Is it incomplete?** Tests that don't cover the new behavior, docs that are now stale
- **Redefinition ≠ break**: a symbol matched by name because a **new or ported module now defines it** (common after a rename/rewrite — e.g. `runAgent` moved to a new provider) is *not* a break. Only a **dangling reference** — one that still resolves to the deleted/changed definition — breaks. Confirm by reading which module the reference actually resolves to before flagging 🔴; a name match alone is noise.

### Step 5: Output Report

```markdown
## Impact Analysis — <scope description>

<N> files changed | +X -Y lines | <mode: working-tree / branch X vs Y / commit abc1234 / ...>

### Changes Summary
- brief bullet points of what changed and why it matters

### 🔴 MUST — Requires Modification
> Files that will break or produce incorrect behavior if not updated.

- **`path/to/file.ts:42`** — <specific reason>
  Changed: `oldThing` → `newThing`, but this file still references `oldThing`

### 🟡 SHOULD — Recommended to Check
> Files that likely need updates but won't immediately break.

- **`path/to/file.test.ts`** — test does not cover the new <behavior>
- **`README.md`** — example code references old API signature
- **`path/to/new-export.ts:12`** — new export `fooBar` has zero call sites repo-wide and isn't a public re-export (speculative — confirm a consumer exists or lands in a follow-up)
- **`runtimes/cloudflare/…`** — node side changed `<behavior>` but the CF mirror was not updated (cross-runtime parity)
- **`providers/…/dispatch.ts`** — new variant `fooKind` added to the enum/registry in `types.ts` but the consumer switch has no matching `case`; falls through to the `default` (renders "Unknown"/no-op) — compiles clean, degrades at runtime (declaration ↔ dispatch parity)

### 🟢 OK — No Action Needed
> Confirmed these related files are unaffected.

- `path/to/other.ts` — imports the module but doesn't use the changed API
```

## Important Rules

1. **Be specific**: Every finding must include a file path, line number (when possible), and concrete reason
2. **No false alarms**: Only flag something as 🔴 MUST if you've confirmed the incompatibility by reading the code. When uncertain, use 🟡 SHOULD
3. **Scope to 1 hop**: Only analyze direct dependents of changed files, not transitive dependencies
4. **Skip noise**: Ignore changes that are purely formatting, comments, or whitespace
5. **Respect project conventions**: This is a `<package_manager>` monorepo. Cross-package impacts within the repo's monorepo layout are the highest-value findings — see the repo's **Custom Impact Checks** section (`.claude/repo-profile.md`) for which package boundaries matter
6. **Fast exit**: If all changes are documentation-only, test-only, or config-only with no code impact, report 🟢 OK immediately

## Project-Specific Checks

On top of the universal steps above, run the repo's **Custom Impact Checks** — the domain-specific
reverse-reference checks documented in `.claude/repo-profile.md`. Arc's are the AFS/AUP-specific ones
(e.g. `@aigne/afs` importers, `runProviderTests` / `test/conformance.test.ts`, AUP widget dispatch
parity, the cross-runtime mirror, `joinURL` from `ufo`) — read that section rather than assuming
this list, since a different repo's profile will name entirely different checks.
