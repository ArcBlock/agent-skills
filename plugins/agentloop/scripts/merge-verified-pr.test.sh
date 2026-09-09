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
export PATH="$tmp:$PATH" TEST_LOG="$tmp/log"

verdicts="$tmp/verdicts"; mkdir -p "$verdicts"
export ARC_MERGE_VERDICT_DIR="$verdicts"
record="$verdicts/merge-gate.head.json"
write_record() { printf '{"ok": %s, "pr": "%s", "sha": "head"}\n' "$1" "$2" > "$record"; }

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
"$root/merge-verified-pr.sh" 42 --repo owner/repo --method squash
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge -f sha=head -f merge_method=squash' "$TEST_LOG"

# ── REJECT: the four ways the record can fail to prove this merge ───────────
rm -f "$record"
fails "no verdict record" "$root/merge-verified-pr.sh" 42 --repo owner/repo
write_record true 99
fails "record is for another PR" "$root/merge-verified-pr.sh" 42 --repo owner/repo
write_record false 42
fails "record says ok=false" "$root/merge-verified-pr.sh" 42 --repo owner/repo
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
printf '{"ok": true, "pr": "42", "sha": "head"}\n' > "$outside/.verify/merge-gate.head.json"
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
