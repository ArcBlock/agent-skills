#!/usr/bin/env bash
# agentloop — scaffold a repo's own .claude/verify/ that drives the plugin engine.
# Generates config.ts (the check list — YOU fill in the real checks) + thin pre-pr /
# pre-merge entries that import runScenario from the plugin. Refuses to overwrite
# existing files (pass --force).
#   bash <plugin_root>/bootstrap/scaffold-verify.sh [--force]
set -uo pipefail
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
prof_val() { [ -f .claude/repo-profile.md ] && grep "\`$1\`" .claude/repo-profile.md | grep -oE '`[^`]+`' | sed -n '2p' | tr -d '`'; }
# Prefer the plugin_root declared in the repo-profile if present (that's the pinned one).
PR="$(prof_val plugin_root)"
[ -n "$PR" ] && [ -f "$PR/lib/scenario.ts" ] && PLUGIN_ROOT="$PR"
# package_manager + default_branch: read the profile (init-profile detected them), else probe/default.
PM="$(prof_val package_manager)"; case "$PM" in npm|pnpm|yarn|bun) ;; *) PM="";; esac
if [ -z "$PM" ]; then
  if   [ -f pnpm-lock.yaml ];               then PM="pnpm"
  elif [ -f bun.lockb ] || [ -f bun.lock ]; then PM="bun"
  elif [ -f yarn.lock ];                    then PM="yarn"
  else PM="npm"; fi
fi
DEFB="$(prof_val default_branch)"; [ -z "$DEFB" ] && DEFB="main"
mkdir -p .claude/verify

guard() { [ -f "$1" ] && [ "$FORCE" -eq 0 ] && { echo "  skip $1 (exists; --force to replace)"; return 1; }; return 0; }

if guard .claude/verify/config.ts; then
cat > .claude/verify/config.ts <<EOF
#!/usr/bin/env bun
/**
 * <repo> verification config — the check list the agentloop engine runs.
 * Engine is imported from the plugin checkout (plugin_root); the DATA below is yours.
 * Replace the starter checks with your real build/lint/type/test commands.
 */
import { cmd, type ScenarioConfig } from "${PLUGIN_ROOT}/lib/scenario.ts";

// STARTER checks (detected package_manager + default_branch) — replace with this
// repo's REAL build / lint / type-check / test commands.
export const prePr: ScenarioConfig = {
  scenario: "pre-pr",
  baseBranch: "origin/${DEFB}",
  checks: [
    cmd({ id: "build", title: "Build", command: "${PM} run build" }),
    cmd({ id: "test",  title: "Test",  command: "${PM} run test" }),
    // add: lint / type-check / your repo-specific logic-checks (import them here)
  ],
};

export const preMerge: ScenarioConfig = {
  scenario: "pre-merge",
  resolveBase: () => "origin/${DEFB}", // default-branch TIP as affected base
  checks: prePr.checks,
};
EOF
echo "  + wrote .claude/verify/config.ts"
fi

if guard .claude/verify/pre-pr.ts; then
cat > .claude/verify/pre-pr.ts <<EOF
#!/usr/bin/env bun
import { runScenario } from "${PLUGIN_ROOT}/lib/scenario.ts";
import { prePr } from "./config.ts";
runScenario(prePr, process.argv);
EOF
echo "  + wrote .claude/verify/pre-pr.ts"
fi

if guard .claude/verify/pre-merge.ts; then
cat > .claude/verify/pre-merge.ts <<EOF
#!/usr/bin/env bun
import { runScenario } from "${PLUGIN_ROOT}/lib/scenario.ts";
import { preMerge } from "./config.ts";
runScenario(preMerge, process.argv);
EOF
echo "  + wrote .claude/verify/pre-merge.ts"
fi

echo "✓ verify scaffold done (engine from ${PLUGIN_ROOT}; pm=${PM}, base=origin/${DEFB})."
echo "  Next (agent): replace the STARTER checks in .claude/verify/config.ts with this repo's real"
echo "  build / lint / type-check / test (add arch/logic checks), then: bun .claude/verify/pre-pr.ts --only build"
