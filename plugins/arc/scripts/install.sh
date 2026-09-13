#!/usr/bin/env bash
#
# arc CLI installer — https://arc.afsd.io
#
#   curl -fsSL https://arc.afsd.io/install.sh | bash
#
# Options (pass after `bash -s --`, or as env vars):
#   --version <v>        install a specific version   (env: ARC_VERSION)
#   --dir <path>         install root                 (env: ARC_INSTALL_DIR, default ~/.arc)
#   --no-modify-path     do not touch shell rc files  (env: ARC_NO_MODIFY_PATH=1)
#   --base <url>         tarball host base URL        (env: ARC_INSTALL_BASE, default https://dl.arcblock.io)
#   --digests-base <url> cross-origin digest source    (env: ARC_DIGESTS_BASE, default https://raw.githubusercontent.com/ArcBlock/arc-release-digests/main)
#   --no-verify          install even if no digest is published anywhere (env: ARC_NO_VERIFY=1)
#
# The installer downloads a self-contained tarball (launcher + binary + assets +
# native modules), verifies its SHA-256 against a digest fetched from a SECOND,
# independent origin (arc#3119), unpacks it under ~/.arc/versions/<v>, points
# ~/.arc/current at it, and adds ~/.arc/current to PATH. Installing over curl
# (not a browser) means macOS never marks the binary as quarantined, so it
# launches with no "damaged / move to Trash" prompt.

set -euo pipefail

# ── config ──────────────────────────────────────────────────────────────────
ARC_INSTALL_BASE="${ARC_INSTALL_BASE:-https://dl.arcblock.io}"
# Cross-origin trust root (arc#3119): a small public repo whose only content is
# release checksums + a "latest" pointer. It is a SEPARATE origin from
# dl.arcblock.io on purpose — an attacker who controls the R2 bucket does not
# thereby control this repo, and any tampering here leaves a visible git
# history. See docs/guides/arc-cli-distribution.md.
ARC_DIGESTS_BASE="${ARC_DIGESTS_BASE:-https://raw.githubusercontent.com/ArcBlock/arc-release-digests/main}"
ARC_INSTALL_DIR="${ARC_INSTALL_DIR:-$HOME/.arc}"
ARC_VERSION="${ARC_VERSION:-}"
ARC_NO_MODIFY_PATH="${ARC_NO_MODIFY_PATH:-}"
ARC_NO_VERIFY="${ARC_NO_VERIFY:-}"

# Env flags are parsed, not tested for emptiness. `ARC_NO_VERIFY=0` in an
# inherited CI profile obviously means "off", but a bare -n test reads it as
# "on" and silently disables verification — the failure mode is the opposite of
# what was written (#3040). Unset/empty is false; 1/true/yes/on are true;
# 0/false/no/off are false; anything else is a hard error rather than a guess.
parse_bool() {
  case "$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')" in
    ""|0|false|no|off) return 1 ;;
    1|true|yes|on)     return 0 ;;
    *) echo "✗ ${1}: expected a boolean (1/0, true/false, yes/no, on/off), got \"${2}\"" >&2; exit 1 ;;
  esac
}

