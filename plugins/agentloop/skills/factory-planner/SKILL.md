---
name: factory-planner
description: >-
  The factory's own sprint planner (scrum master): wake only the work whose recorded wake condition
  fired, judge each into a closed verdict set, and advance self-plannable tracks stage by stage
  (design → build → accept) via the trusted plan-submit entry. State lives in work objects;
  GitHub issues are synced input. Never codes, merges, approves directly or picks an engine.
  Live (R1–R8 landed; FACTORY_PLANNER_DRY_RUN=1 falls back to dry-run).
---

# factory-planner — 工厂给自己派活

> **Repo profile — 先读 `.claude/repo-profile.md`。** `repo_slug`、`factory_planner_*` 诸键、label 集合都从 profile 取，别硬编码。

## 它在哪一层

```
GitHub issues  →  /work（状态主体）  →  factory-planner（只做判断）  →  plan-submit（可信入口）  →  approval drain  →  land  →  monitor
```

[factory-labor-discipline](../../../../../docs/architecture/factory-labor-discipline.md) 规定工厂「只做派活和安排成果检查」：**派工的决定只在这里发生。**

## 上线前提（已全部落地）

本 skill 只负责判断，边界由代码保证（R1–R8 详见 [reference/prerequisites.md](reference/prerequisites.md)）：
- R2 边界上的文件（`.claude/factory-r2-boundary.txt` 加工厂代码下限，#9637）planner 不能为它们开 track，其余命中禁区的照常按「判定顺序」走 panel + 评判团。
- `FACTORY_PLANNER_DRY_RUN=1` 时只做 `--dry-run`，写到 `$ARC_HOME/planner/dry-run/<轮次时间>.json`。
- **工具层白名单**（#9589 W-01）：会话只拿到 [reference/tool-allowlist.json](reference/tool-allowlist.json)（读命令、`work plan-check`、live 四个写入口 `judge`/`attention`/`decide`/`plan-submit`，文件只写 `$ARC_HOME/planner/`）。**本文凡说「跑 `plan-submit --check`」，一律用 `plan-check` 跑**；被拒就是边界：记进轮次记录，不换写法绕过。

## 四条设计原则

1. **不重复扫：判定带唤醒条件（`wakeOn`）。** 详见 [reference/wake.md](reference/wake.md)。
2. **按阶段推进，拉动式（accept → build → design）。** 详见 [reference/stages.md](reference/stages.md)。
3. **不等人：能回滚的先推进。** 详见 [reference/approve.md](reference/approve.md) 与 [reference/attention.md](reference/attention.md)。
4. **边界由代码执行，判断只是第一道筛子（C-2）：**
   - 命中**普通禁区** → 照常派工，`plan-submit` 放行并列出 `denyHits`，合并前由 Gate 6 要 correctness + security panel 加跨引擎评判团 approve。
   - 触到 **R2 边界**（`.claude/factory-r2-boundary.txt`）→ `plan-submit` / `merge-check` 以 `deny-path` 拒绝。只有这一类不派、不合。
   - 操作本身是 R2（approve.md 可逆性表）→ 交人（`human`），与路径无关。

## 判定集合（闭合，每条必带 `wakeOn`）

| verdict | 含义 | 典型 `wakeOn` |
|---|---|---|
| `plan` | 工厂可以自理，进入某一阶段 | 该阶段 stage task 进入终态 |
| `decide` | 需要拍板（方向不定、缺授权），但做错能回滚 → 交给 approve agent | `decision` 写入 |
| `human` | 只限 R5 算出的 R2 级决定（不可逆或对外）→ 挂 `attention`，交给人 | `decision` 由人写入、`attention` 被人清除 |
| `owned` | 别人已认领（`agent:processing`、assignee、在飞 PR、别人的 epic） | 认领释放、PR 关闭、认领超过 `factory_planner_clock` 的 `stale_claim` |
| `blocked` | 依赖未完成 | blocker 进入终态 |
| `excluded` | 只有一种：目标实现面触到 R2 边界——该候选的 `plan-submit --check` 以 `deny-path` 拒绝；写入时必须带本轮的单成员 manifest（`work judge --manifest`），代码重跑检查，不认就拒（#9589 W-02） | `deny-changed`（禁区清单或准入规则变化，#9504） |
| `not-actionable` | P3、记录类、没有具体失败，或者目标实现面定位不出来 | 指纹变化、`path-changed:<前缀>` |
| `duplicate` | 与某条重复（写明是哪条） | 那条进入终态 |

判定存在源 work 上（R3），planner 不维护本地状态文件。

**判定顺序与 `excluded` 的口径（C-2）**——Step 2 的初判、进 build 前的复查、`deny-changed` 唤醒后的重判都按这个顺序：
1. **先判语义上的 R2。** 操作本身落在 [approve.md](reference/approve.md) 可逆性表的 R2 行（生产部署、删真实数据、
   授予权限或凭据、放宽安全策略、对外发布、花钱、改 R2 清单本身、改挡合并判据）→ `human`；`--check` 通过
   也不改变它（`--check` 只判路径，不判操作）。方向不定但能回滚的 → `decide`。
   代码兜底（#9589 W-02）：manifest 每个成员都带 `operation`（Step 4），plan-submit 按 `work decide` 的操作下限判，
   R2 操作（`deploy`、`publish`、`delete-data`、`credential`、`permission`、`spend`，或表里没有的操作）以 `r2-operation` 拒：
   被拒就是这条判错了，改判 `human`，不换个操作名重试。
