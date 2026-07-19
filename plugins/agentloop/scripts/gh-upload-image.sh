#!/usr/bin/env bash
# gh-upload-image.sh — upload an image/asset to the shared company asset repo
# (ArcBlock/loop-agent-assets, PUBLIC) and print its permanently embeddable raw URL.
#
# UNIVERSAL: ships WITH THE PLUGIN (#1037), works in ANY consuming repo with no per-repo
# setup — it auto-detects the SOURCE_REPO from `git remote get-url origin`, so arc, did,
# arcblock-site … each get their assets filed under their own slug. A repo references it as
# `<plugin_root>/scripts/gh-upload-image.sh` (its `ui_upload_script` profile key); the copy
# a repo keeps at `scripts/gh-upload-image.sh`, if any, is a thin delegator to this one.
#
# Single-track storage (issue #949, unified after #1039's dual-track):
# ALL environments store assets in the dedicated public repo — `gh` environments via this
# script (contents API), cloud routines via MCP create_or_update_file (Path B in the calling
# skills). Same layout either way, so URLs never depend on which environment produced them.
#
# Why a dedicated PUBLIC repo (not release assets / a source-repo branch):
#   - cloud routine proxies block ALL GitHub release-write endpoints by session type
#     (#949 measurements); MCP file commits are the only write channel there.
#   - The repo must stay PUBLIC: private-repo raw URLs cannot be rendered anonymously by
#     GitHub camo, so embedded images would break.
#   - A dedicated repo cannot be merged/deleted by PR automation (the old image-hosting
#     branch died exactly that way, #907).
#
# Layout (must match the calling skills' Path B and the assets repo README):
#   {source-repo-slug}/{context}/{filename}     e.g. arc/pr123/20260705-120000-shot.png
#   {source-repo-slug}/{context}/index.md       appended row per asset (reverse lookup)
#
# Usage:
#   <plugin_root>/scripts/gh-upload-image.sh <image-file> [<output-filename>]
#
# Output (stdout): permanent jsdelivr CDN URL, e.g.
#   https://cdn.jsdelivr.net/gh/ArcBlock/loop-agent-assets@main/arc/pr123/20260705-120000-shot.png
#
# Environment variables:
#   ASSETS_REPO    asset repo slug,                default: ArcBlock/loop-agent-assets (shared)
#   SOURCE_REPO    repo the asset belongs to,      default: auto-detected from git remote origin
#   ASSET_CONTEXT  pr<N> | ts-<TS> | issue-<N> | slug, default: misc
#   SOURCE_URL     backlink for the index row,     default derived from ASSET_CONTEXT
#   UPLOADER       identity for the index row,     default: <whoami>@<hostname>
#
# Requires: gh CLI (authenticated, write access to ASSETS_REPO) + jq.
# In cloud routines gh is absent, or present but unauthenticated (some session types inject an
# invalid GH_TOKEN placeholder — issue #1416) — exit 2 either way so callers fall back to the
# MCP path instead of failing deeper with a confusing API error.
#
# Exit codes:
#   0  uploaded; stdout = raw URL, verified anonymously reachable (HTTP 200)
#   2  gh CLI absent or not authenticated (caller falls back to the MCP path)
#   3  freshness guard: this script differs from its repo's origin/main (stale checkout —
#      the #915/#996 broken-image root cause); sync or ALLOW_STALE_UPLOADER=1
#   4  uploaded but the raw URL is NOT anonymously reachable — do not embed

set -euo pipefail

IMAGE="${1:?Usage: $0 <image-file> [output-filename]}"
CUSTOM_NAME="${2:-}"
ASSETS_REPO="${ASSETS_REPO:-ArcBlock/loop-agent-assets}"
# SOURCE_REPO: default to the CALLING repo (cwd's git remote), so assets file under the right
# slug in any repo — the one arc-specific default this script used to hardcode.
SOURCE_REPO="${SOURCE_REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#/$##; s#.*[:/]([^/]+/[^/]+)$#\1#')}"
SOURCE_REPO="${SOURCE_REPO:-unknown/repo}"
ASSET_CONTEXT="${ASSET_CONTEXT:-misc}"

command -v gh >/dev/null 2>&1 || { echo >&2 "gh-absent"; exit 2; }
gh auth status >/dev/null 2>&1 || { echo >&2 "gh-unauthenticated"; exit 2; }
command -v jq >/dev/null 2>&1 || { echo >&2 "error: jq is required"; exit 1; }
[[ -f "$IMAGE" ]] || { echo >&2 "error: file not found: $IMAGE"; exit 1; }

