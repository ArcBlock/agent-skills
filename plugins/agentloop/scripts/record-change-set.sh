#!/usr/bin/env bash
# Record the current PR head on the repo's work ledger as a Change Set
# (ArcBlock/arc#6920, C1 of epic #6900). Run it after `gh pr create` and after
# EVERY push to the PR branch (fixes, rebases, merges of main).
#
#   bash <plugin_root>/scripts/record-change-set.sh --entry "<change_set_record_entry>" \
#     [--pr <url>] [--work <member work DID>]
#
# Generic by construction: the ledger command comes from the repo profile key
# `change_set_record_entry` (arc: `arc work changeset record --skip-outside-run`).
# A repo with no work ledger declares `none`; an empty / missing key or an
# unsubstituted placeholder is read the same way. Each prints an explicit
# "not recorded" line and succeeds. This script only gathers git/GitHub facts:
#
#   --pr     the PR URL (default: the current branch's PR, via gh)
#   --head   local HEAD. It must be the PR head GitHub reports; GitHub can lag a
#            push by seconds, so this waits (bounded) before refusing.
#   --base   the PR's base oid (gh baseRefOid), fetched if it is not local.
#   files    `git diff --no-renames --name-only <base>...<head>` (three-dot: the
#            PR's own changes; a rename is its two paths), one per line, handed
#            over as a temp file (`--files-from <path>`: a separated `--files-from -`
#            is read by yargs as a stray positional, found on #7072).
#   --work   passed through: an epic run names the member work it serves.
#
# A failing ledger entry is retried a bounded number of times (transient store
# refusals, e.g. arc#6982), then exits non-zero with a STOP line on stderr: the
# skill must not continue as if the ledger had the Change Set.
#
# Rollout-order preflight (arc#7081): shipping the agentloop side of a ledger
# command ahead of the host `arc` build that implements it must not stop every
# land / epic-conductor run on every host that has not yet upgraded. Before
# ever invoking the entry for real, this probes whether the entry's OWN
# subcommand path is known to the installed binary, by asking it directly
# rather than guessing from a version number. The probe drops the entry's
# last positional token (its action verb — `record` in
# `arc work changeset record --skip-outside-run`), giving e.g.
# `arc work changeset`, and runs THAT bare (no --help — see the independent
# review's F1/F2 below for why). Two outcomes, kept apart precisely:
#   - the binary itself says the subcommand is unknown (its own "Unknown
#     command" verdict, AND a non-zero exit — a daemon-down or bad-args
#     failure is also non-zero, and text alone is not enough either, see F3
#     below) -> N/A, print and exit 0, never touch the ledger;
#   - anything else (subcommand recognized, or the probe itself failed for an
#     unrelated reason such as the binary being entirely missing) -> fall
#     through unchanged to the fail-closed path below. A missing binary is
#     NOT treated as N/A: this script's existing policy already fails closed
#     on that (command-not-found inside the retry loop), and the preflight
#     must not soften it.
# Too few positional tokens to form a meaningful probe (fewer than 3: no verb
# to drop, or no subcommand segment left after dropping it) skips the
# preflight entirely.
#
# Two fixes from PR #7143's first (Codex) review round, both reproduced
# against the real binary before landing:
#   - a leading global option of the entry's own binary (e.g. `arc --instance
#     x work changeset record ...` — verified: arc accepts its global options
#     before the subcommand path exactly the same as after it, both
#     space-separated and --opt=value) used to end positional-token
#     collection immediately, dropping the preflight to 1 token and silently
#     falling through to the full fail-closed path on an old arc. A small,
#     explicit table of arc's own known global options (value-taking vs
#     boolean) is skipped when it appears BEFORE any positional token has
#     been collected yet. An option NOT in this table still ends the scan
#     there (the safe default: skip the preflight rather than guess an
#     unknown option's arity and risk corrupting the probe path into
#     misreading a perfectly capable new arc as N/A — the opposite, worse
#     failure mode).
#   - the version text read for the N/A message is diagnostic only; under
#     `set -e` a failing `--version` (plausible on an old binary) used to
#     abort the whole script with THAT exit code before ever printing the N/A
#     line, turning the one path that must always succeed back into a stop.
#
# F1/F2/F3/F4 from PR #7143's SECOND (independent) review round — F1 is the
# one that mattered, a real correctness bug on the host #7081 actually names:
#   - F1 (blocking): on arc 2.0.0-beta.48-50 (predates #6384, commit
#     9152d07ea / first released in v2.0.0-beta.51), `arc work changeset
#     --help` prints the ROOT help and exits 0 — reproduced end-to-end
#     against the real installed `~/.arc/current/arc` @ beta.48. A probe using
#     --help reads that as "recognized" and the run still ends in STOP on
#     exactly the host this issue is about.
#   - F2 (the fix): probe the bare path, no --help, as above. Measured on
#     three real builds: beta.48 -> rc 5 `Unknown command: "work"`; pre-#7072
#     main -> rc 5 `Unknown command: "work changeset"`; current -> rc 5
#     `Not enough non-option arguments` (no "unknown command" — the required
#     `action` positional is missing). The bare path is safe on all three: a
#     validation failure, not a side-effecting command.
#   - F3: the rc half of the "rc!=0 AND text says unknown command" conjunction
#     needs its own accept-path twin (a probe that exits 0 while its own text
#     still contains "Unknown command" must NOT be read as N/A), otherwise a
#     mutation that drops the rc check and greps alone passes every test.
#   - F4: the entry's leading global option may also be written --opt=value
#     (one token, not two) — also verified against the real binary.
#
# Tunables (tests use them; defaults are the production values):
#   RECORD_CS_HEAD_WAIT_S=30  RECORD_CS_POLL_S=3  RECORD_CS_ATTEMPTS=3  RECORD_CS_RETRY_SLEEP_S=5
set -euo pipefail

