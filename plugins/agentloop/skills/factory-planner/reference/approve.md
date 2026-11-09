# approve agent：不等人，按可逆性决定

## 为什么

工厂的产物是代码，代码都在版本控制里：一个错的决定，代价通常只是一次 revert 加一轮返工。
生产系统不同，那里的错误会直接落到用户和数据上。所以对工厂来说，「停下来等人拍板」几乎总是比
「按合理建议先推进，错了再改」更贵。实际运行中，人对大多数提问的回答都是「按你的建议」，
这类停顿本来就不该发生。

所以：**需要决定的事先交给 approve agent，只有不可逆或对外的才交给人。**
可逆性决定的是自动化程度，**不替代授权**：禁区和 R2 都由代码执行，approve agent 批准不了越过它们的事。

## 谁提议、谁批准

- **提议者**：planner，或 stage run 里的 worker，在遇到方向选择或缺授权时提出。
  提议要写清：选项、推荐哪个、为什么、做错了怎么回退，以及**它要执行的操作和目标资源**（scope）。
- **批准者**：approve agent。clean-context，引擎取 `factory_planner_approver_engine`，
  必须和提议者不同。它只看提议本身和相关代码，不看提议者的推理过程。

## 可逆性分级

| 级别 | 例子 | 谁决定 |
|---|---|---|
| **R0 可回滚** | 在分支或 PR 上改代码、改文档；合并普通 PR；某个 track 选 A 方向而不是 B 方向；判 `not-actionable` | approve agent，批准即执行 |
| **R1 回滚有代价** | 合并后会被工厂自己部署的改动；删除或重命名公共接口；调整 WIP 和时钟参数 | approve agent，批准即执行，同时登记给监视者 |
| **R2 不可逆或对外** | 生产部署；删除真实数据；授予权限或凭据、放宽安全策略（收紧不算）；对外发布（npm、release、对外消息）；花钱；改 R2 清单本身；改「开发期只有 build-break / data-loss / security 挡合并」判据 | **人**。在 work 上挂 `attention(kind=needs-decision)`，不等，转去推进别的 track |

**流程立法不是 R2，由评判团决定（C-2，Robert 2026-10-25）。** 改 AGENTS.md、`.claude/` 下的 skill
和 routine、`docs/guides/` 里的规则，和工厂核心一样照常派工；合并前要 correctness + security panel
加跨引擎评判团（review jury，#9147 的机制）在同一个 head 上 approve。改 R2 清单本身
（[r2-admission.md](../../../reference/r2-admission.md) 和本表）、改挡合并的三类判据，合并时也不再等人
（agent-factory#24）：落在 R2 边界里的 PR 走 boundary lane，由宿主 merger 合并；硬底线（r2-admission.md 1.2）直接拒绝，
不交给人。本表和下面 R5 的**决定**下限（`work-decide.ts`：部署、发布和命中 R2 边界的目标仍是 R2）这次没有改，
planner 照旧把它们交给人决定。

**级别的下限由代码算，不由 agent 填（R5）。** R5 根据提议里的操作类型和目标资源算出最低级别：
- 操作属于部署、发布、删数据、授予凭据或权限、放宽安全策略、付费；
- 目标是 R2 清单本身，或挡合并的三类判据；
- 命中任一条，下限就是 R2。
- 目标路径命中禁区（`.claude/factory-planner-deny.txt`）本身不再是 R2：下限 R1，合并要 panel 加评判团。

agent 只能把级别往上调，不能往下调；拿不准时也向上取一级。

## 决定是一条被消费的记录

`work decide` 写一条 `decision` 事件，挂在相关的 work 上：

```
proposal(hash), scope{operation, targets[]}, options[], recommended, chosen,
level(computed floor, declared), rationale, rollback,
approver{engine, runId（由服务端从 run 绑定取得，不信任调用方自报）},
proposer{engine, runId?}, engineSource（run-record | declared）
```

- **引擎取 run 记录（#9589 W-17）**：带 run 的一方（批准者的 run 取自 `ARC_CODE_AGENT_RUN_ID` 指名、
  并经宿主核实仍在运行的 run——同 uid 的进程仍可指名另一个 run，已接受的残余风险，见 #9635；
  提议者的 run 写在 `proposer.runId`），引擎由宿主从 run 记录读出，body 里的 `engine` 只做核对，
  不符 → `engine-mismatch`。不带 run 的一方（例如 run 外的 planner）沿用自报的引擎，事件上记
  `engineSource: "declared"`。自报的引擎不算独立引擎：R2（下限或声明为 R2，含挡合并的三类判据）
  有一方是自报的，就不算决定（`engine-unverified`），但照样挂 `needs-decision` 交给人，ask 注明
  「engines declared, not run-bound」。R2 只有一条路：`decide` → `needs-decision`。

- 决定**绑定提议的 hash 和 scope**。执行入口（plan-submit，以及以后其他需要授权的入口）
  消费决定时，要校验当前要做的操作落在 scope 内；scope 变了，决定就无效，必须重新提议。
- R2 级决定只接受经过认证的人类身份。认证方式由部署提供，不能拿「不在 code-agent run 里」
  当成人类身份的证明。**凭据落地前（#8733）人类分支 fail closed**：R2 提议挂
  `attention(needs-decision)` 交给人，`actor=human` 的写入一律被拒绝（`human-unverified`）。
- 人可以推翻任何一条决定：推翻存为一条 `decision-overridden` 事件（id 由原决定派生），覆盖原结论，
  并唤醒相关判定（`work-event:<did>:decision-overridden`）。写入口和人类凭据一起落地。

**决定可以被推翻，所以先推进；被推翻的比例，就是 approve agent 的成绩单。**

## 监视者看什么

- **推翻率**：按级别分开统计。R0 的推翻率高，说明 approve agent 的判据有系统性偏差。
- **判级抽查**：随机抽 R0 / R1 决定，独立重算级别；只要有一条该是 R2 却判低了，就是 P1。
- **R2 积压**：看 `attention(kind=needs-decision)` 的数量和挂了多久，只看，不催。
