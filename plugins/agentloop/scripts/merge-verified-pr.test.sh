#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/gh" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = pr ]; then
  shift
  [ "$1" = view ] || exit 90
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) [ "${2:-}" = headRefOid,state,mergeable,url,headRefName,baseRefOid ] || exit 91; shift 2 ;;
      --jq) [ "${2:-}" = '.headRefOid + "\t" + .state + "\t" + .mergeable + "\t" + .url + "\t" + .headRefName + "\t" + .baseRefOid' ] || exit 92; shift 2 ;;
      *) shift ;;
    esac
  done
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${TEST_SHA:-head}" "${TEST_STATE:-OPEN}" "${TEST_MERGEABLE:-MERGEABLE}" "https://github.com/owner/repo/pull/42" "${TEST_REF:-fix/x}" "${TEST_BASE:-base0}"
  exit 0
fi
# The PR body read (factory-merge stamp, #7662): answered, not logged.
# Reads are counted: from read number TEST_BODY_CHANGE_AT on, the body is
# TEST_BODY_CHANGED (a person editing the description between the script's
# read and its PATCH, Codex P2 on #7685).
if [ "$1" = api ] && [ "${3:-}" = --jq ] && [ "${4:-}" = '.body // ""' ]; then
  printf 'r\n' >> "$TEST_PATCH_DIR/.reads"
  n=$(wc -l < "$TEST_PATCH_DIR/.reads" | tr -d ' ')
  [ -n "${TEST_BODY_READ_FAIL_AT:-}" ] && [ "$n" -ge "$TEST_BODY_READ_FAIL_AT" ] && exit 1
  # Like gh: a raw string, then ONE newline (`gh api --jq '"x\n\n"'` prints x + 3 newlines).
  if [ -n "${TEST_BODY_CHANGE_AT:-}" ] && [ "$n" -ge "$TEST_BODY_CHANGE_AT" ]; then
    printf '%s\n' "${TEST_BODY_CHANGED-}"
  else
    printf '%s\n' "${TEST_BODY-}"
  fi
  exit 0
fi
# Did the merge land? (asked only after a failed PUT, #7662 review)
if [ "$1" = api ] && [ "${3:-}" = --jq ] && [ "${4:-}" = '.merged' ]; then
  [ "${TEST_MERGED:-false}" = fail ] && exit 1
  printf '%s\n' "${TEST_MERGED:-false}"
  exit 0
fi
printf '%s\n' "$*" >> "$TEST_LOG"
# A PATCH's body goes to its own numbered file, so a test can read it whole.
if [ "$1" = api ] && [ "$2" = --method ] && [ "$3" = PATCH ]; then
  for a in "$@"; do
    case "$a" in body=*) n=$(ls "$TEST_PATCH_DIR" | wc -l | tr -d ' '); printf '%s' "${a#body=}" > "$TEST_PATCH_DIR/$n" ;; esac
  done
  [ "${TEST_PATCH_FAIL:-}" = 1 ] && exit 1
fi
if [ "$1" = api ] && [ "$2" = --method ] && [ "$3" = PUT ] && [ "${TEST_PUT_FAIL:-}" = 1 ]; then
  exit 1
fi
exit 0
EOF
chmod +x "$tmp/gh"
export PATH="$tmp:$PATH" TEST_LOG="$tmp/log" TEST_PATCH_DIR="$tmp/patches"
mkdir -p "$TEST_PATCH_DIR"
# Hermetic: this suite may itself run inside a factory run (#7662), and it
# must not read this repo's profile (whose factory check calls a real daemon).
unset ARC_CODE_AGENT_RUN_ID ARC_FACTORY_ALLOW_SELF_MERGE
export AGENTLOOP_REPO_PROFILE="$tmp/no-profile.md"

fails() { # fails <label> -- runs the script, requires non-zero AND no merge call
  local label="$1"; shift
  rm -f "$TEST_LOG"; set +e; "$@" >/dev/null 2>&1; local code=$?; set -e
  [ "$code" -ne 0 ] || { echo "expected refusal: $label" >&2; exit 1; }
  [ ! -e "$TEST_LOG" ] || { echo "merged despite refusal: $label" >&2; exit 1; }
}

