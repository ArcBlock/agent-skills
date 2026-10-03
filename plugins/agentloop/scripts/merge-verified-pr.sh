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
#
# Factory runs (arc#7662): inside a code-agents run (`ARC_CODE_AGENT_RUN_ID`
# set) merge authority is HUMAN. land / epic-conductor stop at ready-to-merge,
# and this script refuses (exit 3, before any GitHub call), so the skills'
# entry does not rest on the model reading the rule. `--no-gate-record` does
# not lift it. Operator override: `ARC_FACTORY_ALLOW_SELF_MERGE=1` (exactly
# `1`, default off) in the run's environment.
#
# Scope, stated honestly: this is a guardrail, not an access control. A run
# holds a credential that can merge, so it can call `gh` directly or set the
# override itself; a consumer repo can narrow that with a PreToolUse hook, and
# the real control is a run credential that cannot merge. What this script
# guarantees is that a merge it performs for a run is never unattributed:
# under the override it first stamps the PR body, bound to the head sha,
#   <!-- arc-factory-merge run=<run id> sha=<40-hex head> -->
# and refuses to merge if the stamp cannot be written. A ledger that reads the
# stamp (arc: the GitHub sync, aos `factoryMergeRunOf`) records the merge as
# the run's, not as the person whose account the run uses. A failed merge
# takes the stamp off only when GitHub says the PR is not merged.
set -euo pipefail