parse_bool ARC_NO_VERIFY "$ARC_NO_VERIFY" && ARC_NO_VERIFY=1 || ARC_NO_VERIFY=""
parse_bool ARC_NO_MODIFY_PATH "$ARC_NO_MODIFY_PATH" && ARC_NO_MODIFY_PATH=1 || ARC_NO_MODIFY_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) ARC_VERSION="${2:?--version needs a value}"; shift 2 ;;
    --dir)     ARC_INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --base)    ARC_INSTALL_BASE="${2:?--base needs a value}"; shift 2 ;;
    --digests-base) ARC_DIGESTS_BASE="${2:?--digests-base needs a value}"; shift 2 ;;
    --no-modify-path) ARC_NO_MODIFY_PATH=1; shift ;;
    --no-verify) ARC_NO_VERIFY=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '/^!/d'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── pretty output (respect NO_COLOR / non-tty) ──────────────────────────────
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; CYAN=""; RESET=""
fi
info()  { printf '%s\n' "$*" >&2; }
step()  { printf '%s➜%s %s\n' "$CYAN" "$RESET" "$*" >&2; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
die()   { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
need uname; need tar; need mkdir; need mktemp

# GNU tar as uid 0 (including a user namespace that only *looks* like root)
# restores archive uid/gid and fails with "Cannot change ownership... Invalid
# argument" on rootless hosts (arc#5859). `--help` is NOT a portable detector:
# macOS bsdtar accepts --no-same-owner and documents it in the man page, but
# omits it from --help. Probe the long option via --version; fall back to
# extract-time `-o` (GNU tar + bsdtar synonym for --no-same-owner).
# Never pass --no-same-permissions: executable bits from the archive are useful.
if tar --no-same-owner --version >/dev/null 2>&1; then
  TAR_NO_SAME_OWNER=--no-same-owner
else
  TAR_NO_SAME_OWNER=-o
fi

extract_tarball() {
  # $1 archive, $2 destination directory. Ownership is NOT restored.
  if [ "$TAR_NO_SAME_OWNER" = "--no-same-owner" ]; then
    tar --no-same-owner -xzf "$1" -C "$2" --strip-components=1
  else
    tar -xozf "$1" -C "$2" --strip-components=1
  fi
}

# ── download helper (curl or wget) ──────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  dl() { curl -fsSL "$1" -o "$2"; }
  dl_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -qO "$2" "$1"; }
  dl_stdout() { wget -qO- "$1"; }
else
  die "need curl or wget to download"
fi

# ── detect platform ─────────────────────────────────────────────────────────
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) die "unsupported OS: $os (arc ships macOS and Linux builds)" ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) die "unsupported architecture: $arch" ;;
esac
platform="${os}-${arch}"

# Only these platforms are currently built/published.
case "$platform" in
  darwin-arm64|darwin-x64|linux-x64|linux-arm64) : ;;
  *) die "no published build for ${platform} yet (available: darwin-arm64, darwin-x64, linux-x64, linux-arm64)" ;;
esac
ok "platform: ${BOLD}${platform}${RESET}"

