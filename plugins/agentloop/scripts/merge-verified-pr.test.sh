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
      --json) [ "${2:-}" = headRefOid,state,mergeable ] || exit 91; shift 2 ;;
      --jq) [ "${2:-}" = '.headRefOid + "\t" + .state + "\t" + .mergeable' ] || exit 92; shift 2 ;;
      *) shift ;;
    esac
  done
  printf '%s\t%s\t%s\n' "${TEST_SHA:-head}" "${TEST_STATE:-OPEN}" "${TEST_MERGEABLE:-MERGEABLE}"
  exit 0
fi
# The PR body read (factory-merge stamp, #7662): answered, not logged.
if [ "$1" = api ] && [ "${3:-}" = --jq ] && [ "${4:-}" = '.body // ""' ]; then
  printf '%s' "${TEST_BODY-}"
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
# The merge script resolves origin/HEAD, fetches that branch, then rev-parses
# it. Those three are stubbed. Everything else is the real git, so the
# non-repo fallback below still asks `rev-parse --show-toplevel`.
cat > "$tmp/git" << 'EOF'
#!/usr/bin/env bash
if [ "$1" = symbolic-ref ] && [ "$2" = --short ] && [ "$3" = refs/remotes/origin/HEAD ]; then
  printf '%s\n' "${TEST_BASE_REF:-origin/main}"
  exit 0
fi
if [ "$1" = fetch ]; then
  printf '%s\n' "$*" >> "${TEST_FETCH_LOG:?}"
  if [ "${TEST_FETCH_FAIL:-}" = 1 ]; then
    exit 1
  fi
  exit 0
