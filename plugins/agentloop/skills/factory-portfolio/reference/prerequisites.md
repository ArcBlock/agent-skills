# 上线前提 P1–P3（工厂核心代码，由人审）

下面三项都改工厂核心（`packages/aos/src/work-*.ts`、`runtimes/node/src/core/commands/work.ts`），
它们都在禁区清单里，portfolio 和 planner 都不能为它们开 track，走代码 PR、由人审。
**全部落地之前，portfolio 只跑 dry-run**：判定、计划、摘要只写 `$ARC_HOME/portfolio/dry-run/`，
不调用 `arc work judge`，不挂 `attention`。唯一的例外是 runner 的缺席报警：它在 runner 专用的 work 上
挂 / 清 `attention(kind=stuck)`，和 planner 的 runner 一样，不是 portfolio 的判定。

每一项都带 accept-path 铁律要求的正反两臂，并断言拒绝的原因码。issue 号见各节标题。

## P1 — epic 计划成为 work object（#9161）

> 落地：`arc work portfolio-submit`。计划行 `workType: portfolio-plan`、`idea`；计划间依赖用已有的 `blocked-by`
> 谓词（不另立 `depends-on`）；除 `rank`、`cut` 外，其他描述字段的变化也按修订处理（事件里列出改了哪些字段），
> `taskType` 或成员集合变化 → `key-conflict`（成员按 issue 号认：`root: null` 同步成 DID 是修订，补上边）。
> 另有 `bad-plan`、`dep-unknown`、`dep-cycle`、`held`（修订被人 hold 的计划）原因码。（PR #9179）

**行为**：一个可信入口（扩展 `arc work plan-submit`，或新的 `arc work portfolio-submit`）读 portfolio 的
计划 JSON（[plan-schema.md](plan-schema.md)），以 `key` 派生 DID、「预期不存在」写入一个计划 work：
- 字段：`taskType`、`rank`、`whyNow`、`blast{packages, breaking, migration}`、`cost{runs, resources, availableOn}`、
  `release{channel, milestone}`、`decisionLevel`、`epicAccept`、`cut`；
- 边：每个成员源 work `planned-in` 计划 work；计划之间 `depends-on`；
- 同 key 内容一致 → 复用；不一致 → 新版本（`rank`、`cut` 可变，`taskType` 和成员集合变更记一条事件）。

**验收**：
- 正臂：提交一份计划 → 建出一个 work 和 n 条 `planned-in` 边；再提交一次 → DID 和边数不变。
- 反臂：成员 `root` 不存在 → `member-unknown`；`taskType` 不在闭合集合里 → `bad-task-type`；
  `release.channel=stable` 却 `decisionLevel` 低于 R2 → `level-below-floor`。
- mutation：把派生 DID 换成随机 DID，「再提交一次 DID 不变」那条测试变红。

## P2 — plan-submit 认计划（#9161，同一个 issue 的第二部分）

> 落地：另有 `plan-unknown`（DID 不是计划）；计划行被 hold 复用 `held`。写入后复读 root 时再判一次，
> 期间被 cut 的计划不会被 seal；只认在自己 key 派生 DID 上的计划行。（PR #9179）

**行为**：manifest 成员可带 `portfolio: <计划 DID>`。R1 额外检查：计划存在、`cut=false`、不在 hold；
成员的 `root` 确实 `planned-in` 这个计划；计划 `decisionLevel=R2` 的成员要带有效的 `decision`。

**验收**：
- 正臂：成员带有效计划 → 提交成功；不带 `portfolio` 的成员行为不变（兼容）。
- 反臂：计划 `cut=true` → `plan-cut`；成员不在计划里 → `plan-member`；R2 计划缺决定 → `decision-missing`；R2 计划带 agent 的决定 → `human-unverified`（R2 是人的决定，可信人类身份未落地前 fail-closed，#8733）。

## P3 — 唤醒谓词 `human-replied` 与 `path-changed`（#9162）

> 落地：事实由 daemon 提供（factory merger 挂载点的 `main-history`、`issue-comments`），基线由 judge 时写入。
> 「agent 身份」= 带 ` · run:` 段的身份行（`agent-run`）；`agent-session` 算人（同 R8c）。（PR #9177）

**行为**：`arc work judge --wake-on` 接受：
- `human-replied`：同步进来的源 issue 有新评论，作者不是 agent 身份（首行身份行判定，同 R8b）；
- `path-changed{prefix}`：main 上 `prefix` 下有新提交（游标是 main 的 sha）。

[factory-planner 的 wake.md](../../factory-planner/reference/wake.md) 早已列了这两个谓词，求值器还没实现。
portfolio 的 `trivial` / `defer` 大多在等「人回复」或「某处重构完」，没有它们只能用 `after` 兜底盲目重读。

**验收**：
- 正臂：agent 评论 → 不唤醒；人评论 → 唤醒，且只唤醒订阅了 `human-replied` 的那条。
- 正臂：`prefix` 下有提交 → 唤醒；兄弟目录（同名前缀）有提交 → 不唤醒。
- 反臂：游标早于保留窗口 → 报断档，不当作 0 条。

## P4 — planner 消费计划（流程立法，P1/P2 之后）

**行为**：factory-planner 的 `stages.md` 批量算法改成 `ready(stage)` 先按计划名次、再按 (priority, age) 排；
计划里 `human` 的成员不进 build；同一实现面上计划内的 track 先走。这是 skill 改动，不是代码，
但必须等 P1/P2 让计划可读之后再改，否则 planner 每小时读到一条做不到的指令。

**验收**：一轮 planner dry-run，两条 ready 的 track 一条在名次 1 的计划里、一条不在计划里，同阶段只剩一个空位
→ 计划内那条被选中；把名次排序去掉 → 选中的变成年龄更大的那条。

## 不是前提的

- 非代码任务类型的 sink、rubric 审查和 publish gate：#9157。portfolio 照样排序，没有机器能提供所需资源的成员判 `defer`。
- runner 的调度记录复用 `scripts/factory-planner-runs.ts`（同一个记录格式，不同的 `runs.jsonl`）。
