---
name: factory-portfolio
description: >-
  The factory's portfolio planner, one layer above factory-planner: daily (full re-rank weekly) it
  clusters idea / planning / research work into ranked epic plans with value, blast radius, cost,
  order, release and per-task-type acceptance; cuts trivia with a wakeOn. Reversible calls apply,
  irreversible or external ones wait on a person. Never codes or dispatches. Dry-run only until
  reference/prerequisites.md lands.
---

# factory-portfolio — 把模糊的 idea 排成可实现的 epic 计划

> **Repo profile — 先读 `.claude/repo-profile.md`。** `factory_portfolio_*` 与 `factory_planner_*`
> 诸键、label 集合都从 profile 取，别硬编码。来源：#9154（设计），#9157（任务类型通用化）。

## 它在哪一层

```
GitHub issues / planning/ / intent/   同步进来的输入
/work（work object）                   状态的主体
factory-portfolio   全局：聚簇、排序、砍、定版本、定验收，产出 epic 计划      ← 本 skill（每日一轮）
factory-planner     单条 track：判定 + design → build → accept，提交 manifest（每小时一轮）
plan-submit / drain / land / merge-check   代码执行的边界与派工
```

planner 回答「这条 track 下一步做什么」；portfolio 回答「**整个工厂接下来该做哪几件事、按什么顺序、
归哪个版本、哪些不做**」。两者分开，是因为每小时的 scrum 判断和全局战略混在一起，上下文和成本都会膨胀。
portfolio 不碰 track 的阶段推进，planner 不做跨主题排序。

## 上线前提

本 skill 只做判断。下面几项要由代码保证，**落地前只跑 dry-run**（只写本地文件，见 Step 7）。
逐条验收见 [reference/prerequisites.md](reference/prerequisites.md)。

| # | 机制 | 防的是什么 |
|---|---|---|
| P1 | epic 计划成为 work object（#9161，入口 `<cli_binary> work portfolio-submit`）：可信入口用 key 派生 DID 原子写入，字段带任务类型、爆破范围、代价、版本归属、验收 | 计划写在本地文件里，planner 读不到；同一主题重复建计划 |
| P2 | plan-submit 的 manifest 成员可带 `portfolio`（计划 DID），R1 校验计划存在、未被 drop/hold，成员在计划里（#9161） | planner 派出计划之外的活，或派出已被砍掉的计划的成员 |
| P3 | `arc work judge` 支持 `human-replied`、`path-changed:<prefix>` 两个唤醒谓词（#9162） | 「等人回复」「等某处重构完」只能用 `after` 兜底，判定盲目重读 |
| P4 | factory-planner 消费计划：`ready(stage)` 先按计划名次排，计划里 `human` 的成员不进 build（planner 的 skill 改动，P1/P2 之后另开流程立法 PR） | 计划写出来了，planner 照旧按自己的 (priority, age) 排，等于没写 |

任务类型只是 work object 上的字段：工厂不按类型给 agent 分工，任何 agent 都能接任何类型的 work，
派工只按**资源**分配（名额、CPU、内存、磁盘、GPU、装了哪些工具和环境）。非代码类型的 sink、rubric 审查和
publish gate 属于 #9157，不是本 skill 的前提：portfolio 照样给它们排序，写明这类 work 要声明哪些资源、
用什么 rubric 和验收，以及现在有没有哪台机器能提供这些资源；没有的，判 `defer`，`wakeOn` 指向 #9157 对应的 work。

## 输入与输出

**输入**（每轮只读，不写回）：
- `/work` 上 `creativeWorkStatus=idea` 且非 bug 类的源 work，连同它们的 `judgments.planner`；
  每条对应的 GitHub issue 全文（正文 + 评论）。
- open 的 planning、research、idea、feature、design 类 issue（还没同步进来的也算）。
- `factory_portfolio_direction_sources` 列出的产品意图与所有者工程观、`<factory_planner_design_root>/`、
  近期合并记录（判断现在的重心）。