# ── resolve version ─────────────────────────────────────────────────────────
# "latest" is resolved from the git-anchored digests repo, NOT from R2's
# manifest.json (arc#3119, note 3). Pinning only the digest and not the version
# pointer leaves a downgrade attack open: whoever controls dl.arcblock.io can
# still point install.sh at an OLD version whose digest is legitimately
# correct — the checksum would verify perfectly while shipping a version with
# a known vulnerability. The version pointer has to live at the same
# independent origin as the digest for the digest to mean anything.
if [ -z "$ARC_VERSION" ]; then
  step "resolving latest version (git-anchored)"

  git_latest="$(dl_stdout "${ARC_DIGESTS_BASE}/digests/latest" 2>/dev/null | tr -d '[:space:]' || true)"

  # R2's manifest.json is kept only as a disagreement signal below — never
  # authoritative for "latest" on its own anymore.
  manifest="$(dl_stdout "${ARC_INSTALL_BASE}/manifest.json" 2>/dev/null || true)"
  r2_latest="$(printf '%s' "$manifest" \
    | tr ',{}' '\n\n\n' \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n1)"

  if [ -n "$git_latest" ]; then
    ARC_VERSION="$git_latest"
    if [ -n "$r2_latest" ] && [ "$r2_latest" != "$git_latest" ]; then
      info "${RED}⚠ WARNING: dl.arcblock.io reports latest=${r2_latest} but the git-anchored source${RESET}"
      info "${RED}  (${ARC_DIGESTS_BASE}) reports latest=${git_latest}. Trusting the git-anchored${RESET}"
      info "${RED}  version — one of the two origins may be compromised (arc#3119).${RESET}"
    fi
  elif [ -n "$ARC_NO_VERIFY" ] && [ -n "$r2_latest" ]; then
    ARC_VERSION="$r2_latest"
    info "${RED}⚠ WARNING: git-anchored version source unreachable (${ARC_DIGESTS_BASE}/digests/latest)${RESET}"
    info "${RED}  — falling back to dl.arcblock.io's manifest.json at your request (--no-verify).${RESET}"
    info "${RED}  A compromised R2 could roll you back to an old, vulnerable version.${RESET}"
  else
    die "could not resolve latest version from ${ARC_DIGESTS_BASE}/digests/latest — refusing to resolve
  'latest' unverified. A same-origin-only source (dl.arcblock.io) cannot be trusted to name the latest
  version: a compromised R2 could roll you back to an old, vulnerable release (arc#3119).
  Pass --version <v> to install a specific version without this lookup, or --no-verify to fall back to
  dl.arcblock.io's manifest.json at your own risk."
  fi
fi
ok "version: ${BOLD}${ARC_VERSION}${RESET}"

asset="arc-${ARC_VERSION}-${platform}.tar.gz"
url="${ARC_INSTALL_BASE}/${asset}"

# ── download + verify ───────────────────────────────────────────────────────
tmp="$(mktemp -d "${TMPDIR:-/tmp}/arc-install.XXXXXX")"
staging=""
backup=""
cleanup_install() {
  rm -rf "$tmp"
  if [ -n "${staging:-}" ]; then
    rm -rf "$staging"
  fi
  # Promote window: dest has been moved to backup but staging has not
  # replaced it. An EXIT/SIGTERM here would otherwise leave `current`
  # pointing at a missing directory (Codex P2 on arc#5868).
  if [ -n "${backup:-}" ] && [ -n "${dest:-}" ] && [ -e "$backup" ] && [ ! -e "$dest" ]; then
    mv "$backup" "$dest" 2>/dev/null || true
  fi
}
trap cleanup_install EXIT

step "downloading ${DIM}${url}${RESET}"
dl "$url" "$tmp/$asset" || die "download failed: $url"

# Fail CLOSED when the git-anchored digest is unreachable (arc#3119, extending
# #3040's fail-closed rule from "sidecar absent" to "cross-origin source
# absent"). Whoever can serve a poisoned tarball on dl.arcblock.io can also
# 404 its own .sha256 sidecar, so a same-origin-only checksum is not a trust
# root — it only detects corruption/truncation, not substitution by whoever
# controls that origin. The digest fetched from ArcBlock/arc-release-digests
# (a SEPARATE public repo, not a mirror) is what actually anchors this: an
# attacker would need to compromise both dl.arcblock.io AND leave a matching,
# undetected commit in that repo's public history.
step "verifying checksum"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi

git_digest_url="${ARC_DIGESTS_BASE}/digests/${ARC_VERSION}.sha256"
git_digest_body="$(dl_stdout "$git_digest_url" 2>/dev/null || true)"
git_expected="$(printf '%s\n' "$git_digest_body" | awk -v a="$asset" '$2==a{print $1; exit}')"

# Same-origin sidecar: no longer the primary check (that would still be the
# exact same-origin-only gap arc#3119 opened about) — kept ONLY as a second
# reading to cross-check against the git-anchored one. Best-effort: its
# absence is not fatal as long as the git-anchored digest verified.
r2_expected=""
if dl "${url}.sha256" "$tmp/$asset.sha256" 2>/dev/null; then
  r2_expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
fi

if [ -n "$git_expected" ]; then
  # Checked even under --no-verify: that flag means "proceed without a
  # checksum", not "ignore a checksum that failed".
  [ "$git_expected" = "$actual" ] || die "checksum mismatch against the git-anchored digest (${git_digest_url}):
  expected ${git_expected}, got ${actual}
  This is what a substituted tarball looks like. Refusing to install."

  # The two origins disagreeing is not silently resolved by "the git-anchored
  # one already matched, so we're fine" — it means one of the two origins may
  # be compromised (or R2's sidecar is stale), and that is worth surfacing
  # loudly even though the install itself is safe to proceed with.
  if [ -n "$r2_expected" ] && [ "$r2_expected" != "$git_expected" ]; then
    info "${RED}⚠ WARNING: dl.arcblock.io's checksum disagrees with the git-anchored one.${RESET}"
    info "${RED}  git (${ARC_DIGESTS_BASE}): ${git_expected}${RESET}"
    info "${RED}  R2  (${ARC_INSTALL_BASE}):  ${r2_expected}${RESET}"
    info "${RED}  Trusting the git-anchored digest — it matched the actual download. One of${RESET}"
    info "${RED}  the two origins may be compromised; please report this at https://github.com/ArcBlock/arc/issues${RESET}"
  fi
  ok "checksum verified (cross-origin, arc-release-digests)"
elif [ -n "$ARC_NO_VERIFY" ]; then
  if [ -n "$r2_expected" ]; then
    [ "$r2_expected" = "$actual" ] || die "checksum mismatch: expected $r2_expected, got $actual"
    info "${RED}⚠ WARNING: git-anchored digest unavailable (${git_digest_url}) — falling back to${RESET}"
    info "${RED}  dl.arcblock.io's SAME-ORIGIN checksum only, at your request (--no-verify).${RESET}"
    ok "checksum verified (same-origin only — NOT cross-origin verified)"
  else
    info "${RED}⚠ WARNING: no checksum available anywhere for ${asset} — installing UNVERIFIED at your request (--no-verify).${RESET}"
  fi
else
  die "could not fetch the git-anchored digest from ${git_digest_url} — refusing to install unverified.
  This is the cross-origin trust root (arc#3119): dl.arcblock.io alone cannot authenticate a download, and
  a missing/unreachable digest here is indistinguishable from one an attacker is suppressing.
  If you truly want to proceed anyway (same-origin checksum only, or none), re-run with --no-verify."
fi

# ── unpack (transactional, arc#5859) ────────────────────────────────────────
# Extract into a staging dir on the SAME filesystem as the final version dir,
# validate, then rename into place. `rm -rf "$dest"` before the new tree is
# known-good is what leaves a half-extracted `versions/<v>` (and, on reinstall
# of the live version, a dangling `current`) when tar or the post-extract
# checks fail.
versions_dir="${ARC_INSTALL_DIR}/versions"
dest="${versions_dir}/${ARC_VERSION}"
staging="${versions_dir}/.staging-${ARC_VERSION}.$$"
tree="$staging"
step "installing to ${BOLD}${dest}${RESET}"
mkdir -p "$versions_dir"
rm -rf "$staging"
mkdir -p "$staging"
# tarball top-level dir is `arc-dist/`; strip it so files land directly in $tree
if ! extract_tarball "$tmp/$asset" "$staging"; then
  rm -rf "$staging"
  staging=""
  die "failed to extract ${asset}"
fi
[ -x "$staging/arc" ] || { rm -rf "$staging"; staging=""; die "unpacked tree missing the arc launcher — bad tarball?"; }
chmod +x "$staging/arc" "$staging"/arc-* 2>/dev/null || true

# ── distribution manifest helpers (#3040) ───────────────────────────────────
ARC_MANIFEST_FILE="dist-manifest.sha256"
manifest_failure=""
manifest_count=0
macho_count=0

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# 0 = verified, 1 = tampered, 2 = build carries no manifest.
#
# Callers MUST treat 2 as "unverified", never as success — an attacker who can
# rewrite the tree can also delete the manifest, so "no manifest" and "manifest
# withheld" are indistinguishable here (same reasoning as the .sha256 gate).
verify_dist_manifest() {
  _dest="$1"; _main="$2"
  _manifest="${_dest}/${ARC_MANIFEST_FILE}"

  [ -f "$_manifest" ] || { manifest_failure="no ${ARC_MANIFEST_FILE} in the tree"; return 2; }

  # The expected digest comes from the binary codesign just authenticated, so
  # it cannot be forged without also forging an Apple-rooted signature.
  _expected="$("$_main" __dist-manifest-digest 2>/dev/null || true)"
  [ -n "$_expected" ] || { manifest_failure="binary reports no manifest digest"; return 2; }

  _actual="$(sha256_of "$_manifest")"
  if [ "$_expected" != "$_actual" ]; then
    manifest_failure="${ARC_MANIFEST_FILE} does not match the digest embedded in the signed binary (expected ${_expected}, got ${_actual})"
    return 1
  fi

  # Every listed file must match its recorded hash.
  if command -v sha256sum >/dev/null 2>&1; then
    _check="sha256sum -c --quiet"
  else
    _check="shasum -a 256 -c --status"
  fi
  if ! ( cd "$_dest" && $_check "$ARC_MANIFEST_FILE" ) >/dev/null 2>&1; then
    manifest_failure="one or more files do not match their recorded hash"
    return 1
  fi

  # …and the tree must contain nothing else. Without this, the manifest is only
  # an allowlist of files that happen to be listed: an attacker could ADD a
  # module that shadows a require() and every listed hash would still match.
  #
  # The accounted-for set is the manifest's files PLUS every Mach-O, because the
  # two layers are complementary by construction: codesign covers Mach-O (and
  # rewrites their bytes when signing, so no manifest hash for them could ever
  # be stable), the manifest covers everything else.
  _accounted="$( { sed 's/^[0-9a-f][0-9a-f]*  //' "$_manifest"
                   printf '%s' "$macho_rel"
                   printf '%s\n' "$ARC_MANIFEST_FILE"
                 } | grep -v '^$' | LC_ALL=C sort -u)"
  _listed="$(sed 's/^[0-9a-f][0-9a-f]*  //' "$_manifest" | LC_ALL=C sort)"
  _present="$(cd "$_dest" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)"
  _extra="$(LC_ALL=C comm -13 <(printf '%s\n' "$_accounted") <(printf '%s\n' "$_present"))"
  if [ -n "$_extra" ]; then
    manifest_failure="the tree contains files the manifest does not cover: $(printf '%s' "$_extra" | tr '\n' ' ')"
    return 1
  fi

  manifest_count="$(printf '%s\n' "$_listed" | wc -l | tr -d ' ')"
  return 0
}

