---
name: build-phases
description: Automated phase-by-phase implementation with a verification loop — drive a multi-phase build plan one phase at a time, each phase implemented then verified (static + dynamic + adversarial) before advancing. Use to execute a phased implementation plan (tasks.md) autonomously.
---

# Build Phases — Automated Phase-by-Phase Implementation + Verification Loop

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic; arc is the reference implementation. Toolchain commands below are written as `<package_manager> <script>` (arc: `pnpm build` / `pnpm check-types` / `pnpm test`) and `<formatter>` (arc: `biome check --write`) — map them to your repo via the profile's Toolchain keys. Arc's issue-number provenance for any lessons is not inlined here.

Execute a planning document's phases sequentially, with mandatory three-layer verification, code simplification, and design review at each phase.

> **Drive to completion (default posture).** The loop's job is to finish **all**
> phases in one continuous run — Phase 0 → 1 → … → last → final PR — not to stop
> after one phase and wait. **Do not pause for a merge between phases**, do not
> hand back "Phase N done, shall I continue?" when nothing is actually blocked.
> The loop stops for exactly two reasons: (a) **all phases are complete**, or
> (b) a **genuine must-human escalation** (the hard-stop conditions in
> "Escalation Rules" — real design fork, unresolvable failure, needs external
> creds/ops, irreversible architecture call). Everything else — next phase,
> respawn, rebase a stacked commit — the loop does itself. In autonomous /
> issue-native mode this is non-negotiable: the human may not return for hours,
> so an unnecessary pause strands the whole feature. When you *must* stop, it's
> an escalation (issue comment if issue-native, inline if a human is present),
> never a silent idle.

## Usage

**Recommended (with watchdog):**
```
/loop /build-phases <planning-dir> [--start-phase <N>] [--review-target <score>]
```

`/loop` without an interval puts the skill in self-pacing mode. Progress is primarily **notification-driven** (executor sub-agents push a task-notification when they finish); `ScheduleWakeup` provides a 30-minute fallback tick so a hung executor can never stall the chain silently. See Rule 4 for the watchdog state machine.

**Direct (single dispatch, no watchdog):**
```
/build-phases <planning-dir> [--start-phase <N>] [--review-target <score>]
```

Direct invocation still spawns one phase and writes `.build-progress.json`, but there is no automatic watchdog — you'll need to re-invoke the skill manually to advance, respawn, or finish. Prefer the `/loop` form unless you know what you're doing.

- `<planning-dir>` — Directory containing `tasks.md` (with phases) and optionally `design.md`
- `--start-phase <N>` — Start from phase N (default: 0, useful for resuming)
- `--review-target <score>` — Minimum design review score (default: 95)

### Examples

```
/loop /build-phases planning/provider-architecture-rethink/
/loop /build-phases planning/provider-architecture-rethink/ --start-phase 2
/loop /build-phases planning/aup-builder/ --review-target 90
```

### Issue-driven plans (no `planning/` file — manage in GitHub)

If the phases live in a **GitHub issue** rather than a `planning/` dir (a human
confirmed a TDD plan in the comments, e.g. `<repo_slug>#N`), do **NOT** commit
a `planning/` doc — the issue is the source of truth. Bridge mechanically:

1. **Render an ephemeral `tasks.md`** (+ optional `design.md`) from the issue's
   confirmed plan into a **scratch / gitignored** dir. `build-phases`'
   `.build-progress.json` + `logs/sN-e2e.log` also live in scratch. None of it is
   committed.
2. **Model the work in GitHub, not in files.** For a multi-phase / complex plan,
   put the phases/tasks as a **checkbox task-list** in the issue body (or a pinned
   tracking comment), and/or split into **sub-issues**. That is the durable,
   browsable tracker.
3. Run `/build-phases <scratch-dir>` normally. **Per phase = one commit**
   (TDD + 3-layer verification land together so history is bisectable), **tick
   that phase's checkbox**, and post a one-line progress comment.
