#!/usr/bin/env bash
# ensure-arc.sh — idempotent arc CLI bootstrap for the arc agent plugin (arc#6443).
#
# Wraps the published installer (vendored copy of blocklets/arc/install.sh, which
# already carries digest verification + the independent arc-release-digests trust
# root). Ownership-restore extract flags and ownership changes belong ONLY in
# install.sh (#5859). This script must never grow its own copy of those
# workarounds — a plugin-local fork would bury the upstream bug.
#
# Usage:
#   ensure-arc.sh [--soft] [--dry-resolve]
#     --soft        on failure print a human message and exit 0 (SessionStart /
#                   Setup degrade path: skills remain usable without the CLI)
#     --dry-resolve print the chosen install.sh path (or fail) and exit; no install
#
# Env:
#   CLAUDE_PLUGIN_ROOT     plugin install root (set by Claude Code for hooks)
#   ENSURE_ARC_INSTALL_SH  force a specific install.sh path (tests / overrides)
#   ENSURE_ARC_CANDIDATES  colon-separated candidate list (tests; empty → non-green)
#   ARC_INSTALL_DIR        forwarded to install.sh (default ~/.arc)
#   ENSURE_ARC_CONNECT_TIMEOUT  curl connect timeout seconds (default 5)
#   ENSURE_ARC_MAX_TIME         curl max time seconds (default 15) for preflight
#
set -euo pipefail

SOFT=0
DRY_RESOLVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --soft) SOFT=1; shift ;;
    --dry-resolve) DRY_RESOLVE=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '✗ unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}"
CONNECT_TIMEOUT="${ENSURE_ARC_CONNECT_TIMEOUT:-5}"
MAX_TIME="${ENSURE_ARC_MAX_TIME:-15}"
INSTALL_DIR="${ARC_INSTALL_DIR:-${HOME:-/tmp}/.arc}"

fail() {
  printf '✗ ensure-arc: %s\n' "$*" >&2
  if [ "$SOFT" = 1 ]; then
    printf '  Plugin skills remain available without the arc CLI (degraded).\n' >&2
    printf '  Manual install: curl -fsSL https://arc.afsd.io/install.sh | bash\n' >&2
    printf '  Docs: docs/guides/arc-cli-distribution.md\n' >&2
    exit 0
  fi
  exit 1
}

info() { printf '%s\n' "$*" >&2; }
ok() { printf '✓ ensure-arc: %s\n' "$*" >&2; }

# ── already installed? (idempotent fast path) ────────────────────────────────
resolve_arc_bin() {
  if command -v arc >/dev/null 2>&1; then
    command -v arc
    return 0
  fi
  if [ -x "${INSTALL_DIR}/current/arc" ]; then
    printf '%s\n' "${INSTALL_DIR}/current/arc"
    return 0
  fi
  return 1
}

if ARC_BIN="$(resolve_arc_bin)"; then
  if ver="$("$ARC_BIN" --version 2>/dev/null)" && [ -n "$ver" ]; then
    ok "arc already present (${ver}) — skipping install"
    [ "$DRY_RESOLVE" = 1 ] && printf '%s\n' "$ARC_BIN"
    exit 0
  fi
fi

# ── candidate install.sh paths (度量正控: 0 candidates is NON-green) ──────────
# Prefer an explicit override list when tests inject one (including empty).
build_candidates() {
  if [ "${ENSURE_ARC_CANDIDATES+x}" = "x" ]; then
    # Variable is set (possibly empty) — honour it exactly.
    if [ -z "$ENSURE_ARC_CANDIDATES" ]; then
      return 0
    fi
    printf '%s' "$ENSURE_ARC_CANDIDATES" | tr ':' '\n'
    return 0
  fi
  if [ -n "${ENSURE_ARC_INSTALL_SH:-}" ]; then
    printf '%s\n' "$ENSURE_ARC_INSTALL_SH"
  fi
  printf '%s\n' "$SCRIPT_DIR/install.sh"
  # In-repo checkout: walk up from plugin root looking for blocklets/arc/install.sh
  local d="$PLUGIN_ROOT"
  local i=0
  while [ "$i" -lt 8 ] && [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -f "$d/blocklets/arc/install.sh" ]; then
      printf '%s\n' "$d/blocklets/arc/install.sh"
      break
    fi
    d="$(dirname "$d")"
    i=$((i + 1))
  done
}

