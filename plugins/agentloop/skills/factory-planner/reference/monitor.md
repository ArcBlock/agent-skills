# 监视者读什么

planner 上线后，监视者（人或监工 agent）**不再扫 issue、不再派工**，只做两件事：
看工厂做得对不对，以及改进工厂。

按 [oversight-discipline](../../../../../../docs/architecture/oversight-discipline.md)，监督信号要满足三条：
- 粗粒度；
- 至少有一个底层来源是 planner 写不了的；
- 缺数据本身就要报警。

**planner 自己写的 `planner-round` 和判定只能用来诊断，不能用来监督**：
持续写空轮就能维持「心跳」，却证明不了它真的读了、真的求值了。

## 独立信号（planner 写不了）

| 信号 | 来源 | 异常形状 | 动作 |
|---|---|---|---|
| 缺席 | 调度器记录的每轮启动、退出和退出码（R4） | 超过 3 个轮间隔没有一次成功退出 | 在 planner 那一行挂 `attention(kind=stuck)` |
| 覆盖率 | 监视者自己数同步进来的 open work，对比带 `judgments.planner` 的数量 | 有 work 超过 2 个轮间隔仍没有判定 | planner 漏读，或求值器漏事件 |
| 越界 | 监视者用禁区清单独立重算每个已提交批次的 surface，并对照 R1/R2 的拦截记录 | 任何一条 | P0：撤掉 planner 的调度，查 R1 |
| 重复 | 同一个 key 对应了不止一个 DID（应该不可能，因为 DID 是派生的） | 任何一条 | P1：R1 没有用派生 DID 或「预期不存在」写入 |
| `wake-miss` | 调度器发起、由另一个引擎重判的抽查结果（R4） | 任何一条 | 补 `wakeOn` 谓词 |
| 假 epic | land 对成员的 veto、Gate 7 的拦截 | veto 率超过 1/5 | 聚簇或 surface 判据有误 |
| 阶段停滞 | stage task 的创建时间和终态时间 | 超过 `factory_planner_clock` 的 `stage_stall` | 看是 worker 卡住，还是设计实现不了 |
| 回流率 | 有 FAIL 的 acceptance.md 数量 | 高于 1/3 | design 阶段写的验收不可执行 |
| attention 积压 | `/work` 上 `attention` 的数量和 `since` 分布 | 只看分布的变化 | 写不出 `ask` 的、反复挂上又清掉的，要改挂的条件 |

## 诊断信号（planner 自报，只用来找原因）

- 判定翻转：同一条 work 7 天内翻转超过 2 次，说明判定标准有缺口，要改 skill。
- R1 拒绝原因的分布：某一类原因占了多数，说明 planner 的判断和 R1 的规则对不上。
- approve agent 的推翻率和判级抽查（[approve.md](approve.md)）。

**board 形状本身就是诊断**（factory-labor-discipline 的 board 一节）：
- design 满而 build 空：设计产不出可实现的东西；
- build 满而 accept 空：实现卡在合并；
- 三段都空、`plan` 判定却很多：planner 没在推进。

靠对比来判断，不设阈值。

## 监视者自己的边界

- 发现问题后改的是 skill、profile、禁区清单或工厂代码，走 PR 和 review；不替 planner 派单。
- 监视者的输出也是 work 上的 `attention` 和修复 PR，不在 GitHub 上开 issue 刷屏。
- 唯一的例外是越界或重复：可以先撤掉 planner 的调度再查原因；撤掉以后也不代它派工。
