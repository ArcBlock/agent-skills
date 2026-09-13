# arc

ARC agent plugin for **Claude Code**, **Claude Desktop**, **Codex CLI**, and
**Grok Build**. One source tree, two runtime manifests
(`.claude-plugin/plugin.json` edited by humans;
`.codex-plugin/plugin.json` generated on publish). There is no
`.grok-plugin/` — Grok validates and loads the Claude shape.

Developed in `ArcBlock/arc` (`.claude/plugins/arc/`). Distributed via the
`ArcBlock/agent-skills` marketplace mirror. Publish with:

```bash
bash scripts/publish-arc-plugin.sh --dry-run          # evidence only
bash scripts/publish-arc-plugin.sh --check <dest>     # three-place version gate
bash scripts/publish-arc-plugin.sh [--bump patch] <path-to-agent-skills>
```

## Local vs remote (v1 boundary)

| Mode | What it is | Status |
|---|---|---|
| **Local stdio (v1)** | `.mcp.json` → `{"command":"arc","args":["mcp"]}` on the host that has a shell | **This plugin** |
| **Remote MCP** | streamable-HTTP connector to a hosted arc instance (no shell hosts: claude.ai web / ChatGPT web) | **Out of scope** — tracked as [#6432](https://github.com/ArcBlock/arc/issues/6432). **Not available from this plugin today.** Do not silence that gap. |

If a host has no shell, do not install this plugin and expect remote tools.
Use a Mode B / remote-MCP connector when #6432 ships.

## Not `@blocklet/cli`

| | **arc** (this plugin) | **`@blocklet/cli`** |
|---|---|---|
| What | Agent plugin: skills + local MCP + `ensure-arc.sh` bootstrap around the `arc` binary | Separate npm CLI for Blocklet Server / blocklet packaging |
| Install | Host plugin commands below (marketplace) | `npm i -g @blocklet/cli` (or project dependency) |
| Agent confusion | Agents often conflate the two. Prefer `arc …` after this plugin’s bootstrap; do not substitute `blocklet` CLI subcommands for `arc` MCP / skills. |

## Install (three hosts)

Zero-state machine → one journey (`install → list-skills → mcp-initialize → …`).
Full walkthrough: [`docs/guides/arc-plugin-interop-walkthrough.md`](../../../docs/guides/arc-plugin-interop-walkthrough.md).

### Claude Code / Claude Desktop

```text
/plugin marketplace add ArcBlock/agent-skills
/plugin install arc@arcblock-agent-skills
```

### Grok Build

Grok does **not** accept `name@marketplace`. Use GitHub shorthand + `#subdir`:

```bash
grok plugin install ArcBlock/agent-skills#plugins/arc --trust
```

### Codex CLI

Subcommand is **`add`**, not `install` (confirm with `codex plugin --help`):

```bash
codex plugin marketplace add https://github.com/ArcBlock/agent-skills
codex plugin add arc
```

## What’s in the tree

```
.claude-plugin/plugin.json   # Claude Code / Grok — human-edited
.codex-plugin/plugin.json    # Codex — generated copy (byte-identical)
.mcp.json                    # v1 local stdio only (arc-local)
bin/arc                      # shim → scripts/ensure-arc.sh
hooks/hooks.json             # Setup / SessionStart → ensure-arc
scripts/ensure-arc.sh        # idempotent CLI bootstrap
skills/*/SKILL.md            # projected from booklets (do not hand-drift)
```

## Version discipline

Both manifests and the marketplace entry must share one semver (three places).
`bash scripts/publish-arc-plugin.sh --check <agent-skills>` exits **1** on
mismatch. Content changes require a version bump before publish.