# ── Freshness guard (exit 3) ──
# Root cause of the #915/#996 broken-image incident: a stale checkout ran the pre-#1046 version
# of this script, which uploaded to the deprecated (private, camo-unreachable) Release CDN.
# Outward writes must follow the CURRENT origin/main contract, so refuse to run when this file
# differs from it (this now tracks the PLUGIN's repo — kept fresh via `claude plugin update`).
# Override for local development of this script: ALLOW_STALE_UPLOADER=1.
SCRIPT_ABS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
if [[ "${ALLOW_STALE_UPLOADER:-}" != "1" ]] \
   && REPO_ROOT=$(git -C "$(dirname "$SCRIPT_ABS")" rev-parse --show-toplevel 2>/dev/null); then
  REL_PATH="${SCRIPT_ABS#"$REPO_ROOT"/}"
  git -C "$REPO_ROOT" fetch -q origin main 2>/dev/null \
    || echo >&2 "warn: could not fetch origin/main; freshness check may compare against a stale ref"
  if UPSTREAM_HASH=$(git -C "$REPO_ROOT" rev-parse "origin/main:${REL_PATH}" 2>/dev/null); then
    LOCAL_HASH=$(git -C "$REPO_ROOT" hash-object "$SCRIPT_ABS")
    if [[ "$LOCAL_HASH" != "$UPSTREAM_HASH" ]]; then
      echo >&2 "error: ${REL_PATH} differs from origin/main — stale or locally modified uploader."
      echo >&2 "  Sync it first:  git checkout origin/main -- ${REL_PATH}"
      echo >&2 "  Developing this script? Re-run with ALLOW_STALE_UPLOADER=1."
      exit 3
    fi
  fi
fi

# Unique filename; timestamp prefix prevents collisions and enforces append-only history
if [[ -n "$CUSTOM_NAME" ]]; then
  FILENAME="$CUSTOM_NAME"
else
  FILENAME="$(date -u +%Y%m%d-%H%M%S)-$(basename "$IMAGE")"
fi

SLUG="${SOURCE_REPO##*/}"
DIR="${SLUG}/${ASSET_CONTEXT}"
ASSET_PATH="${DIR}/${FILENAME}"

case "$ASSET_CONTEXT" in
  pr[0-9]*)  DEFAULT_URL="https://github.com/${SOURCE_REPO}/pull/${ASSET_CONTEXT#pr}" ;;
  issue-*)   DEFAULT_URL="https://github.com/${SOURCE_REPO}/issues/${ASSET_CONTEXT#issue-}" ;;
  *)         DEFAULT_URL="https://github.com/${SOURCE_REPO}" ;;
esac
SOURCE_URL="${SOURCE_URL:-$DEFAULT_URL}"
UPLOADER="${UPLOADER:-$(whoami)@$(hostname -s 2>/dev/null || echo local)}"

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# put_file <repo-path> <content-file> <commit-message> [<sha>]
# Contents API via --input file: keeps large base64 payloads off argv (ARG_MAX-safe).
put_file() {
  local path="$1" file="$2" message="$3" sha="${4:-}"
  base64 < "$file" | tr -d '\n' > "$WORKDIR/b64"
  jq -Rn --arg message "$message" --arg sha "$sha" --rawfile content "$WORKDIR/b64" \
    '{message: $message, content: $content} + (if $sha != "" then {sha: $sha} else {} end)' \
    > "$WORKDIR/payload.json"
  gh api -X PUT "repos/${ASSETS_REPO}/contents/${path}" \
    --input "$WORKDIR/payload.json" --jq '.commit.sha' >/dev/null
}

put_file "$ASSET_PATH" "$IMAGE" "assets(${DIR}): ${FILENAME}"

# Append a row to the directory's index.md (reverse lookup: asset → source).
# Read-modify-write with sha; one retry absorbs a concurrent append.
append_index() {
  local index_path="${DIR}/index.md" row sha
  row="| ${FILENAME} | ${SOURCE_URL} | $(date -u +%Y-%m-%dT%H:%M:%SZ) | ${UPLOADER} |"
  if gh api "repos/${ASSETS_REPO}/contents/${index_path}" > "$WORKDIR/index.json" 2>/dev/null; then
    sha=$(jq -r '.sha' "$WORKDIR/index.json")
    jq -r '.content' "$WORKDIR/index.json" | base64 -d > "$WORKDIR/index.md"
    printf '%s\n' "$row" >> "$WORKDIR/index.md"
  else
    sha=""
    printf '# %s\n\n| file | source | uploaded | by |\n|---|---|---|---|\n%s\n' \
      "$DIR" "$row" > "$WORKDIR/index.md"
  fi
  put_file "$index_path" "$WORKDIR/index.md" "assets(${DIR}): index ${FILENAME}" "$sha"
}
append_index || { sleep 1; append_index; }

BRANCH=$(gh api "repos/${ASSETS_REPO}" --jq '.default_branch' 2>/dev/null || echo main)
RAW_URL="https://cdn.jsdelivr.net/gh/${ASSETS_REPO}@${BRANCH}/${ASSET_PATH}"

# ── Anonymous-reachability gate (exit 4) ──
# GitHub embeds comment images through the camo proxy, which fetches the URL WITHOUT
# credentials. An upload that only works authenticated (private repo, wrong channel) renders as
# a broken image for every reader — so never print a URL that a credential-less fetch cannot
# see. Retries absorb jsdelivr CDN propagation lag after the contents-API commit.
CODE=000
for wait in 1 2 3 5 8; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$RAW_URL" || echo 000)
  [[ "$CODE" == "200" ]] && break
  sleep "$wait"
done
if [[ "$CODE" != "200" ]]; then
  echo >&2 "error: asset uploaded but NOT anonymously reachable (HTTP ${CODE}): ${RAW_URL}"
  echo >&2 "  Embedding this URL would render a broken image (camo fetches without auth)."
  exit 4
fi

echo "$RAW_URL"