2. **再判路径准入：逐条跑单成员 `plan-submit --check --json`**（Step 5 的命令，只检查、不写；`denyHits` 只在 JSON 结果里）：
   - 带成员 `root`、detail 点名 `reaches <file>` 的 `deny-path`，且跑的是**收窄后的**目标实现面（见「两种 surface」，该成员实际要改的文件触到 R2 边界）→ `excluded`，理由里抄这次的原因码和 detail；
     写 `excluded` 时把**这次 `plan-check` 用的单成员 manifest** 交给 `judge`，代码当场重跑检查并存为 `evidence`，宽前缀或检查通过的 surface 一律拒（#9589 W-02）：

     ```bash
     <cli_binary> work judge did:uuid:… --consumer planner --verdict excluded --reason "<原因码>: <detail>" \
       --wake-on '[{"kind":"fingerprint"}]' --manifest <manifest.json>
     ```
     `judge` 拒了就不是 `excluded`：按它说的原因收窄或改判，不换参数重试。
     宽前缀 surface 被 `deny-path` 拒，**不能**直接判 `excluded`：先读代码收窄到实际要改的文件，再跑 `--check`，按收窄后的结果判（#9610）；
   - **不带 `root`** 的 `deny-path`（detail 是 `a boundary that cannot be computed`：宿主算不出 R2 闭包）不是这个候选的判定，
     是准入入口本身坏了：**本轮失败退出**，不写任何判定，候选留在醒着的集合里。
   - 其他原因码（`held`、`owned`、`depth-exceeded`…）→ 对应的 verdict（`blocked` / `owned` / 挂 `attention`），不是 `excluded`；
   - `check ok` → `plan`。结果带 `denyHits`（命中**普通禁区**：工厂核心、调度器、门禁、鉴权/密钥/沙箱/支付，
     以及落在禁区里的流程立法，如 `.claude/` 下的 skill 和 routine、`docs/architecture/`）的，成员 `name` 标
     `[<stage>][security]`（例：`[build][security] <源标题>`），理由写「需要 panel + 评判团，denyHits: <命中项>」
     （理由提到 denyHits，`recordJudgment` 会自动补 `deny-changed`），manifest 照常提交；合并时 Gate 6 自己要
     correctness + security panel 加跨引擎评判团，planner 不用另做什么。
- 凭「看起来碰了禁区」或「是流程立法」判 `excluded` 是错判：流程立法不是 R2，由评判团决定（approve.md，C-2）。

## 两种 surface

| | 含义 | 用途 |
|---|---|---|
| **阶段写入面** | 本阶段 PR 允许改的路径。design 和 accept 是 `<factory_planner_design_root>/<slug>/**`；build 取自设计文档 | stage task 的 `allowedPaths`，Gate 7 据此判定 |
| **目标实现面** | 这个问题最终要改的代码，至少定位到文件，或定位到不覆盖 R2 边界文件的目录 | 判 `plan` / `excluded`（按 `--check` 结果）、做不相交检查 |

- **禁止**用包根级 `**` 或仓库顶层前缀当目标实现面（如 `providers/runtime/code-agents/**`、`.claude/**`、
  `.claude/plugins/agentloop/**`）：这类宽前缀会覆盖任务根本不碰的 R2 边界文件（`src/path-policy.ts`、
  `.claude/settings.json`、`merge-verified-pr.sh`…），`--check` 报 `deny-path`，任务被错判 `excluded`（#9610）。
  写目录只在该目录下没有任何 R2 边界文件时成立（对照 `.claude/factory-r2-boundary.txt` 和工厂代码的下限）。
- 宽前缀 surface 被 `deny-path` 拒，**不能**直接判 `excluded`：先读代码收窄到实际要改的文件，再跑 `--check`，
  按收窄后的结果判。收窄后仍是 `deny-path`，才是真的触到 R2 边界。
- 新建 AUP 页面的任务，目标实现面自动带上该 blocklet 的 `blocklets/<name>/.aup/app.aup` 与 `blocklets/<name>/.aup/app.json`
  （页面要在 catalog 里注册才可达；跳过 design 时最容易漏估这两份）。
- **每次跳过 design**（以及写 design 的文件级实现面时），按 `<factory_planner_surface_companions>` 逐行匹配任务：
  命中的行把它列出的伴随文件并入目标实现面，再读代码落到具体文件。行是下限不是上限。当前三行：
  AUP 页面 → catalog（`.aup/app.aup`、`.aup/app.json`）；a11y 修复 → SSR primitive
  （`providers/runtime/web-device/src/renderer/primitives/**`）；`readRole` 改动 → resolver
  （`site-server.ts`）加 seed（`blocklets/<name>/seed/settings/**`）。Gate 7 判实现面过窄时，build r+1 带上放宽后的实现面，不否决。
