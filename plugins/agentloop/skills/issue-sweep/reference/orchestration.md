# issue-sweep — per-issue orchestration detail and the action table

> On-demand reference for [`issue-sweep`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Bounded per-issue orchestration（无人值守默认并行）

候选集确定后,主控按以下契约运行 `issue-review`:

**并发配置（repo × skill）:**按优先级取值:显式 `--concurrency <N>` →
环境变量 `AGENTLOOP_SKILL_CONCURRENCY`（fleet driver 从 `repos.json` 当前 repo 的
`skillConcurrency["issue-sweep"]` 注入）→ 默认 `3`。值必须是 `1..16` 的整数,非法值
直接报配置错误;当前 runtime 可用 agent slot 更少时向下收敛,没有非交互 agent 能力时
降到 `1`。这个值限制 **active issue workers**,不是本轮最多处理多少 issue。

**重闸另算,同一台机器最多 2 个。** worker 可以有 3 个,但同时在跑的重闸(`<verification_entry>` /
e2e-gate / ui-verify / 全量 build/test)最多 2 个:worker 准备跑闸时向主控要闸位,主控放行前看一眼机器
负载(`load1` ≥ 核数就先不放)。这是调度,不是锁——仓库的机器级闸锁保持关闭。worker 里若有独立
reviewer,**review 在跑闸之前**,意见一次修完再跑一次闸;feature 管道里的 `design-review` 在人已记录设计
决定时跳过,否则 `--max-rounds 2`。

1. **主控分配,worker 即时 claim。** 主控只维护去重后的候选 queue 和空闲 slot,
   **不预加** `agent:processing`。某个 slot 准备立即开工时才把一条 issue 交给 worker;
   worker 的第一个动作是运行 `issue-review` Step 0,自行重验
   open/hold/blocked/`agent:processing` 并 acquire。抢锁失败就返回 `SKIP_LOCKED`,
   主控继续投递下一条。未进入 active slot 的候选保持未锁,避免排队超过 TTL。
2. **一个 worker 只拥有一个 issue。** worker 运行完整 `issue-review` engine,只写该
   issue 的 comment/label/PR/branch;不同 issue 之间不得共享可变任务状态。
3. **会改 repo 的 worker 必须使用独立 worktree。** comment-only / research / idea /
   triage 等只读代码的 worker 可共用主 checkout;任何会 edit/format/test/commit/push/
   open PR 的 worker,开工前从最新 `origin/<default_branch>` 建独立临时 worktree。
   主控把由已核验执行计划得到的结构化 `allowedPaths` 一并交给 `issue-review` worker；worker
   在 claim 成功后、创建/写入 worktree 前运行
   `bun <plugin_root>/scripts/check-pr-path-overlap.ts --run-args '{"allowedPaths":[...]}'`。
   不得从标题猜路径。checker 的 `overlap` 要报告 PR/文件，`clean` 才能继续；`unavailable`
   必须停止实现并显式回报，不能塌陷为“无重叠”。
   **worktree 必须建在 `$AGENTLOOP_WORKTREE_BASE` 下,禁止硬编码 `/tmp/...`**——fleet
   driver 已把这个变量注入 worker 环境(专属 agentloop 的固定目录,不是系统 `/tmp`、
   也不是部署方的 `TMPDIR`),字面照抄即可:
   ```bash
   git -C "$(pwd)" worktree add --detach \
     "$AGENTLOOP_WORKTREE_BASE/$(basename "$(pwd)")-issue-<N>.$$" \
     origin/<default_branch>
   # 本 issue 处理完(无论成功/失败/跳过)务必清理,别只指望 driver 下一轮的兜底清扫:
   git worktree remove --force "$AGENTLOOP_WORKTREE_BASE/$(basename "$(pwd)")-issue-<N>.$$" 2>/dev/null || true
   ```
   硬编码 `/tmp/...` 会绕开部署方的 `checkoutBase` 配置,在系统盘上越攒越多——实测:
   未做限制时一天在 `/private/tmp` 下堆了约 36G 孤儿 worktree,而配置的外置盘却几乎
   是空的。**driver 每轮都会兜底清扫一次 `$AGENTLOOP_WORKTREE_BASE` 下超过 15 分钟、
   且没有活跃进程的残留**,但那是安全网,不是借口——worker 自己清理不了的话,残留
   至少要撑到下一轮才会被回收,别指望它替代及时清理。

   > **★ 同理:不要用会在 `<repo>/.claude/worktrees/` 下建树的 harness 工具**(编码 harness
   > 自带的 worktree/隔离开关)。那个位置**不由 `$AGENTLOOP_WORKTREE_BASE` 管**,而且它建的树会
   > **一直 check out 着 `claude/issue-<N>` 分支**——于是下一次(任何机器、任何轮次)对同一个
   > issue 跑 Step 4 的确定性认领 `git checkout -B claude/issue-<N>` 会 **fatal: already used by
   > worktree at …,exit 128**,这个 issue 号就此永久锁死。实测(arc,2026-08-20):一个 base clone
   > 里攒了 16 棵,占 60G,横跨 15 天;已在隔离环境复现过 exit 128。driver 从 0.29.4 起也会兜底
   > 清扫这些位置(clean 的才删,脏的留下并报告),同样是安全网不是借口——**照上面的
   > `$AGENTLOOP_WORKTREE_BASE` 显式建、显式删**。

   分支仍严格使用 Step 4 的
   `claude/issue-<N>`（或 phase 变体）。禁止
   多个写 worker 在 sweep 主 checkout 中切分支或改文件。进入 worktree 后读取
   `AGENTLOOP_SETUP_COMMAND`（fleet driver 从当前 repo 的 `setupCommand` 注入）并在
   该 worktree 执行;未配置时按 repo profile/toolchain 完成等价 bootstrap。setup
   未成功不得编辑、测试或声称可验证。
4. **共享 KB 由主控单写,worker 仍贡献 KB。** 并行 sweep 调用 `issue-review` 时,
   本条显式覆盖其“收尾直接编辑 KB body”:worker 只返回结构化结果（issue、disposition、证据、
   PR/claim、KB 增量、错误）;共享 KB body、整轮汇总、presence heartbeat 由主控在
   barrier 后统一写,避免 read-modify-write 覆盖。worker 不直接编辑共享 KB body。
5. **失败隔离 + ownership-safe 清理。** 一个 worker 失败不取消其他 worker。正常
   收尾由 worker 按 `issue-review` Step 7 release 自己的 `agent:processing`;主控
   **绝不代删**无 owner token 的 label 锁,worker 崩溃留给 TTL 恢复。写 worker 成功且
   worktree clean 后移除临时 worktree;失败且有未提交内容时不 force-delete,返回路径、
   branch、status 和 blocker 供恢复。不得把半成品汇报为完成。
6. **嵌套 fan-out 也受 runtime 总 slot 限制。** `--concurrency` 只限制 active
   issues;Research 等 issue 内部要再开 subagent 时先看 runtime 剩余 slot,不足就
   在该 worker 内 inline/串行,不得因 3 个 issue 各自再扇出而突破 runtime 上限。

主控只在候选分配与最终共享写入处串行;issue 的取证、实现、验证和 per-issue GitHub
写入在上述边界内并行。并发上限是安全阀,不是本轮处理上限:worker 完成后继续从
unclaimed queue 取下一条,直到候选耗尽或触及真实的运行预算/外部限流。

| Human's latest reply | Action |
|---|---|
| Agrees to **delete** a `deprecated` doc-audit ("可以删除"/"同意删除") | **Delete PR**, but **safe-delete only** — `git grep` for live refs first. Live code/test/doc dependency, a still-needed sub-package, a pending third-party confirm, or a blocking precondition → **do NOT delete; leave a comment** explaining the blocker. Relabel `status:*`→`status:deprecated` if needed. |
| Asks to **update** a `drifted` doc ("update 文档"/"补齐发 pr") | First check doc kind: **`planning/`/`intent/` docs default to historical-archive, NOT doc-update** (2026-07-17 policy, see issue-review「historical 归档」— shipped planning docs are historical artifacts; syncing them to code is negative-ROI, they re-drift immediately). Tombstone banner PR, no content rewrite; extract still-valuable rationale into `docs/guides/` first if any. Only `docs/` living guides get doc-update: decide **doc-drift vs code-drift** (verify the shipped surface); if doc-drift, edit the doc to match shipped reality, each addition checked against `path:line`. **Doc-update PR**, no code change. If another human is already drafting a PR for the same cluster, **skip to avoid collision**. |
| Approves a **bug fix** ("同意"/"easy fix") | Implement the fix; verify locally where possible (typecheck / targeted test). **One PR per bug.** |
| **Feature / design request**(multi-phase / 架构 / feature) | **先判大小(match vehicle to size):小而明确的 feature(单点、验收清晰、代码可触达)= 直接 reproduce→fix→test→PR,不启动 design-review/build-phases(那套对 leaf 是杀鸡用牛刀);只有真正多阶段/架构级才走下面的 pipeline。** **评估 → 能做就做,绝不冻结。** 旧的「(1) 只发计划、不写码 →(2) 等 human 确认才执行」是 bug:卡在等确认,而那个确认基本会变成「你先评估试试」,于是永远不动。改为:**(a) 评估(必做)** —— 读 issue + 引用代码,判「本环境能否自主起步」:issue 自带 spec/验收标准 + 代码可触达 = 能起步(绝大多数 feature 属此)。**(b) 能起步就直接跑 pipeline,不等确认**:`/agentloop:design-review` 定/优化方案(精炼计划 post 回 issue;**post 的设计必须 grounded:现状断言 `path:line` 坐实、代码权威优先于文档并指出文档过时、数字实测或显式标注估计——design-review 的事实+数字 grounding 是 HARD GATE,别手 post 未审的设计**)→ `/agentloop:build-phases` 分阶段实现(phase = issue checkbox;每 phase 一 commit + 进度评论;PR 按耦合切——见 design-review/build-phases「Issue-driven plans」)。issue 即 source of truth;**drive 能做的 phase 到完成**;跨 hourly run 的用 **in-progress** 续做(round-aware 接力 phase N→N+1,不重做、不冻结)。**(c) 只有真正 human-only fork 才停**(无法判定的架构 A-vs-B、安全、不可逆),且停时给**评估结论 + 具体待决项 + 你的推荐 + 已完成的 phase**,**绝不写「不在本轮范围 / 留开放」**那种冻结性 disposition。**(d) 撞墙 → 给详细问题**:实现中卡住,贴**具体 blocker(试了什么、什么失败、确切缺哪个决定/信息)**作为 in-progress 续做点,不是含糊的「需人定方向」。Never skip 评估;never freeze。 |
| **Research 请求**(`research` label / `[research]` 标题,如「研究 perkeep 和 did space 的结合点」;actionable 信号常是 **body 本身、0 comment**) | 走 [`issue-review` ★ Research](../../issue-review/SKILL.md):**调研这一轮不改 repo 代码、不开 PR**(转进 feature 管道后不受此限)。并行 fan-out 两个 subagent 双侧代码级调研(外部 repo shallow clone 到 scratchpad + 本 repo `path:line`)→ 综合成一条证据化 comment(TL;DR 逐条答 issue 问题 + 对照表 + 冲突面 + 结合点分档 ⭐/◐/✗ + **行动声明收尾** + 外部链接)→ 挂 `research`(`needs-human-confirm` 只在真分叉时加)。**默认只留 comment + 链接,不下载保存数据**;仅当 issue 明确要求收集数据入库时才在 `research/<task-slug>/` 开目录(走人签名 PR)。**首轮不自动开 spin-off**;人选定方向后下一轮按选项拆自足 feature issue 或转 `/agentloop:design-review`→`/agentloop:build-phases`。**例外(#1947 反馈):issue 同时含明确终局目标(「不可动摇的目标」式表述)→ research 只是 phase 0,调研 comment 后立即按上面 feature 行转执行管道(sub-issue 图 + 能做即做),绝不以「待拍板」收尾;拍板项必须互斥,非互斥的是依赖序直接做,真分叉用「推荐 + 默认执行的异议窗口」。** **★ ratchet 收尾(铁律 10,2026-08-20):纯调研也不许挂在「待人选方向」——comment 末尾必须是「下一轮我会做 X,除非你说不」,下一轮人没否决就直接执行 ⭐ 档,禁止再调研一遍。`needs-human-confirm` 只贴真分叉(互斥且不可逆)。** |
| **Idea 提案**(`idea` label / `idea:` 标题;actionable 信号常是 **body 本身、0 comment**) | 走 [`issue-review` ★ Idea](../../issue-review/SKILL.md):**首轮不当指令,当提案——不改 repo 代码、不开 PR、不开 spin-off**。理解复述(价值主张分解)→ 对照代码找「地基已有/真实缺口/与现有矛盾」(每条 `path:line`)→ 价值分档 ⭐/◐/✗ → 澄清问题(**每条附「没人答时按哪个默认走」**)→ **以行动声明收尾**(「下一轮我会做 X,除非你说不」)→ 挂 `idea`。**★ ratchet(铁律 10,2026-08-20 老冒反馈):首轮只有一次——第二轮起人没否决也没改方向,就直接执行上一轮声明的 X(拆 spin-off + 写边 + 开工),禁止再写一篇「更完整的评估」;「仍需拍板」不是合法收尾。`needs-human-confirm` 只贴真分叉(互斥且不可逆),能给安全默认的一律不贴。****拿不准「指令还是想法」就按 idea 处理**(clarify 的代价远低于执行错方向)。**例外(#1949 反馈,镜像 Research 行):idea 作者已把需求/目标说清(只是路径/细节未定)→ 评估 comment 后立即按 feature 行转执行管道——可默认的决策直接选定(ratchet + 异议窗口)、终局验收清单写进父 issue(close 唯一条件,子 issue 全关 ≠ 完成)、全量拆自足 spin-off + 写边,能做即做;不出拍板菜单,拍板项必须互斥,详见 issue-review ★Idea 铁律 9。** |
| PR already **merged** but issue still open | **Close** it (`completed`). `Fixes #N` usually auto-closes; close manually if it didn't. **★ 例外(完整测试闸,Robert 拍板 2026-07-20)**:多 phase / 带 sub-issue 图 / 带终局验收的大块 issue,merge 齐 ≠ 可 close——close 前必须有真实 surface 的完整端到端场景测试报告(见 [`issue-review` ★父级 rollup](../../issue-review/SKILL.md) 第 3 步测试闸);缺则先补测试再 close。 |
| **父级 rollup**（Step 0.5 `rollupCandidates`：open 父 issue 的孩子已全部关闭） | 走 [`issue-review` ★父级 rollup](../../issue-review/SKILL.md)：`claim.ts` fencing 抢到才做 → 核对父 issue 验收标准/问题清单（逐条对应到子 issue/PR 证据）→ 综合 comment（带 rollup marker）→ **全覆盖则 close**（这是「自动 close」的显式例外，但 **`agent:hold` 一票否决 close**：hold 禁止一切终态动作，优先级高于本例外——照常综合 comment，但留开等人摘 label），有残留 gap 列出并留开。research/idea 类父 issue 同样综合后 close——结论已在子 issue 落地，父级只是收口。 |
| Conditional / asks a third party to confirm / **security-sensitive** (e.g. P0 security) / needs a **genuine** A-vs-B decision / "要人类 review 不要完全用 ai" | **Comment only** — surface the finding + the decision needed; do not act. **「A-vs-B」指真互斥且不可逆的分叉**——能给安全默认的不算(Step 5.5 硬前置 + ★Idea/★Research 铁律 10:给推荐 + 异议窗口,照做);**把依赖序包装成拍板项交给人是禁止的**。这一行的 comment-only 不覆盖那种情形。 |

Every finding/action carries reproducible evidence (`path:line`, grep hit, real
test output). One verdict/PR-link comment per issue — don't stack duplicates.
