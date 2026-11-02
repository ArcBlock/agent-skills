# land — argument shapes

> On-demand reference for [`land`](../SKILL.md) Step 0 (moved out of SKILL.md in #7105).
> SKILL.md holds the identity order; this file holds the shape table.

| 形态 | 例 | 解析方式 |
|---|---|---|
| work DID | `land did:example:…` / `land w_ab…` | `/work` query `meta.objectId` / path stem；读不到则用本次 run 交付的 brief（`read-bound-work`），**不得** `gh issue view` |
| CS@sha | `land` + 40 hex | `/work` query `meta.head` + `meta.workType=change-set` |
| 显式编号 | `land 5649` | **先** `/work`（inbound ref / `sourceUrl` 反查）；miss 才 `bun scripts/gh-rest/gh.ts issue view` 与 `bun scripts/gh-rest/gh.ts pr view` |
| 显式 URL | `land https://github.com/<org>/<repo>/pull/5643` | 当 `sourceUrl` 反查 `/work`；miss 才当投影 URL |
| 多个 | `land 5649 5651 5652` | 逐个按上面解析，进批量模式 |
| **无引用** | 裸 `land`，或 `land <一句话描述>` | **必须先过 Step 1 的一致性检查** |

`/work` 读不到（`No data found`，或这台主机没有账本）不是 miss：用 `arc --json afs exec /dev/code-agents/.actions/read-bound-work --args "{\"id\":\"$ARC_CODE_AGENT_RUN_ID\"}"`，**不得**再 `gh issue view`。账本回答了且没有这一行时，编号或 URL 才可以把 `gh` 当别名。

```bash
arc --json afs exec /.actions/query --args '{"path":"/work","where":{"field":"meta.objectId","eq":"<DID>"},"limit":8}'
# Change Set @ sha:
arc --json afs exec /.actions/query --args '{"path":"/work","where":{"all":[{"field":"meta.workType","eq":"change-set"},{"field":"meta.head","eq":"<sha>"}]},"limit":8}'
```
