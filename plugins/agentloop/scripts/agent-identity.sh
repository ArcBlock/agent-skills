#!/usr/bin/env bash
# agent-identity — the identity-line suffix carried by every agent comment (issue #1347).
# UNIVERSAL: ships with the plugin, works in any repo, needs no per-repo setup.
#
# Output (one line):
#   @ <hostname> · runner:<runner> · skills@<version>[-dirty]
#
# The three provenance axes it answers:
#   hostname  which machine ran it (vm = cloud routine, *.local = a laptop, runner-N = CI)
#   runner    who owns the routine/session. --runner > $ARC_AGENT_RUNNER > git user.name > whoami
#   skills@   WHICH VERSION OF THE SKILLS produced the comment — i.e. THIS PLUGIN's version,
#             plus the consuming repo's own `.claude/skills/` when it has any.
#
# Why the plugin ships this rather than each repo (#1037): the line describes the AGENT and
# its skills, not the repo. A repo cannot know the plugin's version, and a per-repo copy
# either drifts or (as measured on did/arcblock-site) simply does not exist, silently
# dropping provenance from every comment those repos' agents write.
#
# Usage:
#   suffix=$(bash "$AGENTLOOP_ROOT/scripts/agent-identity.sh")
#   bash "$AGENTLOOP_ROOT/scripts/agent-identity.sh" --header "PR Review"
#     → "> 🤖 AI Agent PR Review @ vm · runner:robert · skills@0.3.0"
# The `> 🤖 AI Agent` prefix is a sweep AI/human predicate — never change it.
set -uo pipefail

runner=""
header_mode=0
header_label=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runner) runner="${2-}"; shift 2 ;;
    --header) header_mode=1; header_label="${2-}"; shift 2 ;;
    *) shift ;;
  esac
done

host=$(python3 -c "import socket; print(socket.gethostname())" 2>/dev/null || hostname)

[ -z "${runner}" ] && runner="${ARC_AGENT_RUNNER:-}"
[ -z "${runner}" ] && runner=$(git config user.name 2>/dev/null || true)
[ -z "${runner}" ] && runner=$(whoami)

# The plugin's own root — this script's parent dir. Independent of where it is invoked from.
plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

version_of() { # read plugin.json's version without needing jq
  python3 -c "import json;print(json.load(open('$1/.claude-plugin/plugin.json'))['version'])" 2>/dev/null
}

# A marketplace install lives in a version-pinned cache dir with NO .git, so a git fingerprint
# is impossible there — and unnecessary, since the version IS the identity. Only a checked-out
# plugin (vendored, or the dev source) gets the sharper commit hash.
skills_hash=""
dirty=""
if git -C "${plugin_root}" rev-parse --git-dir >/dev/null 2>&1; then
  repo_root=$(git -C "${plugin_root}" rev-parse --show-toplevel 2>/dev/null || echo "${plugin_root}")
  # Fingerprint the plugin, plus this repo's own skills tree when it has one (arc does).
  paths="${plugin_root}"
  [ -d "${repo_root}/.claude/skills" ] && paths="${paths} ${repo_root}/.claude/skills"
  # shellcheck disable=SC2086
  skills_hash=$(git -C "${repo_root}" log -1 --format=%h -- ${paths} 2>/dev/null || true)
  # shellcheck disable=SC2086
  [ -n "$(git -C "${repo_root}" status --porcelain -- ${paths} 2>/dev/null)" ] && dirty="-dirty"
fi
if [ -z "${skills_hash}" ]; then
  v=$(version_of "${plugin_root}")
  # A shallow clone can hide path history; the version still locates the code.
  skills_hash="${v:-unknown}"
fi

suffix="@ ${host} · runner:${runner} · skills@${skills_hash}${dirty}"
if [ "${header_mode}" = "1" ]; then
  if [ -n "${header_label}" ]; then echo "> 🤖 AI Agent ${header_label} ${suffix}"; else echo "> 🤖 AI Agent ${suffix}"; fi
else
  echo "${suffix}"
fi
