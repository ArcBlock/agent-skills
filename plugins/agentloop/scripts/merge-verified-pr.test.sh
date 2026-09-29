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
printf '%s\n' "$*" >> "$TEST_LOG"
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
export PATH="$tmp:$PATH" TEST_LOG="$tmp/log" TEST_FETCH_LOG="$tmp/fetch"
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

# ── The pre-existing PR-state refusals still hold, record or not ────────────
write_record true 42
for field in 'TEST_STATE=CLOSED' 'TEST_MERGEABLE=CONFLICTING' 'TEST_MERGEABLE=UNKNOWN'; do
  rm -f "$TEST_LOG"; set +e
  env $field PATH="$PATH" TEST_LOG="$TEST_LOG" ARC_MERGE_VERDICT_DIR="$verdicts" \
    "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null 2>&1
  code=$?; set -e
  test "$code" -ne 0; test ! -e "$TEST_LOG"
done
echo "ok"