# ── ACCEPT: an open, mergeable PR merges, pinned to its head sha ────────────
# Only state + mergeable are checked (#7729). Without this arm the suite is
# satisfied by a script that refuses everything (accept-path).
rm -f "$TEST_LOG"
"$root/merge-verified-pr.sh" 42 --repo owner/repo --method squash
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge -f sha=head -f merge_method=squash' "$TEST_LOG"
rm -f "$TEST_LOG"
"$root/merge-verified-pr.sh" 42 --repo owner/repo --method rebase
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge -f sha=head -f merge_method=rebase' "$TEST_LOG"

# An unknown flag is a usage error, not a silent no-op.
rm -f "$TEST_LOG"; set +e; "$root/merge-verified-pr.sh" 42 --repo owner/repo --skip-checks why >/dev/null 2>&1; code=$?; set -e
[ "$code" -eq 64 ] || { echo "--skip-checks not refused as usage (got $code)" >&2; exit 1; }
[ ! -e "$TEST_LOG" ] || { echo "called gh for a usage error" >&2; exit 1; }
for args in "--repo" "--repo owner/repo --method"; do
  rm -f "$TEST_LOG"; set +e; "$root/merge-verified-pr.sh" 42 $args >/dev/null 2>&1; code=$?; set -e
  [ "$code" -eq 64 ] || { echo "'$args' without a value not refused as usage (got $code)" >&2; exit 1; }
done
fails "unknown method" "$root/merge-verified-pr.sh" 42 --repo owner/repo --method octopus

# ── The PR number is a number (#7662 round 2): it lands in API paths ────────
for bad in abc 0 '42/../1' '-1' '42 43' ''; do
  rm -f "$TEST_LOG"; set +e; out="$("$root/merge-verified-pr.sh" "$bad" --repo owner/repo 2>&1)"; code=$?; set -e
  [ "$code" -eq 64 ] || { echo "PR '$bad' not refused as usage (got $code)" >&2; exit 1; }
  [ ! -e "$TEST_LOG" ] || { echo "called gh for PR '$bad'" >&2; exit 1; }
  [ -z "$bad" ] || grep -qF 'PR number' <<<"$out" || { echo "no reason for PR '$bad': $out" >&2; exit 1; }
done

# ── PR-state refusals ───────────────────────────────────────────────────────
for field in 'TEST_STATE=CLOSED' 'TEST_MERGEABLE=CONFLICTING' 'TEST_MERGEABLE=UNKNOWN'; do
  rm -f "$TEST_LOG"; set +e
  env $field PATH="$PATH" TEST_LOG="$TEST_LOG" \
    "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null 2>&1
  code=$?; set -e
  test "$code" -ne 0; test ! -e "$TEST_LOG"
done

# ── #7662: a factory run does not merge; merge authority is human ───────────
# A Factory run (ARC_CODE_AGENT_RUN_ID set) stops at ready-to-merge. The skill
# says so; this is the guard that does not depend on the model reading it.
sha40=3333333333333333333333333333333333333333
export TEST_SHA=$sha40
reset_patches() { rm -rf "$TEST_PATCH_DIR"; mkdir -p "$TEST_PATCH_DIR"; rm -f "$TEST_LOG"; }

# ACCEPT control first: the same PR merges outside a run, unstamped.
reset_patches
"$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null
grep -qF "api --method PUT repos/owner/repo/pulls/42/merge -f sha=$sha40" "$TEST_LOG"
if grep -qF 'PATCH' "$TEST_LOG"; then echo "stamped outside a run" >&2; exit 1; fi

refused_run() { # refused_run <label> <expected text> -- cmd…: exit 3, no gh call at all, reason named
  local label="$1" want="$2"; shift 2
  reset_patches; set +e; local out; out="$("$@" 2>&1)"; local code=$?; set -e
  [ "$code" -eq 3 ] || { echo "expected exit 3 ($label), got $code: $out" >&2; exit 1; }
  [ ! -e "$TEST_LOG" ] || { echo "called gh despite refusal: $label" >&2; exit 1; }
  grep -qF "$want" <<<"$out" || { echo "reason missing ($label): want '$want' in: $out" >&2; exit 1; }
}
refused_run "run, no override" "factory run agent-43839c9e: merge authority is human" \
  env ARC_CODE_AGENT_RUN_ID=agent-43839c9e "$root/merge-verified-pr.sh" 42 --repo owner/repo
