#!/usr/bin/env bash
# Merge a PR, pinned to the head sha this script reads, without asking gh to
# check out the default branch. Safe in linked worktrees: GitHub atomically
# rejects a stale head SHA. The PR must be OPEN and MERGEABLE.
#
# Nothing else is required here (arc#7729): the author runs the changed
# package's tests and gets one clean-context review; nightly on the default
# branch is the catch-net. What this script still owns is the factory-run contract below.
#
# Factory runs (arc#7662): inside a code-agents run (`ARC_CODE_AGENT_RUN_ID`
# set) merge authority is HUMAN. land / epic-conductor stop at ready-to-merge,
# and this script refuses (exit 3, before any GitHub call), so the skills'
# entry does not rest on the model reading the rule. Operator override:
# `ARC_FACTORY_ALLOW_SELF_MERGE=1` (exactly `1`, default off) in the run's
# environment.
#
# Factory merge check (arc#7729): when the repo profile declares
# `factory_merge_check_entry` (arc: `arc -i factory work merge-check`), it runs
# before the merge with `--pr <url> --head <sha> --json`. A factory PR merges
# only when its latest Change Set round is independently approved and its
# producer run is path-compliant at that head (the factory's Gates 6 and 7);
# a PR with no Change Set passes as not the factory's. A refusal always stops
# the merge, and so does any failure once the factory answered. Only when
# there is no factory to ask (no `arc`, an `arc` too old to have the check,
# no factory instance, or no daemon: a cloud runner, another machine) may
# the caller assert `--not-factory "<why>"`, never for a `factory/*` branch.
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
# takes the stamp off only when GitHub says the PR is not merged. Neither
# PATCH overwrites a description a person edited after the script read it: the
# body is re-read just before each PATCH and a change refuses (named reason);
# bodies are compared and rebuilt byte-exact, trailing newlines included.
set -euo pipefail

usage() {
  echo "usage: $0 <pr-number> [--repo OWNER/REPO] [--method squash|merge|rebase] [--not-factory <why>]" >&2
  exit 64
}
pr="${1:-}"; [ -n "$pr" ] || usage; shift
# It lands in API paths and the PR-body stamp: a positive integer, nothing else.
[[ "$pr" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "refusing: '$pr' is not a PR number" >&2; exit 64; }
repo=""; method="squash"; not_factory=""
while [ $# -gt 0 ]; do
  case "$1" in
    --not-factory) [ $# -ge 2 ] && [ -n "$2" ] || usage; not_factory="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || usage; repo="$2"; shift 2 ;;
    --method) [ $# -ge 2 ] || usage; method="$2"; shift 2 ;;
    *) usage ;;
  esac
done
case "$method" in squash|merge|rebase) ;; *) usage ;; esac

run_id="${ARC_CODE_AGENT_RUN_ID:-}"
if [ -n "$run_id" ]; then
  if [ "${ARC_FACTORY_ALLOW_SELF_MERGE:-}" != 1 ]; then
    cat >&2 <<EOF
