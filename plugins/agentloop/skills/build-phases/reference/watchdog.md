# Watchdog — state machine, tick report, and spawn templates

> On-demand detail for build-phases Rule 4 and Step 0. The rule stays in `SKILL.md`: the parent session is the only spawner; a phase is atomic; do not stop between phases. Read this when running the watchdog.

### Rule 4: Watchdog 调度 — Parent Session 是唯一的 spawn 发起方

**`/agentloop:build-phases` 每次被调用都可能落在两种模式之一：**

- **Init 模式**：`.build-progress.json` 不存在 → 做 pre-flight、写 checkpoint、spawn 第一个 phase、schedule 下一次 wake
- **Watchdog 模式**：`.build-progress.json` 已存在 → 读状态、按状态机采取一个动作、schedule 下一次 wake（或停止 loop）

**核心原则：** 每个 phase 由**一个背景 sub-agent**（Agent 工具，`run_in_background: true`，`general-purpose` 类型）执行——干净上下文、只跑一个 phase、绝不自己派生下一个 phase 的 executor。Parent session 是唯一的调度方。

> **历史注记（2026-06-12 重写）：** 旧实现用 `claude -p` 派独立 CC 进程（订阅即将不支持 headless）。
> sub-agent 方案在完成保证上**更强**：背景 agent 完成/死亡时 harness 主动推送
> task-notification 唤醒 parent（不再依赖纯轮询），`ScheduleWakeup` 降级为兜底心跳。
> 代价是背景 agent 不能脱离 session 存活——`.build-progress.json` 持久态 + `/loop`
> 重入恢复弥补这一点。

**双驱动模型：**
1. **通知驱动（主）** — executor agent 结束时 parent 自动被 task-notification 唤醒，立即走状态机（验 E2E log → review → 推进/重派）
2. **Wakeup 兜底（辅）** — `ScheduleWakeup(1800s)` 防 executor 卡死不退出（通知永远不来）的情况：醒来读 heartbeat，stale 则 `TaskStop` + respawn

**为什么这样做：**
1. **看守与执行解耦** — executor 崩了有通知；卡死了有兜底 tick 读 stale heartbeat 并重启
2. **Context 隔离** — 每个 phase 是一个 fresh subagent；parent 只做调度 + 守门 + review 派发；parent 自身的 compaction 不丢状态（`.build-progress.json` 是真正的记忆）
3. **失败可见** — 异常最多沉默一个兜底周期（30 分钟），通常即时可见

**推荐调用方式：** `/loop /agentloop:build-phases <planning-dir>`（不带 interval，self-pacing）。直接调用也能工作，但没有兜底 tick。

#### Parent session 行为（每次进入 skill 都适用）

1. 读 `.build-progress.json` → 不存在走 Init 分支，存在走 Watchdog 分支
2. 执行对应分支的**一个**动作（spawn / 守门+review / respawn / 停止）
3. 如果任务没结束 → 调用 `ScheduleWakeup(delaySeconds=1800, prompt="/loop /agentloop:build-phases <planning-dir>", reason="fallback watchdog tick for phase N")`——这是**兜底**，正常推进靠 executor 完成时的 task-notification
4. 如果全部完成 → 输出 final report、删除 progress 文件、**不 reschedule**（loop 自然结束）

#### Watchdog 状态机

**入口有两种：** (a) executor 的 task-notification 到达（主路径）；(b) 兜底 wakeup tick。
两者动作相同：读 `.build-progress.json`（必要时配合 `TaskGet <executor_task_id>` 交叉验证 harness 侧状态），按优先级匹配：