INSTALL_SH=""
CANDIDATE_COUNT=0
EXISTING_COUNT=0
CAND_TMP="$(mktemp "${TMPDIR:-/tmp}/ensure-arc-cand.XXXXXX")"
build_candidates >"$CAND_TMP"
while IFS= read -r cand || [ -n "$cand" ]; do
  [ -z "$cand" ] && continue
  CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
  if [ -f "$cand" ] && [ -r "$cand" ]; then
    EXISTING_COUNT=$((EXISTING_COUNT + 1))
    if [ -z "$INSTALL_SH" ]; then
      INSTALL_SH="$cand"
    fi
  fi
done <"$CAND_TMP"
rm -f "$CAND_TMP"

if [ "$CANDIDATE_COUNT" -eq 0 ] || [ "$EXISTING_COUNT" -eq 0 ] || [ -z "$INSTALL_SH" ]; then
  fail "no candidate install.sh paths found (enumerated=${CANDIDATE_COUNT} existing=${EXISTING_COUNT}). Refusing to pretend the CLI was installed. Set ENSURE_ARC_INSTALL_SH or ship scripts/install.sh under the plugin."
fi

if [ "$DRY_RESOLVE" = 1 ]; then
  printf '%s\n' "$INSTALL_SH"
  exit 0
fi

# ── network preflight (bounded; distinguish unreachable vs later digest fail) ─
PROBE_URL="${ENSURE_ARC_PROBE_URL:-https://arc.afsd.io/install.sh}"
ERR_TMP="$(mktemp "${TMPDIR:-/tmp}/ensure-arc-net.XXXXXX")"
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
      -o /dev/null "$PROBE_URL" 2>"$ERR_TMP"; then
    err="$(tr '\n' ' ' <"$ERR_TMP" 2>/dev/null || true)"
    rm -f "$ERR_TMP"
    fail "network unreachable while probing ${PROBE_URL} (connect-timeout=${CONNECT_TIMEOUT}s max-time=${MAX_TIME}s). ${err}This is a connectivity failure, not a digest/checksum failure — digest verification did not run."
  fi
  rm -f "$ERR_TMP"
elif command -v wget >/dev/null 2>&1; then
  if ! wget -q --timeout="$MAX_TIME" -O /dev/null "$PROBE_URL" 2>"$ERR_TMP"; then
    err="$(tr '\n' ' ' <"$ERR_TMP" 2>/dev/null || true)"
    rm -f "$ERR_TMP"
    fail "network unreachable while probing ${PROBE_URL}. ${err}This is a connectivity failure, not a digest/checksum failure — digest verification did not run."
  fi
  rm -f "$ERR_TMP"
else
  rm -f "$ERR_TMP"
  fail "need curl or wget for network preflight before invoking install.sh"
fi

# ── invoke install.sh (digest fail-closed stays inside install.sh) ───────────
info "➜ ensure-arc: installing arc CLI via ${INSTALL_SH}"
set +e
# Forward install-dir; do not pass --no-verify. Never add ownership-extract flags here.
bash "$INSTALL_SH" --dir "$INSTALL_DIR"
install_rc=$?
set -e

if [ "$install_rc" -ne 0 ]; then
  # install.sh already printed the reason (network mid-download vs checksum).
  # Re-state the soft degrade contract without swallowing the cause.
  fail "install.sh exited ${install_rc}. If the message above mentions checksum/digest mismatch, that is fail-closed verification — not a network miss. Do not skip digest checks."
fi

if ARC_BIN="$(resolve_arc_bin)"; then
  if ver="$("$ARC_BIN" --version 2>/dev/null)" && [ -n "$ver" ]; then
    ok "arc ${ver} ready"
    # Ensure current session can see it even before shell rc reload.
    case ":${PATH}:" in
      *":${INSTALL_DIR}/current:"*) ;;
      *) export PATH="${INSTALL_DIR}/current:${PATH}" ;;
    esac
    exit 0
  fi
fi

fail "install.sh reported success but arc --version produced no output under ${INSTALL_DIR}/current"
