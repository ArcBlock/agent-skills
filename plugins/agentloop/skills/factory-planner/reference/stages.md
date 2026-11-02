# 阶段：design → build → accept

一个 **track** 以一个源 work 为根，通常是从 GitHub issue 同步进来的那一行，从设计走到验收。
track 本身是源 work 上的一条记录（R3）：

```
track: {slug, stage, round, stageTasks: [{key, did, stage, round, result}], acceptance: [{item, result}]}
```

每个阶段都有自己的 **stage task**：一个 work object，DID 由 `deriveWorkDid(key)` 派生，
带 `spun-off-from` 边和 `followUpOf` 字段指向源 work。所有 stage task 都直接挂在源 work 下：
stage task 的 follow-up 深度 = 源 work 的深度 + 1（`followUpDepth` 沿 `followUpOf` 一直走到根，
`github-work-sync.ts`），不随 round 增加。源 work 已经处在 intake 的深度上限时，它的 track 无法开阶段，
R1 拒绝（`depth-exceeded`），planner 在源 work 上挂 `attention(kind=stuck)`。

阶段完成**只看合并的 PR**。不看 run 是否退出，也不看 pushed Change Set：`work-state` 把它也算作输出，
但「推了」不等于「完成」。派工通道目前只认 `land` / `epic-conductor`
（`providers/runtime/code-agents/src/factory/work-dispatch.ts` 的 `DISPATCHABLE_SKILLS`），
所以每个阶段的产物都做成 PR，不需要新的 workType；但 `land` 要先能处理没有 GitHub issue 的 work（R7）。

## 阶段契约

| 阶段 | stage task 数 | 进入条件 | 交付物（每个 stage task 一个 PR） | 阶段写入面 |
|---|---|---|---|---|
| **design** | 1 | verdict=`plan`；目标实现面已知（至少到文件，或不覆盖 R2 边界文件的目录）；修法方向不唯一或跨包 | `<root>/<slug>/design.md`，必须包含：frontmatter（`title` / `status: draft` / `created`）；问题陈述；选定方向与被否方向（各一句为什么）；**文件级**实现面；逐条验收（mutation pair）；拆成几个 build 成员，各自的文件面 | `<root>/<slug>/**` |
| **build** | n（按 design.md 的拆分；跳过 design 时为 1） | design 的 PR 已合并；或满足跳过判据 | 实现 PR。跳过 design 的 track，这个 PR 还要附一份 `<root>/<slug>/design.md`（只写验收和实现面），保证 accept 永远从文件读验收 | 该成员在 design.md 里的文件面，加上 `<root>/<slug>/**` |
| **accept** | 1 | 本 round 的 build 成员全部合并 | `<root>/<slug>/acceptance.md`：逐条写出在真实入口（CLI / 活环境）上跑了什么、看到了什么，结论 PASS / FAIL。**PASS 和 FAIL 的报告都合并**：报告记录的是事实，不是放行凭证 | `<root>/<slug>/**`（要补 e2e 测试，就另开 build 成员，不在 accept 阶段写代码） |

`<root>` 是 `factory_planner_design_root`。**进 build 前**，用 design.md 里的文件级实现面重新跑
`plan-submit --check` 和在飞不相交检查，按 SKILL.md「判定顺序」判：带成员 `root` 的 `deny-path`（触到 R2 边界）判 `excluded`，不带 `root` 的（闭包算不出）本轮失败；
其他拒绝码按对应 verdict；只带 `denyHits` 的照常进 build，成员名标 `[build][security]`；不相交不通过就等下一轮。

**跳过 design 的判据**（三条同时成立）：修法方向唯一；落点已定位到文件；只动一个包。

## track 状态机

```
new ──plan──► design ──merged──► build(r) ──all merged──► accept(r) ──全 PASS──► done（源 work 进入 done）
  │             │                   ▲                         │
  │             └──skip─────────────┘                         └──有 FAIL──► build(r+1)，只覆盖 FAIL 的条目
  ├──decide──► （approve agent 写入 decision）──► plan
  └──其他 verdict──► sleeping（等 wakeOn）

异常出口（任何阶段）：
  stage task 被 veto / 阶段 PR 关闭未合并 / epic 被标 blocked 或 dropped / round > 3
    ──► decide：approve agent 决定换方向重来、降为 not-actionable，或在 R2 时转 human
  decide 也给不出方向，或停留超过 stage_stall ──► 挂 attention(kind=stuck)，track 睡着，不阻塞别的 track
```

- **WIP 计数**：每阶段**在推进的 track 数**（不是 epic 数，也不是 stage task 数）。
  由 `<cli_binary> work occupancy --json` 计算（#9330，`packages/aos-factory/src/work-stage-occupancy.ts`）：
  批次 epic 全部 disarm / hold / 关闭、已被同一 track 后面的 stage task 取代、held 或 stalled 超过 2h 的
  stage task 不占名额，列入 `excluded`（带原因码）；held / stalled 超时的另给一行 `attention`。
  track 的当前 stage task 全部进入终态时释放一个位置（终态：合并后 done、转 decide、转 human）。
  有 FAIL 的报告一旦合并，accept 就算结束，同时开 build(r+1)。
- **round 按 track 计**，记在 track 记录上。
- **一个批次 epic 可以装多个 track**：每个 track 仍有自己的 stage task、slug 和 round，epic 只是派工批次。
  一个 track 失败，只改变它自己的状态。

## 批量推进（每轮）

```
# wip = factory_planner_wip；auto 时为本轮 `work capacity --json --max <factory_planner_wip_max>` 的 wip，
#       读不到 → 本轮失败退出（SKILL.md Step 3），不回退到写死的数
for stage in [accept, build, design]:          # 下游优先：先完成，再开始
    slots = max(0, wip[stage] - activeTracks(stage))   # activeTracks = work occupancy 的 stages[stage].active
                                                       # 容量变小时可以是负的：不开新的，在飞的不动
    for track in ready(stage) ordered by (priority, age):
        if slots == 0: break
        if isR2Operation(track): verdict=human; continue        # 操作本身是 R2（approve.md），与路径无关
        r = planSubmitCheck(track)                       # plan-submit --check，单成员
        if r.code == "deny-path" and isWidePrefix(targetSurface(track)):   # 宽前缀被拒不是判定（#9610）
            targetSurface(track) = narrowToFiles(track)                     # 读代码收窄到实际要改的文件
            r = planSubmitCheck(track)                                       # 按收窄后的 surface 重跑
        if r.code == "deny-path" and not r.root: fail round      # 闭包算不出：准入坏了，本轮失败，不写判定
        if r.code == "deny-path": verdict=excluded; continue   # 只有 R2 边界会拒（C-2）
        if not r.ok: verdict=verdictFor(r.code); continue      # held/owned/depth…：分流，绝不放进批次
                                                               # （任一成员被拒，整份 manifest 都被拒）
        if r.denyHits: track.name = "[<stage>][security] " + title  # 普通禁区/流程立法：照常派工，合并要 panel + 评判团
        if not disjoint(targetSurface(track), inFlight(all)): continue   # 下轮再看，不算拒绝
        batch[stage].add(track); slots -= 1
    plan-submit(manifest(batch[stage]))
```

`ready(stage)` 从 track 记录和各 stage task 的终态算出，不重新读源 issue 正文。

## 什么时候需要新的 workType

当某个阶段的交付物没法落成文件时（比如只能在活环境上观察的验收），再给 `DISPATCHABLE_SKILLS`
加一个 `accept` 类 skill，并让 `work-state` 承认验收事件也是一种输出。
这属于工厂核心代码，planner 不能为它开 track。
