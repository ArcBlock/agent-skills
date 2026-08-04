#!/usr/bin/env bash
# Regression test for arc#3011: gh-upload-media.sh's channel B (git push into a
# caller-supplied ASSETS_REPO_DIR) unconditionally ran `git checkout main` +
# `git reset --hard origin/main` on that directory — safe only if it's guaranteed to be
# an agent-owned scratch clone, which ASSETS_REPO_DIR is NOT: it's caller-supplied and can
# be an arbitrary working tree. Measured on a real box: a /private/tmp clone with 18,058
# tracked deletions + 4 untracked files was one call away from being silently discarded.
#
# Scenario: gh unusable (forces channel B) + a DIRTY ASSETS_REPO_DIR (uncommitted tracked
# change + an untracked file) → the script must fail closed (nonzero exit, no upload) and
# leave the directory's tracked/untracked state byte-for-byte unchanged. No network.
#
# Usage: bash gh-upload-media.dirty-checkout.test.sh [path-to-gh-upload-media.sh]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

SCRIPT_UNDER_TEST="${1:-$(pwd)/gh-upload-media.sh}"
FAIL=0

run_dirty_checkout_scenario() {
  local tmproot fakebin gh_log remote_bare clone_dir media_file out code before after
  tmproot=$(mktemp -d)
  fakebin="$tmproot/fakebin"; mkdir -p "$fakebin"
  gh_log="$tmproot/gh-calls.log"; : > "$gh_log"

  # gh unusable → forces channel B (git push), the path under test. GH_LOG is read from
  # the environment at runtime (passed below), not baked into the script text — avoids a
  # `sed -i` portability split between GNU and BSD/macOS sed.
  cat > "$fakebin/gh" <<'GHEOF'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
exit 1
GHEOF
  chmod +x "$fakebin/gh"

  printf '#!/usr/bin/env bash\necho "200 image/png"\n' > "$fakebin/curl"
  chmod +x "$fakebin/curl"

  remote_bare="$tmproot/loop-agent-assets.git"
  git init -q --bare "$remote_bare"
  clone_dir="$tmproot/loop-agent-assets-clone"
  git clone -q "$remote_bare" "$clone_dir"
  git -C "$clone_dir" config user.email "test@example.com"
  git -C "$clone_dir" config user.name "Test"
  echo "original content" > "$clone_dir/tracked.txt"
  git -C "$clone_dir" add tracked.txt
  git -C "$clone_dir" commit -q -m init
  git -C "$clone_dir" branch -M main
  git -C "$clone_dir" push -q -u origin main

  # Make it dirty: an uncommitted edit to a tracked file + an untracked file — this is
  # exactly the shape `git reset --hard` + implicit clean would destroy.
  echo "SOMEONE ELSE'S IN-FLIGHT WORK" > "$clone_dir/tracked.txt"
  echo "unrelated scratch file" > "$clone_dir/untracked.txt"

  before=$(cd "$clone_dir" && git status --porcelain && cat tracked.txt untracked.txt)

  media_file="$tmproot/shot.png"
  printf '\x89PNG\r\n\x1a\nfake-png-bytes' > "$media_file"

  out=$(PATH="$fakebin:$PATH" GH_LOG="$gh_log" ASSETS_REPO="ArcBlock/loop-agent-assets" \
    ASSETS_REPO_DIR="$clone_dir" SOURCE_REPO="ArcBlock/arc" ASSET_CONTEXT="issue-3011" \
    ALLOW_STALE_UPLOADER=1 \
    bash "$SCRIPT_UNDER_TEST" "$media_file" "test-shot.png" 2>"$tmproot/stderr")
  code=$?

  after=$(cd "$clone_dir" && git status --porcelain && cat tracked.txt untracked.txt)

  if [[ $code -eq 0 ]]; then
    echo "FAIL [dirty-checkout]: expected a nonzero (fail-closed) exit, got 0 with output: $out"; return 1
  fi
  if [[ "$before" != "$after" ]]; then
    echo "FAIL [dirty-checkout]: ASSETS_REPO_DIR's tracked/untracked state changed — the dirty tree was touched"
    echo "  before: $before"
    echo "  after:  $after"
    return 1
  fi
  if ! grep -qi "uncommitted changes" "$tmproot/stderr"; then
    echo "FAIL [dirty-checkout]: stderr did not explain the block — got: $(cat "$tmproot/stderr")"; return 1
  fi
  echo "PASS [dirty-checkout]: dirty ASSETS_REPO_DIR left byte-for-byte unchanged, script failed closed with an actionable message"
  rm -rf "$tmproot"
}

run_dirty_checkout_scenario || FAIL=1

exit $FAIL
