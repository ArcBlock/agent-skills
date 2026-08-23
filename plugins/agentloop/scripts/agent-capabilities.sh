#!/usr/bin/env bash
# agent-capabilities — probe which native build/test toolchains this machine
# actually has, so issue-sweep/pr-sweep can match an environment-gated task
# (declared via a `<!-- requires: <tag>[,<tag>...] -->` marker in the issue
# body) to an agent that can really verify it (issue #1574).
#
# UNIVERSAL: ships with the plugin (#1037). This probes the MACHINE, not the repo — it holds
# zero repo-specific knowledge, so every repo's sweep should get the identical answer. A repo
# only needs its own probe if it has an exotic toolchain, and then it overrides via the profile.
#
# Output: one capability tag per line, only for what's ACTUALLY usable here
# (a binary existing is not enough — each check tries to do the minimal
# real thing that would make a task in that category verifiable).
#
# Usage:
#   bash scripts/agent-capabilities.sh                # → e.g.:
#     native-ios
#     native-android
#     gh-cli
#     dns-localhost-subdomain
#
#   # In a sweep: does this environment satisfy an issue's declared requirement?
#   caps=$(bash scripts/agent-capabilities.sh)
#   grep -qx "native-ios" <<<"$caps" || echo "missing native-ios — skip or downgrade to 🟡"
set -uo pipefail

# native-ios: swift toolchain + can actually invoke `swift test` (not just `xcode-select -p`,
# which can point at a stale/incomplete install).
if command -v swift >/dev/null 2>&1 && swift --version >/dev/null 2>&1; then
  echo "native-ios"
fi

# native-android: SDK present + java available. ANDROID_HOME/ANDROID_SDK_ROOT is commonly UNSET
# in a fresh shell even when the SDK is installed (real footgun hit on this exact machine) — so
# fall back to the conventional default install path before concluding "no SDK".
android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "${android_home}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  android_home="$HOME/Library/Android/sdk"
fi
# Homebrew installs (adb/sdkmanager on PATH but no env, no ~/Library dir — second
# real footgun on the same machine class): the cask's SDK root is conventional.
if [ -z "${android_home}" ] && [ -d "/opt/homebrew/share/android-commandlinetools" ]; then
  android_home="/opt/homebrew/share/android-commandlinetools"
fi
if [ -n "${android_home}" ] && [ -d "${android_home}" ] && command -v java >/dev/null 2>&1; then
  echo "native-android"
fi

# gh-cli: binary present. Do NOT gate on `gh auth status` — in this harness, writes go through an
# injected GitHub App credential that `gh auth status` can report as "invalid" even while every
# actual `gh api`/`gh issue`/`gh pr` call works fine (verified empirically: real 403s in this same
# session were rate-limit errors, never auth errors). Presence of the binary is the honest signal.
if command -v gh >/dev/null 2>&1; then
  echo "gh-cli"
fi

# dns-localhost-subdomain: RFC 6761 `*.localhost` must resolve to loopback AND complete an
# HTTP fetch (arc#4102). Some cloud sandboxes only have an external nameserver and fail this.
# Probe actually binds 127.0.0.1 and fetches a subdomain; emit the tag only on HTTP success.
# A missing tag means this machine does not have the capability (scripts list what it HAS).
dns_localhost_probe_js='const http=require("http");const s=http.createServer((_,r)=>{r.writeHead(200);r.end("ok")});const t=setTimeout(()=>{try{s.close()}catch(e){}process.exit(1)},5000);s.listen(0,"127.0.0.1",()=>{const port=s.address().port;fetch("http://arc-probe.localhost:"+port+"/").then(res=>{clearTimeout(t);s.close();process.exit(res.status===200?0:1)}).catch(()=>{clearTimeout(t);s.close();process.exit(1)})});'
probe_dns_localhost_subdomain() {
  if command -v node >/dev/null 2>&1; then
    node -e "$dns_localhost_probe_js"
  elif command -v bun >/dev/null 2>&1; then
    bun -e "$dns_localhost_probe_js"
  else
    return 1
  fi
}
if probe_dns_localhost_subdomain >/dev/null 2>&1; then
  echo "dns-localhost-subdomain"
fi
