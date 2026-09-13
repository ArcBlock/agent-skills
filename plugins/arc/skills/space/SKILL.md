---
name: "space"
description: "When to use: persist app state without a separate DB+object store — DID Space is the strongest AFS implementation (paths under /spaces, /user, /instance)."
---
# ARC skill: space

**DID Space** is Arc’s durable data plane: path-addressed objects that apps can
treat as the default persistence layer so they **do not need a separate database
plus object storage**. Space is an AFS implementation optimized for that model —
not “another cloud drive.”

Offline booklet only. Prefer live `explain` / `/.knowledge` after a daemon is up
(`arc skill show daemon`, `arc skill show afs`).

## Prefer

1. `arc skill list` → this booklet when the task is **store / list / persist**
2. Live paths: `arc afs explain /spaces`, `arc afs read /.knowledge`
3. CLI ops: `arc space --help` (verify flags; do not invent subcommands)

## Product rules (do not invent ontology)

- Persist into Space (or session `/user` / `/instance` projections) by default.
- Treat path objects as first-class app data (content objects), not side files.
- For discovery/search over those objects → `arc skill show index` (`/modules/index`).
- Do **not** reinvent CID/auth protocols here; reuse existing Space + AFS APIs.

## Discover (daemon up)

Add `--instance <name>` to every `arc afs` call unless you are on the default
instance (`arc skill show afs`).

```bash
arc space --help
arc space list
arc afs ls /spaces --instance <name>
arc afs explain /spaces --instance <name>
arc afs read /.knowledge --instance <name>
# Per-space drill (DID / storage-scope directory name from ls):
arc afs ls /spaces/<scope> --instance <name>
arc afs explain /spaces/<scope> --instance <name>
```

Session views (when mounted): `/user` (caller data), `/instance` (instance data),
sometimes `/space` (caller whole Space root). Prefer `explain` those paths before
writing.

## Claim / inspect a local folder Space

```bash
# Claim a folder as a writable DID Space (creates .did-space/ when needed)
arc space init <dir>
arc space check
arc space path <app-did> [subpath]   # print AFS path for an app fragment
arc space tree <app-did>             # file tree (--scope instance|user)
```

`arc space init` / `list` / `check` / `tree` / `path` are the offline-safe CRUD
surface. Confirm exact flags with `--help`.

## Minimal write → still just AFS

Once a Space (or `/user`) is writable in the live world:

```bash
# Example shape only — confirm path + write contract with explain/stat first
arc afs write /user/notes/hello.md "hello from space" --instance <name>
arc afs read /user/notes/hello.md --instance <name>
arc afs ls /user/notes --instance <name>
```

No external DB required for that object. Indexing/search is a separate layer:
`arc skill show index`.

## Related

- Index / FTS / vector: `arc skill show index`
- Path ops / WM: `arc skill show afs`
- Daemon: `arc skill show daemon`
- Offline catalog: `arc skill list`
- Install: `arc skill install space`