# ── verify Developer ID signature (macOS) ───────────────────────────────────
# The checksum above comes from the same origin as the tarball, so it proves
# nothing against whoever controls that origin. The Developer ID signature is
# rooted in Apple's CA instead — but curl sets no com.apple.quarantine
# attribute, so Gatekeeper never runs on this path. If install.sh does not check
# the signature, nothing does, and #1618's signing only protects the far less
# common browser-download route.
#
# The designated requirement pins BOTH the Apple anchor and our team, so it
# asserts "signed by ArcBlock", not the far weaker "signed by somebody" — any
# $99 Apple developer can obtain a valid Developer ID.
#
# Verifies EVERY Mach-O, not just the main binary: our entitlements include
# com.apple.security.cs.disable-library-validation (Bun's embedded
# JavaScriptCore needs JIT), so a perfectly signed main binary will happily
# dlopen a tampered .node sitting next to it.
ARC_APPLE_TEAM_ID="K4NSWQ8457"   # ArcBlock, Inc. — public; embedded in every signed build
ARC_SIGNING_REQUIREMENT="anchor apple generic and certificate leaf[subject.OU] = \"${ARC_APPLE_TEAM_ID}\""

# ROLLOUT (#3040): every tarball published so far is ad-hoc signed, so a MISSING
# signature currently warns instead of aborting. Flip this to 1 once the first
# signed release is out — after that, unsigned is refused like any other failed
# verification. A signature that is PRESENT but not ours is refused at both
# stages; the grace period is for absence, not for substitution.
ARC_SIGNING_ENFORCED="${ARC_SIGNING_ENFORCED:-}"
parse_bool ARC_SIGNING_ENFORCED "$ARC_SIGNING_ENFORCED" && ARC_SIGNING_ENFORCED=1 || ARC_SIGNING_ENFORCED=""

