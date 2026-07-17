#!/usr/bin/env bash
# Reference implementation of the Watchdog Tick Report format.
# Mirrors the template in .claude/plugins/loop-engineering/skills/build-phases/SKILL.md Rule 4.
#
# Usage: render-tick.sh <progress-file>
# Output: markdown tick report block

set -euo pipefail

FILE="${1:?progress file required}"
NOW_EPOCH="${NOW_EPOCH:-$(date -u +%s)}"
STALE_SECONDS="${STALE_SECONDS:-1800}"
TAIL_LINES="${TAIL_LINES:-10}"

if [[ ! -f "$FILE" ]]; then
  cat <<EOF
## 🐕 Watchdog init

**Planning:** (not yet initialized)
**→ Decision:** \`INIT\` — no progress file, will bootstrap
EOF
  exit 0
fi

jg() { jq -r "$1 // \"-\"" "$FILE"; }

total=$(jg '.total_phases')
current=$(jg '.current_phase')
completed_arr=$(jq -rc '.completed_phases // []' "$FILE")
completed=$(jq -r '.completed_phases | length' "$FILE")
status=$(jg '.executor_status')
task=$(jg '.executor_current_task')
log=$(jg '.executor_log')
respawn=$(jq -r '.executor_respawn_count // 0' "$FILE")
heartbeat_iso=$(jg '.executor_last_heartbeat')
started_iso=$(jg '.executor_started_at')

format_ago() {
  local iso="$1"
  if [[ "$iso" == "-" || -z "$iso" ]]; then echo "-"; return; fi
  local epoch
  epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null || date -u -d "$iso" +%s 2>/dev/null || echo 0)
  local age=$((NOW_EPOCH - epoch))
  if [[ $age -lt 60 ]]; then echo "${age}s"
  elif [[ $age -lt 3600 ]]; then echo "$((age/60))m"
  else echo "$((age/3600))h $((age%3600/60))m"
  fi
}

hb_ago=$(format_ago "$heartbeat_iso")
started_ago=$(format_ago "$started_iso")

fresh_marker="✓ fresh"
if [[ "$heartbeat_iso" != "-" && -n "$heartbeat_iso" ]]; then
  hb_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$heartbeat_iso" +%s 2>/dev/null || date -u -d "$heartbeat_iso" +%s 2>/dev/null || echo 0)
  age=$((NOW_EPOCH - hb_epoch))
  if [[ $age -ge $STALE_SECONDS ]]; then fresh_marker="⚠️ stale"; fi
fi

cat <<EOF
## 🐕 Watchdog tick — phase $current/$total

**Executor:** \`$status\` | started $started_ago ago
**Current task:** $task
**Heartbeat:** $hb_ago ago ($fresh_marker)
**Respawn count:** $respawn/3
**Completed:** $completed_arr ($completed/$total)
**Log:** \`$log\`
EOF

echo ""
echo "**Recent output:**"
echo '```'
if [[ "$log" != "-" && -f "$log" ]]; then
  tail -n "$TAIL_LINES" "$log"
else
  echo "(no log file yet)"
fi
echo '```'
