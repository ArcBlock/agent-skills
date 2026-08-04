#!/usr/bin/env bash
# Regression test for arc#2802: gh-upload-media.sh's channel selection was gated on
# `gh auth status`, which only checks token *shape* — it exits 0 even in a gh-403 session
# where every real `gh api` call against the org returns 403 (org disabled the GitHub App
# for that session type). That made the script always pick channel A (gh contents API) and
# always fail instead of falling back to channel B (git push), in exactly the session type
# where the fallback exists to help. Independently reproduced by 5 test-sweep sub-agents in
# one run (2026-07-31).
#
# Two scenarios, both against the REAL script (mocked `gh`/`curl`, real local git repos for
# channel B — no network):
#   1. gh-403 session  → must skip channel A entirely and fall back to channel B.
#   2. healthy gh       → must still use channel A (the fix must not cause needless fallback).
#
# Usage: bash gh-upload-media.channel-select.test.sh [path-to-gh-upload-media.sh]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

SCRIPT_UNDER_TEST="${1:-$(pwd)/gh-upload-media.sh}"
FAIL=0

# ── Scenario 1: gh-403 session must fall back to channel B ──
run_403_scenario() {
  local tmproot fakebin gh_log remote_bare clone_dir media_file out code
  tmproot=$(mktemp -d)
  fakebin="$tmproot/fakebin"; mkdir -p "$fakebin"
  gh_log="$tmproot/gh-calls.log"; : > "$gh_log"

  cat > "$fakebin/gh" <<'GHEOF'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
if [[ "$1 $2" == "auth status" ]]; then
  echo "github.com"
  echo "  X Failed to log in to github.com using token (GH_TOKEN)"
  echo "  - Active account: true"
  echo "  - The token in GH_TOKEN is invalid."
  exit 0
fi
if [[ "$1" == "api" ]]; then
  echo '{"message":"GitHub access is not enabled for this session."}' >&2
  exit 1
fi
exit 1
GHEOF
  sed -i "s#\$GH_LOG#$gh_log#" "$fakebin/gh"
  chmod +x "$fakebin/gh"

  printf '#!/usr/bin/env bash\necho "200 image/png"\n' > "$fakebin/curl"
  chmod +x "$fakebin/curl"

  remote_bare="$tmproot/loop-agent-assets.git"
  git init -q --bare "$remote_bare"
  clone_dir="$tmproot/loop-agent-assets-clone"
  git clone -q "$remote_bare" "$clone_dir"
  git -C "$clone_dir" config user.email "test@example.com"
  git -C "$clone_dir" config user.name "Test"
  touch "$clone_dir/.keep"
  git -C "$clone_dir" add .keep
  git -C "$clone_dir" commit -q -m init
  git -C "$clone_dir" branch -M main
  git -C "$clone_dir" push -q -u origin main

  media_file="$tmproot/shot.png"
  printf '\x89PNG\r\n\x1a\nfake-png-bytes' > "$media_file"

  out=$(PATH="$fakebin:$PATH" GH_TOKEN="invalid-token-shape-ok" ASSETS_REPO="ArcBlock/loop-agent-assets" \
    ASSETS_REPO_DIR="$clone_dir" SOURCE_REPO="ArcBlock/arc" ASSET_CONTEXT="issue-2802" ALLOW_STALE_UPLOADER=1 \
    bash "$SCRIPT_UNDER_TEST" "$media_file" "test-shot.png" 2>"$tmproot/stderr")
  code=$?

  if [[ $code -ne 0 ]]; then
    echo "FAIL [403-session]: expected exit 0 (fell back to channel B), got $code"; return 1
  fi
  if [[ "$out" != https://raw.githubusercontent.com/ArcBlock/loop-agent-assets/main/* ]]; then
    echo "FAIL [403-session]: expected a raw.githubusercontent.com URL, got: $out"; return 1
  fi
  if grep -qE "^gh api -X PUT" "$gh_log"; then
    echo "FAIL [403-session]: attempted the doomed channel A (gh api -X PUT) instead of falling back"; return 1
  fi
  if ! git -C "$clone_dir" log --oneline | grep -q "assets(arc/issue-2802): test-shot.png"; then
    echo "FAIL [403-session]: channel B did not actually push the asset"; return 1
  fi
  echo "PASS [403-session]: gh-403 session correctly fell back to channel B, never attempted channel A write"
  rm -rf "$tmproot"
}

# ── Scenario 2: healthy gh must still use channel A (no needless fallback) ──
run_healthy_scenario() {
  local tmproot fakebin gh_log media_file out code
  tmproot=$(mktemp -d)
  fakebin="$tmproot/fakebin"; mkdir -p "$fakebin"
  gh_log="$tmproot/gh-calls.log"; : > "$gh_log"

  cat > "$fakebin/gh" <<'GHEOF'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
if [[ "$1 $2" == "auth status" ]]; then
  echo "github.com"
  echo "  - Logged in to github.com account someone (keyring)"
  exit 0
fi
if [[ "$1" == "api" ]]; then
  if [[ "$*" == *"-X PUT"* ]]; then echo '{"content":{"sha":"deadbeef"}}'; exit 0; fi
  echo '{}'
  exit 0
fi
exit 1
GHEOF
  sed -i "s#\$GH_LOG#$gh_log#" "$fakebin/gh"
  chmod +x "$fakebin/gh"

  printf '#!/usr/bin/env bash\necho "200 image/png"\n' > "$fakebin/curl"
  chmod +x "$fakebin/curl"

  media_file="$tmproot/shot.png"
  printf '\x89PNG\r\n\x1a\nfake-png-bytes' > "$media_file"

  out=$(PATH="$fakebin:$PATH" ASSETS_REPO="ArcBlock/loop-agent-assets" SOURCE_REPO="ArcBlock/arc" \
    ASSET_CONTEXT="issue-2802" ALLOW_STALE_UPLOADER=1 \
    bash "$SCRIPT_UNDER_TEST" "$media_file" "test-shot.png" 2>"$tmproot/stderr")
  code=$?

  if [[ $code -ne 0 ]]; then
    echo "FAIL [healthy-gh]: expected exit 0, got $code"; return 1
  fi
  if [[ "$out" != https://raw.githubusercontent.com/ArcBlock/loop-agent-assets/main/* ]]; then
    echo "FAIL [healthy-gh]: bad URL: $out"; return 1
  fi
  if ! grep -qE "^gh api -X PUT" "$gh_log"; then
    echo "FAIL [healthy-gh]: channel A was never attempted — a working gh session should still use it"; return 1
  fi
  echo "PASS [healthy-gh]: healthy gh session still uses channel A (no needless fallback)"
  rm -rf "$tmproot"
}

run_403_scenario || FAIL=1
run_healthy_scenario || FAIL=1

exit $FAIL