4. Durable record = issue thread + checkboxes / sub-issues + merged PR(s) + git
   history. The scratch files are throwaway. Nothing lands in `planning/`.

**PR granularity ≠ phase granularity — decide by coupling, don't default to
one-PR-per-phase.** A phase is the unit of *commit* discipline; the PR is the
unit of *review + merge*. Pick the PR shape per feature:

- **One feature PR** (phases as commits; only the last commit `Fixes #N`) when
  the phases are tightly coupled and early phases have **no standalone value** —
  e.g. a Phase 0 pure-refactor "seam" that nothing consumes yet, or a feature
  that's only half-wired until the final phase. This is the **default for a
  coherent feature**: one review, one merge, main never carries a half-feature,
  and (crucial in autonomous mode) the human hits **one** merge gate, not N.
- **One PR per phase** (`Refs #N` each, final `Fixes #N`) only when each phase
  **independently ships and delivers value** (e.g. unrelated doc deletions, or
  steps that can each go live on their own), or the diff is genuinely too large
  to review at once.

When unsure, prefer the single feature PR for a feature; reserve per-phase PRs
for independently-shippable work. If a human is present, you may ask; in
autonomous mode pick by the coupling test above and state the choice in the PR
body.

**Autonomous escalation → issue comment, not an inline wait.** In this
issue-native flow nobody is babysitting the session, so every escalation
(see "Escalation Rules" below) that would normally `⏸ 停下来等用户指令`
must instead be **posted as a comment on the source issue** — state the blocker,
the options, and your recommendation — and then stop that work item without
waiting in-session. The human answers asynchronously on the issue and the next
sweep resumes. Still record the same `executor_status: "error"` + `executor_error`
in the scratch `.build-progress.json` so a resumed run knows where it stopped.
Only use an inline blocking prompt when a human is demonstrably present in the
session.

## How It Works

For each phase in `tasks.md`:

```
┌─────────────────────────────────────────────────────┐
│  Phase N                                             │
│                                                      │
│  1. IMPLEMENT                                        │
│     Read phase spec from tasks.md                    │
│     Write tests first (TDD)                          │
│     Implement until tests pass                       │
│     Use parallel subagents for independent tasks     │
│                                                      │
│  2. VERIFY (three layers, mandatory, not skippable)  │
│     Layer 1: build + type-check + test suite         │
│     Layer 2: Start service, send real requests        │
│            → write raw afs_exec output to            │
│            planning/<dir>/logs/s{N}-e2e.log          │
│            (HARD GATE — phase NOT done without it)   │
│     Layer 3: Adversarial — break it intentionally    │
│     → ALL must pass, or go back to 1                 │
│                                                      │
│  3. COMMIT "phase N: implement"                      │
│                                                      │
│  4. SIMPLIFY (/simplify skill)                       │
│     Clean up code for clarity and maintainability    │
│                                                      │
│  5. RE-VERIFY (Layer 1 only — ensure no regression)  │
│     → FAIL? Revert simplify changes                  │
│                                                      │
│  6. COMMIT "phase N: simplify"                       │
│                                                      │
│  7. DESIGN REVIEW (parent dispatches a clean-context │
│     reviewer — implementer and reviewer are           │
│     DIFFERENT agents)                                 │
│     Score must meet --review-target                   │
│     → NOT APPROVED? respawn executor with findings   │
│                                                      │
│  8. Report phase completion, proceed to Phase N+1    │
└─────────────────────────────────────────────────────┘
```

## CRITICAL: Execution Continuity Rules

**这些规则防止 agent 在 phase 中途停下来。**

### Rule 1: Phase 是原子的 — 8 步全部完成才输出

**在一个 phase 的 8 个步骤全部完成之前，不要向用户输出任何总结或报告。**

- ❌ 错误：implement → commit → "Done! 4 tests added." → 等用户说话
- ✅ 正确：implement → commit → simplify → re-verify → commit → review → fix if needed → THEN report

唯一允许中途输出的情况是 **escalation（hard stop 条件）**。非 escalation 情况一律继续执行下一步。