| 条件 | 动作 |
|------|------|
| `completed_phases.length === total_phases` | **全部完成** — 输出 final report、删 progress 文件、不 reschedule |
| `executor_status === "done"` 且 **检查全过 + review approved** 且还有 phase 未完成 | **链条推进** — `current_phase` +1，spawn 下一个 phase 的 executor，reschedule 兜底 tick |
| `executor_status === "done"` 但 parent 守门未跑 | **守门** — parent 亲自跑 E2E log check（存在/非空/含 JSON/无 deferred 自白），过 → 发 clean-context review agent；review approved → 推进；NOT APPROVED → 把 review 发现写进 respawn prompt，respawn 修复（计 respawn_count） |
| `executor_status === "running"` 且 heartbeat < 30 min | **一切正常** — 什么都不做，reschedule 兜底 tick |
| `executor_status === "running"` 且 heartbeat stale ≥ 30 min | **卡死** — `TaskStop` 旧 executor、`executor_respawn_count` +1、respawn 当前 phase，reschedule |
| executor 的 task-notification 显示 agent 死亡/出错（或 `executor_status === "error"`） | **显式失败** — 读 `executor_error`；`E2E_LOG_*` 类 → escalation 停止 loop；spec 歧义/需外部操作 → 停止 loop；其余 respawn 并 reschedule |
| `executor_status === "done"` 但 `e2e_logs[phase_N]` 缺失或文件不存在/为空 | **伪完成** — 视作 error，respawn_count +1，respawn |
| 其他（init 刚写完还没 spawn） | 立即 spawn 当前 phase，reschedule |

**连续 stall 保护：** 同一 phase `executor_respawn_count ≥ 3` → 停止 loop、按 escalation 格式报告。

**与旧版的关键差异：** parent 在推进前**亲自守门**（bash 验 E2E log + deferred grep）并**亲自派发 design review**（clean-context agent）——不再信任 executor 的自报。审查者与实现者来自不同 agent，独立性强于旧设计。

#### Watchdog Tick Report（每次 wake 必须输出）

**规则：每次 watchdog wake 都在决定动作之前输出一个状态报告。** 即使动作是 `WAIT`（什么都不做），也要输出一条简短报告，让用户看到链路在动而不是死掉。

```markdown
## 🐕 Watchdog tick — phase {current_phase}/{total_phases}

**Executor:** `{executor_status}` | started {executor_started_ago} ago
**Current task:** {executor_current_task}
**Heartbeat:** {heartbeat_ago} ({fresh|stale})
**Respawn count:** {n}/3
**Completed:** {completed_phases} | **Tests:** {latest_test_count}
**Log:** `{executor_log}`

**Recent output:**
```
{tail -10 of executor_log, or "(no log file yet)" if missing}
```

**→ Decision:** `{ACTION}` — {one-line reason}
**→ Next tick:** notification-driven; fallback wake in 30 min (ScheduleWakeup) | stopping (complete/escalated)
```

**Log tail:** watchdog reads the last ~10 lines of `executor_log` on every tick and inlines them. Users who want continuous output still have `tail -f {executor_log}` in a separate terminal, but the tick alone is enough to see whether the spawned process is making progress (new `▸` markers appearing) or stuck (same tail two ticks in a row with stale heartbeat).

**在 Init 模式**用简化版（还没有 executor 状态）：
```markdown
## 🐕 Watchdog init — phase 0/{total_phases}

**Planning:** {planning-dir}
**Design review:** ✓ passed at {score}%
**Log:** `{executor_log}` (tail -f to follow)

**→ Spawned phase 0.** Advancement is notification-driven; fallback tick in 30 min.
```

**为什么强制报告：**
- 旧链式 spawn 最大问题是"沉默失败"——用户以为在跑，其实早死了
- 现在 executor 完成即推送通知，外加每 30 分钟兜底输出，用户随时能看到当前在跑什么、heartbeat 新不新鲜
- 即使是 `WAIT`（什么都没干）也要输出，让用户看到 watchdog 自己活着

**Heartbeat ago 格式化：** `< 60s → "Ns"`，`< 60min → "Nm"`，`> 60min → "Nh Mm"`，stale 的话加 `⚠️`。

#### Executor agent 行为（写进 spawn prompt）

1. **第一动作**：用 Bash 更新 `.build-progress.json`（在读任何其他文件之前）：
   ```json
   {
     "executor_status": "running",
     "executor_started_at": "<ISO>",
     "executor_current_task": "<phase name>",
     "executor_last_heartbeat": "<ISO>"
   }
   ```
