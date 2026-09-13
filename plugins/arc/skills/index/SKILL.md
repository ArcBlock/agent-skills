---
name: "index"
description: "When to use: find AFS/DID Space content via FTS, anchors, or optional vectors at `/modules/index` (retrieval Index — not the federated AFS Index manifest)."
---
# ARC skill: index

**`/modules/index`** is Arc’s **retrieval Index**: structured discovery over
path-addressed objects (FTS, anchors, optional semantic/vector). It exists so
“looks like files on AFS” stays queryable without a full-tree scan.

Offline booklet only. Prefer live `explain` after a daemon is up.

## Name disambiguation (read this)

| Name | Meaning | This skill? |
|------|---------|-------------|
| **`/modules/index`** | Retrieval provider — `index` / `query` / `reindex` (FTS, anchors, optional vectors) | **Yes** |
| **AFS Index** (manifest-of-manifests) | Federated routing / distributed naming of AFS sources | **No** — architecture docs only; do not mix into query recipes |

If the task is “search my objects,” you want **`/modules/index`**.

## Prefer

1. `arc skill show space` when you still need somewhere durable to **write** objects
2. Then this booklet for **find / query**
3. Live: `arc afs explain /modules/index` + `list …/.actions`

## Discover (daemon up)

```bash
arc afs explain /modules/index --instance <name>
arc afs ls /modules/index --instance <name>
arc afs ls /modules/index/.actions --instance <name>
arc afs read /.knowledge/index --instance <name>   # when that knowledge entry exists
```

Always `explain` an action path before inventing `--args`.

## Golden path: write object → index → FTS query

Space (or `/user`) holds the object; Index discovers it. Many mounts
auto-index on write; you can also call `index` explicitly.

```bash
# 1) Persist a small object (confirm writable path with explain first)
arc afs write /user/notes/hello.md "arc space index golden path" --instance <name>

# 2) Optional explicit index (schema via explain …/index)
arc afs exec /modules/index/.actions/index --instance <name> \
  --args '{"entryPath":"/user/notes/hello.md","summary":"arc space index golden path"}'

# 3) FTS query
arc afs exec /modules/index/.actions/query --instance <name> \
  --args '{"mode":"fts","text":"golden path","opts":{"limit":10}}'

# Optional: semantic/vector when embeddings are configured in the live world
# arc afs exec /modules/index/.actions/query --args '{"mode":"semantic","text":"..."}' --instance <name>
```

Other useful actions (names only — take args from `explain`):
`reindex`, `get`, `cleanup`, `register-domain`, `discover`.

## Decision tree

- **Know the path** → `arc afs ls` / `read` / `stat`
- **Need search / facets / recall** → `/modules/index/.actions/query`
- **Need durable store without DB+blob** → `arc skill show space`
- **Memory provider** often delegates to Index — prefer memory tools when the
  product surface is “agent memory”; use `/modules/index` for explicit search

## Related

- DID Space / data objects: `arc skill show space`
- Path ops: `arc skill show afs`
- Offline catalog: `arc skill list`
- Install: `arc skill install index`