### Rule 2: Phase 之间也不停

多 phase 任务中，一个 phase 完成后立即开始下一个。不要等用户确认。

- ❌ 错误：Phase 0 complete → "Phase 0 done, shall I proceed to Phase 1?" → 等用户
- ✅ 正确：Phase 0 complete → Phase 1 starts immediately → ... → all phases done → final report

每个 phase 输出简短的 completion line（不超过 3 行），然后立即开始下一个。

### Rule 3: 跑到最后才出最终报告

只有以下情况才停下来：
1. **所有 phase 都完成了** → 输出 final report
2. **遇到 escalation 条件** → 输出 ⏸ 报告，等用户指令
3. **用户主动中断**

### Rule 4: Watchdog 调度 — Parent Session 是唯一的 spawn 发起方

**`/build-phases` 每次被调用都可能落在两种模式之一：**

- **Init 模式**：`.build-progress.json` 不存在 → 做 pre-flight、写 checkpoint、spawn 第一个 phase、schedule 下一次 wake
- **Watchdog 模式**：`.build-progress.json` 已存在 → 读状态、按状态机采取一个动作、schedule 下一次 wake（或停止 loop）

**核心原则：** 每个 phase 由**一个背景 sub-agent**（Agent 工具，`run_in_background: true`，`general-purpose` 类型）执行——干净上下文、只跑一个 phase、绝不自己派生下一个 phase 的 executor。Parent session 是唯一的调度方。

> **历史注记（2026-06-12 重写）：** 旧实现用 `claude -p` 派独立 CC 进程（订阅即将不支持 headless）。
> sub-agent 方案在完成保证上**更强**：背景 agent 完成/死亡时 harness 主动推送
> task-notification 唤醒 parent（不再依赖纯轮询），`ScheduleWakeup` 降级为兜底心跳。
> 代价是背景 agent 不能脱离 session 存活——`.build-progress.json` 持久态 + `/loop`
> 重入恢复弥补这一点。

**双驱动模型：**
1. **通知驱动（主）** — executor agent 结束时 parent 自动被 task-notification 唤醒，立即走状态机（验 gate → review → 推进/重派）
2. **Wakeup 兜底（辅）** — `ScheduleWakeup(1800s)` 防 executor 卡死不退出（通知永远不来）的情况：醒来读 heartbeat，stale 则 `TaskStop` + respawn

**为什么这样做：**
1. **看守与执行解耦** — executor 崩了有通知；卡死了有兜底 tick 读 stale heartbeat 并重启
2. **Context 隔离** — 每个 phase 是一个 fresh subagent；parent 只做调度 + 守门 + review 派发；parent 自身的 compaction 不丢状态（`.build-progress.json` 是真正的记忆）
3. **失败可见** — 异常最多沉默一个兜底周期（30 分钟），通常即时可见

**推荐调用方式：** `/loop /build-phases <planning-dir>`（不带 interval，self-pacing）。直接调用也能工作，但没有兜底 tick。

#### Parent session 行为（每次进入 skill 都适用）

1. 读 `.build-progress.json` → 不存在走 Init 分支，存在走 Watchdog 分支
2. 执行对应分支的**一个**动作（spawn / 守门+review / respawn / 停止）
3. 如果任务没结束 → 调用 `ScheduleWakeup(delaySeconds=1800, prompt="/loop /build-phases <planning-dir>", reason="fallback watchdog tick for phase N")`——这是**兜底**，正常推进靠 executor 完成时的 task-notification
4. 如果全部完成 → 输出 final report、删除 progress 文件、**不 reschedule**（loop 自然结束）

#### Watchdog 状态机

**入口有两种：** (a) executor 的 task-notification 到达（主路径）；(b) 兜底 wakeup tick。
两者动作相同：读 `.build-progress.json`（必要时配合 `TaskGet <executor_task_id>` 交叉验证 harness 侧状态），按优先级匹配：