refused_run "the refusal names the override" "ARC_FACTORY_ALLOW_SELF_MERGE=1" \
  env ARC_CODE_AGENT_RUN_ID=agent-43839c9e "$root/merge-verified-pr.sh" 42 --repo owner/repo
for v in 0 true yes " 1"; do
  refused_run "override value '$v' is not 1" "merge authority is human" \
    env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE="$v" "$root/merge-verified-pr.sh" 42 --repo owner/repo
done
# Whitespace-only is still a run (fail-closed; the hook policy and arc work agree).
refused_run "whitespace-only run id" "merge authority is human" \
  env ARC_CODE_AGENT_RUN_ID='  ' "$root/merge-verified-pr.sh" 42 --repo owner/repo
refused_run "a run id that cannot be stamped" "run id" \
  env ARC_CODE_AGENT_RUN_ID='agent x-->' ARC_FACTORY_ALLOW_SELF_MERGE=1 "$root/merge-verified-pr.sh" 42 --repo owner/repo

# ACCEPT (operator override): stamp the run onto the PR BEFORE the merge, keep the body.
reset_patches
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 \
  TEST_BODY=$'Fixes #7640\n\nprose\n<!-- arc-factory-merge run=agent-old sha=2222222222222222222222222222222222222222 -->\n' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo)"
grep -qF 'agent-43839c9e' <<<"$out"
# The body is kept byte-exact (its trailing newline included); the stamp goes
# after a blank line.
want_body=$'Fixes #7640\n\nprose\n\n\n<!-- arc-factory-merge run=agent-43839c9e sha=3333333333333333333333333333333333333333 -->'
[ "$(cat "$TEST_PATCH_DIR/0")" = "$want_body" ] || { echo "stamped body wrong:"; cat "$TEST_PATCH_DIR/0"; exit 1; } >&2
# Order: the stamp lands before the merge, so no observer sees the merge without it.
[ "$(grep -n PATCH "$TEST_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n PUT "$TEST_LOG" | cut -d: -f1)" ]
grep -qF "api --method PATCH repos/owner/repo/pulls/42" "$TEST_LOG"

# An empty body gets the stamp alone.
reset_patches
env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_BODY= \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null
[ "$(cat "$TEST_PATCH_DIR/0")" = "<!-- arc-factory-merge run=agent-43839c9e sha=$sha40 -->" ]

# The stamp could not be written → no merge (an unattributable run merge is the bug).
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PATCH_FAIL=1 TEST_BODY=x \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ]; grep -qF 'could not stamp' <<<"$out"
if grep -qF PUT "$TEST_LOG"; then echo "merged without a stamp" >&2; exit 1; fi

# The merge itself failed and GitHub says the PR is NOT merged → the stamp is
# taken back off. The restore strips every stamp, also a stale one for this
# same head that an earlier failed restore left behind (#7662 review P3-1).
stale="<!-- arc-factory-merge run=agent-prev sha=$sha40 -->"
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PUT_FAIL=1 \
  TEST_BODY=$'orig body\n'"$stale" \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ]
[ "$(cat "$TEST_PATCH_DIR/1")" = "orig body" ] || { echo "stamp not removed after a failed merge: $(cat "$TEST_PATCH_DIR/1")" >&2; exit 1; }

# A CRLF body (edited on the GitHub web) is stripped too (#7662 round 2): the
# strip must remove every line the A2 reader accepts, CR or not.
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PUT_FAIL=1 \
  TEST_BODY=$'orig body\r\n'"$stale"$'\r\nmore\r\n' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ]
if grep -qF 'arc-factory-merge' "$TEST_PATCH_DIR/1"; then echo "CRLF stamp survived the restore: $(cat -v "$TEST_PATCH_DIR/1")" >&2; exit 1; fi
grep -qF 'more' "$TEST_PATCH_DIR/1"
# …and the stamping PATCH itself leaves exactly one stamp line (the new one).
[ "$(grep -c 'arc-factory-merge' "$TEST_PATCH_DIR/0")" = 1 ]

