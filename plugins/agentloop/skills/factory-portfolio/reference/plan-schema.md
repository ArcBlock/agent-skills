# epic 计划的形状与交接契约

## epic 计划（P1 落地前写本地 JSON，落地后是 `/work` 上的一个 work）

```json
{"key": "portfolio:<theme-slug>",
 "rank": 1,
 "title": "<主题>",
 "taskType": "code | content | seo | media | data | intel | process",
 "whyNow": "<一两句>",
 "value": "high | med | low",
 "blast": {"packages": ["<包或 sink>"], "breaking": "no | maybe | yes",
           "breakingWhy": "...", "migration": "<迁移成本>"},
 "cost": {"runs": 6,
          "resources": ["cf-staging", "ios-device", "real-did-space", "multi-machine", "gpu", "ffmpeg"],
          "availableOn": "<现在哪台机器能提供这些资源；没有写 none>"},
 "rubric": "<非 code 类型：审查用的 rubric；code 类型省略>",
 "deps": ["portfolio:<另一个主题>", "#<issue>"],
 "release": {"channel": "beta | stable", "milestone": "<里程碑>"},
 "decisionLevel": "R0 | R1 | R2",
 "needsHuman": ["<只列 R2 事项>"],
 "epicAccept": "<epic 级 accept test：在哪个真实入口跑什么，看到什么算过>",
 "members": [
   {"root": "<源 work DID，没同步进来的写 null>", "issue": 1234,
    "taskType": "code",
    "stage": "build | design | human | defer",
    "landing": "<落点：文件或目录>",
    "targetSurface": ["<目标实现面>"],
    "allowedPaths": ["<阶段写入面草案>"],
    "denyHit": ["<命中的禁区条目，没有就是 []>"],
    "acceptance": ["<按类型：mutation pair / rubric / 指标 / 复算 / 引用>"]}
 ],
 "cut": false}
```

- `key` 是计划的身份：P1 由它派生 DID，同一主题重跑不会建出第二个计划。主题改名不改 key。
  同一 key 下 `taskType` 或成员集合变了是另一个主题（`key-conflict`）：换新 key，把旧计划 `cut`。
- `deps` 里的 `portfolio:<key>` 写成计划 → 计划的 `blocked-by` 边（work.yaml 的 `dependsOn` 就是它的投影），
  被依赖的计划要先提交（否则 `dep-unknown`）；`#<issue>` 只记在计划上。
- `root` 为 `null` 的成员记在计划上，但没有 `planned-in` 边，进不了 manifest。
- `rank` 每轮可以变（R0），变化写进 roadmap 摘要的「名次变化」一节。
- `stage` 只是建议：进 design 还是直接进 build 由 planner 按它的跳过判据决定
  （修法方向唯一、落点到文件、只动一个包）。
- `decisionLevel` 取成员里最高的那一级；有 R2 的计划，R2 成员挂 `attention(needs-decision)`，其余成员照常走。

## 交接契约：portfolio → factory-planner

P1、P2、P4 落地后的目标契约；在那之前 planner 不读计划。

1. **只通过 `/work` 交接**：计划 work + 源 work 上的 `judgments.portfolio`。不经 GitHub，不经本地文件。
2. **成员形状 ≈ manifest 成员形状**：`root`、`acceptance`、`targetSurface` planner 直接用；`allowedPaths` 只是提示——
   manifest 里的 `allowedPaths` 是阶段写入面，design 是 `<design_root>/<slug>/**`，build 取自 design.md，由 planner 重算。
   `root` 为空的成员不能交接（先同步成 work）。P2 落地后再加 `portfolio: <计划 DID>`。
3. **禁区先筛一遍**：portfolio 对 `factory_planner_deny_paths` 判过的 `denyHit` 只是第一道筛子；
   planner 进 build 前用 design.md 的文件级实现面重判，R1/R2 由代码再判。三道任何一道拦下就不派。
4. **名次是排序依据，不是闸**：planner 的 `ready(stage)` 先按计划名次、再按自身优先级和年龄排。
   计划之外的 track 照常推进。
5. **R2 成员不进 build**：直到 `decision` 写入（人类凭据 #8733 落地前，只能等人清 `attention`）。
6. **砍掉的计划**（`cut: true`）：planner 不为它的成员开新 track；在飞的 track 跑完当前阶段后停，
   不中途撤 PR（撤 PR 是 R1，要过 approve agent）。
7. **反向信号**：planner 的 stage task 结果（合并、veto、accept FAIL、`stuck`）是 portfolio 判定的
   `wakeOn` 事件源；某计划的成员 veto 率超过 1/5，说明聚错了，下一轮重聚。
