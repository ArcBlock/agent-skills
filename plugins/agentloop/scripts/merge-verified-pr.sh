#!/usr/bin/env bash
# Merge an already-gated PR without asking gh to check out the default branch.
# Safe in linked worktrees: GitHub atomically rejects a stale head SHA.
#
# "already-gated" is CHECKED here, not assumed. This script's first line has
# claimed it since the day it was written while nothing verified the claim, and
# the claim did not hold: arc#6251/#6252/#6255/#6256/#6257 all merged in a state
# the merge gate would have refused (stale or FAILed stickies). "The gate ran"
# and "the gate was skipped" left identical traces, so the gap was invisible.
#
# The check reads the verdict record the gate writes on exit 0
# (`.verify/merge-gate.<sha>.json`), and requires it to be for THIS pr AND THIS
# head sha. Scope, stated honestly: this makes a skipped gate *visible*, it is
# not an authenticity control — a local record is as forgeable as anything else
# in a repo whose gate_mode is `scripts` (no CI on PRs, arc#745). Merging by
# another path (`gh pr merge`) still bypasses it; this script enforces its own
# contract, and does not pretend to be a global one.
#
# `--no-gate-record <why>` is the documented, LOUD escape hatch: it merges and
# says on stdout that it did so without a record, plus the reason. An escape
# hatch that leaves no trace is how the original hole stayed open.
set -euo pipefail

usage() {
  echo "usage: $0 <pr-number> [--repo OWNER/REPO] [--method squash|merge|rebase] [--no-gate-record <why>]" >&2
  exit 64
}
pr="${1:-}"; [ -n "$pr" ] || usage; shift
repo=""; method="squash"; skip_reason=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --method) method="${2:-}"; shift 2 ;;
    --no-gate-record)
      skip_reason="${2:-}"
      [ -n "$skip_reason" ] || { echo "refusing: --no-gate-record needs a reason" >&2; exit 64; }
      shift 2 ;;
    *) usage ;;
  esac
done
case "$method" in squash|merge|rebase) ;; *) usage ;; esac
args=(pr view "$pr" --json headRefOid,state,mergeable --jq '.headRefOid + "\t" + .state + "\t" + .mergeable')
[ -n "$repo" ] && args+=(--repo "$repo")
IFS=$'\t' read -r sha state mergeable <<<"$(gh "${args[@]}")"
[ "$state" = "OPEN" ] || { echo "refusing: PR #$pr is $state" >&2; exit 1; }
[ "$mergeable" = "MERGEABLE" ] || { echo "refusing: PR #$pr merge state is $mergeable" >&2; exit 1; }

# MUST match `mergeVerdictDir()` in the repo's merge-gate EXACTLY, all three branches:
#   $ARC_MERGE_VERDICT_DIR  →  <git toplevel>/.verify  →  $PWD/.verify
# The third branch is not decoration. Written as a bare
# `${VAR:-$(git rev-parse --show-toplevel)/.verify}`, a non-repo cwd makes the
# substitution empty and this resolves to "/.verify/..." — the filesystem root —
# while the TS side falls back to cwd. Then the gate writes one path, this reads
# another, and every gated merge is refused right after passing, which trains people
# to reach for --no-gate-record: the guarantee disables itself.
if [ -n "${ARC_MERGE_VERDICT_DIR:-}" ]; then
  verdict_dir="$ARC_MERGE_VERDICT_DIR"
else
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  verdict_dir="${toplevel:-$PWD}/.verify"
fi
record="$verdict_dir/merge-gate.${sha}.json"
if [ -n "$skip_reason" ]; then
  echo "⚠ merging WITHOUT a merge-gate verdict record for ${sha:0:9} — reason: $skip_reason"
elif [ ! -f "$record" ]; then
  cat >&2 <<EOF
refusing: no merge-gate verdict for PR #$pr at ${sha:0:9}
  expected: $record
  run:      bun .claude/verify/merge-gate.ts --cs-head $sha $pr
  A gate that was never run and a gate that passed are the same color without
  this record — that is exactly what let #6251/#6255 merge on stale evidence.
  Deliberate exception: --no-gate-record "<why>" (says so on stdout).
EOF
  exit 1
else
  # The record must be about THIS pr, not merely about this sha: a sha can be the
  # head of more than one PR (same branch, a reopened PR), and a record from a
  # different PR proves a different set of gates ran.
  #
  # python3-for-JSON is this directory's existing idiom (agent-identity.sh parses
  # plugin.json the same way). An unparseable record gets its OWN refusal message:
  # "the record is corrupt" and "the record is for another PR" are different facts
  # and must not be reported as the same one.
  if ! parsed="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print("%s\t%s" % (d.get("pr", ""), "yes" if d.get("ok") is True else "no"))
' "$record" 2>&1)"; then
    echo "refusing: verdict record for PR #$pr at ${sha:0:9} is unreadable/unparseable" >&2
    echo "  $record" >&2
    echo "  $parsed" >&2
    exit 1
  fi
  IFS=$'\t' read -r rec_pr rec_ok <<<"$parsed"
  [ "$rec_pr" = "$pr" ] || { echo "refusing: verdict record at ${sha:0:9} is for PR #$rec_pr, not #$pr" >&2; exit 1; }
  [ "$rec_ok" = "yes" ] || { echo "refusing: verdict record for PR #$pr is not ok=true" >&2; exit 1; }
  echo "✓ merge-gate verdict found for PR #$pr @ ${sha:0:9}"
fi

endpoint="repos/${repo:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}/pulls/$pr/merge"
gh api --method PUT "$endpoint" -f sha="$sha" -f merge_method="$method"