- 工厂吞吐量：`<cli_binary> work status --json` 的 `works[]`（Step 1，算每轮上限）。
- 工厂容量：`<cli_binary> work capacity --json` 的 `wip.build`（Step 1，每轮上限的第二道，#9240）。
- 联网调研：竞品、生态，结论附引用。

**输出**：
- **epic 计划**（P1 前写本地 JSON，格式见 [reference/plan-schema.md](reference/plan-schema.md)）：
  主题与为什么现在做、任务类型、成员与落点、爆破范围、代价、依赖与顺序、版本归属、
  每个成员的验收和 epic 级 accept test、`allowedPaths` 草案，以及禁区命中标记。
- 每个被判的源 work 上一条 `judgments.portfolio`（带 `wakeOn`）。
- **一页 roadmap 摘要**：本轮排了什么、砍了什么（附理由和 `wakeOn`）、哪些在等人拍板（每项给选项和推荐）。

## 判定集合（闭合，每条必带 `wakeOn`）

| verdict | 含义 | 典型 `wakeOn` |
|---|---|---|
| `schedule` | 排进某个 epic 计划，有名次 | 计划进入终态、指纹变化 |
| `fold` | 并入另一条的计划，作为它的成员或验收项（写明并入哪条） | 那条进入终态 |
| `defer` | 有价值，但不是现在：依赖未到、没有机器能提供它要的资源（含 #9157 的非代码 sink 和 gate）、吞吐量不够 | 依赖进入终态（`work-terminal`）、指纹变化、`path-changed`（等某处重构完）；`after` 只能和它们搭配 |
| `trivial` | 鸡毛蒜皮：P3 记录、一次性观察、收益不抵一个 run 的代价。建议关闭或保持 `not-actionable` | 指纹变化、`human-replied` |
| `investigate` | 价值判断要先有事实：交给一个 intel / research 任务（它也是一种任务类型） | 那个调研任务进入终态 |
| `human` | 不可逆或对外：breaking、发版节奏、对外承诺或发布、市场方向、钱 | `decision` 由人写入、`attention` 被人清除 |
| `excluded` | 实现面全在禁区或是流程立法：工厂不能做，只能由人做 | 禁区清单变化 |
| `duplicate` | 与某条重复（写明是哪条） | 那条进入终态 |
| `owned` | 已有在飞的 planner track、认领或别人的 epic：portfolio 只给名次，不重排它的成员 | 那个 track 或 epic 进入终态（`work-terminal`）、`status-changed` |

`trivial` 和 `defer` 是**真的砍**：每条都要能追溯理由，并写出什么情况下重新考虑。写不出 `wakeOn`
的砍，说明没想清楚，不许写。`wakeOn` 只能用求值器今天认的谓词（`fingerprint`、`status-changed`、
`work-terminal`、`work-event`、`deny-changed`、`human-replied`、`path-changed{prefix}`、`after`），`after` 必须和至少一个别的谓词搭配，且不超过
`factory_portfolio_clock` 的 `max_sleep`；理由里可以用文字写真正在等的事。

## 判断维度：按任务类型取，不写死成代码

每个 epic 计划先定**任务类型**：`code`、`content`、`seo`、`media`、`data`、`intel`、`process`。
爆破范围、代价、验收的写法按类型取，细则见 [reference/dimensions.md](reference/dimensions.md)：

| 类型 | 爆破范围 | 验收 |
|---|---|---|
| code | 包、是否 breaking、迁移成本 | 每个成员一个 mutation pair；epic 级 accept test 在真实入口上跑 |
| content | 品牌、声誉、对外承诺、版权 | rubric（风格取 `factory_portfolio_direction_sources` 里的写作风格）+ 逐条事实核查 |
| seo | 站点流量、索引、对外可见 | 可测指标（索引数、排名、CWV），允许发布后 N 天**延迟复测** |
| data | 结论被谁引用、决策依赖 | 可复算：输入快照 + 脚本 + 同输入同输出 |
| intel | 方向判断被它左右 | 每条结论附引用；关键结论至少两个独立来源 |
| media | 品牌、版权、对外 | 技术规格 + 节奏 rubric |