refusing: factory run $run_id: merge authority is human (arc#7662).
  Stop at ready-to-merge: leave the PR with its test and review evidence posted
  and report "ready to merge, human decision". A person merges.
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
args=(pr view "$pr" --json headRefOid,state,mergeable,url,headRefName,baseRefOid --jq '.headRefOid + "\t" + .state + "\t" + .mergeable + "\t" + .url + "\t" + .headRefName + "\t" + .baseRefOid')
[ -n "$repo" ] && args+=(--repo "$repo")
IFS=$'\t' read -r sha state mergeable pr_url head_ref base_sha <<<"$(gh "${args[@]}")"
[ "$state" = "OPEN" ] || { echo "refusing: PR #$pr is $state" >&2; exit 1; }
[ "$mergeable" = "MERGEABLE" ] || { echo "refusing: PR #$pr merge state is $mergeable" >&2; exit 1; }

# Factory merge check (arc#7729). The profile is read from the DEFAULT
# BRANCH, never from the PR's own working tree: a PR that deleted the key
# would otherwise switch off its own check. AGENTLOOP_REPO_PROFILE names
# another profile file (tests point it at their own).
profile_text=""
if [ -n "${AGENTLOOP_REPO_PROFILE:-}" ]; then
  [ -f "$AGENTLOOP_REPO_PROFILE" ] && profile_text="$(cat "$AGENTLOOP_REPO_PROFILE")"
else
  for ref in origin/HEAD origin/main origin/master; do
    if profile_text="$(git show "$ref:.claude/repo-profile.md" 2>/dev/null)"; then break; fi
    profile_text=""
  done
fi
check_entry="$(printf '%s\n' "$profile_text" | python3 -c '
import re, sys
for line in sys.stdin:
    m = re.match(r"\|\s*`factory_merge_check_entry`\s*\|\s*`([^`]+)`", line)
    if m:
        print(m.group(1)); break
')"
if [ -z "$check_entry" ]; then
  echo "note: no factory_merge_check_entry in the default branch's repo profile; no factory merge check for PR #$pr"
else
  read -r -a check_cmd <<<"$check_entry"
  # "No factory to ask" is: no arc (127), an arc too old to have the check
  # (its --help fails), no factory instance on this machine, or no daemon (6).
  no_factory=0
  set +e
  if ! "${check_cmd[@]}" --help >/dev/null 2>&1; then
    no_factory=1; check_rc=127
    check_out="this machine's arc cannot run: ${check_entry} (missing, or too old to have it)"
  else
    check_out="$("${check_cmd[@]}" --pr "$pr_url" --head "$sha" --head-ref "$head_ref" --base-sha "$base_sha" --json 2>&1)"
    check_rc=$?
    if [ "$check_rc" -eq 6 ] || [ "$check_rc" -eq 127 ]; then no_factory=1; fi
    if [ "$check_rc" -eq 1 ] && printf '%s' "$check_out" | grep -q 'no instance named'; then no_factory=1; fi
  fi
  set -e
  # The first JSON object anywhere in the output, decoded exactly.
  check_kind="$(printf '%s' "$check_out" | python3 -c '
import json, sys
text = sys.stdin.read()
dec = json.JSONDecoder()
i = text.find("{")
while i >= 0:
    try:
        obj, _ = dec.raw_decode(text, i)
        print(obj.get("kind", "") if isinstance(obj, dict) else "")
        break
    except ValueError:
        i = text.find("{", i + 1)
')"
  if [ "$check_rc" -eq 0 ] && { [ "$check_kind" = ok ] || [ "$check_kind" = not-factory ]; }; then
    echo "factory merge check: $check_kind"
  elif [ "$no_factory" -eq 0 ]; then
    # Reached the factory (or failed in a way that is not "no factory here"):
    # refused, and no assertion lifts it.
    echo "refusing: the factory merge check did not pass PR #$pr at $sha (exit $check_rc):" >&2
    printf '%s\n' "$check_out" | tail -8 >&2
    exit 1
  elif [ -n "$not_factory" ] && [[ "$head_ref" != factory/* ]]; then
    echo "⚠ no factory to ask (exit $check_rc); merging on the caller's assertion: not a factory PR — $not_factory"
  else
    echo "refusing: no factory daemon / arc to run the merge check (exit $check_rc) for PR #$pr ($head_ref):" >&2
    printf '%s\n' "$check_out" | tail -5 >&2
    echo "  Start the factory instance, or, for a PR no factory run produced, pass --not-factory \"<why>\" (refused for factory/* branches)." >&2
    exit 1
  fi
fi

slug="${repo:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
# Every body below is handled BYTE-EXACT (Codex P2 on #7722): `$( … )` strips
# trailing newlines, so a comparison of two captures misses an edit that only
# adds or removes them, and a PATCH built from a capture drops them. Captures
# carry a sentinel `x`; gh prints a raw string plus exactly one newline.
#
# stamped_body <var> <body> [marker]: BODY with every factory-merge stamp line
# removed (prose kept byte-exact), plus MARKER after a blank line when given.
# Grammar shared with the A2 reader (aos `factoryMergeRunOf`): a stamp is a
# whole line, CRLF tolerated; this removes every line that starts with the
# stamp prefix and ends with `-->`, a superset of what the reader accepts. A
# trailing stamp goes with the blank line this script put before it, so a
# restore gives back the body as it was. Line-by-line string tests: a 64 KiB
# run of blanks costs one pass, not a backtracking search.
stamped_body() {
  local out
  out="$(BODY="$2" MARKER="${3:-}" python3 -c '
import os, sys
body, mark = os.environ["BODY"], os.environ["MARKER"]
def stamp(line):
    s = line.rstrip("\r").strip(" \t")
    return s.startswith("<!-- arc-factory-merge ") and s.endswith("-->")
lines = body.split("\n")
trailing = False
while lines and stamp(lines[-1]):
    lines.pop()
    trailing = True
if trailing and len(lines) >= 2 and lines[-1] == "":
    lines.pop()
body = "\n".join(line for line in lines if not stamp(line))
sys.stdout.write((body + "\n\n" + mark if body else mark) if mark else body)
' && printf x)" || return 1
  printf -v "$1" '%s' "${out%x}"
}
# read_body <var>: the PR body, byte-exact.
read_body() {
  local raw
  raw="$(gh api "repos/$slug/pulls/$pr" --jq '.body // ""' && printf x)" || return 1
  raw="${raw%x}"
  printf -v "$1" '%s' "${raw%$'\n'}"
}
# GitHub's update-PR endpoint has no conditional write (no If-Match), so a
# PATCH computed from an earlier read would overwrite a person's edit made in
# between (Codex P2 on #7685). Each PATCH below re-reads the body immediately
# before writing and refuses when it is no longer, byte for byte, the body the
# new one was computed from. That narrows the window to one round trip; it
# cannot close it.
body_unchanged() { # body_unchanged <body the PATCH was computed from>
  local now
  read_body now || return 1
  [ "$now" = "$1" ]
}
if [ -n "$run_id" ]; then
  # Operator override (#7662): stamp first, merge second, so the GitHub sync
  # can never observe this merge without the run that executed it.
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "refusing: could not stamp factory run $run_id onto PR #$pr: head '$sha' is not a 40-char sha" >&2
    exit 1
  fi
  if ! read_body old_body; then
    echo "refusing: could not stamp factory run $run_id onto PR #$pr (reading the PR body failed)" >&2
    exit 1
  fi
  # Earlier stamps (a refused attempt) go; the prose stays.
  if ! stamped_body new_body "$old_body" "<!-- arc-factory-merge run=$run_id sha=$sha -->"; then
    echo "refusing: could not stamp factory run $run_id onto PR #$pr (building the stamped body failed)" >&2
    exit 1
  fi
  if ! body_unchanged "$old_body"; then
    echo "refusing: could not stamp factory run $run_id onto PR #$pr: the PR body changed since it was read (or the re-read failed); not overwriting a concurrent edit. Re-run to stamp the current body." >&2
    exit 1
  fi
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
    # the CURRENT body (a fresh read, re-checked just before the PATCH: a
    # concurrent human edit is never overwritten).
    merged="$(gh api "repos/$slug/pulls/$pr" --jq '.merged' 2>/dev/null || true)"
    restore=""
    if [ "$merged" = false ] && read_body cur_body && stamped_body restored "$cur_body"; then
      if body_unchanged "$cur_body"; then
        gh api --method PATCH "repos/$slug/pulls/$pr" -f body="$restored" >/dev/null && restore=done
      else
        restore=changed
      fi
    fi
    case "$restore" in
      done) echo "merge failed; PR #$pr is not merged, factory-merge stamp removed" >&2 ;;
      changed)
        echo "WARNING: the merge call failed and PR #$pr is not merged, but the PR body changed since it was read (or the re-read failed); factory-merge stamp kept rather than overwrite that edit. Delete the arc-factory-merge line by hand." >&2 ;;
      *)
        echo "WARNING: the merge call failed, but PR #$pr merged=${merged:-unknown}; factory-merge stamp kept. If the PR is really unmerged, delete the arc-factory-merge line by hand." >&2 ;;
    esac
  fi
  exit 1
fi
