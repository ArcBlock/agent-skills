#!/usr/bin/env bash
# gh-upload-media.sh — upload one media file (image OR video) to the shared public asset repo and
# print a permanently embeddable, camo-safe raw URL. THE ONE universal uploader (issue #1037).
#
# UNIVERSAL: ships WITH THE PLUGIN, works in ANY consuming repo with no per-repo setup — it
# auto-detects SOURCE_REPO from `git remote`, so arc, did, arcblock-site … each get their assets
# filed under their own slug. A repo references it as `<plugin_root>/scripts/gh-upload-media.sh`
# (its `ui_upload_script` profile key); the copy a repo keeps at `scripts/gh-upload-media.sh`, if
# any, is a thin delegator to this one.
#
# EMBEDDING IS NOT UNIFORM — the caller must branch on kind (upload is uniform, embed is not):
#   - image/gif → inline with `![](<raw-url>)` (renders as an image / animated gif).
#   - video     → GitHub does NOT inline-play a raw.githubusercontent URL via `![]()`. Embed it as a
#                 LINK (`[▶ recording](<raw-url>)`) or a best-effort `<video src=...>` tag. Never
#                 `![](x.webm)` — it renders broken.
#
# TWO WRITE CHANNELS, auto-selected by environment; the URL it returns is identical either way:
#   A. `gh` contents API  — when `gh` is authenticated (local + most `gh` environments).
#   B. `git push`         — when `gh` is absent (cloud routines): pushes the binary into a local
#      clone of the asset repo mounted as a git source. MCP file-write is NOT used — it corrupts
#      binaries (#1079). Set ASSETS_REPO_DIR to point at the clone, else common paths are probed.
#
# It ALWAYS returns `https://raw.githubusercontent.com/<assets-repo>/main/<path>` — NOT a jsdelivr
# URL. Reason (#1334, measured): GitHub's MCP comment-writer (`add_issue_comment` / `issue_write`)
# strips `![](url)` to a plain link for EVERY host except `raw.githubusercontent.com` on `main`;
# `gh`-posted comments keep any host. So raw.githubusercontent/main is the one URL that survives
# BOTH posting channels — jsdelivr broke silently whenever a comment was posted via MCP.
#
# Layout (matches the assets-repo README):
#   {source-repo-slug}/{context}/{filename}     e.g. arc/pr123/20260705-120000-shot.png
#   {source-repo-slug}/{context}/index.md       appended row per asset (reverse lookup)
#
# Usage:
#   <plugin_root>/scripts/gh-upload-media.sh <media-file> [<output-filename>]
#
# Output (stdout): the raw URL, verified anonymously reachable AND served as real media (not text/*).
#
# Environment variables:
#   ASSETS_REPO      asset repo slug,               default: ArcBlock/loop-agent-assets (shared)
#   ASSETS_REPO_DIR  local clone for channel B,     default: probed (git-source mounts)
#   SOURCE_REPO      repo the asset belongs to,     default: auto-detected from git remote origin
#   ASSET_CONTEXT    pr<N> | ts-<TS> | issue-<N>,   default: misc
#   SOURCE_URL       backlink for the index row,    default derived from ASSET_CONTEXT
#   UPLOADER         identity for the index row,    default: <whoami>@<hostname>
#
# Requires: jq. Channel A also needs `gh` (authenticated); channel B needs a local asset-repo clone.
#
# Exit codes:
#   0  uploaded; stdout = raw URL, verified anonymously reachable + non-text content-type
#   2  neither channel usable (no `gh` AND no asset-repo clone) — caller falls back (SendUserFile)
#   3  freshness guard: this script differs from its repo's origin/main (stale — #915/#996)
#   4  uploaded but the raw URL is NOT anonymously reachable, or served as text = corrupted (#1079)

set -euo pipefail

MEDIA="${1:?Usage: $0 <media-file> [output-filename]}"
CUSTOM_NAME="${2:-}"
ASSETS_REPO="${ASSETS_REPO:-ArcBlock/loop-agent-assets}"
# SOURCE_REPO: default to the CALLING repo (cwd's git remote), so assets file under the right slug
# in any repo — the one arc-specific default the old script hardcoded (in BOTH channels).
SOURCE_REPO="${SOURCE_REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#/$##; s#.*[:/]([^/]+/[^/]+)$#\1#')}"
SOURCE_REPO="${SOURCE_REPO:-unknown/repo}"
ASSET_CONTEXT="${ASSET_CONTEXT:-misc}"

