---
name: "site"
description: "When to use: build a full website via `/web/.actions/create-site` — themes at `/web/.library/themes`; writable storage on a fresh instance is `/work` (not `/storage`); tell disk `.web/.build` from the HTTP host; map daemon :4900 vs Web Device port vs `*.localhost`."
---
# ARC skill: site

Cold-read agents often miss the **full-site** path (theme + multi-page via
`create-site`), mix up **disk build output** with **what HTTP is serving**, and
mix up **daemon `:4900`** with the **Web Device site host port**. This booklet
is the L0 map. Prefer live `arc afs explain /web` after a daemon is up
(`arc skill show daemon`).

## Prefer

1. `arc skill list` → this booklet for **create-site / whole site / serve vs build / URLs**
2. Live: `arc afs explain /web` then `arc afs explain /web/.actions/create-site`
3. After a site exists: `arc afs exec /web/sites/<name>/.actions/doctor` (site doctor — not top-level `arc doctor`)
4. No dangling links: `arc afs exec /web/sites/<name>/.actions/check-links`
5. Persist durable content: `arc skill show space` · search: `arc skill show index`

## Critical path facts (do not invent)

| Wrong (404 / missing) | Correct on a typical daemon |
|------------------------|-----------------------------|
| `list /.library/themes` | `list /web/.library/themes` |
| `explain /.library/themes/{name}` | `explain /web/.library/themes/{name}` |
| `storage: "/storage"` on a **new** instance | `storage: "/work"` (writable host work root) |

`/storage` is **not** a default system mount. Theme library is under the **`/web`**
mount. Writable storage on a fresh instance is `/work`.

## Serve vs build

`build` writes static HTML to `.web/.build` on disk. `declare` starts an HTTP
host with its **own lifecycle** (in-memory SiteServer). A successful build does
**not** reload HTTP. If disk `.web/.build` is a new revision but
`http://<site>.localhost:<web-port>/en/` still shows the old page, the host is
stale.

```bash
arc afs exec /web/sites/<name>/.actions/doctor --instance <name>
# FAIL + remediation → reload the host:
arc afs exec /web/.actions/undeclare --instance <name> --args '{"name":"<site>"}'
arc afs exec /web/.actions/declare --instance <name> --args '{"name":"<site>","source":"/work/<site>"}'
```

Accept-path: healthy site (HTTP matches disk) **passes**. Stale-serve **fails**
with undeclare+declare — never a silent success.

## Ports and URLs

Three different listeners — do not mix them:

| Surface | Typical URL | What it is |
|---------|-------------|------------|
| Daemon / `arc service` HTTP | `http://localhost:4900/` | ARC daemon (AFS, blocklets, MCP). **Not** the site. |
| Web Device site host | `http://<site>.localhost:<web-port>/en/` | Site HTTP started by `declare` (dynamic port, e.g. `:34069`). |
| `*.localhost` Host routing | Host `<site>.localhost` | Multi-site routing **on the Web Device port**. |

`create-site` / `declare` return the site URL — open **that**, not `:4900`.

## Discover (daemon up)

Add `--instance <name>` unless you are on the default instance.

```bash
arc afs explain /web --instance <name>
arc afs ls /web/.library/themes --instance <name>
arc afs explain /web/.library/themes/default --instance <name>
arc afs ls /web/.library/themes/default/components --instance <name>
arc afs ls /web/.actions --instance <name>
arc afs explain /web/.actions/create-site --instance <name>
arc afs ls /work --instance <name>          # confirm writable root
arc service status
```

## Golden path: create-site

```bash
arc afs ls /web/.library/themes --instance <name>
arc afs exec /web/.actions/create-site --instance <name> --args '{
  "name": "my-site",
  "storage": "/work",
  "theme": "default",
  "pages": {
    "index": {
      "sections": [
        {
          "id": "hero",
          "type": "hero-banner",
          "props": { "title": "Hello", "subtitle": "From arc skill show site" }
        }
      ]
    }
  }
}'
```

Then:

```bash
arc afs ls /web/sites --instance <name>
arc afs explain /web/sites/my-site --instance <name>
arc afs exec /web/sites/my-site/.actions/check-links --instance <name>
```

Open the URL in the action receipt (`http://my-site.localhost:<web-port>/en/`).
If the page looks stale after a later `build`, run `doctor` (above).
Acceptance: `check-links` reports no dangling links. The JSON above is
listing-safe; default theme chrome still links to `/en/docs/` and
`/en/articles/` unless those pages exist — copy `examples/starter-site/site.json`
for a check-links-green template.

Take component `type` names from `list /web/.library/themes/{theme}/components`
— do not invent. Prefer `explain` a component path before filling `props` (leaf returns the props schema).

Chrome / portal-header: avoid stacking shell chrome — see doctor / blocklet
guidance when present; do not double-wrap `portal-header`.

## Listing components invent collection URLs

`product-showcase`, `content-card`, `news-ticker`, and `technology-card`
invent collection URLs even when items have **no `slug`** (`/en/products/#/`,
`/en/news/#/`, `/en/technology/#/`, …). Without matching detail pages those
links dangle and `check-links` goes red.

The create-site example's `product-showcase` + `items: []` emits no hrefs;
filling those items without slugs / detail pages is the trap. Prefer the
copy-paste starter (`examples/starter-site/site.json`) — its `content-card`
items have no slugs, so default-theme cards stay unlinked.

Golden-path acceptance after create-site:

```bash
arc afs exec /web/sites/<name>/.actions/check-links --instance <name>
```

Site doctor is `/web/sites/<name>/.actions/doctor`, not top-level `arc doctor`.

## Local Pages deploy

Local-only Pages deploy (no public URL, receipt `local://…`) needs **either**
daemon env `AFS_TEST_PAGES_LOCAL=1` at start, **or** `{ "local": true }` on
`/web/sites/<name>/.actions/deploy` when the Pages backend is already local.
Client-shell export of `AFS_TEST_PAGES_LOCAL` does not reach a running daemon.

## Related

- Daemon / `:4900`: `arc skill show daemon`
- Paths / WM: `arc skill show afs`
- DID Space persist: `arc skill show space`
- Retrieval Index: `arc skill show index`
- Blocklet scaffold: `arc skill show blocklet`
- Catalog: `arc skill list`
- Install: `arc skill install site`
