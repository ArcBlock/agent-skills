#!/usr/bin/env bash
# Runs watchdog state machine against all fixtures and checks expected actions.

set -euo pipefail
cd "$(dirname "$0")"

WATCHDOG=./watchdog.sh
FIXTURES=./fixtures
NOW="2026-04-15T12:00:00Z"
NOW_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$NOW" +%s 2>/dev/null || date -u -d "$NOW" +%s)
export NOW_EPOCH

pass=0
fail=0

run_case() {
  local name="$1" file="$2" expected="$3"
  local actual
  actual=$("$WATCHDOG" "$file" 2>&1 || echo "ERROR")
  if [[ "$actual" == "$expected"* ]]; then
    printf "  \033[32m✓\033[0m %-40s → %s\n" "$name" "$actual"
    pass=$((pass+1))
  else
    printf "  \033[31m✗\033[0m %-40s → got: %s, want: %s\n" "$name" "$actual" "$expected"
    fail=$((fail+1))
  fi
}

echo "Watchdog State Machine Tests"
echo "============================"
echo "NOW = $NOW (epoch $NOW_EPOCH)"
echo ""

run_case "no file (init mode)"           "$FIXTURES/nonexistent.json"    "INIT"
run_case "freshly written, no executor"  "$FIXTURES/fresh.json"          "SPAWN_CURRENT"
run_case "running, fresh heartbeat"      "$FIXTURES/running-fresh.json"  "WAIT"
run_case "running, stale heartbeat"      "$FIXTURES/running-stale.json"  "RESPAWN"
run_case "executor done, phase remains"  "$FIXTURES/phase-done.json"     "SPAWN_NEXT"
run_case "all phases complete"           "$FIXTURES/all-done.json"       "COMPLETE"
run_case "executor error (escalate)"     "$FIXTURES/error.json"          "ESCALATE"
run_case "deferred admission (escalate)" "$FIXTURES/deferred.json"       "ESCALATE E2E_LOG_HAS_DEFERRED"
run_case "crashed status"                "$FIXTURES/crashed.json"        "RESPAWN"
run_case "respawn limit exceeded"        "$FIXTURES/respawn-limit.json"  "ESCALATE respawn_limit"

echo ""
echo "Tick Report Render Tests"
echo "========================"

render_check() {
  local name="$1" file="$2" pattern="$3"
  local output
  output=$(./render-tick.sh "$file" 2>&1 || echo "ERROR")
  if echo "$output" | grep -qE "$pattern"; then
    printf "  \033[32m✓\033[0m %-40s → matches /%s/\n" "$name" "$pattern"
    pass=$((pass+1))
  else
    printf "  \033[31m✗\033[0m %-40s → missing /%s/\n    output: %s\n" "$name" "$pattern" "$output"
    fail=$((fail+1))
  fi
}

render_check "init report: bootstrap hint"  "$FIXTURES/nonexistent.json"   'Decision.*INIT'
render_check "fresh tick: marks fresh"      "$FIXTURES/running-fresh.json" 'fresh'
render_check "fresh tick: shows 5m ago"     "$FIXTURES/running-fresh.json" 'Heartbeat.*5m ago'
render_check "fresh tick: shows log path"   "$FIXTURES/running-fresh.json" 'Log.*phase-1.*\.log'
render_check "fresh tick: recent output hdr" "$FIXTURES/running-fresh.json" 'Recent output'
render_check "fresh tick: tails log body"    "$FIXTURES/running-fresh.json" 'VERIFY L3'
render_check "stale tick: marks stale"      "$FIXTURES/running-stale.json" 'stale'
render_check "stale tick: shows 40m ago"    "$FIXTURES/running-stale.json" 'Heartbeat.*40m ago'
render_check "stale tick: no log placeholder" "$FIXTURES/running-stale.json" 'no log file yet'

echo ""
echo "Results: $pass passed, $fail failed"
exit $fail
