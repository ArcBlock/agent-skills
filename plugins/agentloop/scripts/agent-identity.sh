#!/usr/bin/env bash
# agent-identity — the identity-line suffix carried by every agent comment (issue #1347).
# UNIVERSAL: ships with the plugin, works in any repo, needs no per-repo setup.
#
# Output (one line):
#   @ <hostname> · runner:<runner> · agentloop@<version>[+<hash>][-dirty][ · skill:<id>][ · engine:<kind>[/<model>]]
#
# The provenance axes it answers:
#   hostname   which machine ran it (vm = cloud routine, *.local = a laptop, runner-N = CI)
#   runner     who owns the routine/session. --runner > $ARC_AGENT_RUNNER > git user.name > whoami
#   agentloop@ WHICH VERSION OF THE SKILLS produced the comment. **The semver is always present**
#              — it is the thing a reader can act on ("are you on the version that has the fix?").
#              A checked-out tree appends `+<commit>` for the sharper answer; the commit
#              fingerprints THIS PLUGIN plus the consuming repo's own `.claude/skills/` when it
#              has any, so it moves when either tree moves. `-dirty` = uncommitted local edits.
#              Was `skills@<commit-or-version>`: in a git tree it printed a BARE COMMIT and no
#              semver at all, so the common case answered neither "which version" nor "which
#              plugin" (arc#2713 follow-up — a reader staring at `skills@eb9a70f1` cannot tell
#              whether it predates a given fix). Renamed off `skills@` because it sat one
#              character from the new `skill:` segment.
#   skill:     WHICH SKILL wrote this comment (`pr-review`, `issue-sweep`, `verification`, …).
#              The human label after "AI Agent" is prose chosen per call site ("PR Review",
#              "Audit", "— UI 验证报告"); this segment is the stable machine id. Omitted when the
#              caller does not pass --skill, so external callers keep working unchanged.
#   engine    claude or codex, and the model IF it is actually known (--engine/--model >
#             $ARC_AGENT_ENGINE/$ARC_AGENT_MODEL > omitted). The fleet driver always knows
#             engine.kind (resolveEngine defaults to claude) but NOT always engine.model — a
#             codex run with no explicit `engine.model` gets no `-m` flag, so the CLI picks its
#             own default and the driver never learns what it was. In that case print the kind
#             alone; never guess a model, that would be worse than admitting we don't know it
#             (agent-skills#28). Interactive/ad-hoc sessions have no env signal for either axis
#             (no live-model env var exists in either CLI) — the calling skill must pass
#             --engine/--model from the agent's own self-knowledge if it wants this segment.
#
# Why the plugin ships this rather than each repo (#1037): the line describes the AGENT and
# its skills, not the repo. A repo cannot know the plugin's version, and a per-repo copy
# either drifts or (as measured on did/arcblock-site) simply does not exist, silently
# dropping provenance from every comment those repos' agents write.
#
# Usage:
#   suffix=$(bash "$AGENTLOOP_ROOT/scripts/agent-identity.sh")
#   bash "$AGENTLOOP_ROOT/scripts/agent-identity.sh" --header "PR Review" --skill pr-review
#     → "> 🤖 AI Agent PR Review @ vm · runner:robert · agentloop@0.27.0+eb9a70f1 · skill:pr-review · engine:codex/gpt-5-codex"
# The `> 🤖 AI Agent` prefix is a sweep AI/human predicate — never change it.
set -uo pipefail

runner=""
engine=""
model=""
skill=""
header_mode=0
header_label=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runner) runner="${2-}"; shift 2 ;;
    --engine) engine="${2-}"; shift 2 ;;
    --model) model="${2-}"; shift 2 ;;
    --skill) skill="${2-}"; shift 2 ;;
    --header) header_mode=1; header_label="${2-}"; shift 2 ;;
    *) shift ;;
  esac
done

[ -z "${skill}" ] && skill="${AGENTLOOP_SKILL:-}"

# engine/model fall back to the ambient $ARC_AGENT_ENGINE/$ARC_AGENT_MODEL as a PAIR, not
# independently: they describe THIS session's own identity together. An explicit --engine
# override (e.g. a caller reporting on a different engine than the one currently running)
# must not then get grafted onto the ambient model — that model was measured for the
# ambient engine, not the overridden one (agent-skills#28: "codex" was getting the CURRENT
# claude session's model appended, e.g. "engine:codex/claude-sonnet-5").
engine_from_flag=""
[ -n "${engine}" ] && engine_from_flag=1
[ -z "${engine}" ] && engine="${ARC_AGENT_ENGINE:-}"
if [ -z "${engine_from_flag}" ]; then
  [ -z "${model}" ] && model="${ARC_AGENT_MODEL:-}"
fi

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
#
# `rev-parse --git-dir` is NOT a sufficient test: git walks UP, so a cache install under a
# versioned ~/.claude reports that unrelated repo, and its dirty state then leaks into every
# identity line as a permanent "-dirty" (measured: ~/.claude had 62 dirty entries, so every
# repo consuming the marketplace install claimed its skills were locally modified). A tree
# only counts if it actually TRACKS the plugin manifest.
in_own_git_tree() {
  git -C "$1" rev-parse --git-dir >/dev/null 2>&1 &&
    git -C "$1" ls-files --error-unmatch ".claude-plugin/plugin.json" >/dev/null 2>&1
}

# The semver ALWAYS leads — it is the actionable half ("does this run have the fix?").
# The commit is precision on top, available only in a checked-out tree.
version=$(version_of "${plugin_root}")
version="${version:-unknown}"

skills_hash=""
dirty=""
if in_own_git_tree "${plugin_root}"; then
  repo_root=$(git -C "${plugin_root}" rev-parse --show-toplevel 2>/dev/null || echo "${plugin_root}")
  # Fingerprint the plugin, plus this repo's own skills tree when it has one (arc does).
  paths="${plugin_root}"
  [ -d "${repo_root}/.claude/skills" ] && paths="${paths} ${repo_root}/.claude/skills"
  # shellcheck disable=SC2086
  skills_hash=$(git -C "${repo_root}" log -1 --format=%h -- ${paths} 2>/dev/null || true)
  # shellcheck disable=SC2086
  [ -n "$(git -C "${repo_root}" status --porcelain -- ${paths} 2>/dev/null)" ] && dirty="-dirty"
fi

# `<version>` on a marketplace install (no git, and none needed — the version IS the identity);
# `<version>+<commit>` in a checked-out tree. A shallow clone can hide path history, in which
# case the commit is simply absent and the version still locates the code.
skills_id="${version}"
[ -n "${skills_hash}" ] && skills_id="${version}+${skills_hash}"

skill_seg=""
[ -n "${skill}" ] && skill_seg=" · skill:${skill}"

engine_seg=""
if [ -n "${engine}" ]; then
  if [ -n "${model}" ]; then
    engine_seg=" · engine:${engine}/${model}"
  else
    engine_seg=" · engine:${engine}"
  fi
fi

suffix="@ ${host} · runner:${runner} · agentloop@${skills_id}${dirty}${skill_seg}${engine_seg}"
if [ "${header_mode}" = "1" ]; then
  if [ -n "${header_label}" ]; then echo "> 🤖 AI Agent ${header_label} ${suffix}"; else echo "> 🤖 AI Agent ${suffix}"; fi
else
  echo "${suffix}"
fi