if [ "$os" = darwin ] && command -v codesign >/dev/null 2>&1; then
  step "verifying code signature"
  unsigned_files=""
  macho_rel=""
  bad_reason=""; bad_file=""; bad_detail=""
  main_binary="${tree}/arc-${platform}"
  while IFS= read -r -d '' f; do
    file "$f" 2>/dev/null | grep -q "Mach-O" || continue

    # Three states, distinguished carefully — `codesign -dvvv` exits non-zero
    # when a file is unsigned, prints "Signature=adhoc" for an ad-hoc one, and
    # prints "Signature size=N" (NOT "Signature=") for a real one. Testing for
    # "^Signature=" therefore misreads every real signature as absent.
    macho_count=$((macho_count + 1))
    macho_rel="${macho_rel}${f#"$tree"/}
"
    if desc="$(codesign -dvvv "$f" 2>&1)"; then has_sig=1; else has_sig=0; fi

    if [ "$has_sig" -eq 0 ] || grep -q "^Signature=adhoc" <<<"$desc"; then
      # No real signature to check. Whether that is fatal depends on the
      # rollout stage, so collect and decide once, below.
      unsigned_files="${unsigned_files}
    ${f#"$tree"/}"
      continue
    fi

    # A real signature exists — it must be Apple-anchored AND ours. This is
    # fatal regardless of rollout stage or --no-verify.
    #
    # `-R=` with an equals sign, NOT `-R <text>`: bare -R takes a FILE PATH, so
    # passing the requirement inline that way makes codesign fail with "invalid
    # requirement specification" — non-zero, and indistinguishable from a real
    # rejection unless the output is read. That form silently rejects every
    # build including genuine ones, and no amount of "hostile input is refused"
    # testing catches it, because it refuses everything for the wrong reason.
    if ! _out="$(codesign --verify --strict -R="$ARC_SIGNING_REQUIREMENT" "$f" 2>&1)"; then
      case "$_out" in
        *"invalid requirement"*|*"unknown requirement"*)
          # The installer is broken, not the download. Never report this as an
          # attack — that misdirects the user completely.
          bad_reason="internal"; bad_file="${f#"$tree"/}"; bad_detail="$_out"; break ;;
        *)
          bad_reason="foreign"; bad_file="${f#"$tree"/}"; bad_detail="$_out"; break ;;
      esac
    fi
  done < <(find "$tree" -type f -print0)

  # Handled after the loop rather than inside it: `rm -rf "$tree"` while `find`
  # is still enumerating that same tree makes find print "fts_read: No such
  # file or directory" over the real error.
  if [ "$bad_reason" = "internal" ]; then
    rm -rf "$tree"; staging=""
    die "installer error while verifying ${bad_file}: ${bad_detail}
  This is a bug in install.sh, not evidence of a tampered download.
  Please report it at https://github.com/ArcBlock/arc/issues"
  elif [ -n "$bad_reason" ]; then
    rm -rf "$tree"; staging=""
    die "signature verification FAILED for ${bad_file}
  It carries a code signature that is not ArcBlock's (team ${ARC_APPLE_TEAM_ID}).
  This is what a substituted binary looks like. Refusing to install.
  Downloaded from: ${url}"
  fi

  # Zero Mach-O files is not "everything passed" — it means nothing anchored the
  # chain. An empty `unsigned_files` must never be read as success on its own.
  if [ "$macho_count" -eq 0 ] || [ ! -f "$main_binary" ]; then
    unsigned_files="
    (no signed main binary found in the tree — nothing could anchor verification)"
  elif [ -z "$unsigned_files" ]; then
    # The Mach-O files are authentic, which anchors the chain — but they are a
    # small minority of the tree (3 of ~2550). The `arc` launcher is a /bin/sh
    # script and node_modules is mostly JavaScript that the binary require()s
    # via NODE_PATH; an attacker who leaves every signature intact and edits
    # those still gets code execution. So the verified binary now vouches for
    # everything else, via a manifest digest baked into it at build time:
    #
    #   codesign -R (Apple CA) → main binary → manifest digest → every file
    #
    # Announcing "signature verified" before this step would be worse than
    # saying nothing: it converts no protection into false confidence.
    # `|| manifest_rc=$?` rather than a bare call: under `set -e` a function
    # returning non-zero as an untested simple command kills the script before
    # the case below ever runs.
    manifest_rc=0
    verify_dist_manifest "$tree" "$main_binary" || manifest_rc=$?
    case $manifest_rc in
      0) ok "signature + manifest verified (${manifest_count} files, team ${ARC_APPLE_TEAM_ID})" ;;
      2)
        # Signed, but built before manifests existed. Same class as an absent
        # signature, so it follows the same rollout rule rather than being
        # treated as a pass.
        unsigned_files="
    (this build predates the distribution manifest — only its ${macho_count} Mach-O files could be verified)"
        ;;
      *)
        rm -rf "$tree"; staging=""
        die "distribution manifest verification FAILED
  ${manifest_failure}
  The Mach-O binaries are correctly signed, but a file they do not cover has
  been altered — the launcher script or the JavaScript loaded via NODE_PATH.
  Refusing to install. Downloaded from: ${url}"
        ;;
    esac
  fi

  if [ -n "$unsigned_files" ]; then
    if [ -n "$ARC_SIGNING_ENFORCED" ] && [ -z "$ARC_NO_VERIFY" ]; then
      rm -rf "$tree"; staging=""
      die "not signed with ArcBlock's Developer ID:${unsigned_files}
  Refusing to install. Re-run with --no-verify to override."
    fi
    info "${RED}⚠ WARNING: this build's authenticity could NOT be verified:${unsigned_files}${RESET}"
    info "${RED}  Only that it downloaded intact — which the download origin itself could fake.${RESET}"
    info "${RED}  Signed builds ship from the next release onward (see arc#3040).${RESET}"
  fi
