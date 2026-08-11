#!/usr/bin/env bash
# git-hygiene.sh — inventory (default) or apply SAFE cleanups only.
# Compatible with bash 3.2 (macOS /bin/bash).
#
# Usage:
#   git-hygiene.sh inventory [repo_path]
#   git-hygiene.sh apply [--yes] [repo_path]
#
# apply removes only SAFE worktrees/branches (ancestor of origin/<default>,
# not dirty, not locked, not current, not default). Never deletes SQUASH/KEEP.
set -euo pipefail

CMD="${1:-inventory}"
YES=0
REPO=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    *) REPO="$1"; shift ;;
  esac
done

if [ -n "$REPO" ]; then
  cd "$REPO"
else
  cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: not a git repository: $(pwd)" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

remote="${GIT_HYGIENE_REMOTE:-origin}"

default_branch() {
  local b
  b="$(git symbolic-ref -q "refs/remotes/${remote}/HEAD" 2>/dev/null | sed "s@^refs/remotes/${remote}/@@" || true)"
  if [ -n "$b" ]; then
    echo "$b"
    return
  fi
  if git show-ref --verify --quiet "refs/remotes/${remote}/main"; then
    echo main
    return
  fi
  if git show-ref --verify --quiet "refs/remotes/${remote}/master"; then
    echo master
    return
  fi
  echo main
}

DEFAULT="$(default_branch)"
OD="${remote}/${DEFAULT}"

echo "repo: $ROOT"
echo "remote: $remote  default: $DEFAULT  tracking: $OD"
echo "cmd: $CMD"
echo

if git remote get-url "$remote" >/dev/null 2>&1; then
  git fetch "$remote" --prune 2>&1 | tail -20 || true
else
  echo "WARN: remote $remote not configured; using local refs only"
fi

if ! git show-ref --verify --quiet "refs/remotes/${OD}"; then
  echo "ERROR: missing refs/remotes/${OD} — fetch failed or default branch wrong" >&2
  exit 2
fi

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
DIRTY_PRIMARY="$(git status --porcelain | wc -l | tr -d ' ')"

echo "current: $CURRENT  dirty_lines: $DIRTY_PRIMARY"
echo "origin/${DEFAULT}: $(git rev-parse --short "$OD")"
echo

echo "=== worktrees ==="
printf '%-8s %-6s %-50s %s\n' "dirty" "lock" "branch" "path"

SAFE_WT_FILE="$(mktemp)"
KEEP_WT_FILE="$(mktemp)"
SAFE_BR_FILE="$(mktemp)"
KEEP_BR_FILE="$(mktemp)"
trap 'rm -f "$SAFE_WT_FILE" "$KEEP_WT_FILE" "$SAFE_BR_FILE" "$KEEP_BR_FILE"' EXIT