fi
if [ "$1" = rev-parse ] && [[ "${2:-}" == origin/* ]]; then
  printf '%s\n' "${TEST_MAIN_TIP:?}"
  exit 0
fi
exec /usr/bin/git "$@"
EOF
chmod +x "$tmp/git"
export PATH="$tmp:$PATH" TEST_LOG="$tmp/log" TEST_FETCH_LOG="$tmp/fetch" TEST_PATCH_DIR="$tmp/patches"
mkdir -p "$TEST_PATCH_DIR"
# Hermetic: this suite may itself run inside a factory run (#7662).
unset ARC_CODE_AGENT_RUN_ID ARC_FACTORY_ALLOW_SELF_MERGE
export TEST_MAIN_TIP=1111111111111111111111111111111111111111

verdicts="$tmp/verdicts"; mkdir -p "$verdicts"
export ARC_MERGE_VERDICT_DIR="$verdicts"
record="$verdicts/merge-gate.head.json"
write_record() {
  local tip="${3:-$TEST_MAIN_TIP}"
  printf '{"ok": %s, "pr": "%s", "sha": "head", "mainTip": "%s"}\n' "$1" "$2" "$tip" > "$record"
}

fails() { # fails <label> -- runs the script, requires non-zero AND no merge call
  local label="$1"; shift
  rm -f "$TEST_LOG"; set +e; "$@" >/dev/null 2>&1; local code=$?; set -e
  [ "$code" -ne 0 ] || { echo "expected refusal: $label" >&2; exit 1; }
  [ ! -e "$TEST_LOG" ] || { echo "merged despite refusal: $label" >&2; exit 1; }
}

# ── ACCEPT: a matching verdict record merges ────────────────────────────────
# Without this arm the whole suite is satisfied by a script that refuses
# everything — the accept-path 铁律 applied to this gate itself.
write_record true 42
rm -f "$TEST_FETCH_LOG"
"$root/merge-verified-pr.sh" 42 --repo owner/repo --method squash
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge -f sha=head -f merge_method=squash' "$TEST_LOG"
grep -F 'fetch --no-tags origin main' "$TEST_FETCH_LOG"

# A non-main default branch is fetched and compared under its own name.
export TEST_BASE_REF=origin/develop
rm -f "$TEST_LOG" "$TEST_FETCH_LOG"
"$root/merge-verified-pr.sh" 42 --repo owner/repo --method squash
grep -F 'fetch --no-tags origin develop' "$TEST_FETCH_LOG"
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge -f sha=head -f merge_method=squash' "$TEST_LOG"
unset TEST_BASE_REF

# A failed fetch is not "the local ref is still current".
export TEST_FETCH_FAIL=1
rm -f "$TEST_LOG" "$TEST_FETCH_LOG"
fails "fetch failed" "$root/merge-verified-pr.sh" 42 --repo owner/repo
unset TEST_FETCH_FAIL

# ── REJECT: the four ways the record can fail to prove this merge ───────────
rm -f "$record"
fails "no verdict record" "$root/merge-verified-pr.sh" 42 --repo owner/repo
write_record true 99
fails "record is for another PR" "$root/merge-verified-pr.sh" 42 --repo owner/repo
write_record false 42
fails "record says ok=false" "$root/merge-verified-pr.sh" 42 --repo owner/repo
write_record true 42 2222222222222222222222222222222222222222
fails "newer main tip" "$root/merge-verified-pr.sh" 42 --repo owner/repo
set +e; moved="$("$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; set -e
grep -qF 'Re-run merge-gate' <<<"$moved"
grep -qF 'has moved past' <<<"$moved"
write_record true 42
printf 'not json at all' > "$record"
fails "record is unparseable" "$root/merge-verified-pr.sh" 42 --repo owner/repo

# An unparseable record must NOT be reported as "for another PR" — a corrupt
# instrument and a wrong answer are different facts.
set +e; msg="$("$root/merge-verified-pr.sh" 42 --repo owner/repo 2>&1)"; set -e
grep -qF 'unreadable/unparseable' <<<"$msg"

# ── The escape hatch works, and is LOUD ─────────────────────────────────────
rm -f "$TEST_LOG" "$record"
out="$("$root/merge-verified-pr.sh" 42 --repo owner/repo --no-gate-record 'e2e box is offline')"
grep -qF 'WITHOUT a merge-gate verdict record' <<<"$out"
grep -qF 'e2e box is offline' <<<"$out"
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge' "$TEST_LOG"
# …and it refuses to be silent: a bare --no-gate-record with no reason is usage error.
fails "escape hatch without a reason" "$root/merge-verified-pr.sh" 42 --repo owner/repo --no-gate-record

# ── review #3: 非 git 仓库时必须落到 $PWD/.verify，不是 "/.verify" ───────────
# 裸的 ${VAR:-$(git rev-parse --show-toplevel)/.verify} 在这里会解析成文件系统根，
# 而 TS 侧落到 cwd —— 两侧回退不一致，就是「闸刚过却拒绝合并」。
unset ARC_MERGE_VERDICT_DIR
outside="$tmp/notarepo"; mkdir -p "$outside/.verify"
printf '{"ok": true, "pr": "42", "sha": "head", "mainTip": "%s"}\n' "$TEST_MAIN_TIP" > "$outside/.verify/merge-gate.head.json"
rm -f "$TEST_LOG"
( cd "$outside" && GIT_CEILING_DIRECTORIES="$tmp" "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null )
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge' "$TEST_LOG"
export ARC_MERGE_VERDICT_DIR="$verdicts"

# ── The PR number is a number (#7662 round 2): it lands in API paths ────────
for bad in abc 0 '42/../1' '-1' '42 43' ''; do
  rm -f "$TEST_LOG"; set +e; out="$("$root/merge-verified-pr.sh" "$bad" --repo owner/repo 2>&1)"; code=$?; set -e
  [ "$code" -eq 64 ] || { echo "PR '$bad' not refused as usage (got $code)" >&2; exit 1; }
  [ ! -e "$TEST_LOG" ] || { echo "called gh for PR '$bad'" >&2; exit 1; }
  [ -z "$bad" ] || grep -qF 'PR number' <<<"$out" || { echo "no reason for PR '$bad': $out" >&2; exit 1; }
done

# ── The pre-existing PR-state refusals still hold, record or not ────────────
write_record true 42
for field in 'TEST_STATE=CLOSED' 'TEST_MERGEABLE=CONFLICTING' 'TEST_MERGEABLE=UNKNOWN'; do
  rm -f "$TEST_LOG"; set +e
  env $field PATH="$PATH" TEST_LOG="$TEST_LOG" ARC_MERGE_VERDICT_DIR="$verdicts" \
    "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null 2>&1
  code=$?; set -e
  test "$code" -ne 0; test ! -e "$TEST_LOG"
done

# ── #7662: a factory run does not merge; merge authority is human ───────────
# A Factory run (ARC_CODE_AGENT_RUN_ID set) stops at ready-to-merge. The skill
# says so; this is the guard that does not depend on the model reading it.
sha40=3333333333333333333333333333333333333333
export TEST_SHA=$sha40
record40="$verdicts/merge-gate.$sha40.json"
printf '{"ok": true, "pr": "42", "sha": "%s", "mainTip": "%s"}\n' "$sha40" "$TEST_MAIN_TIP" > "$record40"
reset_patches() { rm -rf "$TEST_PATCH_DIR"; mkdir -p "$TEST_PATCH_DIR"; rm -f "$TEST_LOG"; }

# ACCEPT control first: the same PR and record merge outside a run, unstamped.
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
refused_run "--no-gate-record is not a way around it" "merge authority is human" \
  env ARC_CODE_AGENT_RUN_ID=agent-43839c9e "$root/merge-verified-pr.sh" 42 --repo owner/repo --no-gate-record "why"
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
want_body=$'Fixes #7640\n\nprose\n\n<!-- arc-factory-merge run=agent-43839c9e sha=3333333333333333333333333333333333333333 -->'
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

# The stamp strip is linear: a 64 KiB run of blanks (GitHub's body limit) is
# not a backtracking trap (#7662 review P3-2: the old pattern took seconds).
big="$(python3 -c 'print(" " * 65536 + "x", end="")')"
reset_patches; start=$(date +%s)
env ARC_CODE_AGENT_RUN_ID=agent-43839c9e ARC_FACTORY_ALLOW_SELF_MERGE=1 TEST_BODY="$big" \
  "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null
[ $(( $(date +%s) - start )) -le 2 ] || { echo "stamp strip is slow on a 64 KiB blank body" >&2; exit 1; }
unset TEST_SHA
echo "ok"
