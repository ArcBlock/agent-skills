---
name: "afs"
description: "Use AFS paths via `arc afs` (list/read/write/exec/explain) once a world is available."
---
# ARC skill: afs

AFS is the path-addressed world. **Prefer MCP (`arc skill show mcp`) or the
daemon HTTP API (`POST /afs` on the instance's own port) for live agent
work** — both attach to one already-known instance without ambiguity.

`arc afs <cmd>` is for **ad-hoc inspection of a named instance** from a
terminal. It never silently picks a world: pass `--instance <name>` to
attach to a specific instance's daemon, or `--standalone` for a throwaway
ad-hoc AFS with no daemon and no runtime state. Bare `arc afs <cmd>` (no
flag) targets the **default** instance and fails closed — non-zero exit —
if that instance has no daemon running.

## Core ops

```bash
arc afs ls [path] --instance <name>
arc afs read <path> --instance <name>
arc afs write <path> [content] --instance <name>
arc afs stat <path> --instance <name>
arc afs exec <executable_path> --args '<json-object>' --instance <name>
arc afs search <path> <query> --instance <name>
arc afs explain [topic|path] --instance <name>
```

Every example above works the same with `--standalone` instead of
`--instance <name>` (ad-hoc mode; the first output line reads `[standalone]`).

**`arc afs mount` is the exception — it is NOT instance-scoped.** Its four
subcommands (`add` / `remove` / `list` / `validate`) only read and write the
`.afs-config/config.toml` found by walking up from the current directory, and
they **reject** `--instance` / `-i` / `--home` rather than accept-and-ignore
them. To mount a path into a **running** instance, use `arc attach`:

```bash
cd <dir-with-.afs-config>  &&  arc afs mount list        # edit/inspect the cwd config
arc attach --to ws://localhost:<port> --namespace <ns> --source <dir>   # runtime mount
```

**Exec args (critical):** pass parameters as **one JSON object**. Check the
exact shape with `arc afs exec --help` (per-command help never needs an
instance).

```bash
arc afs exec /some/.actions/foo --args '{"key":"value"}' --instance <name>
```

Do **not** invent bare `key=value` after `--` unless `exec --help` documents
it. When in doubt: `--args '{...}'`.

## Which instance am I talking to?

Never trust a result without knowing which world it came from:

```bash
arc service list                          # names + status of every registered instance
arc service status --instance <name> --print port    # confirm the daemon you think is up, is up
```

- `--instance <name>` attaches to that instance's daemon. If it has no
  daemon running, the command fails closed (non-zero exit, `arc service
  start --instance <name>` in the error).
- `--standalone` never touches a daemon — an ad-hoc AFS is built from local
  config, and the first output line is tagged `[standalone]` so you can't
  mistake it for a live world:
  ```bash
  arc afs ls / --standalone   # no daemon, no runtime state
  ```
- There is no third mode. A path that 404s or looks stale means **re-check
  which instance you attached to** (`arc service status --instance <name>`), not
  "trust whatever tree came back."

## Discover protocol (when you are stuck)

1. `arc service status --instance <name> --print port` — confirm the instance is up
2. `arc afs ls / --instance <name>`
3. `arc afs explain / --instance <name>`
4. `arc afs read /.knowledge --instance <name>` — capability index (providers + actions)
5. Full site: `arc skill show site` → `explain /web`, `list /web/.library/themes` (not bare `/.library/themes`), storage `/work`
6. Data plane: `arc skill show space` / `arc skill show index`, then `explain /spaces` and `explain /modules/index`
7. Drill: `ls` parent → `explain` parent → `ls …/.actions` → `exec` with `--args`
8. Provider detail: `arc afs read /.knowledge/<provider-name> --instance <name>`

## Agent output contract

- Prefer structured output when available: global `--json` / `--view llm` where supported.
- Never invent mount tables offline — **list live paths** after connect.
- Destructive ops (`delete`, dangerous `exec`) require clear human/agent intent; fail closed when unsure.

## Concepts (offline-safe)

- **mount**: a provider rooted at a virtual path
- **path**: virtual location, e.g. `/src`, `/dev/ui`
- **uri**: backend address, e.g. `fs://`, `sqlite://`

```text
User path → AFS → /{mount} → Provider → backend
```

## UI device + WM / multi-terminal (L1)

UI is a **system device** under **`/dev/ui`** (not bare `/ui`). Every
`arc afs` example below carries `--instance <name>` — swap in the instance
you're actually attached to (or add `--standalone` yourself).

Web multi-terminal is **WM `panels` + leaf terminal surfaces**, not tmux inside one device.

### Session without a browser

HTTP/daemon up ≠ AUP session. If `arc afs ls /dev/ui/web/sessions --instance <name>` is empty:

```bash
arc afs explain /dev/ui/web --instance <name>
# Expect action create-named-session

arc afs exec /dev/ui/web/.actions/create-named-session --instance <name> \
  --args '{"name":"agent-1"}'
# → { "sessionId": "agent-1" }
# Same name **replaces** the session (clears prior WM surfaces). Do not re-run once you have layout state.
```

### Panels multi-term (full-bleed wall — prefer this over floating tiles)

**`open-surface` requires `name`** (surface handle). Do **not** pass only `id` — live validation fails with `name: expected string`. Node `content.id` is the AUP tree id, not the surface handle.

```bash
SID=agent-1
WM=/dev/ui/web/sessions/$SID/wm

arc afs exec $WM/.actions/set-strategy --args '{"strategy":"panels"}' --instance <name>
arc afs exec $WM/.actions/set-layout --args '{"preset":"explorer"}' --instance <name>

# Always: explain $WM/.actions/open-surface first if unsure of the schema
arc afs exec $WM/.actions/open-surface --instance <name> --args '{
  "name":"term-a","panel":"primary",
  "content":{"id":"t1","type":"terminal","props":{"endpoint":"/ws/terminal?panel=term-a"}}
}'
arc afs exec $WM/.actions/open-surface --instance <name> --args '{
  "name":"term-b","panel":"primary",
  "content":{"id":"t2","type":"terminal","props":{"endpoint":"/ws/terminal?panel=term-b"}}
}'
# Default does NOT steal focus when other surfaces exist (activated:false) — set-active only if intentional
arc afs exec $WM/.actions/open-surface --instance <name> --args '{
  "name":"notes","panel":"sidebar",
  "content":{"id":"n1","type":"text","props":{"content":"notes","format":"markdown"}}
}'
arc afs exec $WM/.actions/set-active --args '{"name":"term-a"}' --instance <name>

# Verify (PASS checks for multi-term walls)
arc afs read $WM/strategy --instance <name>   # → panels
arc afs read $WM/layout --instance <name>     # panels[] + panelActives
arc afs ls $WM/surfaces --instance <name>     # ≥2 terminals + ≥1 other
```

- **`strategy: panels`**: full-bleed grid (ops wall / multi-monitor). Prefer for “fill the screen”.
- **`strategy: floating`**: desktop windows (draggable). Do **not** use floating tiles to fake a monitor wall.
- Each live web-terminal WS is a separate session; use distinct `endpoint` query suffixes per panel.
- Prefer **`content: { type, props }`** over inventing a top-level `component` field — when in doubt, `explain …/open-surface`.

### Verify primitives catalog (optional)

```bash
arc afs ls /dev/ui/primitives --instance <name>
arc afs ls /dev/ui/components --instance <name>
```

## Related

- Start/connect: `arc skill show daemon`
- Full site / themes / serve vs build / ports: `arc skill show site`
- DID Space / persist: `arc skill show space`
- Retrieval Index (FTS/vector): `arc skill show index`
- MCP: `arc skill show mcp`
- Install booklet: `arc skill install afs`
