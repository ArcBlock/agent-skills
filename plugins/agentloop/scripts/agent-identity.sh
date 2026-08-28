#!/usr/bin/env bash
# agent-identity — the identity-line suffix carried by every agent comment (issue #1347).
# UNIVERSAL: ships with the plugin, works in any repo, needs no per-repo setup.
#
# Output (one line):
#   @ <hostname> · runner:<runner> · agentloop@<version>[+<hash>][-dirty][ · skill:<id>] · engine:<kind|unknown>[/<model>]
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
#   engine:    WHICH TOOL ran it — claude, codex, or unknown — plus the model IF it is
#              actually known. **Always present now, never omitted** (see "engine self-
#              detect" below for why: a missing segment used to mean either "untracked" or
#              "nobody asked", and a reader could not tell which).
#              Priority: --engine/--model flag > $ARC_AGENT_ENGINE/$ARC_AGENT_MODEL (set by
#              the fleet driver, which always knows engine.kind but not always engine.model —
#              a codex run with no explicit `engine.model` gets no `-m` flag, so the CLI picks
#              its own default and the driver never learns what it was) > self-detected via
#              the tool's own ambient env var (works for cloud routines and interactive
#              sessions, which have no launcher to hand engine info down) > `unknown` as a
#              last resort. Model is NEVER filled in by self-detection or guessed when
#              unknown — printing a wrong model is worse than admitting we don't know it
#              (agent-skills#28); only an explicit flag or $ARC_AGENT_MODEL can supply it.
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

# Self-detect the running CLI when nothing above supplied one. --engine/--model and
# $ARC_AGENT_ENGINE come from a LAUNCHER that knows what it started (the fleet driver);
# cloud routines and interactive/ad-hoc sessions have no launcher, so without this tier
# their identity line silently omitted `engine:` — "no signal" and "nobody asked" looked
# identical, and a reader could not tell whether the tool was untracked or genuinely
# unknown (issue raised after comparing two 0.28.15 comments, one with engine: one
# without, same version — the difference was invocation path, not version).
#
# Detection reads the CLI's OWN ambient env var, set by the tool itself for every one of
# its sessions — not something this repo or the fleet driver injects — so it works
# regardless of who launched it. Confidence differs per tool:
#   claude  CLAUDECODE=1 — Anthropic's CLI sets this for every session (verified live
#           against a running session, 2026-08), but an ancestor Claude process can leak
#           it into a different engine. It is only a fallback; a launcher must set
#           ARC_AGENT_ENGINE to the engine it actually spawned. $CLAUDE_CODE_ENTRYPOINT /
#           a live-model
#           env var do not exist, so self-detection can only ever fill `kind`, never
#           `model` — that stays the launcher's job.
#   codex   CODEX_SANDBOX is present — best-effort only. OpenAI has not documented this
#           var (github.com/openai/codex#3064); it is an observed implementation detail
#           that could change without notice. Treated as a signal, not a promise.
# Add a new tool here ONLY once its OWN self-identifying env var is confirmed against a
# live session of that tool. A CLI flag's `[env: X_SANDBOX=]` in --help is user-supplied
# CONFIG the flag reads, not proof the tool stamps that var into every child process —
# do not add an entry on that evidence alone (checked for Grok Build, 2026-08: only a
# config-input env var is documented, no self-identifying one confirmed yet).
if [ -z "${engine}" ]; then
  if [ -n "${CLAUDECODE:-}" ]; then
    engine="claude"
  elif [ -n "${CODEX_SANDBOX:-}" ]; then
    engine="codex"
  fi
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

# Always emitted now, never omitted — "unknown" is a visible, honest answer; a missing
# segment let "untracked" and "nobody asked" look the same (see the self-detect comment
# above). Model still only ever comes from an explicit --model/$ARC_AGENT_MODEL source;
# self-detection never fills it in, per the "never guess a model" rule above.
engine_seg=""
if [ -n "${engine}" ]; then
  if [ -n "${model}" ]; then
    engine_seg=" · engine:${engine}/${model}"
  else
    engine_seg=" · engine:${engine}"
  fi
else
  engine_seg=" · engine:unknown"
fi

suffix="@ ${host} · runner:${runner} · agentloop@${skills_id}${dirty}${skill_seg}${engine_seg}"
if [ "${header_mode}" = "1" ]; then
  if [ -n "${header_label}" ]; then echo "> 🤖 AI Agent ${header_label} ${suffix}"; else echo "> 🤖 AI Agent ${suffix}"; fi
else
  echo "${suffix}"
fi