usage() {
  echo "usage: $0 --entry \"<change_set_record_entry>\" [--pr <PR URL>] [--work <member work DID>]" >&2
  exit 64
}

entry=""; pr=""; work=""
while [ $# -gt 0 ]; do
  case "$1" in
    --entry) entry="${2:-}"; shift 2 ;;
    --pr) pr="${2:-}"; shift 2 ;;
    --work) work="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

case "$entry" in
  none) echo "Change Set: not recorded — this repo has no work ledger (change_set_record_entry: none)"; exit 0 ;;
  ""|"<change_set_record_entry>")
    echo "Change Set: not recorded — repo has no ledger entry (change_set_record_entry missing or empty in the repo profile)"
    exit 0 ;;
esac

read -r -a entry_cmd <<<"$entry"

# Preflight (arc#7081): does the installed binary's own subcommand tree
# recognize the entry's path, before we do any GitHub work?
#
# arc's own known global options (verified against the real binary's --help),
# recognized ONLY when they appear before any positional token has been
# collected yet — an option not in this table still ends the scan there
# (safe default: skip the preflight rather than misread an unknown option's
# arity, arc#7081 Codex finding 2).
ARC_GLOBAL_BOOL_OPTS=(--standalone --json)
ARC_GLOBAL_VALUE_OPTS=(-i --instance --home --view)
positional=()
i=0
n_tok="${#entry_cmd[@]}"
while [ "$i" -lt "$n_tok" ]; do
  tok="${entry_cmd[$i]}"
  case "$tok" in
    -*)
      # The binary name itself is always positional[0] (collected before we
      # can ever see a flag), so "only the bin collected so far" is length 1
      # — not 0 — for "this flag sits between the binary and the subcommand
      # path".
      if [ "${#positional[@]}" -eq 1 ]; then
        matched=0
        for b in "${ARC_GLOBAL_BOOL_OPTS[@]}"; do
          [ "$tok" = "$b" ] && { matched=1; break; }
        done
        if [ "$matched" -eq 1 ]; then i=$((i + 1)); continue; fi
        for v in "${ARC_GLOBAL_VALUE_OPTS[@]}"; do
          [ "$tok" = "$v" ] && { matched=1; i=$((i + 2)); break; }
          # arc#7081 F4: the --opt=value form (verified against the real
          # binary) is ONE token — consume just it, not a second one.
          case "$tok" in
            "$v"=*) matched=1; i=$((i + 1)); break ;;
          esac
        done
        if [ "$matched" -eq 1 ]; then continue; fi
      fi
      break
      ;;
    *) positional+=("$tok"); i=$((i + 1)) ;;
  esac