fi

# Promote staging → dest only after the tree has been validated. `current` is
# switched last so a failed install never changes the live version.
if [ -e "$dest" ] || [ -L "$dest" ]; then
  backup="${dest}.prev.$$"
  rm -rf "$backup"
  mv "$dest" "$backup"
  if mv "$staging" "$dest"; then
    rm -rf "$backup"
    backup=""
  else
    mv "$backup" "$dest" 2>/dev/null || true
    backup=""
    rm -rf "$staging"
    staging=""
    die "failed to promote staged install into ${dest}"
  fi
else
  if ! mv "$staging" "$dest"; then
    rm -rf "$staging"
    staging=""
    die "failed to promote staged install into ${dest}"
  fi
fi
staging=""
tree="$dest"

# point ~/.arc/current at this version last (ln -sfn replaces the symlink)
ln -sfn "$dest" "${ARC_INSTALL_DIR}/current"
bindir="${ARC_INSTALL_DIR}/current"
ok "unpacked $(du -sh "$dest" 2>/dev/null | awk '{print $1}')"

# ── smoke check ─────────────────────────────────────────────────────────────
if v="$("$bindir/arc" --version 2>/dev/null)"; then
  ok "arc ${BOLD}${v}${RESET} is ready"
else
  info "${DIM}(installed, but 'arc --version' did not print cleanly — run it manually to see any error)${RESET}"
