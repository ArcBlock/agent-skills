---
name: issue-graph
description: Deterministic issue-relationship graph over GitHub native sub-issues + dependencies — compute the ready set / parent-rollup candidates / close-kick targets as pure calculation (scripts, no LLM judgment), write real edges when creating spin-off issues, and mutually exclude terminal actions across parallel agents via claim-comment fencing. Called by issue-sweep (candidate injection), issue-review (edge writing + rollup), and the future agent:ready producer routine.
---

# Issue Graph — 确定性 issue 关系图（原生边 + 图计算 + 并发原语）

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> arc is the reference implementation. It resolves the repo from the git remote
> (`repo_slug`); its runtime scripts are referenced as `<plugin_root>/skills/issue-graph/scripts/*.ts`
> (the profile's `plugin_root` — so they resolve wherever the plugin is checked out). Arc's own
> issue-number provenance for any lessons is not inlined here.

**「选择和传播都是纯计算，LLM 只负责做，不负责猜该做谁。」**

GitHub 原生图（sub-issues + issue dependencies）是关系数据的**唯一真相**；本 skill
提供四个确定性脚本，把「哪些 issue 现在能做 / 哪些父 issue 该收尾 / 哪些 issue
被某次关闭解锁」从模型猜测变成每轮现算的图计算。图**不落盘**——唯一持久状态是
GitHub 本身，所以永远没有索引漂移。

设计来源、Phase 0 演练证据（149 条边、17 个 rollup 候选、fencing 实测）、并发
设计全文见 arc case-law 附录（repo-profile Case Law）。

## 脚本（`scripts/`，全部 REST-only + 手动分页）

> 为什么 REST-only：cloud routine 的出站代理挡 `gh` 的 GraphQL（403 "not
> enabled"），`--paginate` 对 issues 端点也有代理 bug（根 CLAUDE.md「按需安装
> CLI 依赖」节）。所有脚本手动 `page=N` 循环，在本地与 cloud routine 行为一致。

### graph-scan.ts — 图计算（只读，sweep 每轮调）

```bash
bun <plugin_root>/skills/issue-graph/scripts/graph-scan.ts [--window-hours 2] [--pretty]
```

输出 JSON：

| 字段 | 语义 | 消费方怎么用 |
|---|---|---|
| `ready` | open ∧ 无 open blocker；**顺序已按 hostname 旋转**（多机错峰） | 并入 sweep 候选集；`hasHold=true` 的按 hold 语义处理 |
| `blocked` | 有 open blocker 的 issue + blocker 列表 | **确定性 SKIP**（带原因），不再靠模型猜「轮没轮到」 |
| `rollupCandidates` | open ∧ 有孩子 ∧ 全部孩子已关 | 走 issue-review 的父级 rollup（fencing 互斥） |
| `kicks` | 近窗口关闭的 issue 反查出的 open parent / 被解锁 dependent | **无需人类 comment 直接注入候选集**——这就是修「子 issue 完成后要人 bump」的机制 |

窗口默认 2h > sweep 间隔 1h：同一关闭事件被两轮看见没关系，kick 只是注入候选，
后续统一走 terminal-comment 去重 + 锁 + 认领检查，重复注入零成本。

### link.ts — 写边（幂等，开派生 issue 时必调）

```bash
bun <plugin_root>/skills/issue-graph/scripts/link.ts --parent <N> --child <M>      # 父子边
bun <plugin_root>/skills/issue-graph/scripts/link.ts --issue <Y> --blocked-by <X>  # 依赖边
```

**写边纪律（图精确性的来源）**：agent 每开一个 spin-off / 派生 issue，除了 body
里的 `<!-- spinoff-of: #N -->` 标记（留作 provenance），**必须**同时调 `link.ts`
挂原生父子边；phase 之间有硬次序的加 `--blocked-by`。边已存在 = 幂等 OK；child
已有**不同** parent = 报错停下（换 parent 是人类决定）。人手开的 issue 不带边也
没关系——孤立点走现有 label/catch-all 通道，图只增强、不替代。

### claim.ts — claim-comment fencing（终态动作互斥）

```bash
bun <plugin_root>/skills/issue-graph/scripts/claim.ts --issue <N> --action rollup   # exit 0=赢 / 3=输
bun <plugin_root>/skills/issue-graph/scripts/claim.ts --release <claimId>           # 完成后必调
```

为什么存在：label 添加无 CAS，`agent:processing` 是 advisory（两机秒级内可双拿）；
产出 PR 的工作有确定性分支碰撞兜底，但 **comment + close 类终态动作（rollup）没有
任何硬兜底**。comment 流是 GitHub 唯一 append-only 全序原语（comment id 单调），
先写后读、最早未过期 claim 赢——两台机器算出同一个 winner（实测：两并发
claimer，id 只差 1，仍恰好一胜一负，loser 自删 claim）。

调用方三条纪律：① claim 前先查动作是否已做过（rollup marker / issue 已关）；
② 赢了才动手，动手前最后重读一次目标状态；③ 完成后 `--release`（崩溃靠 TTL
30min 过期兜底）。

### backfill.ts — 存量标记迁移（一次性，幂等可重跑）

```bash
bun <plugin_root>/skills/issue-graph/scripts/backfill.ts            # dry-run
bun <plugin_root>/skills/issue-graph/scripts/backfill.ts --execute  # 真写（1 边/秒限速）
```

把存量 `spinoff-of` 标记迁成原生边。冲突（child 已有不同 parent）、parent 缺失、
单 parent 100 孩子上限，全部跳过并报告，绝不强写。

## 并发设计（多机并行防打架）

确定性选择会**加剧**撞车（各机算出相同 ready set + 相同排序，cron 同分钟起跑）。
四条对策，各管一面：

1. **成员资格确定性，处理顺序随机化**——ready set 是集合不是队列，`graph-scan`
   已按 hostname 旋转输出顺序，锁竞争从"必然"变"罕见"。
2. **产出 PR 的工作**：现有两层兜底不变（`agent:processing` advisory 锁早短路 +
   确定性分支 `claude/issue-<N>` + 开 PR 前认领检查硬去重）。
3. **无分支兜底的终态动作**（rollup 的 comment+close）：`claim.ts` fencing。
4. **其余一切幂等**：写边重复 = no-op；kick 窗口重叠 = 重复注入零成本。

## Queue / producer（Phase 4）

### producer.ts — 定期图计算 + label 对账（schedule 跑）

```bash
bun <plugin_root>/skills/issue-graph/scripts/producer.ts [--window-hours 2] [--dry-run]
```

**职责铁律：只算图 + 对账索引，不执行任何实质工作。** producer 挂了消费方退化回
各自跑 `graph-scan`，无单点。

**Label 语义（反 label-spam：绝不给全部"未被 block"的 issue 打标——那会让
queue 视图失去信号）：**

| label | 含义 | 谁加 | 谁摘 |
|---|---|---|---|
| `agent:ready` | 图计算发现的**可干事件**（close-kick 目标 ∪ rollup 候选，排除 hold）| producer | **消费方处理完摘**；producer 只清理失效（hold / 变 blocked）——kick 是瞬态事件，窗口过了不代表事没了，producer 不因"不在本轮计算里"摘 |
| `agent:blocked` | 有 open blocker（确定性 SKIP 的人可见视图，稀疏）| producer | producer（状态非事件，严格全量对账）|

### 反漂移铁律

**queue/label 只是索引提示，永远不是执行依据**——worker 领到任务必须回 GitHub
重验（仍 open、仍 ready、无 hold、无新人类输入）。守住这条 queue 是缓存加速；
丢了就是又造一个会漂移的副本。规模上来后领取迁 AFS scheduler claim/lease queue
（Phase 5，deferred），label 保留为人类可读视图。

## 消费方

| skill | 集成点 |
|---|---|
| [`issue-sweep`](../issue-sweep/SKILL.md) | Step 1 前跑 `graph-scan`：kicks/rollupCandidates 注入候选集、blocked 确定性 SKIP |
| [`issue-review`](../issue-review/SKILL.md) | 开 spin-off 时调 `link.ts`（写边纪律）；父级 rollup 终态动作（`claim.ts` fencing） |
| producer routine（Phase 4） | 定期 `graph-scan` + 对账 `agent:ready` label，只索引不干活 |
