---
name: "blocklet"
description: "Discover, scaffold, build, and inspect Arc blocklets via `arc blocklet` without reading the monorepo."
---
# ARC skill: blocklet

Blocklets are installable AFS apps (manifest + optional AUP pages/agents). This booklet is L0 — **verify flags with `arc blocklet <cmd> --help`**.

## Discover (always start here)

```bash
arc --help
arc blocklet --help
arc blocklet recipe list
arc blocklet recipe explain <name>   # e.g. basic | blog | agent | minimal-app
arc blocklet list [dir]              # local packages under dir (or cwd)
arc blocklet inspect <path|ref>
arc blocklet check <dir>             # validate against recipe/profile
```

After a daemon is up (`arc skill show daemon`) — add `--instance <name>` to
every `arc afs` call below unless you're on the default instance
(`arc skill show afs` covers this):

```bash
arc afs ls /blocklets --instance <name>          # live catalog when mounted
arc afs ls /registry/blocklets --instance <name> # registry entries if present
arc afs explain /blocklets --instance <name>
# WM: open a running blocklet in a surface
#   exec $WM/.actions/open-blocklet --args '{"blocklet":"<name>"}' --instance <name>
# Prefer: explain that action first
```

## Scaffold (T5 minimal)

Use an **empty isolated directory** — never scaffold into the monorepo root.

```bash
mkdir -p /tmp/my-blocklet && cd /tmp/my-blocklet
arc blocklet create . --name my-blocklet --recipe basic
# basic → blocklet.yaml only (smallest green path)
# --name becomes the DID identifier: alphanumeric / hyphen / underscore only.
# Omitting it derives one from the directory basename, and `create` REFUSES
# (exit 5) rather than write a DID `blocklet build` would reject (arc#6281).

arc blocklet check .
arc blocklet build .
# → dist/ with .afs/manifest.json + blocklet.dist.json
```

Richer recipes (need more files; still offline-capable):

| Recipe | What you get |
|--------|----------------|
| `basic` / `blank` | manifest only |
| `blog` | AUP blog pages |
| `agent` | AI chat + agent |
| `minimal-app` | web + aup + agent + settings |
| `agent-workspace` | workspace-shaped app |
| `support-community` | support-community shell |

```bash
arc blocklet create /tmp/blog-app --name blog-app --recipe blog
arc blocklet build /tmp/blog-app
```

## Deploy / run (after build)

```bash
arc blocklet deploy --help
arc blocklet run --help              # serve one blocklet on the daemon
arc blocklet instance list
arc blocklet instance deploy --help
```

Cloud / Pages deploy needs project credentials — read `--help` and fail closed if secrets missing.

## Install this booklet into host agent dirs

```bash
arc skill install blocklet
# → .agents/skills/blocklet/SKILL.md and .claude/skills/blocklet/SKILL.md
```

## Related

- Daemon: `arc skill show daemon`
- Paths / WM: `arc skill show afs`
- Persist / search: `arc skill show space`, `arc skill show index`
- Prefer live `explain` / `/.knowledge` over memorizing recipe file lists
