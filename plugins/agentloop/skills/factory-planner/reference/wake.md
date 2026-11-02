# 唤醒台账：工厂共用的「不重复扫」机制

## 问题

pr-sweep、issue-sweep、issue-sweep-batch 都是按时间定期把存量全扫一遍。
成本随存量线性增长，而且每轮结论几乎都和上轮一样：真正的浪费是**重新论证一个前提没变的判定**。
各家都打过补丁，但补丁各不相同，而且都不完整：

| 现状 | 补丁 | 缺口 |
|---|---|---|
| pr-sweep | `awaiting-*` 的 PR 超过 `pr_sweep_freeze_ttl_days` 进冻结集，`updatedAt` 变化就解冻 | 只看 `updatedAt`，邻居变化看不见 |
| issue-sweep-batch | fingerprint + 14 天 TTL | TTL 一到就盲目重读；邻居变化要另跑 issue-graph |
| issue-graph `graph-scan.ts` | 一个有限时间窗内的关闭事件 → `kicks` | 只扫 open 和窗口内的关闭事件；parent 查询失败就跳过；窗口外的事件丢失 |

这三者其实是同一个机制的不同特例。本文把它定义成**一个**机制（R3），
planner 是第一个用户，各个 sweep 再逐个迁过来，删掉各自的定时全量扫。

## 做法：判定 = 结论 + 失效谓词

任何消费者（planner、pr-sweep、issue-sweep）对一个 work 做出的判定，都写在 work 上，
字段带消费者的命名空间（`judgments.<consumer>`），并带一个 `wakeOn` 列表：

| 谓词 | 求值来源 |
|---|---|
| `fingerprint-changed` | 被判对象的内容指纹（issue：正文 + 排序后的 label；PR：head sha + review 状态） |
| `work-terminal:<did>` | `/work` 上那一行进入 done / dropped |
| `work-event:<did>:<type>` | `/work` 上那一行出现某类事件（merged、decision、attention-cleared…） |
| `human-replied` | 同步进来的源 issue 有新评论，且不是工厂 run 写的（身份行带 ` · run:` 段才算 agent；`agent-session` 是人借会话发言，算人，同 R8c）。CLI：`{"kind":"human-replied"}`（#9162） |
| `claim-released` / `claim-stale:<days>` | 认领状态 |
| `path-changed:<prefix>` | main 上 `<prefix>` 下有新提交，按路径段判（`foo` 不含 `foo-bar`；适用于「等某处重构完」）。CLI：`{"kind":"path-changed","prefix":"<dir>"}`；游标被重写或落后超过窗口 → 断档，这一轮失败（#9162） |
| `deny-changed` | 禁区清单文件有新提交，或准入规则变了（plan-submit 的 `ADMISSION_POLICY_VERSION`、目标仓库的 R2 边界声明，#9504 / #9637） |
| `after:<date>` | 兜底，最长不超过 `factory_planner_clock` 的 `max_sleep` |

**每条判定至少要带一个非 `after` 的谓词。** 只带 `after`，说明判定者没想清楚「什么会改变结论」，
求值器拒绝写入。

睡过 `max_sleep` 仍然没被唤醒的判定，不会被默默重读，而是挂上 `attention(kind=stuck)`
（[attention.md](attention.md)），让人看一眼它是不是被遗忘了。

## 求值器（R3）的契约

- **以事件为驱动，不以时间为驱动。** 求值器消费的是 `/work` 的事件流和同步层的增量，
  按「哪些判定订阅了这个事件」建反向索引：事件来了，只唤醒订阅它的判定。
  GitHub 的变化先由同步层变成 `/work` 事件，求值器不直接读 GitHub。
- **游标**：每个事件源都保存「上次读到哪」（`/work` 事件 seq、同步层的 cursor、main 的 sha）。
  读完才推进游标；中途失败，游标不动。
- **断档要报错**：分页拿满上限、游标早于事件源的保留窗口、任何事件源不可用，都让这一轮失败退出，
  并挂 `attention(kind=wake-miss)`。**不允许**当成「没有命中」。