while IFS= read -r line; do
  [ -z "$line" ] && continue
  path="$(echo "$line" | awk '{print $1}')"
  if echo "$line" | grep -q '\[.*\]'; then
    br="$(echo "$line" | sed -n 's/.*\[\(.*\)\].*/\1/p')"
  else
    br="HEAD"
  fi
  locked=0
  echo "$line" | grep -qi locked && locked=1
  d=0
  if [ -d "$path" ]; then
    d="$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  fi
  printf '%-8s %-6s %-50s %s\n' "$d" "$locked" "$br" "$path"

  # classify worktree (skip primary)
  if [ "$path" = "$ROOT" ]; then
    continue
  fi
  if [ "$d" != "0" ] || [ "$locked" = "1" ]; then
    echo "$path|$br|dirty=$d locked=$locked" >>"$KEEP_WT_FILE"
    continue
  fi
  case "$path" in
    /tmp/*|/private/tmp/*)
      if [ "$br" = "HEAD" ]; then
        echo "$path|$br|detached-tmp" >>"$SAFE_WT_FILE"
        continue
      fi
      ;;
  esac
  # branch classification deferred after SAFE_BR list; mark pending
  echo "$path|$br|pending" >>"$KEEP_WT_FILE.tmp" 2>/dev/null || true
  echo "$path|$br" >>"${KEEP_WT_FILE}.pending"
done < <(git worktree list)

# --- classify local branches ---
while IFS= read -r br; do
  [ -z "$br" ] && continue
  [ "$br" = "$DEFAULT" ] && continue
  if git merge-base --is-ancestor "$br" "$OD" 2>/dev/null; then
    echo "$br" >>"$SAFE_BR_FILE"
  else
    n="$(git rev-list --count "$OD..$br" 2>/dev/null || echo "?")"
    echo "$br	ahead=$n" >>"$KEEP_BR_FILE"
  fi
done < <(git branch --format='%(refname:short)')

echo
echo "=== SAFE branches (ancestor of ${OD}) ==="
if [ ! -s "$SAFE_BR_FILE" ]; then
  echo "(none)"
else
  cat "$SAFE_BR_FILE"
fi
echo
echo "=== KEEP branches (commits not on ${OD}) ==="
if [ ! -s "$KEEP_BR_FILE" ]; then
  echo "(none)"
else
  cat "$KEEP_BR_FILE"
fi
echo

# Re-classify pending worktrees using SAFE branch list
: >"$KEEP_WT_FILE"
: >"$SAFE_WT_FILE"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  path="$(echo "$line" | awk '{print $1}')"
  if echo "$line" | grep -q '\[.*\]'; then
    br="$(echo "$line" | sed -n 's/.*\[\(.*\)\].*/\1/p')"
  else
    br="HEAD"
  fi
  locked=0
  echo "$line" | grep -qi locked && locked=1
  d=0
  if [ -d "$path" ]; then
    d="$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  fi
  [ "$path" = "$ROOT" ] && continue

  if [ "$d" != "0" ] || [ "$locked" = "1" ]; then
    echo "$path|$br|dirty=$d locked=$locked" >>"$KEEP_WT_FILE"
    continue
  fi
  if [ "$br" = "HEAD" ]; then
    case "$path" in
      /tmp/*|/private/tmp/*)
        echo "$path|$br|detached-tmp" >>"$SAFE_WT_FILE"
        ;;
      *)
        echo "$path|$br|detached" >>"$KEEP_WT_FILE"
        ;;
    esac
    continue
  fi
  if grep -qxF "$br" "$SAFE_BR_FILE" 2>/dev/null; then
    echo "$path|$br|merged-branch" >>"$SAFE_WT_FILE"
  else
    echo "$path|$br|unmerged" >>"$KEEP_WT_FILE"
  fi
done < <(git worktree list)

echo "=== SAFE worktrees (eligible for remove) ==="
if [ ! -s "$SAFE_WT_FILE" ]; then
  echo "(none)"
else
  cat "$SAFE_WT_FILE"
fi
echo
echo "=== KEEP worktrees ==="
if [ ! -s "$KEEP_WT_FILE" ]; then
  echo "(none)"
else
  cat "$KEEP_WT_FILE"
fi
echo
echo "NOTE: SQUASH-merged branches often appear under KEEP (not ancestors)."
echo "      Agent must verify PR MERGED + path parity before branch -D (SKILL.md §4)."
echo

if [ "$CMD" = "inventory" ]; then
  echo "Done inventory. Review KEEP; then: $0 apply --yes [repo]"
  exit 0
fi

if [ "$CMD" != "apply" ]; then
  echo "Unknown command: $CMD (use inventory|apply)" >&2
  exit 2
fi

if [ "$DIRTY_PRIMARY" != "0" ]; then
  echo "ERROR: primary worktree is dirty — commit/stash first" >&2
  exit 1
fi

if [ "$(git rev-parse --abbrev-ref HEAD)" != "$DEFAULT" ]; then
  echo "Checking out $DEFAULT …"
  git checkout "$DEFAULT"
fi
git pull --ff-only "$remote" "$DEFAULT" || {
  echo "ERROR: pull --ff-only failed" >&2
  exit 1
}

if [ "$YES" != "1" ]; then
  echo "Dry-run apply. Re-run with --yes to remove SAFE items."
  echo "Would remove worktrees:"
  sed 's/^/  /' "$SAFE_WT_FILE" 2>/dev/null || true
  echo "Would delete branches:"
  sed 's/^/  /' "$SAFE_BR_FILE" 2>/dev/null || true
  exit 0
fi

while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  path="${entry%%|*}"
  echo "worktree remove: $path"
  git worktree remove --force "$path" || echo "WARN: failed remove $path"
done <"$SAFE_WT_FILE"

while IFS= read -r br; do
  [ -z "$br" ] && continue
  [ "$br" = "$DEFAULT" ] && continue
  if git worktree list | grep -q "\[${br}\]"; then
    echo "SKIP branch still checked out: $br"
    continue
  fi
  echo "branch -d: $br"
  git branch -d "$br" || echo "WARN: could not delete $br"
done <"$SAFE_BR_FILE"

git worktree prune 2>/dev/null || true

echo
echo "=== apply done ==="
echo "remaining worktrees:"
git worktree list
echo "remaining unmerged branches:"
git branch --no-merged "$OD" || true