2. 读 `tasks.md`，跑当前 phase 的 implement→verify→commit→simplify→re-verify→commit 流程（Section 2.1-2.5。**design review 不归 executor**——parent 在收到完成通知后亲自派发独立 reviewer）
3. 每完成一个 sub-task：更新 `executor_last_heartbeat` + `executor_current_task`，并向 `<planning-dir>/.build-logs/phase-N.log` append 一行 `▸ <sub-task>`（用户 tail -f 的进度面板）
4. **E2E log check 自检（必做，在写 `done` 之前）**：确认 `<planning-dir>/logs/s{N}-e2e.log` 存在、非空、含 JSON 形输出、无 deferred 自白（out-of-scope/deferred/skipped/will be done later）。不满足 → 写 `executor_status: "error"` + `executor_error: {reason: E2E_LOG_MISSING|E2E_LOG_NO_JSON|E2E_LOG_HAS_DEFERRED, detail}` 并结束。parent 还会复检一遍——自检是为了少跑一轮 respawn
5. Phase 完成 → 更新：
   ```json
   {
     "executor_status": "done",
     "completed_phases": [..., N],
     "test_counts": { ..., "phase_N": <count> },
     "commits": { ..., "phase_N": ["<sha>", ...] },
     "e2e_logs": { ..., "phase_N": "<planning-dir>/logs/s<N>-e2e.log" }
   }
   ```
6. **最终消息保持简短**（≤15 行：phase、测试数、commits、E2E log 路径、遇到的意外）——状态都在文件里，最终消息只是给 parent 的摘要，不要贴大段日志
7. **不要派生下一个 phase 的 executor。** 遇到 escalation → 写 `executor_status: "error"` + `executor_error: { reason, detail, attempt_count }` → 结束并在最终消息中说明

#### Checkpoint 格式

```json
{
  "planning_dir": "planning/xxx",
  "started_at": "2026-04-15T10:00:00Z",
  "total_phases": 5,
  "current_phase": 2,
  "completed_phases": [0, 1],
  "test_counts": { "phase_0": 1782, "phase_1": 1850 },
  "commits": { "phase_0": ["abc123"], "phase_1": ["def456"] },
  "e2e_logs": {
    "phase_0": "planning/xxx/logs/s0-e2e.log",
    "phase_1": "planning/xxx/logs/s1-e2e.log"
  },

  "executor_status": "running",
  "executor_started_at": "2026-04-15T10:42:00Z",
  "executor_current_task": "phase 2 — implement foo",
  "executor_last_heartbeat": "2026-04-15T10:47:00Z",
  "executor_respawn_count": 0,
  "executor_error": null,
  "executor_log": "planning/xxx/.build-logs/phase-2-20260415T104200Z.log"
}
```

#### Spawn 模板（Agent 工具）

用 Agent 工具发背景 executor。spawn 前先建 log 目录、把 log 路径和 task id 写进 progress 文件：

```
Bash: mkdir -p {planning-dir}/.build-logs
      LOG={planning-dir}/.build-logs/phase-{N}.log
      jq --arg log "$LOG" '.executor_log = $log' .build-progress.json > tmp && mv tmp .build-progress.json

Agent(
  subagent_type: "general-purpose",
  run_in_background: true,
  description: "build-phases executor: phase {N}",
  prompt: <<<
    You are a build-phases EXECUTOR for exactly ONE phase. Repo root: {abs-repo-root}.

    Read {planning-dir}/tasks.md and execute ONLY Phase {N}, following
    .claude/plugins/agentloop/skills/build-phases/SKILL.md sections 2.1-2.5 (implement → 3-layer
    verify → commit → simplify → re-verify → commit) and the layer scripts in
    .claude/plugins/agentloop/skills/build-phases/reference/execute-phase.md. Do NOT run the design
    review — the parent session dispatches an independent reviewer.

    FIRST ACTION (before reading anything else): update
    {planning-dir}/.build-progress.json via Bash:
      executor_status: "running", executor_started_at/<heartbeat>: now (ISO),
      executor_current_task: "phase {N} — starting"

    Rules:
    - After each sub-task: update executor_last_heartbeat + executor_current_task,
      and append "▸ <sub-task>" to {planning-dir}/.build-logs/phase-{N}.log
    - E2E HARD REQUIREMENT self-check before flipping to "done": logs/s{N}-e2e.log
      exists, non-empty, contains JSON-shaped afs output, no deferred-work
      admissions. Fail → executor_status: "error" + executor_error{reason,detail}.
    - On success update progress JSON: executor_status "done", append {N} to
      completed_phases, record test_counts/commits/e2e_logs.
    - TDD strictly; 3-layer verification per SKILL.md 2.2 and
      .claude/plugins/agentloop/skills/build-phases/reference/execute-phase.md;
      escalation rules per SKILL.md（停下来写 error，不要猜）.
    - NEVER commit run-generated logs/state (logs/*.log, .build-logs/,
      .build-progress*.json). Only `git add <specific-files>`.
    - Final message ≤15 lines: phase, tests, commits, e2e log path, surprises.
    {if respawn for review fixes: append the reviewer's findings here}
  >>>
)
```

