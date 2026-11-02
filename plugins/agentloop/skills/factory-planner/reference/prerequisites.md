# 上线前提 R1–R7（工厂核心代码，由人审）

下面八项都是工厂核心代码，planner 不能为它们开 track，它们的文件都在禁区清单里（闭包测试 `scripts/test/factory-planner-deny.test.ts` 保证）。**全部已落地**（R3 的 new/deny-changed 补全见 #9051）；尚未完成的部分在各节里写明。
每一项都带 accept-path 铁律要求的正反两臂，并断言拒绝的原因码。

## R1 — `work plan-submit --manifest`：可信提交入口（已实现：`packages/aos-factory/src/work-plan-submit.ts`）

**位置**：`packages/aos/src/`（与 `work-approval.ts`、`github-work-sync.ts` 的 intake 检查放在一起）；
CLI 入口在 `runtimes/node/src/core/commands/work.ts`。

**行为**：读 planner 的 manifest（格式见 SKILL.md 的 Step 4），依次：
1. **派生身份**：key 由 R1 从 `(root, stage, round, part)` 计算，作为 `createWork` 的 nonce，DID 由 nonce 派生
   （`packages/aos/src/work-create.ts`、`work-derived-did.ts`）；全部以「预期不存在」的方式写入。
   已存在且内容一致 → 复用；已存在但内容不一致 → 拒绝（`key-conflict`）。
2. **写边**：成员 `member-of` 批次 epic；`spun-off-from` 源 work；设置 `followUpOf = 源 work`。
3. **检查**，任何一条不过就拒绝，已创建的行停在 `idea`，不派工：

| 检查 | 原因码 |
|---|---|
| 每个成员的 `allowedPaths` 和 `targetSurface` 都不与 **R2 边界**相交（目标仓库默认分支上 `.claude/factory-r2-boundary.txt` 声明的文件和执行它的闸代码，加上工厂代码里的下限，#9637；仓库没有声明时整份 plan 以 `r2-undeclared` 拒绝）。与普通禁区相交不再拒绝：照常派工，结果列出命中的禁区（`denyHits`），合并要 panel 加评判团（语义见下） | `deny-path` |
| `allowedPaths` 不是 `**`，并且能通过 `parseAllowedPaths` 的解析 | `bad-surface` |
| 每个**成员**的完整 follow-up 祖先链（源 work 深度 + 1）不超过 intake 的上限；祖先链缺父节点或成环也拒绝 | `depth-exceeded` / `ancestry-unknown` |
| 源 work、批次 epic 或成员处于 blocked，或带 `reviewHold` / `mergeHold` | `held` |
| 源 work 已被别的 agent 或人认领 | `owned` |
| 来自 `decide` 的 track：`decision` 存在、未被推翻、关于本 track 的根、scope 覆盖本次提交 | `decision-missing` / `decision-scope` |
| 每个成员带 `operation`（缺了是 `bad-manifest`）；按 `work decide` 的操作下限（B-31，`operationFloor`）判，R2 操作或表里没有的操作拒绝（#9589 W-02） | `r2-operation` |

4. **复查 + 封口**：写完后重读每个源 work，再过一遍 hold / owned / 深度检查；全部通过才在 epic 上写
   `planSealed`（成员内容摘要，CAS）。`approveEpic` 拒绝带 `planKey` 却没有 `planSealed` 的 epic，
   所以中途崩溃或复查失败留下的行（结果里 `wrote: true`）停在 `idea`，谁也批不了。
5. 全部通过 → `approveEpic(--actor agent)`。

预检阶段还会让每条记录先过一遍 `createWork` 自己的输入校验（`prepareWorkCreate`），并和同 key 已存的
内容摘要（含 `targetSurface`）比对；字段不合法或同 key 内容不同，都在第一次写入前拒绝。
禁区比较对大小写和 Unicode 做折叠（只会多拦），因为大小写不敏感的文件系统会把 `.CLAUDE/x` 打开成 `.claude/x`。

**禁区的语义**：与 `allowedPaths` 完全一致，直接复用 `providers/runtime/code-agents/src/factory/path-policy.ts`
的 `parseAllowedPaths` 来解析，用同样的路径段判定方式来比较：
- 每行是一个精确文件，或一个 `dir/**` 子树；不支持其他 glob，也不做字符串前缀匹配；
- surface `S` 与禁区 `D` 相交 ⇔ `S == D`，或 `S` 以 `D + "/"` 开头，或 `D` 以 `S + "/"` 开头（宽 surface 覆盖了禁区）；
- `basename:NAME` 只在 R2 里对实际 diff 判定。

