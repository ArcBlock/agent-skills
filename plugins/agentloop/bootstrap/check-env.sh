#!/usr/bin/env bash
# agentloop preflight — verify a repo has what the loop-engine skills need.
# Turns silent half-failures ("label won't apply", "token unresolved") into clear,
# up-front "missing X" errors. Run from the CONSUMING repo root:
#   bash <plugin_root>/bootstrap/check-env.sh
# Skills should run this at Step 0 before doing real work; exit != 0 = do not proceed.
set -uo pipefail
fail=0; warn=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
wn()  { printf '  \033[33m⚠\033[0m %s\n' "$1"; warn=1; }

echo "== agentloop check-env =="

# 1. Required CLIs (skills shell out to all of these). On a miss we SUGGEST a platform
#    install command but never run it — repairing the env is the agent's job (it can judge
#    platform / permissions / fallback), not this read-only probe's. See the bootstrap skill.
plat_pkg() { case "$(uname -s)" in Darwin) echo "brew install $1";; Linux) echo "sudo apt install -y $1";; *) echo "install $1 via your package manager";; esac; }
suggest() {
  case "$1" in
    bun) echo "curl -fsSL https://bun.sh/install | bash";;
    gh)  case "$(uname -s)" in Darwin) echo "brew install gh";; *) echo "https://github.com/cli/cli/blob/trunk/docs/install_linux.md";; esac;;
    *)   plat_pkg "$1";;
  esac
}
for t in bun git gh jq; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t on PATH"
  else bad "$t NOT on PATH — install it, e.g.: $(suggest "$t")"; fi
done
command -v python3 >/dev/null 2>&1 && ok "python3 on PATH" || wn "python3 not on PATH (only some verify checks need it)"

# 2. Git repo + origin remote (skills resolve repo_slug from the remote).
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  ok "inside a git repo"
  if git remote get-url origin >/dev/null 2>&1; then ok "origin remote: $(git remote get-url origin)"
  else bad "no 'origin' remote (skills resolve the repo from it)"; fi
else
  bad "not inside a git repo"
fi

# 3. gh authenticated — a REAL REST probe. `gh auth status` is unreliable behind the
#    outbound proxy (it may report a placeholder token invalid while REST works), so
#    the authority is an actual REST call (see CLAUDE.md).
if command -v gh >/dev/null 2>&1; then
  if gh api rate_limit >/dev/null 2>&1; then ok "gh authenticated (REST probe OK)"
  else bad "gh REST call failed — not authenticated or no network (run: gh auth login)"; fi
fi

# 4. repo-profile present + required keys.
PROFILE=".claude/repo-profile.md"
if [ -f "$PROFILE" ]; then
  ok "$PROFILE present"
  for k in repo_slug default_branch gate_mode verification_entry plugin_root package_manager; do
    grep -q "\`$k\`" "$PROFILE" && ok "profile key: $k" \
      || bad "profile MISSING key: $k (add it, or run init-profile.sh for a template)"
  done
  # 5. plugin root resolves to a real plugin checkout. Runtime resolution order is
  #    $AGENTLOOP_ROOT (central / fleet clone) → the profile's plugin_root (vendored
  #    path, usually .claude/plugins/agentloop). A bad path fails SILENTLY at load
  #    time (bad --plugin-dir / missing import), so hard-verify it here.
  PROF_PR=$(grep '`plugin_root`' "$PROFILE" | grep -oE '`[^`]+`' | sed -n '2p' | tr -d '`')
  PR="${AGENTLOOP_ROOT:-$PROF_PR}"
  SRC="${AGENTLOOP_ROOT:+\$AGENTLOOP_ROOT}"; SRC="${SRC:-profile plugin_root}"
  if [ -n "$PR" ]; then
    if [ -f "$PR/lib/report.ts" ] && [ -d "$PR/skills" ]; then
      ok "plugin root resolves ($SRC → $PR): engine + skills present"
    else
      bad "plugin root '$PR' (from $SRC) has no lib/report.ts + skills/ — vendor the plugin at .claude/plugins/agentloop or set \$AGENTLOOP_ROOT to a checkout"
    fi
  else
    bad "no plugin root resolved — set \$AGENTLOOP_ROOT or a profile plugin_root (vendor at .claude/plugins/agentloop)"
  fi
else
  bad "$PROFILE MISSING — run: bash <plugin_root>/bootstrap/init-profile.sh"
fi

echo
if   [ "$fail" -ne 0 ]; then echo "RESULT: ✗ FAIL — fix the ✗ items before running the loop skills."; exit 1
elif [ "$warn" -ne 0 ]; then echo "RESULT: ✓ ok (with warnings)."; exit 0
else echo "RESULT: ✓ all preflight checks passed."; exit 0; fi