# A failed PUT is not proof the merge did not land (timeout, 5xx after the
# commit). Merged, or unknown → the stamp STAYS, loudly (#7662 review P2-2):
# removing it would turn an agent merge into a human one.
for merged in true fail; do
  reset_patches; set +e
  out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PUT_FAIL=1 \
    TEST_MERGED=$merged TEST_BODY='orig body' "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
  [ "$code" -ne 0 ]
  [ ! -e "$TEST_PATCH_DIR/1" ] || { echo "stamp removed although merged=$merged" >&2; exit 1; }
  grep -qF 'stamp kept' <<<"$out" || { echo "no warning for merged=$merged: $out" >&2; exit 1; }
done

# Codex P2 on #7685: GitHub's update-PR endpoint has no conditional write, so a
# PATCH computed from an earlier read would overwrite a person's edit made in
# between. The script re-reads the body right before each PATCH and refuses
# when it changed. Read 1 is the stamp's GET, read 2 its re-check; after a
# failed PUT, read 3 is the restore's GET and read 4 its re-check.
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_BODY='orig body' \
  TEST_BODY_CHANGE_AT=2 TEST_BODY_CHANGED='orig body, edited by a person' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ] || { echo "stamped over a concurrent edit" >&2; exit 1; }
grep -qF 'PR body changed since it was read' <<<"$out" || { echo "no reason for the stamp refusal: $out" >&2; exit 1; }
[ ! -e "$TEST_PATCH_DIR/0" ] || { echo "PATCHed over a concurrent edit: $(cat "$TEST_PATCH_DIR/0")" >&2; exit 1; }
[ ! -e "$TEST_LOG" ] || ! grep -qF PUT "$TEST_LOG" || { echo "merged although the stamp was refused" >&2; exit 1; }
# A re-read that FAILS is not "unchanged": the stamp is refused the same way.
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_BODY='orig body' \
  TEST_BODY_READ_FAIL_AT=2 "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ] && grep -qF 'the re-read failed' <<<"$out" || { echo "a failed re-read stamped: $out" >&2; exit 1; }
[ ! -e "$TEST_PATCH_DIR/0" ] && { [ ! -e "$TEST_LOG" ] || ! grep -qF PUT "$TEST_LOG"; } || { echo "a failed re-read wrote or merged" >&2; exit 1; }
# Accept twin: the same run with an unchanged body re-reads, stamps and merges.
reset_patches
env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_BODY='orig body' \
  TEST_BODY_CHANGE_AT=9 TEST_BODY_CHANGED='never served' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null
[ "$(wc -l < "$TEST_PATCH_DIR/.reads" | tr -d ' ')" = 2 ] || { echo "the stamp did not re-read the body" >&2; exit 1; }
grep -qF "api --method PUT repos/owner/repo/pulls/42/merge" "$TEST_LOG"

# The failed-merge restore: a body edited between its GET and its PATCH is not
# overwritten; the stamp stays and the reason is named.
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PUT_FAIL=1 \
  TEST_BODY='orig body' TEST_BODY_CHANGE_AT=4 TEST_BODY_CHANGED='edited after the failed merge' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ]
[ ! -e "$TEST_PATCH_DIR/1" ] || { echo "restore PATCHed over a concurrent edit: $(cat "$TEST_PATCH_DIR/1")" >&2; exit 1; }
grep -qF 'PR body changed since it was read' <<<"$out" || { echo "no reason for the restore refusal: $out" >&2; exit 1; }
grep -qF 'stamp kept' <<<"$out"
# …and a restore whose re-read FAILS keeps the stamp too.
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PUT_FAIL=1 \
  TEST_BODY='orig body' TEST_BODY_READ_FAIL_AT=4 "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ]
[ ! -e "$TEST_PATCH_DIR/1" ] || { echo "restore PATCHed after a failed re-read" >&2; exit 1; }
grep -qF 'the re-read failed' <<<"$out" || { echo "no reason for a failed restore re-read: $out" >&2; exit 1; }
# Accept twin: unchanged across the restore's two reads → the stamp comes off.
reset_patches; set +e
env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PUT_FAIL=1 \
  TEST_BODY='orig body' "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null 2>&1; set -e
[ "$(cat "$TEST_PATCH_DIR/1")" = "orig body" ]
[ "$(wc -l < "$TEST_PATCH_DIR/.reads" | tr -d ' ')" = 4 ] || { echo "the restore did not re-read the body" >&2; exit 1; }

