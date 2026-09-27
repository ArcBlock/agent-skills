# land — argument shapes

> On-demand reference for [`land`](../SKILL.md) Step 0 (moved out of SKILL.md in #7105).
> SKILL.md holds the identity order; this file holds the shape table.

| 形态 | 例 | 解析方式 |
|---|---|---|
| work DID | `land did:example:…` / `land w_ab…` | `/work` query `meta.objectId` / path stem；**不得先** `gh issue view` |
| CS@sha | `land` + 40 hex | `/work` query `meta.head` + `meta.workType=change-set` |
| 显式编号 | `land 5649` | **先** `/work`（inbound ref / `sourceUrl` 反查）；miss 才 `gh issue view` 与 `gh pr view` |
| 显式 URL | `land https://github.com/<org>/<repo>/pull/5643` | 当 `sourceUrl` 反查 `/work`；miss 才当投影 URL |
| 多个 | `land 5649 5651 5652` | 逐个按上面解析，进批量模式 |
| **无引用** | 裸 `land`，或 `land <一句话描述>` | **必须先过 Step 1 的一致性闸** |