清单的 fixture 测试见 `scripts/test/factory-planner-deny.test.ts`：每一行都指向仓库里真实存在的路径；
该禁的边界文件必须命中；普通文件和「名字前缀相同的兄弟目录」不能被误拦。

**验收**：
- 正臂：不相交的 manifest → 提交成功；同一份 manifest 再提交一次 → DID 不变，work 总数不变。
- 崩溃恢复：在第 1、2、3 步之后各杀一次进程，重跑后的结果和一次跑完相同，没有孪生行。
- 反臂：
  - surface 覆盖 R2 边界（如 `.claude/**` 盖住禁区清单）→ `deny-path`；只命中普通禁区 → 通过，带 `denyHits`；
  - surface 为 `**` → `bad-surface`；
  - 成员带 `mergeHold` → `held`；
  - 同一个 key 但内容不同 → `key-conflict`；
  - `decide` 类 track 缺 `decision` → `decision-missing`；
  - 深度：源 work 深度 0、1 → 通过；源 work 已在上限 → `depth-exceeded`；祖先链缺父节点、成环 → `ancestry-unknown`。
- mutation：把相交判定改成恒为 false，`deny-path` 那条测试必须变红。

## R2 — merge-check 按实际 diff 复查禁区（已实现：#9037，`work-merge-check.ts` 的 planner 禁区检查；宿主清单由 daemon 的 `FACTORY_DENY_LIST_ACTION` 提供）

**位置**：factory merge-check（`factory_merge_check_entry`，与 Gate 7 放在一起）。

**行为**：PR 的 Change Set 如果追溯到一个由 plan-submit 创建的 work，就把 diff 里的每个文件
对照禁区清单检查，路径和 `basename:` 两类都查。命中就拒绝合并，点名是哪个文件，
并在那个 work 上挂 `attention(kind=boundary)`。

**验收**：
- diff 只改普通文件 → 通过；
- diff 改了任意目录下的 `AGENTS.md` → 拒绝，点名该文件；
- 不是 planner 来源的 PR 不受影响（误拦一侧）。

## R3 — 唤醒台账（已实现：#9011 `work-wake.ts`、`arc work judge` / `wake`；new 与 `deny-changed`：#9051）

**位置**：判定写在 work 上（`judgments.<consumer>`，用 ifMatch CAS）；求值器是一个独立模块，消费 `/work` 事件流。
契约和验收见 [wake.md](wake.md)。planner 是第一个消费者，issue-sweep-batch 的 ledger（#5540）、pr-sweep、issue-sweep 随后迁入。

## R4 — 调度器：租约、记录、抽查（部分实现：#9024 记录与缺席报警；租约、抽查未做）

**位置**：跑 planner 的调度器（arc `/scheduler` 周期任务）。它不是 planner 的一部分。

**行为**：
- 每轮发放一个租约（planner 那一行上的 CAS 字段），并在 planner 写不了的地方记录启动时间、退出时间和退出码；
- 每 `audit_every` 轮选一次抽查样本，交给 `factory_planner_approver_engine` 独立重判，把结果写成事件。

**验收**：
- planner 不退出或退出码非 0 → 监视者的缺席检查报警；
- planner 传入自选样本 → 拒绝；
- 租约过期后 planner 再写 → CAS 失败，planner 停下。

**现状**：
- `scripts/factory-planner-local.sh`（launchd，每个间隔一轮）把 start / exit+rc / skip 记到 `runs.jsonl`。
  `scripts/factory-planner-runs.ts check` 只看这些记录：3 个间隔内没有成功退出，或者一条记录都没有，就在专用 work
  （`FACTORY_PLANNER_WORK`）上按 owner 条件挂 `attention(kind=stuck)`（#9054）。
- 未做：
  - 租约：暂时用本机 symlink 锁代替；
  - 抽查样本；
  - 「launchd job 本身被卸载」的独立报警（需要一个 planner 写不了的进程来跑 `check`，见 #9023）。

## R5 — `work decide`（已实现：#9030 `work-decide.ts`、`arc work decide`）

**位置**：`/work` 事件，加写入入口 `work decide`。

**行为**：
- 按提议的 `scope{operation, targets[]}` **计算级别下限**：目标命中禁区，或操作属于部署、发布、删数据、改凭据或权限、付费 → 下限 R2。声明的级别只能大于等于下限；
- 批准者的引擎和 run 由服务端从 code-agent run 绑定取得，提议者带 `proposer.runId` 时引擎由宿主从 run 记录取得，两者必须不同；
  body 里自报的引擎只做核对（不符 → `engine-mismatch`）；不带 run 的一方沿用自报引擎并记 `engineSource: "declared"`，
  R2 不认自报引擎为独立引擎：不写决定（`engine-unverified`），照样挂 `needs-decision` 交给人（#9589 W-17）；