# Codex P2 on #7722: `$( )` strips trailing newlines, so a concurrent edit that
# only adds or removes trailing newlines compared equal and was overwritten.
# The bodies are compared byte-exact.
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_BODY='orig body' \
  TEST_BODY_CHANGE_AT=2 TEST_BODY_CHANGED=$'orig body\n' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ] && grep -qF 'PR body changed since it was read' <<<"$out" || { echo "a trailing-newline edit was not seen (stamp): $out" >&2; exit 1; }
[ ! -e "$TEST_PATCH_DIR/0" ] || { echo "stamped over a trailing-newline edit" >&2; exit 1; }
reset_patches; set +e
out="$(env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PUT_FAIL=1 \
  TEST_BODY=$'orig body\n\n' TEST_BODY_CHANGE_AT=4 TEST_BODY_CHANGED='orig body' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ]
[ ! -e "$TEST_PATCH_DIR/1" ] || { echo "restore overwrote a trailing-newline edit: $(cat -v "$TEST_PATCH_DIR/1")" >&2; exit 1; }
grep -qF 'PR body changed since it was read' <<<"$out" && grep -qF 'stamp kept' <<<"$out" || { echo "no reason for the restore refusal: $out" >&2; exit 1; }
# Accept twin: trailing blank lines, unchanged → stamped, the body kept byte-exact.
reset_patches
env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_BODY=$'orig body\n\n' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null
[ "$(cat "$TEST_PATCH_DIR/0"; printf x)" = $'orig body\n\n\n\n<!-- arc-factory-merge run=agent-43839c9e sha='"$sha40"$' -->x' ] ||
  { echo "stamped body not byte-exact: $(cat -v "$TEST_PATCH_DIR/0")" >&2; exit 1; }
grep -qF "api --method PUT repos/owner/repo/pulls/42/merge" "$TEST_LOG"
# …and the restore of that stamped body gives the original back, trailing newlines included.
reset_patches; set +e
env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_PUT_FAIL=1 \
  TEST_BODY=$'orig body\n\n\n\n<!-- arc-factory-merge run=agent-prev sha='"$sha40"' -->' \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null 2>&1; set -e
[ "$(cat "$TEST_PATCH_DIR/1"; printf x)" = $'orig body\n\nx' ] ||
  { echo "restore not byte-exact: $(cat -v "$TEST_PATCH_DIR/1")" >&2; exit 1; }

# The stamp strip is linear: a 64 KiB run of blanks (GitHub's body limit) is
# not a backtracking trap (#7662 review P3-2: the old pattern took seconds).
big="$(python3 -c 'print(" " * 65536 + "x", end="")')"
reset_patches; start=$(date +%s)
env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_BODY="$big" \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null
[ $(( $(date +%s) - start )) -le 2 ] || { echo "stamp strip is slow on a 64 KiB blank body" >&2; exit 1; }
unset TEST_SHA
echo "ok"

# ── factory merge check (#7729), from the repo profile ─────────────────────
# A stub check: TEST_CHECK=ok|not-factory|refused|down decides its answer.
cat > "$tmp/check" <<'CHECK'
#!/usr/bin/env bash
case "${TEST_CHECK:-ok}" in old) echo 'Unknown command: "-i"'; exit 5 ;; esac
[ "$1" = --help ] && exit 0
printf '%s\n' "$*" >> "$TEST_PATCH_DIR/.check-args"
case "${TEST_CHECK:-ok}" in
  noinstance) echo 'ERROR: no instance named "factory"'; exit 1 ;;
  ok) echo '{"kind":"ok","reason":"approved"}' ;;
  not-factory) echo '{"kind":"not-factory","reason":"no Change Set"}' ;;
  refused) echo 'ERROR: {"kind":"refused","code":"path-policy","reason":"agent-1 is violated: .claude/settings.json"} trailing'; exit 5 ;;
  broken) echo 'ERROR: index exploded {not json'; exit 5 ;;
  down) echo 'ERROR: No AFS daemon is running for instance "factory".'; exit 6 ;;
  missing) exit 127 ;;
esac
CHECK
chmod +x "$tmp/check"
printf '| `factory_merge_check_entry` | `%s` — stub |\n' "$tmp/check" > "$tmp/profile.md"
export AGENTLOOP_REPO_PROFILE="$tmp/profile.md"
head40=$(printf 'a%.0s' {1..40})