**对外发布一律按 R2**（不可逆或对外），不管任务类型。

## 决策权：按可逆性分级

| 级别 | portfolio 的操作 | 谁决定 |
|---|---|---|
| **R0 可回滚** | 排序、聚簇成 epic、判 `trivial` / `defer` / `duplicate` / `fold`、写 epic 计划、改名次 | portfolio 自己的判定写入，**不是** `work decide` 提议，不过 approve agent；写进 roadmap 摘要 |
| **R1 回滚有代价** | 建议关闭 GitHub issue、把成员拆出或并入在飞的 epic、调整版本归属的里程碑 | 用 `work decide` 提议（scope 写操作和目标 issue / work），交给 approve agent（`factory_planner_approver_engine`）。**目前没有执行入口**：批准后的关闭只进摘要，由人执行，直到有执行入口为止 |
| **R2 不可逆或对外** | breaking change、发版节奏、对外承诺或发布、市场方向、花钱 | **人**：在源 work 上挂 `attention(kind=needs-decision)`，计划里标成 `human`，不等，继续排别的 |

R1 / R2 的级别下限由 `work decide` 按 scope 计算（planner 的 R5）；portfolio 只能往上调。
**breaking 一律 R2 是有意上调**：approve.md 把删改公共接口放在 R1，但 portfolio 判的是要不要做、何时进哪个版本，
这对用户是对外承诺。portfolio **自己不关 issue、不写 GitHub**。

## 每一轮

两种轮：**日轮**只处理醒着的（新同步进来的 ∪ `judgments.portfolio` 的 `wakeOn` 命中）；
**周轮**全量重排，所有计划和所有判定重新排一遍名次（判定本身没醒的，只重排、不重判）。
节奏由 `factory_portfolio_clock` 给出。**dry-run 没有判定台账**：用上一轮的
`portfolio/dry-run/*/roadmap.json` 当替身台账（和它比对出新增、变化和翻转）；没有上一轮时这一轮按周轮跑。

### Step 0 — 单实例
runner 持有锁（`scripts/factory-portfolio-local.sh`），与 planner 的锁互不相关。手动起一轮前确认 runner 没在跑。

### Step 1 — 取输入，量吞吐
- 日轮：`<cli_binary> work wake --consumer portfolio`。周轮：`<cli_binary> work status --json` 的 `works[]`
  里 `status=idea` 的全部行。求值器报错 → 本轮失败退出，不当作 0 条。
- 吞吐量 `T`：`works[]` 里 `lastOutput.kind=merged` 且 `lastOutput.at` 在过去 14 天内的行数 / 14。
  **正控**：`counted.mergedEvents` 存在且 > 0、`works[]` 非空，才算「测了」；否则本轮失败。
  测了而窗口内是 0，才是「测了是 0」。
- 容量 `C`：`<cli_binary> work capacity --json` 的 `wip.build`，每轮现读。命令非零退出、`status` 不是 `ok`
  或 `wip` 为空 → 本轮失败退出（[reference/noise.md](reference/noise.md) 第 1 节）。

### Step 2 — 读全文，定落点
每条醒着的 work：读 issue 全文和评论；读代码，把目标实现面定位到包或目录；查它是否已经在代码里做完了
（是 → 判 `duplicate` 指向那个 PR，或建议关闭）。定位不出来的，不能进 `schedule`，判 `investigate` 或 `trivial`。

### Step 3 — 全局聚簇
按**主题**聚，不是一条一个 epic：同一个问题的不同投影、同一实现面的连续改动、同一验收能覆盖的几条，
归成一个计划。主题之间的依赖画成有向图，环 = 聚错了。

### Step 4 — 逐主题判断
价值和为什么现在做；是否鸡毛蒜皮；爆破范围；代价（多少 run、哪些特殊环境）；依赖与顺序；版本归属
（beta 还是 stable、哪个里程碑）。方向类主题做市场分析（[reference/dimensions.md](reference/dimensions.md) 的 intel 一节），
结论附引用。用所有者的工程观检查：这个抽象 10 年后还成立吗；它是不是在错误方向上勤奋。

