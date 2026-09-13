---
name: "mcp"
description: "Connect MCP clients (`arc mcp`), negotiate local vs remote capability, and explore the live AFS tool surface."
---
# ARC skill: mcp

MCP is a **transport into the same AFS world**, not a second ontology.

## Capability negotiation (local first)

Decide which MCP path is available **before** assuming tools exist:

| Host situation | What to do |
|---|---|
| `arc` CLI is on `PATH` | Use **local stdio**: plugin `.mcp.json` server `arc-local` → `arc mcp` (bridge to the daemon; starts it if needed). |
| `arc` CLI is **not** on `PATH` | Plugin skills still load. Do **not** treat this as a silent total failure. Install the CLI (`curl -fsSL https://arc.afsd.io/install.sh \| bash` — see `docs/guides/arc-cli-distribution.md`). Plugin bootstrap that auto-installs CLI is **S5** (not shipped yet). |
| Want remote / no-shell host | **Not ready in v1.** `arc-remote` is intentionally absent from `.mcp.json` so "not configured" is not the same colour as "endpoint down". Tracked in **#6432** (hosted endpoint + OAuth grant). |

**Say the remote path is unready out loud.** An agent that reads "remote unavailable" behaves differently from one that never sees remote mentioned.

Distinguish failure **reasons** when local MCP will not start:

- **`arc` missing** — `command not found` / spawn ENOENT for `arc`. Fix: install CLI (above). Message shape: needs `arc` on PATH.
- **`arc` present but daemon unreachable** — CLI runs; bridge cannot attach / daemon will not stay up. Fix: `arc service start` (or check instance). Message shape: daemon unavailable — **not** "arc missing".

## Connect

```bash
# Bridge stdio MCP client ↔ running daemon (auto-starts daemon if configured to)
arc mcp

# Standalone serve variants exist under `arc serve --transport mcp-*`
# Check: arc serve --help
```

## After connect (L1)

Prefer live AFS tools over re-reading booklets. For multi-terminal layout pointers:

```bash
arc skill show afs   # section: WM / multi-terminal
```

Plugin `.mcp.json` (v1 — local only, flat format — **no** `mcpServers` wrapper):

```json
{
  "arc-local": { "command": "arc", "args": ["mcp"] }
}
```

Claude Desktop user config (outside the plugin) still uses the `mcpServers` envelope:

```json
{
  "mcpServers": {
    "AFS": { "command": "arc", "args": ["mcp"] }
  }
}
```

## Agent discipline

- Use MCP **explore** / tools to discover **live** mounts and tools after connect.
- Do not treat MCP tool lists as a substitute for offline `arc skill` bootstrap.
- Mutations still go through AFS semantics (path write/exec) with the same safety expectations.
- If MCP initialize fails, read this skill's negotiation table — do not invent a remote server entry.

## Related

- Offline bootstrap: `arc skill list`
- Daemon: `arc skill show daemon`
- Path ops: `arc skill show afs`
- Remote MCP (deferred): GitHub issue #6432