done
if [ "${#positional[@]}" -ge 3 ]; then
  bin="${positional[0]}"
  verb_path=("${positional[@]:0:$((${#positional[@]} - 1))}")
  set +e
  probe_out="$("${verb_path[@]}" 2>&1)"
  probe_rc=$?
  set -e
  if [ "$probe_rc" -ne 0 ] && printf '%s' "$probe_out" | grep -qi "unknown command"; then
    set +e
    version="$("$bin" --version 2>&1 | head -1)"
    version_rc=$?
    set -e
    if [ "$version_rc" -ne 0 ] || [ -z "$version" ]; then
      version="unknown version"
    fi
    subcmd="${verb_path[*]:1}"
    echo "Change Set: not recorded (N/A: $bin $version lacks $subcmd)"
    exit 0
  fi
fi

wait_s="${RECORD_CS_HEAD_WAIT_S:-30}"
poll_s="${RECORD_CS_POLL_S:-3}"
attempts="${RECORD_CS_ATTEMPTS:-3}"
retry_sleep="${RECORD_CS_RETRY_SLEEP_S:-5}"

if [ -z "$pr" ]; then
  pr="$(gh pr view --json url -q .url)"
fi
[ -n "$pr" ] || { echo "record-change-set: no PR for the current branch; pass --pr" >&2; exit 1; }

head="$(git rev-parse HEAD)"
# GitHub can report the previous head for a few seconds after a push.
deadline=$(( $(date +%s) + ${wait_s%.*} ))
while :; do
  pr_head="$(gh pr view "$pr" --json headRefOid -q .headRefOid)"
  [ "$pr_head" = "$head" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "record-change-set: local HEAD $head is not the PR head $pr_head on GitHub (waited ${wait_s}s) — push first, then record" >&2
    exit 1
  fi
  sleep "$poll_s"
done

base="$(gh pr view "$pr" --json baseRefOid -q .baseRefOid)"
[ -n "$base" ] || { echo "record-change-set: gh reported no baseRefOid for $pr" >&2; exit 1; }
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  base_ref="$(gh pr view "$pr" --json baseRefName -q .baseRefName)"
  git fetch -q origin "$base_ref" 2>/dev/null || true
  if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
    echo "CHANGE SET NOT RECORDED: cannot fetch the PR base $base (origin/$base_ref) — stop" >&2
    exit 1
  fi
fi

files="$(mktemp)"
trap 'rm -f "$files"' EXIT
if ! git -c core.quotePath=false diff --no-renames --name-only "$base...$head" > "$files"; then
  echo "CHANGE SET NOT RECORDED: git diff $base...$head failed — stop" >&2
  exit 1
fi

extra=()
[ -n "$work" ] && extra=(--work "$work")
rc=0
for ((i = 1; i <= attempts; i++)); do
  set +e
  "${entry_cmd[@]}" --pr "$pr" --head "$head" --base "$base" --files-from "$files" ${extra[@]+"${extra[@]}"}
  rc=$?
  set -e
  [ "$rc" -eq 0 ] && exit 0
  if [ "$i" -lt "$attempts" ]; then
    echo "record-change-set: ledger entry exited $rc (attempt $i/$attempts); retrying in ${retry_sleep}s" >&2
    sleep "$retry_sleep"
  fi
done
echo "CHANGE SET NOT RECORDED (exit $rc after $attempts attempts) for $pr @ $head — stop: do not continue as if the work ledger had it" >&2
exit "$rc"