写回 `executor_task_id`（Agent 返回的 task id）到 progress 文件，供 `TaskGet`/`TaskStop` 使用。

#### Spawn 后确认

Agent 工具的 launch 是同步确认的（返回 agentId 即受理），不需要旧版的 30 秒启动等待。spawn 后只做一件事：把 `executor_task_id` 写进 progress 文件，然后 `ScheduleWakeup(1800s)` 等通知。

**关键规则：一个 executor agent = 一个 phase；parent 是唯一的 spawn 发起方；推进前 parent 亲自守门 + 派 review。**

#### 回归测试

状态机 + tick 渲染有参考实现和 fixture 测试在 `test/`。每次改 Watchdog 状态机或 tick 报告格式时先改 `test/watchdog.sh` / `test/render-tick.sh` + fixtures，确认全部 pass 再改本文档：

```bash
.claude/plugins/agentloop/skills/build-phases/test/run-tests.sh
```

Fixture 覆盖：init / fresh / running-fresh / running-stale / phase-done / all-done / error / crashed / respawn-limit。Render 测试还覆盖 "Recent output" 面板（有 log 时 tail 文件，无 log 时显示占位符）。sub-agent 重写后 stale 阈值从 10 分钟改为 30 分钟，脚本默认值与 fixture 已同步更新（`STALE_SECONDS` 默认 1800）。

### Step 0: Dispatch by Mode (current session only)

**The current session NEVER writes implementation code. It only does pre-flight, dispatches spawns, and schedules watchdog wakes.**

Read `<planning-dir>/.build-progress.json`. If it does not exist → **Branch A (Init)**. Otherwise → **Branch B (Watchdog)**.

#### Branch A: Init Mode

**0a. Design Review Check:**
- Check if the planning directory has a recent design review result
- If no review on record, or last review was < 95% → **STOP. Run `/agentloop:design-review` first.**

**0b. Parse `tasks.md`** to determine `total_phases` and the phase list.

**0c. Write `.build-progress.json`** with initial state:
```json
{
  "planning_dir": "<planning-dir>",
  "started_at": "<now>",
  "total_phases": <N>,
  "current_phase": <start-phase, default 0>,
  "completed_phases": [],
  "test_counts": {},
  "commits": {},
  "executor_status": null,
  "executor_respawn_count": 0,
  "executor_error": null
}
```

**0d. Spawn the first phase** using the Agent template in Rule 4; write `executor_task_id` into the progress file.

**0e. Call `ScheduleWakeup`** with `delaySeconds: 1800` and `prompt: "/loop /agentloop:build-phases <planning-dir>"` as the fallback watchdog (primary advancement is the executor's task-notification).

**0f. Output the Init variant of the Watchdog Tick Report** (see Rule 4) including the log path. Tell the user how to tail it: `tail -f <executor_log>`.

#### Branch B: Watchdog Mode

**0a. Read `.build-progress.json`** and apply the **Watchdog 状态机** from Rule 4.

**0a'. Output the Watchdog Tick Report** (see Rule 4) — mandatory even for `WAIT` action. The user needs to see the watchdog is alive every tick.

**0b. Take at most ONE action:** spawn / check+review / respawn (`TaskStop` the stale executor first) / stop. Do not run the phase implementation in the current session — the only "work" the parent does directly is the E2E log check check (bash) and dispatching the clean-context review agent.

**0c. If task not complete** → call `ScheduleWakeup(delaySeconds: 1800, prompt: "/loop /agentloop:build-phases <planning-dir>", reason: "fallback watchdog tick for phase <N>")`.

**0d. If task complete** → output the Final Report (Section 3), delete `.build-progress.json`, **do not reschedule**.

**0e. If escalation** (`executor_respawn_count ≥ 3` on same phase, or `executor_status === "error"` with unresolvable `executor_error.reason`) → output the escalation report format (see Escalation Rules), **do not reschedule**, wait for user input.

**NEVER write implementation code in either branch.** Spawning is the only way implementation happens. The parent's own hands-on work is limited to: progress-file bookkeeping, the E2E log check (bash), dispatching the review agent, and fixing nothing — review findings go back to a respawned executor.