| 条件 | 动作 |
|------|------|
| `completed_phases.length === total_phases` | **全部完成** — 输出 final report、删 progress 文件、不 reschedule |
| `executor_status === "done"` 且 **gate 全过 + review approved** 且还有 phase 未完成 | **链条推进** — `current_phase` +1，spawn 下一个 phase 的 executor，reschedule 兜底 tick |
| `executor_status === "done"` 但 parent 守门未跑 | **守门** — parent 亲自跑 E2E log gate（存在/非空/含 JSON/无 deferred 自白），过 → 发 clean-context review agent；review approved → 推进；NOT APPROVED → 把 review 发现写进 respawn prompt，respawn 修复（计 respawn_count） |
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
4. **E2E log gate 自检（必做，在写 `done` 之前）**：确认 `<planning-dir>/logs/s{N}-e2e.log` 存在、非空、含 JSON 形输出、无 deferred 自白（out-of-scope/deferred/skipped/will be done later）。不满足 → 写 `executor_status: "error"` + `executor_error: {reason: E2E_LOG_MISSING|E2E_LOG_NO_JSON|E2E_LOG_HAS_DEFERRED, detail}` 并结束。parent 还会复检一遍——自检是为了少跑一轮 respawn
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
    verify → commit → simplify → re-verify → commit). Do NOT run the design
    review — the parent session dispatches an independent reviewer.

    FIRST ACTION (before reading anything else): update
    {planning-dir}/.build-progress.json via Bash:
      executor_status: "running", executor_started_at/<heartbeat>: now (ISO),
      executor_current_task: "phase {N} — starting"

    Rules:
    - After each sub-task: update executor_last_heartbeat + executor_current_task,
      and append "▸ <sub-task>" to {planning-dir}/.build-logs/phase-{N}.log
    - E2E HARD GATE self-check before flipping to "done": logs/s{N}-e2e.log
      exists, non-empty, contains JSON-shaped afs output, no deferred-work
      admissions. Fail → executor_status: "error" + executor_error{reason,detail}.
    - On success update progress JSON: executor_status "done", append {N} to
      completed_phases, record test_counts/commits/e2e_logs.
    - TDD strictly; 3-layer verification per SKILL.md 2.2; escalation rules per
      SKILL.md（停下来写 error，不要猜）.
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

## Implementation Instructions

### Step 0: Dispatch by Mode (current session only)

**The current session NEVER writes implementation code. It only does pre-flight, dispatches spawns, and schedules watchdog wakes.**

Read `<planning-dir>/.build-progress.json`. If it does not exist → **Branch A (Init)**. Otherwise → **Branch B (Watchdog)**.

#### Branch A: Init Mode

**0a. Design Review Gate:**
- Check if the planning directory has a recent design review result
- If no review on record, or last review was < 95% → **STOP. Run `/design-review` first.**

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

