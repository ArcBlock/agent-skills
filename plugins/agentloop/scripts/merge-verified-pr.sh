#!/usr/bin/env bash
# Merge an already-gated PR without asking gh to check out the default branch.
# Safe in linked worktrees: GitHub atomically rejects a stale head SHA.
set -euo pipefail

usage() { echo "usage: $0 <pr-number> [--repo OWNER/REPO] [--method squash|merge|rebase]" >&2; exit 64; }
pr="${1:-}"; [ -n "$pr" ] || usage; shift
repo=""; method="squash"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --method) method="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
case "$method" in squash|merge|rebase) ;; *) usage ;; esac
args=(pr view "$pr" --json headRefOid,state,mergeable --jq '.headRefOid + "\t" + .state + "\t" + .mergeable')
[ -n "$repo" ] && args+=(--repo "$repo")
IFS=$'\t' read -r sha state mergeable <<<"$(gh "${args[@]}")"
[ "$state" = "OPEN" ] || { echo "refusing: PR #$pr is $state" >&2; exit 1; }
[ "$mergeable" = "MERGEABLE" ] || { echo "refusing: PR #$pr merge state is $mergeable" >&2; exit 1; }
endpoint="repos/${repo:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}/pulls/$pr/merge"
gh api --method PUT "$endpoint" -f sha="$sha" -f merge_method="$method"
