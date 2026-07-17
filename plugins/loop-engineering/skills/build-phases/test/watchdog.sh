#!/usr/bin/env bash
# Reference implementation of build-phases watchdog state machine.
# Mirrors the logic in .claude/plugins/loop-engineering/skills/build-phases/SKILL.md Rule 4.
#
# Usage: watchdog.sh <progress-file>
# Output: one of [INIT, SPAWN_NEXT, WAIT, RESPAWN, ESCALATE, COMPLETE, SPAWN_CURRENT]

set -euo pipefail

FILE="${1:?progress file required}"
NOW_EPOCH="${NOW_EPOCH:-$(date -u +%s)}"
STALE_SECONDS="${STALE_SECONDS:-1800}"  # 30 min (sub-agent era: notification-driven, wakeup is fallback)
MAX_RESPAWN="${MAX_RESPAWN:-3}"

if [[ ! -f "$FILE" ]]; then
  echo "INIT"
  exit 0
fi

jq_get() { jq -r "$1 // empty" "$FILE"; }

total_phases=$(jq_get '.total_phases')
completed_count=$(jq -r '.completed_phases | length' "$FILE")
executor_status=$(jq_get '.executor_status')
heartbeat_iso=$(jq_get '.executor_last_heartbeat')
respawn_count=$(jq -r '.executor_respawn_count // 0' "$FILE")
error_reason=$(jq_get '.executor_error.reason')

# Priority 1: All phases complete
if [[ -n "$total_phases" && "$completed_count" -ge "$total_phases" ]]; then
  echo "COMPLETE"
  exit 0
fi

# Priority 2: Respawn limit hit → escalate
if [[ "$respawn_count" -ge "$MAX_RESPAWN" ]]; then
  echo "ESCALATE respawn_limit"
  exit 0
fi

# Priority 3: Executor reported done → spawn next phase
if [[ "$executor_status" == "done" ]]; then
  echo "SPAWN_NEXT"
  exit 0
fi

# Priority 4: Explicit error
if [[ "$executor_status" == "error" || "$executor_status" == "crashed" ]]; then
  if [[ -n "$error_reason" ]]; then
    echo "ESCALATE $error_reason"
  else
    echo "RESPAWN"
  fi
  exit 0
fi

# Priority 5: Running — check heartbeat freshness
if [[ "$executor_status" == "running" ]]; then
  if [[ -z "$heartbeat_iso" ]]; then
    echo "RESPAWN"
    exit 0
  fi
  heartbeat_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$heartbeat_iso" +%s 2>/dev/null || \
                    date -u -d "$heartbeat_iso" +%s 2>/dev/null || echo 0)
  age=$((NOW_EPOCH - heartbeat_epoch))
  if [[ "$age" -lt "$STALE_SECONDS" ]]; then
    echo "WAIT"
  else
    echo "RESPAWN stale_${age}s"
  fi
  exit 0
fi

# Priority 6: null/unset status → freshly written, never spawned
echo "SPAWN_CURRENT"