- 目标实现面定位不出来 → 判 `not-actionable`，**不能**判 `plan`，哪怕只是进 design。
- 进 build 前，**用设计文档里的文件级实现面重新做** `plan-submit --check` 和在飞不相交检查。

## 每一轮（Step 0–6）

### Step 0 — 单实例锁
锁由 runner 持有（`scripts/factory-planner-local.sh` 的 `$BASE/run.lock`）。手动起一轮前先确认 `run.lock` 不存在或进程已不在。

### Step 1 — 只取醒着的
求值器给出醒着的集合（新同步 ∪ 指纹变化 ∪ `wakeOn` 命中 ∪ 抽查样本）。求值器报错 → **本轮失败退出**，不当作 0 条。醒着的为 0 且无阶段可推 → 记空轮退出。

### Step 2 — 判定
对每条醒着的 work，读代码定位落点，给出 verdict、`wakeOn`、目标实现面和一句理由。
凡是目标实现面碰到禁区的候选，按上文「判定顺序」判：先判语义上的 R2，再**逐条**用单成员 manifest 跑 `plan-submit --check`。被 `deny-changed` 唤醒的判定（禁区清单或准入版本变了，#9504）同样逐条重跑 `--check` 重判，**禁止**以「deny list 条目没变」「上轮也是 excluded」为由批量维持 `excluded`（见 [wake.md](reference/wake.md)）。

### Step 3 — 推进阶段（下游优先）
照 [stages.md](reference/stages.md) 先 accept，再 build，最后 design。WIP 上限 `wip[stage]`（#9240）：
- `factory_planner_wip=auto`：每轮现读 `<cli_binary> work capacity --json --max "<factory_planner_wip_max>"`，取 `wip`，把 `totalSlots`、`usableCoderSeats`、`wip` 和被排除 peer 写进轮次记录；若命令退出码为 5 或 6（daemon 正在重启），等待 30 秒后重试（最多 3 次）；重试后仍非零、`status!=ok` 或 `wip` 为空 → **本轮失败退出**。
- `factory_planner_wip` 为写死的 `design=N build=N accept=N`：照用。

每阶段已占用名额（#9330）每轮现读 `<cli_binary> work occupancy --json`，取 `stages[stage].active`：
- `excluded` 逐条写进轮次记录 step3 notes；`attention` 里的每一行（held/stalled 超时释放）在该 stage task 上挂 `attention(kind=stuck)`（已挂不重复挂）；若命令退出码为 5 或 6（daemon 正在重启），等待 30 秒后重试（最多 3 次）；重试后仍非零 → **本轮失败退出**。

### Step 4 — 写 manifest
每个阶段一份：
```json
{"stage": "design",
 "members": [{"root": "<源 work DID>", "round": 1, "part": 2, "operation": "edit-code",
              "name": "[design] <源标题>（命中普通禁区时为 [design][security] <源标题>）", "acceptance": ["..."],
              "allowedPaths": ["<阶段写入面>"], "targetSurface": ["<目标实现面>"],
              "decision": "<decide 类 track 的 decision 事件 id，没有则省略>"}]}
```
`operation` 必填（取 `work decide` 操作类型：`edit-code`、`edit-docs`、`edit-process-legislation`、`change-public-interface`、`tune-factory`…）；`part` 只在 build 拆多成员时出现；key 由 R1 自己计算。不相交检查用 [issue-sweep-batch](../issue-sweep-batch/SKILL.md) 的三态判定，在飞 surface 从 `/work` 读。

### Step 5 — 提交（只走 R1）
manifest 写成本地文件 `$ARC_HOME/planner/manifests/<轮次时间>-<stage>.json`，先用 `plan-check` 检查，通过了再（仅 live）用 `plan-submit` 提交：
```bash
<cli_binary> work plan-check --manifest <manifest.json> --deny <factory_planner_deny_paths> \
  --actor agent --instance <factory_planner_instance> --json
<cli_binary> work plan-submit --manifest <manifest.json> --deny <factory_planner_deny_paths> \
  --actor agent --instance <factory_planner_instance>
```
拒绝时把原因码记进轮次记录，**不重试、不改参数绕过**。**不写 GitHub。planner 永远不直接调 `work approve`。**

### Step 6 — 轮次记录
每轮（空轮也写）写 `$ARC_HOME/planner/rounds/<轮次时间>.json`（醒着条数、verdict 计数、各阶段推进数、批次 key、拒绝原因）。监督靠 runner 的 `runs.jsonl`，见 [reference/monitor.md](reference/monitor.md)。

## 不做的事

- 不写代码、不开 PR、不合并、不选引擎、不直接 approve、不写 GitHub、不留言催人（只在 work 上挂 `attention`）。
- 不为 R2 边界开 track（判 `excluded`）；普通禁区和流程立法照常判 `plan` 并标 `[security]`，合并由 panel + 评判团裁决（C-2）。
- R1 拒绝了，不换个参数再试。