**0e. Call `ScheduleWakeup`** with `delaySeconds: 1800` and `prompt: "/loop /build-phases <planning-dir>"` as the fallback watchdog (primary advancement is the executor's task-notification).

**0f. Output the Init variant of the Watchdog Tick Report** (see Rule 4) including the log path. Tell the user how to tail it: `tail -f <executor_log>`.

#### Branch B: Watchdog Mode

**0a. Read `.build-progress.json`** and apply the **Watchdog 状态机** from Rule 4.

**0a'. Output the Watchdog Tick Report** (see Rule 4) — mandatory even for `WAIT` action. The user needs to see the watchdog is alive every tick.

**0b. Take at most ONE action:** spawn / gate+review / respawn (`TaskStop` the stale executor first) / stop. Do not run the phase implementation in the current session — the only "work" the parent does directly is the E2E log gate check (bash) and dispatching the clean-context review agent.

**0c. If task not complete** → call `ScheduleWakeup(delaySeconds: 1800, prompt: "/loop /build-phases <planning-dir>", reason: "fallback watchdog tick for phase <N>")`.

**0d. If task complete** → output the Final Report (Section 3), delete `.build-progress.json`, **do not reschedule**.

**0e. If escalation** (`executor_respawn_count ≥ 3` on same phase, or `executor_status === "error"` with unresolvable `executor_error.reason`) → output the escalation report format (see Escalation Rules), **do not reschedule**, wait for user input.

**NEVER write implementation code in either branch.** Spawning is the only way implementation happens. The parent's own hands-on work is limited to: progress-file bookkeeping, the E2E log gate (bash), dispatching the review agent, and fixing nothing — review findings go back to a respawned executor.

### Step 0.5: Pre-Code Principle Check (in executor agent)

Before writing ANY code in any phase, verify the design does not violate:

1. **AFS-Only I/O** — Does any part of the design bypass AFS? If you notice the tasks.md describing direct file access, HTTP fetch, or any I/O that doesn't go through AFS → **STOP and escalate to user**
2. **Abstraction reuse** — Does the design reinvent something that already exists in AFS? → **STOP and escalate**
3. **Provider boundary** — Does code outside a provider directly access underlying resources? → **STOP and escalate**

These checks apply at EVERY phase, not just the start. If during implementation you find yourself about to write code that violates these principles: **STOP immediately and ask the user, even if it means the phase is incomplete.**

### Step 1: Parse tasks.md and identify phases

Read `<planning-dir>/tasks.md`. Identify all phases by looking for:
- `## Phase N:` headers
- `## Task N:` headers (some docs use tasks instead of phases)
- Numbered sections with implementation steps

Build a list of phases with their:
- Name / number
- Acceptance criteria
- Test files to create
- Files to modify
- Dependencies on previous phases

**Parallel phase detection:** If two phases have no dependency between them (both listed as "独立" or no cross-references), they CAN run in parallel using separate Agent subagents. Build a dependency graph and identify parallelizable groups.

### Step 1.5: Pre-implementation check — what already exists?

**Before implementing each phase**, check if the work is already done:

```
For each phase:
1. Check if files-to-create already exist (ls/stat)
2. If they exist, check if they have substantial content (not just scaffold)
3. Check if tests already exist and pass
4. If phase is already implemented → SKIP with note "already done"
5. If partially implemented → adjust scope to only the missing parts
```

This prevents re-implementing work that was done outside of /build-phases (manual coding, other sessions, etc.).

### Step 2: Execute phases

**If phases are independent (no dependency):** Launch parallel Agent subagents, each implementing one phase. Merge results, then verify all together.

**If phases have dependencies:** Execute sequentially as described below.

For each phase:

#### 2.1 IMPLEMENT

Read the phase spec carefully. Follow TDD strictly:
1. Write test files first (all tests should fail initially)
2. Implement until all tests pass
3. For independent sub-tasks within a phase, use parallel subagents (Agent tool with worktree isolation)

#### 2.2 VERIFY — Three Layers (MANDATORY)

This is the critical step. Do NOT skip any layer.

**Layer 1: Static**
```bash
<package_manager> build
<package_manager> check-types
<package_manager> --filter <affected-packages> test    # specific
<package_manager> test                                  # full suite
```
- Compare full test pass count with previous phase
- If pass count decreased → FAIL

**Layer 2: Dynamic — Actually run the feature (E2E, not just unit tests)**

**MANDATORY:** Follow the `### E2E Verification (mandatory)` table from tasks.md for this phase. If the table doesn't exist, STOP and escalate — every phase must have one.

#### HARD GATE: E2E log file

**Phase cannot be marked `done` unless `<planning-dir>/logs/s{N}-e2e.log` exists AND contains the raw afs_exec output.**

Before running the E2E section:

```bash
mkdir -p <planning-dir>/logs
LOG_FILE="<planning-dir>/logs/s${PHASE}-e2e.log"
# Truncate at start of Layer 2 so each run is fresh
: > "$LOG_FILE"
```

For every `afs_exec` / `afs_read` / `afs_list` call specified in the phase's E2E Verification table:

1. Run the call via the MCP tool (or `<cli_binary>` CLI / curl equivalent).
2. Append a header line with the command + a JSON-serialised response to `$LOG_FILE`, e.g.:
   ```
   === S6.1 afs_exec /blocklets/demo-team-seq/.actions/run ===
   input: {"message": "hello"}
   output: {"success": true, "data": {"reply": "..."}, "_meta": {...}}
   ```
3. Do NOT paraphrase ("verified via AFS", "tests passed"). Paste the raw JSON.
4. Include at least one negative case (invalid session / bad path / missing field).

**Phase-done check (spawned executor MUST run before flipping `executor_status` to `"done"`):**

```bash
test -s "<planning-dir>/logs/s${PHASE}-e2e.log" || {
  # Log missing or empty — write error and exit
  jq '.executor_status = "error" | .executor_error = {reason: "E2E_LOG_MISSING", detail: "<planning-dir>/logs/s'${PHASE}'-e2e.log missing or empty"}' \
    <planning-dir>/.build-progress.json > /tmp/bp.json && mv /tmp/bp.json <planning-dir>/.build-progress.json
  exit 1
}
```

Also the log must contain at least one JSON object response (not just prose). A quick sanity check:

```bash
grep -E '^\s*[{\[]|"success"\s*:' "<planning-dir>/logs/s${PHASE}-e2e.log" > /dev/null || {
  # No JSON detected — treat as missing
  ...E2E_LOG_NO_JSON error...
}
```

On success, record the log path in `.build-progress.json`:

```json
{
  "e2e_logs": { "phase_N": "<planning-dir>/logs/s{N}-e2e.log" }
}
```

**Named sessions for deterministic access:**
```bash
# 1. Restart daemon with latest build
afs service restart

# 2. Open target page with named session (Playwright or browser)
playwright → http://target.localhost:4900/?session=e2e-{phase-name}

# 3. Call AFS MCP paths directly — ZERO session discovery
afs_read /dev/ui/web/sessions/e2e-{phase-name}/inspect/viewport
afs_list /dev/ui/web/sessions/e2e-{phase-name}/dom/main
```

Choose additional verification based on change type:

| Change Type | Strategy |
|-------------|----------|
| **Provider** | Mount provider → list/read/write/exec through AFS MCP tools |
| **Session/Protocol** | `afs service restart` → open page with `?session=e2e-test` → call AFS paths |
| **AUP/UI** | Use inspect capabilities: `design-audit`, `overflow-scan`, `dom/@styles`, `accessibility` |
| **Inspect feature** | Test the new inspect path on a real page via named session |
| **Pure utility/library** | Call functions directly via a REPL/one-off script — verify output |
| **CLI** | Run CLI commands, verify stdout/exit code |
| **Refactoring** | Layer 1 sufficient — Layer 2 = verify one happy path via AFS MCP |

**OUTPUT THE ACTUAL TOOL CALL RESULTS.** Paste the `afs_read` / `afs_list` / `afs_exec` responses. Do not just say "verified via AFS". Show the JSON. These same outputs must also land in `<planning-dir>/logs/s{N}-e2e.log` (see HARD GATE above).

**Layer 3: Adversarial — Try to break it**
Try at least ONE of:
- Send empty/null/undefined where values are expected
- Send oversized payload (>16MB for WS)
- Path traversal attack (../, %2e%2e, null bytes)
- Kill process mid-operation, check for data corruption
- Concurrent operations, check for race conditions
- Prototype pollution (__proto__, constructor)

**OUTPUT THE RESULTS.** Paste actual terminal output showing what you ran and what happened. Do not just say "tests passed."

If any layer fails → fix → re-run all three layers.

#### 2.3 COMMIT

**Always format before committing** to avoid pre-commit hook failures:
```bash
<formatter> <changed-files>
git add <specific-files>
git commit -m "phase N: implement <description>"
```

**Never commit run-generated log/state files.** `<planning-dir>/logs/*.log`、
`<planning-dir>/.build-logs/`、`.build-progress*.json` 都已被 `.gitignore` 覆盖——它们是本地证据/状态，
不是交付物。规则：
- 只 `git add <specific-files>`，绝不 `git add -A` / `git add .`；
- 绝不 `git add -f` 强加被 ignore 的 log——E2E hard gate 验证的是文件**存在于本地**，不要求入库；
  design review 的 reviewer 直接读本地文件。
- **改了依赖 → lockfile 必须一起 add。** "specific files" **包含**本次连带产生的改动:改了 `package.json` 的依赖后,安装会更新 `<package_manager>` 的 lockfile(如 `pnpm-lock.yaml`/`package-lock.json`/`yarn.lock`);只提 manifest 不提 lockfile → 两者不一致,别处 / 后续 phase / 其他 agent 的 `<package_manager> install --frozen-lockfile` 直接红。**commit 前先 `git status` 扫连带改动:**
  - 本次动了依赖、lockfile 有对应 diff → 一起 `git add <lockfile>`(`git diff` 确认 diff 只含你增删的包,scoped);
  - 本次没碰依赖、lockfile 却有 diff → 是并发/无关改动,**别卷入**——精确 add 的意义正在于此。

#### 2.4 SIMPLIFY (conditional)

**Skip if phase changed < 50 lines of production code** (tests don't count). Small changes rarely benefit from a simplify pass.

If applicable, launch a `code-simplifier:code-simplifier` agent (or use /simplify skill). Focus on:
- Recently modified files only
- Clarity and maintainability
- Remove unnecessary complexity
- Do NOT change behavior

#### 2.5 RE-VERIFY

Run Layer 1 only (build + types + tests). If simplify broke something:
- Revert the simplify changes
- Commit without simplify
- Note what went wrong

Otherwise:
```bash
git add <simplified-files>
git commit -m "phase N: simplify"
```

#### 2.6 DESIGN REVIEW（parent 负责，不在 executor 内）

收到 executor 完成通知并通过 E2E log gate 后，**parent** launch 一个 clean-context review agent（与 /design-review 同模式）。审查者与实现者是不同的 agent——独立性是设计要求：NOT APPROVED 时 parent 把 review 发现写进 respawn prompt 重派 executor 修复，而不是 reviewer 自己修。Review prompt:

```
你是一个独立的代码审查者。检查 Phase {N} 的实现是否符合 spec。

1. 读取 {planning-dir}/tasks.md 中 Phase {N} 的 spec
2. 读取实际代码变更（git diff HEAD~2 对比 phase 开始前）
3. 读取 E2E 日志 {planning-dir}/logs/s{N}-e2e.log：
   - 文件必须存在且非空
   - 必须包含 JSON-shaped 响应（至少一个 `{` 或 `"success":` 行）
   - 如果只是散文 ("verified via AFS"、"tests passed") → NOT APPROVED
   - 至少包含 tasks.md 的 E2E Verification 表中列出的每一个 afs_exec 调用
4. 检查：
   - 所有 acceptance criteria 是否满足
   - 测试是否覆盖 spec 中列出的场景
   - 是否有 spec 中描述但未实现的功能
   - 是否有实现了但 spec 中没提到的额外功能（scope creep）
   - E2E 日志中的返回值是否匹配 tasks.md 预期（比如 `success: true`、特定字段）
5. 打分 0-100%。E2E 日志缺失或不合格 = 自动 NOT APPROVED，不管其他维度。
```

If score < target:
- Parent respawns the executor with the reviewer's findings appended to the prompt
- Respawned executor fixes, re-runs verify (Layer 1), updates progress JSON
- Parent re-dispatches review on the next notification
- Repeat until approved (counts toward the same respawn_count ≤ 3 budget)

#### 2.7 REPORT（parent 在 review approved 后输出）

Output phase completion summary:
```
## Phase N Complete

**Tests:** X pass (up from Y)
**Verification:** Layer 1 ✓ | Layer 2 ✓ | Layer 3 ✓
**E2E log:** `planning/<dir>/logs/s{N}-e2e.log` ({bytes} bytes, {calls} afs_exec calls)
**Simplify:** Applied / Skipped
**Review:** {score}% — APPROVED
**Commits:** {hash1} (implement), {hash2} (simplify)
```

The E2E log line is **required** — omitting it (or pointing at a missing/empty file) means the phase did not pass the hard gate.

### Step 3: Final report after all phases

```
## Build Phases Complete

**Planning:** {planning-dir}
**Phases completed:** {N} / {total}
**Total test count:** {before} → {after}
**All phases:** PASSED
```

## Escalation Rules（什么时候必须停下来问用户）

**这些是 hard stop 条件。遇到时立即停止自动执行，向用户报告情况并等待指令。不要自己猜测或绕过。**

### 必须停下来的情况

| 条件 | 触发 | 报告内容 |
|------|------|----------|
| **连续失败 3 次** | 同一个 test/build/verify 失败 3 次，每次 fix 都没解决 | 贴出 3 次的错误信息 + 你尝试了什么 + 你的猜测 |
| **E2E log 写不进去** | Layer 2 跑过一轮之后 `<planning-dir>/logs/s{N}-e2e.log` 仍缺失/空白/无 JSON | 贴出执行的命令 + 实际响应 + 你的诊断；**不要**伪造 log 蒙混过关 |
| **Spec 歧义** | tasks.md 对某个行为有两种合理解读，选哪个会影响后续 phase | 列出两种解读 + 各自影响 + 你的倾向 |
| **需要外部操作** | 需要用户配置环境、提供 credentials、启动外部服务、安装系统依赖 | 说明需要什么 + 为什么 + 用户操作步骤 |
| **架构决策** | 实现过程中发现 tasks.md 没覆盖到的设计选择，且影响不可逆 | 描述决策点 + 选项 + tradeoff |
| **Scope 溢出** | 发现要完成当前 phase 必须改 spec 外的代码，改动量超预期 | 列出额外改动 + 为什么需要 + 是否应该拆 phase |
| **测试覆盖疑问** | tasks.md 的测试 spec 没覆盖到你发现的重要场景 | 描述场景 + 为什么重要 + 建议的测试 |
| **性能异常** | verify Layer 2 发现性能比预期差 10x 以上 | 贴出数据 + 瓶颈分析 |

### 报告格式

遇到 hard stop 时，用这个格式：

```markdown
## ⏸ Phase N 需要你的输入

**停止原因：** {条件名}
**当前进度：** {做到哪一步了}
**问题描述：** {具体是什么}

**我尝试过的：**
1. ...
2. ...
3. ...

**我的判断：** {你觉得应该怎么做}
**需要你：** {具体需要用户做什么}
```

### 不应该停下来的情况

以下情况自己解决，不要打断用户：

- 普通的 type error → 自己 fix
- 测试失败但原因明确 → 自己 fix
- import 路径错误 → 自己 fix
- 需要安装一个 npm dev dependency → 自己 `<package_manager> add -D`
- Lint/format 错误 → 自己 `<formatter>`
- 一次就修好的 bug → 自己修

**判断标准：如果你有信心（>80%）能在 1-2 次尝试内解决，自己做。如果连续失败或不确定方向，停下来。**

## Key Principles

1. **TDD is non-negotiable** — write tests before implementation in every phase.

2. **Three-layer verification is not optional** — Layer 2 (dynamic) catches the bugs that unit tests miss. Layer 3 (adversarial) catches security and resilience issues. Both must be done.

3. **Show your work** — paste actual test output, not just "tests passed." This is how the user knows verification actually happened.

4. **Each phase is independently deployable** — after each phase, the system must be fully functional. No "half-done" phases.

5. **Simplify preserves behavior** — if simplify breaks tests, revert it. Code clarity is important but correctness is more important.

6. **Review is against the spec** — the clean-context reviewer checks implementation vs. documented spec, not general code quality (that's what simplify does).

7. **When in doubt, test more** — if you're unsure whether something works, run it. AFS's WS protocol makes everything testable programmatically.

8. **When stuck, stop and ask** — escalation is not failure. Wasting 30 minutes guessing is worse than asking a 30-second question. Follow the escalation rules above.
