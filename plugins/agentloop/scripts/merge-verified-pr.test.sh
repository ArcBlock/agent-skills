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
"$root/merge-verified-pr.sh" 42 --repo owner/repo --method squash
grep -F 'api --method PUT repos/owner/repo/pulls/42/merge -f sha=head -f merge_method=squash' "$TEST_LOG"
for field in 'TEST_STATE=CLOSED' 'TEST_MERGEABLE=CONFLICTING' 'TEST_MERGEABLE=UNKNOWN'; do
  rm -f "$TEST_LOG"; set +e; env $field PATH="$PATH" TEST_LOG="$TEST_LOG" "$root/merge-verified-pr.sh" 42 --repo owner/repo >/dev/null 2>&1; code=$?; set -e
  test "$code" -ne 0; test ! -e "$TEST_LOG"
done