- 输出：醒着的 work 列表，每条附上命中的谓词。

## 被 deny-changed 唤醒之后

`deny-changed` 命中说明「判法」可能变了，不只是「清单」变了：#9504 起，准入版本 bump、R2 边界变化
都会唤醒所有以准入为依据的判定（`excluded`，或理由里提到 deny / R2 的）。重判的规则：

- 按 SKILL.md「判定顺序」重判：先判语义上的 R2（是 → `human`，`--check` 通过也不改变）；再**逐条**对候选跑一次
  `plan-check --json`（即 `plan-submit --check --json`，没有写路径；单成员 manifest，只检查、不写），按**当前**结果判：带成员 `root` 的 `deny-path` → 维持 `excluded`，
  理由里抄这次的原因码和 detail；不带 `root` 的 `deny-path`（闭包算不出）→ 本轮失败，不写判定；其他原因码按对应 verdict 判；`check ok` → `plan`（带 `denyHits` 的成员名标
  `[<stage>][security]`，理由写明 denyHits，manifest 照常提交）。
- 旧判定的目标实现面是宽前缀（包根级 `**`、`.claude/**` 之类）的，**不能**用它重跑后维持 `excluded`：
  先读代码收窄到实际要改的文件，再跑 `--check`，按收窄后的结果判（#9610，SKILL.md「两种 surface」）。
- 维持 `excluded` 也是一次新的 `judge`，同样要带这次 `plan-check` 的单成员 manifest（`--manifest`，SKILL.md「判定顺序」）：
  代码重跑检查，宽前缀、检查通过、闭包算不出的一律拒（#9589 W-02），所以「批量写回 excluded」在代码层面就写不进去。
- **禁止**按「deny list 条目没变」「上轮理由仍成立」批量重新确认 `excluded`。清单没变而准入版本变了，
  正是这条规则要处理的情形；不跑 `--check` 就写回 `excluded`，等于把 C-2 之前的口径重新写进台账。
- 唤醒的条数多（例如一次 bump 醒来上百条）不是跳过 `--check` 的理由：`--check` 不写东西，跑满即可；
  一轮跑不完，剩下的留在醒着的集合里下一轮继续，不写回旧判定。`work wake` 一轮最多交出 `WAKE_ROUND_CAP`（50）条，
  新进来的在前；其余在结果的 `carried` 里计数，什么都不写，下一轮仍是醒着的（#9589 W-02）。

## 成本

```
awake = new ∪ {j | j.wakeOn 中有谓词被本轮事件命中} ∪ audit_sample
cost  ∝ |本轮事件| + |awake|          # 而不是 ∝ |存量|
```

验收（mutation pair）：
- 全部已判、没有事件 → 选中 0；
- 改一条的指纹 → 选中 1，而且必须正是这一条；
- 让 A 进入 done → 订阅 `work-terminal:A` 的判定被选中，没订阅的不被选中；
- 把游标调到保留窗口之前 → 必须报断档，**不能**选中 0；
- 写入只带 `after` 的判定 → 被拒绝。

## 抽查（谓词集合完备性的正控）

每 `audit_every` 轮，**调度器**（R4）随机抽 N 条睡着的判定，交给另一个引擎
（`factory_planner_approver_engine`）独立重判。消费者自己既不选样本，也不判样本。
新结论和旧判定不同，说明 `wakeOn` 漏了某类失效：记一个 `wake-miss` 事件，挂 `attention(kind=wake-miss)`。

## 迁移路线

1. planner 先用这套机制（与 R3 一起落地）。
2. issue-sweep-batch 的 ledger 迁进 `judgments.sweep-batch`（#5540 的方向），删掉本地 JSON 和 14 天 TTL。
3. pr-sweep 的冻结集改成 `judgments.pr-sweep` 加 `fingerprint-changed`（head sha、review 状态），
   删掉 `pr_sweep_freeze_ttl_days` 的定时解冻。
4. issue-sweep 同理。每迁完一个，就删掉它的定时全量扫入口：两套并存的话，旧的那套迟早会被拿来兜底，然后变回全量扫。
