#!/usr/bin/env bash
# gh-upload-dir — upload a DIRECTORY of screenshots via the universal single-image uploader
# (gh-upload-image.sh, its sibling in this dir) and emit a `<filename>\t<raw-url>` map.
#
# UNIVERSAL (#1037): ui-verify, test-sweep, and any repo's screenshot flow call this ONE copy
# instead of each re-rolling `for f in *.png; do gh-upload-image.sh "$f"; done` (which is exactly
# what arcblock-site's ui-verify and arc's test-sweep were doing separately — drift waiting to happen).
#
# The single-image mechanics live in gh-upload-image.sh and are NOT repeated here:
#   - channel select (gh contents API, else git push into a loop-agent-assets clone)
#   - returns raw.githubusercontent.com/<repo>/main/<path> — the only host+ref the GitHub MCP
#     comment-writer keeps as an inline image (#1334); never MCP file-write for binaries (#1079)
#   - content-type=image/* gate (catches double-encoding / unreachable)
# This wrapper only loops a directory and calls it per image.
#
# Env: SCREENSHOT_DIR (required), CONTEXT (asset sub-folder, default ts-<timestamp>).
# Stdout: one `<filename>\t<raw-url>` per uploaded image; a trailing `UPLOAD_FAILED\t<reason>`
#         if ANY image could not be uploaded (caller degrades to SendUserFile). Always exits 0 —
#         the UPLOAD_FAILED line, not the exit code, is the failure signal.
set -uo pipefail

SCREENSHOT_DIR="${SCREENSHOT_DIR:?set SCREENSHOT_DIR}"
CONTEXT="${CONTEXT:-ts-$(date -u +%Y%m%dT%H%M%SZ)}"
# The single-image uploader is our sibling in the same plugin scripts dir. Override for tests.
IMG_UPLOADER="${IMG_UPLOADER:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/gh-upload-image.sh}"

shopt -s nullglob
IMAGES=( "$SCREENSHOT_DIR"/*.png "$SCREENSHOT_DIR"/*.jpg "$SCREENSHOT_DIR"/*.jpeg )
shopt -u nullglob
[ ${#IMAGES[@]} -eq 0 ] && exit 0   # no screenshots — normal, no output

FAILED=""
for IMG in "${IMAGES[@]}"; do
  BASE="$(basename "$IMG")"
  # Success signal is the URL on stdout (logging goes to stderr), NOT the exit code through a pipe.
  URL="$(ASSET_CONTEXT="$CONTEXT" bash "$IMG_UPLOADER" "$IMG" 2>/dev/null)"
  URL="${URL##*$'\n'}"   # last line, defensive against any stray stdout
  if [[ "$URL" == https://* ]]; then
    printf '%s\t%s\n' "$BASE" "$URL"
  else
    FAILED=1
    echo "WARN: upload failed for $BASE (gh-upload-image.sh exit≠0: 2=no write channel→SendUserFile, 4=unreachable/non-image)" >&2
  fi
done

if [ -n "$FAILED" ]; then
  printf 'UPLOAD_FAILED\t%s\n' "gh-upload-image.sh upload failed — see stderr (no write channel / image unreachable)"
fi
exit 0