# ACCEPT: an approved, path-compliant factory PR merges; the check got the PR url and head.
rm -f "$TEST_LOG" "$TEST_PATCH_DIR/.check-args"
TEST_CHECK=ok TEST_SHA=$head40 "$root/merge-verified-pr.sh" 42 --repo owner/repo
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge' "$TEST_LOG"
grep -F -- "--pr https://github.com/owner/repo/pull/42 --head $head40 --head-ref fix/x --base-sha base0 --json" "$TEST_PATCH_DIR/.check-args"
# ACCEPT: a PR the factory never produced merges.
rm -f "$TEST_LOG"
TEST_CHECK=not-factory "$root/merge-verified-pr.sh" 42 --repo owner/repo
grep -F 'api --method PUT' "$TEST_LOG"
# A refusal stops the merge, and --not-factory does not lift it.
TEST_CHECK=refused fails "factory check refused" "$root/merge-verified-pr.sh" 42 --repo owner/repo
TEST_CHECK=refused fails "refused + --not-factory" "$root/merge-verified-pr.sh" 42 --repo owner/repo --not-factory "cloud runner"
set +e; out=$(TEST_CHECK=refused "$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1); set -e
printf '%s' "$out" | grep -F '.claude/settings.json' >/dev/null || { echo "refusal reason not shown" >&2; exit 1; }
# Ledger unreachable: refused without an assertion; merges with one; never for factory/*.
TEST_CHECK=down fails "check down, no assertion" "$root/merge-verified-pr.sh" 42 --repo owner/repo
rm -f "$TEST_LOG"
TEST_CHECK=down "$root/merge-verified-pr.sh" 42 --repo owner/repo --not-factory "cloud bug-land runner"
grep -F 'api --method PUT' "$TEST_LOG"
TEST_CHECK=down TEST_REF=factory/w_abc fails "factory branch + --not-factory" "$root/merge-verified-pr.sh" 42 --repo owner/repo --not-factory "nope"
# A failure after the factory answered (exit 5, no parsable kind) is never liftable.
TEST_CHECK=broken fails "broken check + --not-factory" "$root/merge-verified-pr.sh" 42 --repo owner/repo --not-factory "cloud runner"
# No arc at all (127) is "no factory to ask", like a missing daemon.
TEST_CHECK=missing fails "no arc, no assertion" "$root/merge-verified-pr.sh" 42 --repo owner/repo
rm -f "$TEST_LOG"
TEST_CHECK=missing "$root/merge-verified-pr.sh" 42 --repo owner/repo --not-factory "cloud runner without arc"
grep -F 'api --method PUT' "$TEST_LOG"
# No factory instance on this machine, or an arc too old for the check: no
# factory to ask, liftable only with the assertion.
for mode in noinstance old; do
  TEST_CHECK=$mode fails "$mode, no assertion" "$root/merge-verified-pr.sh" 42 --repo owner/repo
  rm -f "$TEST_LOG"
  TEST_CHECK=$mode "$root/merge-verified-pr.sh" 42 --repo owner/repo --not-factory "no factory on this runner"
  grep -F 'api --method PUT' "$TEST_LOG"
done
# A plain exit 1 that is not "no instance" is still a refusal.
TEST_CHECK=broken fails "broken (exit 5) + assertion" "$root/merge-verified-pr.sh" 42 --repo owner/repo --not-factory "x"
# No key in the profile: no check, said out loud, and the merge proceeds.
printf '| `other_key` | `x` |\n' > "$tmp/nokey.md"
rm -f "$TEST_LOG"; out=$(AGENTLOOP_REPO_PROFILE="$tmp/nokey.md" "$root/merge-verified-pr.sh" 42 --repo owner/repo)
printf '%s' "$out" | grep -F 'no factory_merge_check_entry' >/dev/null || { echo "missing no-key notice" >&2; exit 1; }
fails "--not-factory needs a reason" "$root/merge-verified-pr.sh" 42 --repo owner/repo --not-factory ""
export AGENTLOOP_REPO_PROFILE="$tmp/no-profile.md"
echo "factory merge check: ok"
echo ok