command -v jq >/dev/null 2>&1 || { echo >&2 "error: jq is required"; exit 1; }
[[ -f "$MEDIA" ]] || { echo >&2 "error: file not found: $MEDIA"; exit 1; }

# ── Freshness guard (exit 3) ──
# #915/#996: a stale checkout ran a pre-#1046 uploader that wrote to a camo-unreachable channel.
# Outward writes must follow the CURRENT origin/main contract (this tracks the PLUGIN's repo —
# kept fresh via `claude plugin update`). Override for local dev of this script: ALLOW_STALE_UPLOADER=1.
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

# Unique filename; timestamp prefix prevents collisions and enforces append-only history.
if [[ -n "$CUSTOM_NAME" ]]; then
  FILENAME="$CUSTOM_NAME"
else
  FILENAME="$(date -u +%Y%m%d-%H%M%S)-$(basename "$MEDIA")"
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
INDEX_PATH="${DIR}/index.md"
INDEX_ROW="| ${FILENAME} | ${SOURCE_URL} | $(date -u +%Y-%m-%dT%H:%M:%SZ) | ${UPLOADER} |"

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# ── Channel A: gh contents API (commits to the repo's default branch = main) ──
channel_gh() {
  # put_file <repo-path> <content-file> <message> [<sha>]  — --input keeps base64 off argv (ARG_MAX-safe)
  put_file() {
    local path="$1" file="$2" message="$3" sha="${4:-}"
    base64 < "$file" | tr -d '\n' > "$WORKDIR/b64"
    jq -Rn --arg message "$message" --arg sha "$sha" --rawfile content "$WORKDIR/b64" \
      '{message: $message, content: $content} + (if $sha != "" then {sha: $sha} else {} end)' \
      > "$WORKDIR/payload.json"
    # Retry transient GitHub failures (5xx / "No server is currently available" / secondary rate
    # limit) — measured: a broad api.github.com 503 incident failed the whole upload otherwise.
    local i
    for i in 1 2 3 4 5; do
      # No --jq: a 5xx returns an HTML error page, and --jq would fail with an opaque
      # "invalid character '<'" that the retry match below can't recognize. We discard the
      # success body anyway, so let the raw gh exit code + stderr drive the retry.
      gh api -X PUT "repos/${ASSETS_REPO}/contents/${path}" --input "$WORKDIR/payload.json" >/dev/null 2>"$WORKDIR/gherr" && return 0
      grep -qiE "HTTP 5|No server is currently available|submitted too quickly|rate limit|abuse|invalid character" "$WORKDIR/gherr" || { cat "$WORKDIR/gherr" >&2; return 1; }
      sleep $((i * 2))
    done
    cat "$WORKDIR/gherr" >&2; return 1
  }
  put_file "$ASSET_PATH" "$MEDIA" "assets(${DIR}): ${FILENAME}"
  # Append the index row (read-modify-write with sha; one retry absorbs a concurrent append).
  append_index() {
    local sha
    if gh api "repos/${ASSETS_REPO}/contents/${INDEX_PATH}" > "$WORKDIR/index.json" 2>/dev/null; then
      sha=$(jq -r '.sha' "$WORKDIR/index.json")
      jq -r '.content' "$WORKDIR/index.json" | base64 -d > "$WORKDIR/index.md"
      printf '%s\n' "$INDEX_ROW" >> "$WORKDIR/index.md"
    else
      sha=""
      printf '# %s\n\n| file | source | uploaded | by |\n|---|---|---|---|\n%s\n' "$DIR" "$INDEX_ROW" > "$WORKDIR/index.md"
    fi
    put_file "$INDEX_PATH" "$WORKDIR/index.md" "assets(${DIR}): index ${FILENAME}" "$sha"
  }
  append_index || { sleep 1; append_index; }
}