usage() {
  echo "usage: $0 <pr-number> [--repo OWNER/REPO] [--method squash|merge|rebase] [--no-gate-record <why>]" >&2
  exit 64
}
pr="${1:-}"; [ -n "$pr" ] || usage; shift
# It lands in API paths and the PR-body stamp: a positive integer, nothing else.
[[ "$pr" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "refusing: '$pr' is not a PR number" >&2; exit 64; }
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

run_id="${ARC_CODE_AGENT_RUN_ID:-}"
if [ -n "$run_id" ]; then
  if [ "${ARC_FACTORY_ALLOW_SELF_MERGE:-}" != 1 ]; then
    cat >&2 <<EOF
refusing: factory run $run_id: merge authority is human (arc#7662).
  Stop at ready-to-merge: leave the PR with its gate evidence posted and report
  "ready to merge, human decision". A person runs the merge gate and merges.
  Operator override (set in the run's environment by the operator, never by the
  run itself): ARC_FACTORY_ALLOW_SELF_MERGE=1 — the merge is then stamped with
  the run id and counted as an agent merge.
EOF
    exit 3
  fi
  if ! [[ "$run_id" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; then
    echo "refusing: ARC_CODE_AGENT_RUN_ID '$run_id' is not a run id that can be stamped onto the PR (expected [A-Za-z0-9._:-]{1,128})" >&2
    exit 3
  fi
fi
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
tip = d.get("mainTip")
tip_s = tip if isinstance(tip, str) else ""
print("%s\t%s\t%s" % (d.get("pr", ""), "yes" if d.get("ok") is True else "no", tip_s))
' "$record" 2>&1)"; then
    echo "refusing: verdict record for PR #$pr at ${sha:0:9} is unreadable/unparseable" >&2
    echo "  $record" >&2
    echo "  $parsed" >&2
    exit 1
  fi
  IFS=$'\t' read -r rec_pr rec_ok rec_main <<<"$parsed"
  [ "$rec_pr" = "$pr" ] || { echo "refusing: verdict record at ${sha:0:9} is for PR #$rec_pr, not #$pr" >&2; exit 1; }
  [ "$rec_ok" = "yes" ] || { echo "refusing: verdict record for PR #$pr is not ok=true" >&2; exit 1; }
  # The configured remote HEAD, not a hardcoded `main` (#7106, Codex P1 on
  # #7285). A consumer whose default branch is not named main must still be
  # checked. A missing origin/HEAD falls back to origin/main, the historical
  # arc default.
  base_ref="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  case "$base_ref" in
    origin/*) ;;
    *) base_ref="origin/main" ;;
  esac
  base_branch="${base_ref#origin/}"
  # The local remote-tracking ref is not the live tip. Fetch immediately
  # before the compare, or a stale origin/<base> matches a verdict that was
  # also recorded against that stale ref.
  if ! git fetch --no-tags origin "$base_branch" >/dev/null 2>&1; then
    echo "refusing: could not fetch ${base_ref} before merge, so the recorded tip was not checked against the live remote. Re-run merge-gate." >&2
    exit 1
  fi
  current_main="$(git rev-parse "$base_ref" 2>/dev/null || true)"
  if [ -z "$rec_main" ] || [ "$current_main" != "$rec_main" ]; then
    echo "refusing: ${base_ref} (${current_main:-unknown}) has moved past the main tip recorded in the merge-gate verdict (${rec_main:-<none>}). Re-run merge-gate." >&2
    exit 1
  fi
  echo "✓ merge-gate verdict found for PR #$pr @ ${sha:0:9} (${base_ref} ${rec_main:0:9})"
fi

slug="${repo:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
# Print BODY with every factory-merge stamp line removed (prose kept), plus
# MARKER on its own paragraph when given. Grammar shared with the A2 reader
# (aos `factoryMergeRunOf`): a stamp is a whole line, CRLF tolerated; this
# removes every line that starts with the stamp prefix and ends with `-->`, a
# superset of what the reader accepts. Anchored per line, so a 64 KiB run of
# blanks costs one pass, not a backtracking search.
strip_stamps() {
  BODY="$1" MARKER="${2:-}" python3 -c '
import os, re
body = re.sub(r"(?m)^[ \t]*<!-- arc-factory-merge [^\n]*-->[ \t]*\r?(?:\n|$)", "", os.environ["BODY"]).rstrip()
mark = os.environ["MARKER"]
print((body + "\n\n" + mark if body else mark) if mark else body, end="")
'
}
if [ -n "$run_id" ]; then
  # Operator override (#7662): stamp first, merge second, so the GitHub sync
  # can never observe this merge without the run that executed it.
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "refusing: could not stamp factory run $run_id onto PR #$pr: head '$sha' is not a 40-char sha" >&2
    exit 1
  fi
  if ! old_body="$(gh api "repos/$slug/pulls/$pr" --jq '.body // ""')"; then
    echo "refusing: could not stamp factory run $run_id onto PR #$pr (reading the PR body failed)" >&2
    exit 1
  fi
  # Earlier stamps (a refused attempt) go; the prose stays.
  new_body="$(strip_stamps "$old_body" "<!-- arc-factory-merge run=$run_id sha=$sha -->")"
  if ! gh api --method PATCH "repos/$slug/pulls/$pr" -f body="$new_body" >/dev/null; then
    echo "refusing: could not stamp factory run $run_id onto PR #$pr; not making an agent merge nobody can attribute" >&2
    exit 1
  fi
  echo "⚠ factory run $run_id is merging PR #$pr under ARC_FACTORY_ALLOW_SELF_MERGE=1 — stamped as an agent merge"
fi
if ! gh api --method PUT "repos/$slug/pulls/$pr/merge" -f sha="$sha" -f merge_method="$method"; then
  if [ -n "$run_id" ]; then
    # A failed PUT is not proof the merge did not land (a timeout or a 5xx
    # after the commit). Only GitHub saying `merged: false` takes the stamp
    # off; merged or unknown keeps it, because removing it would record an
    # agent merge as a human one. A stamp left on an unmerged PR would mark a
    # later human merge of this head, so the restore strips every stamp from
    # the CURRENT body (a fresh read: a concurrent human edit survives).
    merged="$(gh api "repos/$slug/pulls/$pr" --jq '.merged' 2>/dev/null || true)"
    if [ "$merged" = false ] && cur_body="$(gh api "repos/$slug/pulls/$pr" --jq '.body // ""')" &&
      gh api --method PATCH "repos/$slug/pulls/$pr" -f body="$(strip_stamps "$cur_body")" >/dev/null; then
      echo "merge failed; PR #$pr is not merged, factory-merge stamp removed" >&2
    else
      echo "WARNING: the merge call failed, but PR #$pr merged=${merged:-unknown}; factory-merge stamp kept. If the PR is really unmerged, delete the arc-factory-merge line by hand." >&2
    fi
  fi
  exit 1
fi
