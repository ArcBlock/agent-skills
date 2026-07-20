#!/usr/bin/env bash
# gh-upload-dir — upload a DIRECTORY of media (images AND videos) via the universal single-file
# uploader (gh-upload-media.sh, its sibling in this dir) and emit a `<filename>\t<raw-url>` map.
#
# UNIVERSAL (#1037): ui-verify, test-sweep, and any repo's screenshot/recording flow call this ONE
# copy instead of each re-rolling `for f in *.png; do gh-upload-media.sh "$f"; done` (which is exactly
# what arcblock-site's ui-verify and arc's test-sweep were doing separately — drift waiting to happen).
#
# The single-file mechanics live in gh-upload-media.sh and are NOT repeated here:
#   - channel select (gh contents API, else git push into a loop-agent-assets clone)
#   - returns raw.githubusercontent.com/<repo>/main/<path> — the only host+ref the GitHub MCP
#     comment-writer keeps as an inline image (#1334); never MCP file-write for binaries (#1079)
#   - content-type=image/* OR video/* gate (catches double-encoding / unreachable)
# This wrapper only loops a directory and calls it per file.
#
# EMBEDDING is the CALLER's job and is NOT uniform: image/gif → `![](url)` inline; video → a LINK
# (`![](x.webm)` renders broken — GitHub won't inline-play raw video). The map key's extension tells
# the caller which kind it is.
#
# Env: SCREENSHOT_DIR (required — the media dir), CONTEXT (asset sub-folder, default ts-<timestamp>).
# Stdout: one `<filename>\t<raw-url>` per uploaded file; a trailing `UPLOAD_FAILED\t<reason>`
#         if ANY file could not be uploaded (caller degrades to SendUserFile). Always exits 0 —
#         the UPLOAD_FAILED line, not the exit code, is the failure signal.
set -uo pipefail

SCREENSHOT_DIR="${SCREENSHOT_DIR:?set SCREENSHOT_DIR}"
CONTEXT="${CONTEXT:-ts-$(date -u +%Y%m%dT%H%M%SZ)}"
# The single-file uploader is our sibling in the same plugin scripts dir. Override for tests.
MEDIA_UPLOADER="${MEDIA_UPLOADER:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/gh-upload-media.sh}"

shopt -s nullglob
MEDIA_FILES=( "$SCREENSHOT_DIR"/*.png "$SCREENSHOT_DIR"/*.jpg "$SCREENSHOT_DIR"/*.jpeg \
              "$SCREENSHOT_DIR"/*.gif "$SCREENSHOT_DIR"/*.webm "$SCREENSHOT_DIR"/*.mp4 "$SCREENSHOT_DIR"/*.mov )
shopt -u nullglob
[ ${#MEDIA_FILES[@]} -eq 0 ] && exit 0   # no media — normal, no output

FAILED=""
for FILE in "${MEDIA_FILES[@]}"; do
  BASE="$(basename "$FILE")"
  # Success signal is the URL on stdout (logging goes to stderr), NOT the exit code through a pipe.
  URL="$(ASSET_CONTEXT="$CONTEXT" bash "$MEDIA_UPLOADER" "$FILE" 2>/dev/null)"
  URL="${URL##*$'\n'}"   # last line, defensive against any stray stdout
  if [[ "$URL" == https://* ]]; then
    printf '%s\t%s\n' "$BASE" "$URL"
  else
    FAILED=1
    echo "WARN: upload failed for $BASE (gh-upload-media.sh exit≠0: 2=no write channel→SendUserFile, 4=unreachable/non-media)" >&2
  fi
done

if [ -n "$FAILED" ]; then
  printf 'UPLOAD_FAILED\t%s\n' "gh-upload-media.sh upload failed — see stderr (no write channel / media unreachable)"
fi
exit 0
