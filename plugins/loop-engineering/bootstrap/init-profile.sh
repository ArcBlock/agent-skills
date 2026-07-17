#!/usr/bin/env bash
# loop-engineering — scaffold a repo-profile for a repo adopting the plugin.
# Writes .claude/repo-profile.md with the required keys + <FILL: …> placeholders.
# Refuses to overwrite an existing profile (pass --force to replace).
#   bash <plugin_root>/bootstrap/init-profile.sh [--force]
set -uo pipefail
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
OUT=".claude/repo-profile.md"
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$OUT" ] && [ "$FORCE" -eq 0 ]; then
  echo "✗ $OUT already exists — edit it, or re-run with --force to overwrite." >&2; exit 1
fi
mkdir -p .claude
SLUG="$(git remote get-url origin 2>/dev/null | sed -E 's#/$##; s#\.git$##; s#.*[:/]([^/]+/[^/]+)$#\1#' || echo '<FILL: owner/repo>')"

# default_branch: origin/HEAD if the tracking ref is set (clone/set-head), else current branch, else main.
DEFB="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's#^refs/remotes/origin/##')"
[ -z "$DEFB" ] && DEFB="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
{ [ -z "$DEFB" ] || [ "$DEFB" = "HEAD" ]; } && DEFB="main"

# package_manager: lockfile probe (deterministic); <FILL> only if none is present.
if   [ -f pnpm-lock.yaml ];               then PM="pnpm"
elif [ -f bun.lockb ] || [ -f bun.lock ]; then PM="bun"
elif [ -f yarn.lock ];                    then PM="yarn"
elif [ -f package-lock.json ];            then PM="npm"
else PM="<FILL: npm / pnpm / yarn / bun>"; fi

cat > "$OUT" <<EOF
# Repo Profile — ${SLUG}

One source of truth for the values the loop-engineering plugin skills read instead of hardcoding
another repo's facts. Fill in the <FILL: …> values below; arc's own profile (in ArcBlock/arc) is the
reference implementation to copy patterns from.

## Identity

| Field | Value |
|---|---|
| \`repo_slug\` | \`${SLUG}\` |
| \`default_branch\` | \`${DEFB}\` — auto-detected; skills read this for every fetch / reset / merge-base. Verify it matches your repo's real default. |
| \`cli_binary\` | <FILL: your repo's CLI, or remove if none> |
| \`plugin_root\` | \`${PLUGIN_ROOT}\` — where the loop-engineering plugin is checked out. Skills reference their runtime scripts as \`<plugin_root>/skills/…/scripts/*.ts\`. Pin this to a stable checkout (a submodule / vendored clone) for reproducibility. |

## Gate & Verification

| Field | Value |
|---|---|
| \`gate_mode\` | \`both\` — \`scripts\` (local only) / \`ci\` (gh pr checks only) / \`both\` (both green). See contract below. |
| \`verification_entry\` | \`bun .claude/verify/pre-pr.ts\` (scaffold with scaffold-verify.sh) |
| \`pre_merge_entry\` | \`bun .claude/verify/pre-merge.ts\` |
| \`merge_gate_entry\` | \`bun .claude/verify/merge-gate.ts\` (optional; only if you use the SHA-match merge gate) |
| \`additional_merge_gates\` | \`[]\` — extra gates on backend diffs; empty for most repos |
| \`docs_na_flag\` | \`--na "docs-only change"\` |

**\`gate_mode\` contract:** \`scripts\` = local verification scripts are the only gate (\`gh pr checks\`
ignored). \`ci\` = CI is the gate. \`both\` = require \`gh pr checks\` green AND local scripts green.
Invariant: local scripts are always authoritative; ci/both only *add* a CI requirement.

## Toolchain

| Field | Value |
|---|---|
| \`package_manager\` | \`${PM}\` |
| \`build_system\` | <FILL: e.g. turbo, or your build command> |
| \`test_runner\` | <FILL: e.g. \`<package_manager> test\`> |
| \`type_checker\` | <FILL: e.g. \`<package_manager> check-types\`, or remove if not typed> |
| \`formatter\` | <FILL: e.g. \`biome check --write\` / \`prettier -w\`> |

## Knowledge Base

| Field | Value |
|---|---|
| \`kb_issue\` | <FILL: a pinned repo-map issue #, or remove if none> |

## Comment / Writing Conventions

| Field | Value |
|---|---|
| \`comment_language\` | <FILL: body language + title convention, e.g. \`en\` / \`zh body, en Conventional-Commit titles\`> |

## UI Face Paths

Diff paths that trigger UI verification (renderer/page changes). <FILL or leave empty if no UI>:

\`\`\`
<FILL: e.g. src/ui/, packages/frontend/>
\`\`\`

## Backend Face Paths

Diff paths that trigger the backend/data-plane gate. <FILL or leave empty>:

\`\`\`
<FILL: e.g. src/server/, packages/api/>
\`\`\`

## Label Vocabulary

The loop coordination labels (agent:* / needs-* / pr-sweep:*) are created by \`sync-labels.sh\`.
Add your repo's own work-type / priority / status labels here so the sweeps know which to scan.

## Milestone Conventions

<FILL: how your repo uses milestones, or "none">

## Agent Tooling

| Field | Value |
|---|---|
| \`agent_identity_script\` | <FILL: a provenance-header script, or remove> |
| \`ui_shot_script\` / \`ui_upload_script\` | <FILL, or remove if no UI verification> |
| \`memory_namespace\` | <FILL, or remove> |

## Companion Skills

Bundled in the plugin (no action): issue-graph, design-review, build-phases.
Repo-specific companions you must supply (or drop the steps that use them): e2e-gate, e2e-verify,
ui-verify — arc's drive its product surface and can't be reused verbatim. \`companion_skills_path\` = \`.claude/skills/\`.

## Custom Impact Checks

Repo-specific reverse-reference checks impact-check runs on top of its universal steps. <FILL or leave empty>.

## Case Law References

Your repo's own lessons (the loop skills carry the generic lesson, not issue numbers). Keep fuller
case narratives under \`.claude/case-law/\` if you grow an appendix.
EOF

echo "✓ wrote $OUT (repo_slug=${SLUG}, default_branch=${DEFB}, package_manager=${PM}, plugin_root=${PLUGIN_ROOT})."
echo "  Auto-detected the above. The remaining <FILL: …> (toolchain commands, face paths, gate_mode,"
echo "  conventions) need judgement — the bootstrap skill fills them by reading the repo, or fill by hand."