# ── Channel B: git push into a local clone of the asset repo (cloud routines; #1334) ──
# Locate the clone (raw.githubusercontent only serves `main`, so we force the clone onto main and
# reset to origin before pushing — some sessions leave it on a stale branch, #1334).
channel_git_push() {
  local root="$1" media_dest="${1}/${ASSET_PATH}" idx_dest="${1}/${INDEX_PATH}"
  ( cd "$root"
    git fetch origin main >&2 2>&1 || true
    git checkout main >&2 2>&1 || git checkout -B main origin/main >&2 2>&1 || true
    git reset --hard origin/main >&2 2>&1 || true
    git config user.email "agent@arcblock.io" 2>/dev/null || true
    git config user.name "ARC Agent" 2>/dev/null || true )
  mkdir -p "$(dirname "$media_dest")"
  cp "$MEDIA" "$media_dest"
  if [[ -f "$idx_dest" ]]; then printf '%s\n' "$INDEX_ROW" >> "$idx_dest"
  else printf '# %s\n\n| file | source | uploaded | by |\n|---|---|---|---|\n%s\n' "$DIR" "$INDEX_ROW" > "$idx_dest"; fi
  ( cd "$root"
    git add "$DIR/" >&2 2>&1 || true
    git commit -m "assets(${DIR}): ${FILENAME}" --allow-empty >&2 2>&1 || true
    # push with rebase-retry: a concurrent push leaves the local clone behind, and a bare retry
    # re-rejects identically until it's rebased (#1334-adjacent, measured on concurrent sweeps).
    for attempt in 1 2 3 4; do
      git push origin main >&2 2>&1 && exit 0
      [[ $attempt -eq 4 ]] && { echo >&2 "error: git push to ${ASSETS_REPO} failed after 4 tries"; exit 1; }
      sleep $((attempt * 2)); git fetch origin main >&2 2>&1 || true
      git rebase origin/main >&2 2>&1 || git rebase --abort 2>/dev/null || true
    done )
}

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  channel_gh
else
  ASSETS_CLONE="${ASSETS_REPO_DIR:-}"
  if [[ -z "$ASSETS_CLONE" ]]; then
    for c in "${HOME}/loop-agent-assets" /home/user/loop-agent-assets /workspace/loop-agent-assets; do
      [[ -d "$c/.git" ]] && { ASSETS_CLONE="$c"; break; }
    done
  fi
  if [[ -z "$ASSETS_CLONE" || ! -d "$ASSETS_CLONE/.git" ]]; then
    echo >&2 "error: no gh auth AND no ${ASSETS_REPO} clone (set ASSETS_REPO_DIR or mount it as a git source) — caller should fall back to SendUserFile."
    exit 2
  fi
  channel_git_push "$ASSETS_CLONE"
fi

RAW_URL="https://raw.githubusercontent.com/${ASSETS_REPO}/main/${ASSET_PATH}"

# ── Anonymous-reachability + content-type gate (exit 4) ──
# GitHub's camo proxy fetches embedded media WITHOUT credentials, so an upload only visible when
# authenticated renders broken for every reader. AND the bytes must be real media, not corrupted: a
# double base64-encode (the #1079 MCP-file-write corruption) yields HTTP 200 but content-type text/*
# (an ASCII string). GitHub serves images as image/* but video / unclassified binaries often as
# application/octet-stream, so the gate is permissive on TYPE, strict on the one corruption
# signature: reachable AND not text/*. Retries absorb post-commit CDN propagation lag.
CODE=000; CT=""
for wait in 1 2 3 5 8; do
  # curl's -w output MUST end in \n: without it `read` returns non-zero on the unterminated last
  # line and, under `set -e`, silently kills the script here — the asset uploads fine but the URL
  # is never returned (measured: mis-attributed to a GitHub 503 twice). `|| true` is a second guard.
  read -r CODE CT < <(curl -sSL -o /dev/null -w '%{http_code} %{content_type}\n' --max-time 20 "$RAW_URL" 2>/dev/null || echo "000 ") || true
  # Accept ANY real binary media type, reject only text/*. GitHub raw serves images as image/* but
  # video (and binaries it can't classify) often as application/octet-stream — NOT video/* (measured:
  # a .webm came back application/octet-stream). The one thing the #1079 double-base64 corruption
  # produces is text/* (an ASCII string). So the honest gate is "reachable AND not text/*".
  [[ "$CODE" == "200" && -n "$CT" && "$CT" != text/* ]] && break
  sleep "$wait"
done
if [[ "$CODE" != "200" ]]; then
  echo >&2 "error: asset uploaded but NOT anonymously reachable (HTTP ${CODE}): ${RAW_URL}"
  exit 4
fi
if [[ -z "$CT" || "$CT" == text/* ]]; then
  echo >&2 "error: asset reachable but served as text (content-type ${CT:-empty}) — double-encoded (#1079), do NOT embed: ${RAW_URL}"
  exit 4
fi

echo "$RAW_URL"
