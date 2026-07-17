#!/usr/bin/env bash
# loop-engineering — materialize the controlled labels the sweep/review skills rely on.
# Idempotent: creates missing labels, syncs colour/description of existing ones.
# Run from the CONSUMING repo root (uses that repo's origin):
#   bash <plugin_root>/bootstrap/sync-labels.sh [--dry-run]
#
# These are the loop-engine's COORDINATION vocabulary — required for the sweeps to
# function (disposition, hold/mutex, human-gate signals). Work-type / priority /
# status labels (bug, P0-P3, status:*, doc-audit, …) are your repo's OWN convention;
# add them per your repo-profile "Label Vocabulary" section — this script does not
# invent project taxonomy for you.
set -uo pipefail
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

# name|color|description
LABELS=(
  "agent:hold|D4C5F9|Human hold: automation must not take terminal actions (close/merge) until a human clears it"
  "agent:processing|FBCA04|Processing mutex (advisory, ~30min TTL)"
  "agent:ready|0E8A16|Deterministically actionable now (issue-graph kick/rollup); the consumer removes it when done"
  "agent:blocked|B60205|Has an open blocker — deterministic SKIP"
  "needs-human-confirm|D93F0B|Needs a human decision before an agent proceeds"
  "needs-decision|D93F0B|Open design/direction decision for a human"
  "needs-human-review|D93F0B|Needs human review before merge/close"
  "pr-sweep:needs-fix|FBCA04|Review found a fixable issue with a clear path — the agent owns the fix next round"
  "pr-sweep:awaiting-glance|C2E0C6|Fully verified; a human just needs a quick visual/sanity confirm"
  "pr-sweep:awaiting-direction|1D76DB|Needs a human's high-level direction (product / architecture / scope)"
  "pr-sweep:awaiting-judgment|FBCA04|A risk the agent can't self-clear; needs a human judgment"
  "pr-sweep:awaiting-caution|B60205|Security / breaking / irreversible — always needs human approval"
)

if [ "$DRY" -eq 0 ] && ! gh api rate_limit >/dev/null 2>&1; then
  echo "✗ gh REST call failed — not authenticated. Run check-env.sh / gh auth login first." >&2; exit 1
fi

created=0; synced=0; failed=0
for row in "${LABELS[@]}"; do
  IFS='|' read -r name color desc <<<"$row"
  if [ "$DRY" -eq 1 ]; then printf '  would ensure: %-28s #%s\n' "$name" "$color"; continue; fi
  if gh label create "$name" --color "$color" --description "$desc" >/dev/null 2>&1; then
    printf '  + created  %s\n' "$name"; created=$((created+1))
  elif gh label edit "$name" --color "$color" --description "$desc" >/dev/null 2>&1; then
    printf '  = synced   %s (already existed)\n' "$name"; synced=$((synced+1))
  else
    printf '  ? FAILED   %s (check gh auth / repo write perms)\n' "$name"; failed=$((failed+1))
  fi
done

echo
if [ "$DRY" -eq 1 ]; then
  echo "DRY-RUN: ${#LABELS[@]} coordination labels would be ensured (nothing changed)."
else
  echo "Done: $created created, $synced synced, $failed failed."
  echo "Reminder: work-type / priority / status labels are your repo's own — see repo-profile Label Vocabulary."
  [ "$failed" -ne 0 ] && exit 1 || exit 0
fi