### Step 5 — 排序、截断
按 `价值 × 紧迫 / 代价` 排，依赖先于被依赖者。本轮新增的 epic 计划数不超过上限 `N`
（[reference/noise.md](reference/noise.md)）；超出的判 `defer`，`wakeOn` 是名次在它前面的计划进入终态
（P1 前用指纹 + `after:<下一轮>`）。

### Step 6 — 成员可交接
每个能进 build 的成员，写成 planner 能直接放进 manifest 的形状（`root`、`acceptance`、`targetSurface`，
`allowedPaths` 只是提示，由 planner 按阶段重算），并对照 `factory_planner_deny_paths` 先筛一遍：命中禁区的成员标
`denyHit`，判 `excluded` 或拆成「人做」的成员。`root` 为空（源 issue 还没同步）的成员不能交接。
可以用 `<cli_binary> work plan-submit --check` 验一遍（只检查、不写）。交接契约见 [reference/plan-schema.md](reference/plan-schema.md)。

### Step 7 — 写出
- 判定：`<cli_binary> work judge <did> --consumer portfolio --verdict … --reason … --wake-on …`（dry-run 不写）。
- 计划：P1 落地后每个计划一份 JSON，经 `<cli_binary> work portfolio-submit --plan <file> --actor agent` 写进 `/work`
  （先 `--check`；拒绝原因码见 [reference/prerequisites.md](reference/prerequisites.md)）；dry-run 期间写
  `$ARC_HOME/portfolio/dry-run/<轮次时间>/roadmap.json`。
- 摘要：`$ARC_HOME/portfolio/dry-run/<轮次时间>/roadmap.md`（一页）。
- R2 事项：挂 `attention(kind=needs-decision)`，`ask` 写成一个能回答的问题，带选项和推荐（dry-run 只写进摘要）。
- 轮次记录：醒着的条数、各 verdict 计数、`T`、`C` 和 `N`、本轮新增和砍掉的计划数、正控结果。

## 防止它本身变成噪音

细则见 [reference/noise.md](reference/noise.md)，要点：
- **不建 GitHub issue、不评论、不打 label**：状态只写 work object（同 #9086）。
- 每轮新增上限 `N` 跟着吞吐量 `T` 和容量 `C` 走，计划不能远远跑在执行前面。
- 一轮「全砍」或「全推」必须单独说明为什么；任何计数都有正控，「数到 0」不等于「没数」。
- 同一条判定 30 天内翻转超过 2 次，说明判据有缺口，挂 `attention(kind=stuck)` 让人改 skill。

## 和 factory-planner 的交接

P1、P2、P4 落地后的**目标契约**；在那之前 planner 不读计划，portfolio 只出 dry-run 摘要。
- portfolio 写计划和 `judgments.portfolio`；planner 只读，不改。
- planner 的 `ready(stage)` 先按计划名次、再按自身的 (priority, age) 排；计划之外的源 work，planner 照旧推进
  （portfolio 不是 planner 的闸，只是排序依据），但同一实现面上有计划时，planner 让计划内的先走。
- 计划被判 `human` 的成员，planner 不推进到 build，直到 `decision` 写入。
- planner 的 `not-actionable` 不是终点：portfolio 每周看一遍，把能聚成主题的捞起来，其余写清楚为什么砍。

## 不做的事

- 不写代码、不开 PR、不派工、不 approve、不提交 manifest（那是 planner 的事）、不写 GitHub。
- 不立流程法：发现规则该改，写进摘要的「需要人」一节。
- 不替人拍 R2：breaking、发版、对外、市场方向只给选项和推荐。

## 一句话心智模型

> **planner 推进已经决定要做的事；portfolio 决定哪些事值得做、按什么顺序、哪些不做——
> 每个「不做」都写明理由和重新考虑的条件，每个「做」都带着能被证伪的验收。**
