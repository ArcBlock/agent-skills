# attention：静默地让人看见

## 为什么不用 GitHub 评论

工厂的状态以 work object 为主体，GitHub issue 只是同步进来的数据。需要人看的东西，
如果写成 issue 评论或 `needs-human-confirm` label，就把状态又放回了投影层：
它会刷屏，会触发通知，而且工厂自己读不回来。

所以：**长期推不动、需要人看一眼的东西，在对应的 work 上挂 `attention`。**
不发通知，不 @ 人，不在 GitHub 上留言。人打开 board 就能看到。

## 字段（R6，写在 work 上）

```
attention: {
  kind:   needs-decision | stuck | wake-miss | boundary | other,
  ask:    一句话：要人做什么（决定什么 / 看什么），写不出 ask 就不该挂,
  since:  第一次挂上的时间（之后重写也不变）,
  by:     挂它的身份（planner / approve agent / monitor）,
  evidence: [指向 work、decision、事件的链接],
}
```

- 每个 work 只有一个 `attention`。同一原因再次触发时只更新 `evidence`，`since` 保持不变，这样「挂了多久」是真实的。
- 由人清除，或者由挂它的一方在条件消失时清除（比如决定已写入、track 已推进）。清除时写一个 `attention-cleared` 事件。
- **`by` 取自 run（#9589 W-17）**：在 code-agents run 里，挂和清的身份取自 `ARC_CODE_AGENT_RUN_ID` 指名的 run，
  并经宿主核实该 run 存在且仍在运行（id 为空或宿主不认识 → 拒绝）；同 uid 的进程仍可指名另一个 run
  （已接受的残余风险，见 #9635）。`--by` 可以省略，写成别人会被拒绝；run 外是 `--by`，但不能写成工厂自己的写入方
  （`approval-drain`、`acceptance-check`、`factory-merge`、`factory-merge-check`、`r2-boundary`、`work-release`）、
  引擎名、run id（`agent-…`）或 `human`。
- **CLI 能清什么（#9589 W-17）**：`arc work attention clear` 只清调用方自己挂的标记，别人挂的拒绝；
  而且**人的标记谁也清不了**——`needs-decision`（R2、挡合并三类、或任何问过人的）在可信人类凭据（#8733）落地前
  没有 CLI 入口能清，只有宿主进程内的工厂代码（drain 等）在条件消失时清自己挂的。
  CLI 的 `set` 也一样：不覆盖别人挂的标记（`--keep-foreign` 总是生效），也不覆盖人的标记，
  所以「先 set 覆盖、再 clear」清不掉人的标记；`decide` 的 R2 遇到已有人的标记时保留原标记。
- 静默是默认行为。要不要另外推送通知，是 board 或人自己的设置，不是工厂的职责。

## 什么时候挂

| 情况 | kind | 谁挂 |
|---|---|---|
| R5 判出 R2 级决定，等人拍板 | `needs-decision` | approve agent |
| 某个 track 在一个阶段停留超过 `stage_stall`，或者 round 用完、approve agent 也给不出方向 | `stuck` | planner |
| 判定一直睡着，超过 `max_sleep` 都没被唤醒（说明它可能被遗忘了） | `stuck` | 求值器（R3） |
| 抽查发现 `wakeOn` 漏了某类失效 | `wake-miss` | 调度器（R4） |
| 任何一次越界（R1/R2 拦下的禁区命中） | `boundary` | R1 / R2 |

## board 上怎么看

attention 是 `/work` 上一个可查询的字段，按 `kind`、`since` 排序就是一份「待人看」清单。
挂得最久的排在最前面。工厂自己不去处理这份清单，也不因为它停下：
挂了 `attention` 的 track 照常睡着，其他 track 照常推进。

## 监视者看什么

- 挂了多久的分布：`since` 越来越早，说明人没在看，或者 `ask` 写得没法回答。
- 同一个 work 反复挂上又清掉：清除的条件判错了。
- `boundary` 一出现就是 P0：停 planner，查 R1/R2。
