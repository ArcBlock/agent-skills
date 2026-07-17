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

if guard .claude/verify/engine.ts; then
cat > .claude/verify/engine.ts <<'EOF'
#!/usr/bin/env bun
/**
 * engine — locate the agentloop verification engine (the repo-agnostic lib/).
 *
 * The root is resolved at RUNTIME from the first candidate that ACTUALLY holds the
 * engine, so no machine-specific path is committed and the common case (a normal
 * global plugin install) needs no env var at all. Every entry imports from here, so
 * there is exactly one resolution and one error message.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** In priority order; the first one holding lib/scenario.ts wins. */
function candidates(): string[] {
  return [
    // 1. explicit override (fleet driver / CI / a non-standard checkout)
    process.env.AGENTLOOP_ROOT,
    // 2. global plugin install via the ArcBlock marketplace
    `${homedir()}/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop`,
    // 3. vendored fallback, if this repo chooses to vendor the plugin
    new URL("../plugins/agentloop", import.meta.url).pathname,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** Absolute path to the engine root, or a hard error explaining how to fix it. */
export function engineRoot(): string {
  const tried = candidates();
  for (const root of tried) {
    if (existsSync(`${root}/lib/scenario.ts`)) return root;
  }
  throw new Error(
    [
      "agentloop engine not found — the verification gate cannot run.",
      "",
      "Tried (in order):",
      ...tried.map((p) => `  - ${p}`),
      "",
      "Fix: install the agentloop plugin globally (marketplace ArcBlock/agent-skills),",
      "or point $AGENTLOOP_ROOT at a checkout, e.g.:",
      "  AGENTLOOP_ROOT=/path/to/agentloop bun .claude/verify/pre-pr.ts",
    ].join("\n"),
  );
}

const ROOT = engineRoot();

// Resolved once here so every entry shares one resolution (and one error message).
export const { cmd, runScenario } = await import(`${ROOT}/lib/scenario.ts`);
EOF
echo "  + wrote .claude/verify/engine.ts"
fi

if guard .claude/verify/config.ts; then
cat > .claude/verify/config.ts <<EOF
#!/usr/bin/env bun
/**
 * <repo> verification config — the check list the agentloop engine runs.
 * The engine root is resolved at runtime by ./engine.ts (no committed absolute path).
 * Replace the starter checks with your real build/lint/type/test commands.
 */
import { cmd } from "./engine.ts";

// STARTER checks (detected package_manager + default_branch) — replace with this
// repo's REAL build / lint / type-check / test commands.
export const prePr = {
  scenario: "pre-pr",
  baseBranch: "origin/${DEFB}",
  checks: [
    cmd({ id: "build", title: "Build", command: "${PM} run build" }),
    cmd({ id: "test",  title: "Test",  command: "${PM} run test" }),
    // add: lint / type-check / your repo-specific logic-checks
  ],
};

export const preMerge = {
  scenario: "pre-merge",
  resolveBase: () => "origin/${DEFB}", // default-branch TIP as affected base
  checks: prePr.checks,
};
EOF
echo "  + wrote .claude/verify/config.ts"
fi

if guard .claude/verify/pre-pr.ts; then
cat > .claude/verify/pre-pr.ts <<'EOF'
#!/usr/bin/env bun
import { runScenario } from "./engine.ts";
import { prePr } from "./config.ts";
runScenario(prePr, process.argv);
EOF
echo "  + wrote .claude/verify/pre-pr.ts"
fi

if guard .claude/verify/pre-merge.ts; then
cat > .claude/verify/pre-merge.ts <<'EOF'
#!/usr/bin/env bun
import { runScenario } from "./engine.ts";
import { preMerge } from "./config.ts";
runScenario(preMerge, process.argv);
EOF
echo "  + wrote .claude/verify/pre-merge.ts"
fi

echo "✓ verify scaffold done (runtime-resolved engine; pm=${PM}, base=origin/${DEFB})."
echo "  Engine resolution (engine.ts, first hit wins): \$AGENTLOOP_ROOT → global marketplace install → vendored."
echo "  Next (agent): replace the STARTER checks in .claude/verify/config.ts with this repo's real"
echo "  build / lint / type-check / test, then: bun .claude/verify/pre-pr.ts --only build"
