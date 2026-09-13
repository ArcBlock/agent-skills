---
name: "daemon"
description: "Start, attach, and check the ARC daemon / service without breaking a live session."
---
# ARC skill: daemon

Bootstrap a **running ARC daemon** so L1 paths (mounts, blocklets, MCP, UI/WM) become real.

## Prefer

1. Discover this catalog first: `arc skill` or `arc skill list`
2. Load only the booklet you need: `arc skill show <name>`
3. Prefer **JSON** for agents: `arc skill list --json` (or global `--json` when supported)

## Safe rules

- Prefer inspecting status before mutating: `arc service status`.
- Do **not** kill or force-stop a daemon you did not start unless the human explicitly asked.
- **Never stop `purpose=observe` daemons.** Session end is not a stop. Killing observe is a contract break — the row stays in `/dev/instances` as DOWN, it does not disappear.
- Prefer attaching to an already-running daemon over spawning a second conflicting instance on the same `--home`/port.
- Discovery commands must be **side-effect free**. Do not probe by starting long-lived servers "just to see help".
- Optional isolation: `arc service start --instance <name> --home <dir>` (see `arc service start --help`).

## Typical flow

```bash
arc --help
arc skill list
arc service status

# Start when needed (check --help for flags)
arc service start
# or: arc service start --instance <name> --port <port>   (named instance)

arc service status
# Then L1 — targets the instance you just started:
arc afs ls /
arc afs explain /
arc afs read /.knowledge
```

Started a **named** instance (`arc service start --instance <name>`) instead of the
default one? `arc afs` never guesses which world you mean — add
`--instance <name>` to every `arc afs` call in this booklet (bare `arc afs`
targets the default instance and fails closed, non-zero exit, if that one
has no daemon running). `arc skill show afs` covers this in depth.

`arc service start` registers this daemon in the machine instance catalog (`$ARC_INSTANCES_DIR`, default `~/.arc/instances`). Clean `arc service stop` removes the row. Crash leftovers stay until GC.

Headless Linux / no D-Bus session? Read **Headless vault** below before `arc service start` — do not invent a vault key.

## Headless vault (Linux / no GUI)

Linux OS keychain is **Secret Service** (`secret-tool`). A headless box often has **no `secret-tool` and no D-Bus session**. In that state the daemon will **not** invent a new master key (minting one would make existing `vault.enc` files undecryptable).

**Working pattern:** `dbus-run-session` + `AFS_VAULT_KEY=<64 hex>` on the **daemon process** (`arc service start`), not a later CLI client shell. Exporting the key only where you run `arc afs` does not reach vault bootstrap.

```text
dbus-run-session -- env AFS_VAULT_KEY=<64-hex> arc service start
dbus-run-session -- env AFS_VAULT_KEY=<64-hex> arc service start --instance <name> --home <dir>
```

`AFS_VAULT_KEY` must be exactly **64 hex characters** (32 bytes). First-run with no existing vaults: `openssl rand -hex 32`. Existing vaults need the **original** key, not a newly generated one.

**Wrong length or format** does not unlock the vault. You hit **key already exists / refusing overwrite**. Recovery: set the **correct** 64-hex `AFS_VAULT_KEY` on `arc service start` and restart the daemon. Do **not** overwrite the keychain entry.

## Instance catalog (`/dev/instances`)

This is the **local instance catalog**, not AFS small-world and not `/peers`.

```bash
arc afs ls /dev/instances --instance <name>
arc afs read /dev/instances/<id> --instance <name>
```

- Default `ls` lists `purpose=observe` rows. `purpose=evidence` (short-lived ui-verify) is omitted from the default list; read by id still works.
- Set purpose at start time: `arc service start --instance <name> --purpose observe|evidence` (default observe). Invalid value fails closed before the instance is claimed. `restart` reuses whatever the instance was already recorded with — `--purpose` is refused there, same as `--port`/`--host`.
- `ARC_INSTANCE_PURPOSE` is **retired** — setting it prints a warning and is ignored; it is no longer a way to set purpose.
- Do not invent a second discovery path. Do not scan ports. Do not stop observe instances to "clean up".

Stale registry files (dead pid) are catalog leftovers, not running daemons. Inspect, then GC:

```bash
arc service list
arc service gc
```

`arc service gc` (alias `prune`) drops dead registry rows only. It does not stop daemons. Do not `arc service stop` a `purpose=observe` instance to "clean up".

## After daemon is up (L1)

Dynamic inventory lives in **AFS**, not in this booklet:

- **Always** start discovery with: `arc afs ls / --instance <name>`,
  `arc afs explain / --instance <name>`, `arc afs read /.knowledge --instance <name>`
  (omit `--instance` only for the default instance)
- Instance catalog: `arc afs ls /dev/instances --instance <name>`
- Multi web-terminal + WM: `arc skill show afs` → section *WM / multi-terminal*
- MCP: `arc skill show mcp`

## Next skills after the daemon is up

```bash
arc skill show afs         # paths, /.knowledge, WM panels
arc skill show site        # create-site / themes — full website path
arc skill show space       # DID Space — persist without DB+object store
arc skill show index       # /modules/index — FTS / anchors / optional vectors
arc skill show blocklet    # create / build / list blocklets
arc skill show site        # create-site, serve vs build, :4900 vs web host vs *.localhost
arc skill install afs      # optional: write SKILL.md into .agents/.claude
```

## Related

- Catalog: `arc skill list`
- AFS ops: `arc skill show afs`
- Site / data plane / URLs: `arc skill show site` (and live `arc afs explain /web`), `arc skill show space`, `arc skill show index`
- Local Pages deploy: `arc skill show site` — daemon env `AFS_TEST_PAGES_LOCAL=1` **or** deploy `{ local: true }`
- Install: `arc skill install daemon` (or `install all`)