fi

# ── wire PATH ───────────────────────────────────────────────────────────────
add_path_line="export PATH=\"${bindir}:\$PATH\""
already_on_path=0
case ":$PATH:" in *":$bindir:"*) already_on_path=1 ;; esac

if [ "$already_on_path" = 1 ]; then
  ok "already on PATH"
elif [ -n "$ARC_NO_MODIFY_PATH" ]; then
  info ""
  info "Add arc to your PATH:"
  info "  ${BOLD}${add_path_line}${RESET}"
else
  # pick the rc file for the user's login shell
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)  rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    *)    rc="" ;;
  esac
  marker="# added by arc installer (https://arc.afsd.io)"
  if [ -n "$rc" ]; then
    touch "$rc"
    if grep -qF "$marker" "$rc" 2>/dev/null; then
      ok "PATH already configured in ${rc}"
    else
      printf '\n%s\n%s\n' "$marker" "$add_path_line" >> "$rc"
      ok "added arc to PATH in ${BOLD}${rc}${RESET}"
    fi
    info ""
    info "Restart your shell or run: ${BOLD}source ${rc}${RESET}"
  else
    info ""
    info "Add arc to your PATH (unknown shell '${shell_name}'):"
    info "  ${BOLD}${add_path_line}${RESET}"
  fi
fi

info ""
ok "${GREEN}${BOLD}Done.${RESET} Try: ${BOLD}arc --help${RESET}"