- R2 只接受部署提供的认证人类身份；
- 决定绑定提议的 hash 和 scope，执行入口消费时校验。

**验收**：
- 正臂：codex 批准 claude 提出的 R0 决定 → 写入成功；
- 反臂：
  - 同引擎自批 → `same-engine`；
  - 声明 R0、但目标命中禁区 → `level-below-floor`；
  - agent 写入 R2 → `r2-needs-human`；
  - 批准后 scope 变了，再拿去提交 → plan-submit 返回 `decision-scope`；
- 人推翻一条决定 → 相关判定在下一轮被唤醒。

**现状**：
- 下限按 operation 闭合词表计算。目标命中禁区（含 `basename:`）→ R2。`..`、绝对路径等非法 target 和空清单直接拒绝。
- 人类分支 fail closed：可信人类凭据（#8733）落地前，`actor=human` 的记录和推翻一律拒绝（`human-unverified`），
  agent 的 R2 提议挂 `attention(needs-decision)`。
- 推翻存为 `decision-overridden` 事件（`validDecisionFor` 认它），写入口等 #8733。

## R6 — `attention` 标记（已实现：#9006 `work-attention.ts`；按 owner 条件写入与清除：#9054）

**位置**：work 上的字段，加上 `attention-set` / `attention-cleared` 事件，并能在 `/work` 上查询（按 `kind`、`since`）。
字段和挂上的条件见 [attention.md](attention.md)。

**验收**：
- 同一原因再次挂上 → `since` 不变，`evidence` 更新；
- 清除之后，查询结果里不再出现；
- 没有 `ask` → 拒绝写入；
- 不产生任何 GitHub 写入（反臂：断言同步层没有出站调用）。

## R7 — `land` 的纯 work 路由（已实现：#9020 `land/SKILL.md` Step 2 / 3 / 5；端到端验收待 planner 首次实跑）

**问题**：dispatch 按 DID 生成调用，不需要 GitHub refs（`providers/runtime/code-agents/src/factory/work-dispatch.ts`）。
但 `land` 现在默认以 GitHub issue 为执行主体：没有 issue 就先建一个，给 implementer 的也是 issue 号，
PR 正文写 `Fixes #N`。如果不改，worker 会给每个 stage task 补建一个 GitHub issue，
状态又回到了 GitHub 上。

**位置**：`.claude/plugins/agentloop/skills/land/SKILL.md`（以及它引用的 brief 和 PR 模板）。

**行为**：输入是一个没有 `refs` / `sourceUrl` 的 work DID 时：
- brief 取自 work object（`name`、`description`、`acceptance`、`allowedPaths`，以及 track 根的链接），**不建 GitHub issue**；
- PR 正文用 `Work: <did>` 关联，不写 `Fixes #N`；源 issue 只由 accept 阶段的 PR 用 `Fixes #<源>` 关闭；
- Change Set 照常回写（`change_set_record_entry`），合并事件让 stage task 进入 done。

**验收**：
- 正控：一个无 `refs`、无 `sourceUrl` 的 task 走完 dispatch → land → PR → merge，stage task 进入 done；全程 GitHub issue 数不变；
- 反臂：有 `refs` 的 task 行为不变（仍用 `Fixes #N`）；
- 是否允许把 stage task 投影成 GitHub issue，由同步层的配置决定，land 不自己决定。

## R8 — 输入：open issue 同步成源 work（已实现：#9048）

**问题**：既有的 factory intake（`ARC_FACTORY_INTAKE_REPOS`）只收带 `factory` label 的 issue，而且导入后直接 approve，
绕过了 planner。不开 intake，planner 又没有输入（首次 dry-run：283 个 open issue，账本里 0 个待规划的源 work）。

**行为**：`ARC_FACTORY_SOURCE_REPOS` 开启后，github-work-sync 每个 tick 用分窗搜索把 open issue 导入成**源 work**：
状态 `idea`（drainTick 只查 `planned`，所以 approval drain 和手动 `arc drain` 都不会派它），不 approve，不建 epic，
带 `sourcedBy: "github-source-sync"`。已有行不改。`ARC_AGENT_GITHUB_LOGINS` 为空时不运行（deny-by-default）。
agent 开的 issue 如果没有可追溯的 `followUpOf` 祖先，记为 `ancestry-unknown` 不导入，否则会被 R1 当作深度 0 放行。
进度看 `/work/github-sync.json` 的 `source` 字段。listing 不完整会被记成错误，不会当成「没有新 issue」。

