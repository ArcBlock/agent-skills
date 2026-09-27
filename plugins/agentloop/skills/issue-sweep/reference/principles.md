# issue-sweep — key principles and memory MCP

> On-demand reference for [`issue-sweep`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## Memory MCP（可选，当已配置时）

如果运行环境的 MCP 工具列表包含 AFS 命名空间（`afs_read` / `afs_write` / `afs_search`，来自已连接的 ARC instance MCP 端点），在每轮 sweep 的 Step 0（sync `<default_branch>` 之后）增加两步：

**Scan 前 recall（与读取 issue 列表并行）：**
```
afs_search /user/memory 关键词:<本轮重点 label / 子系统 / 常见问题域>
```
返回的 observations / patterns / principles 补充进 sweep 的初始上下文（「已知约束/规律快速热启」）。

**每条 issue 处理完毕后 store（追加）：** 跨 issue 有价值的发现（同类 bug 根因、代码隐藏约束、团队决策）写入 memory。粒度三层：
- `observation`：具体事实 + `path:line`
- `pattern`：跨 issue 归纳出的规律
- `principle`：推断出的工作原则

路径：`afs_write /user/memory/<memory_namespace>/<namespace>/<id>`;caller 身份隔离，loop agent 间互不干扰。

**未配置 MCP = 本节跳过**，sweep 其余行为完全不变。

## Key principles

0. **Sync `<default_branch>` before anything** (Step 0). Safety greps, type checks, and
   branch-offs are only trustworthy against the latest tree; a stale clone
   silently invalidates them.
1. **Scan by label + last-comment, never by an updated-at window** — that window
   is exactly what dropped issues with early, never-re-bumped human replies or
   priority-only labels before.
2. **Human vs AI is by content (`🤖 AI Agent` marker present near the top, not
   necessarily the literal first line — see Step 2), not author** — both post
   under the same account here.
3. **`issue-review` does the per-issue work; this skill only decides what to feed
   it and enforces the resolve-action + discipline rules.**
4. **Safe-delete only; comment on what can't be cleanly/safely done** — live deps,
   pending third-party confirm, security, A/B decisions stay human.
5. **两层并发协调:advisory 锁(早)+ 确定性分支(硬,兜底)。** (a) `agent:hold` = 人类保留 =
   **终态冻结**(绝不 close/终态处置,只人摘;但人类新评论仍要响应);`agent:processing` = 处理中互斥锁(TTL 30min),
   Step 1 跳过新鲜锁的候选,`issue-review` 开工 acquire、收尾 release——把撞车提前到读/核验/测试之前。
   (b) **确定性分支 `claude/issue-<N>` + 开 PR 前认领检查 + 一 issue 一 PR + `Fixes #N` + never
   auto-merge** 是收尾硬去重:描述性 slug 分支名是多机重复 PR 的根因,必须只由 issue 号派生、创建前
   查重 SKIP。锁是 advisory(有残留竞态),分支claim 顶上;残留重复由 `pr-sweep` 去重关闭兜底。
6. **Silent no-op when nothing is pending — 而且沉默是 per-issue 的,不只是 per-round。** agent
   **自发**处理完一条 issue 却既无动作也无新信息 → 不发 comment,结果只进 run report(Step 5 +
   [`issue-review` Step 5.7](../../issue-review/SKILL.md));同一条终态 disposition 也只发一次,要更新就
   `--edit-last` 原地改。**但人类输入触发的必须回应**——否则 Step 2 谓词永远判它「未回应」,每轮
   全额重跑。回应的收尾走 ratchet(「下一轮我会做 X,除非你说不」),不是「复核确认,现状不变」。
6b. **图计算决定候选与传播,LLM 只负责做。** 每轮 Step 0.5 跑
   `graph-scan`:kicks/rollupCandidates 注入候选(无需人类 comment),blocked 确定性
   SKIP;开 spin-off 必写原生边(`link.ts`);无分支兜底的终态动作(rollup)用
   `claim.ts` fencing 互斥。图只增强、不替代 label 扫描。
7. **`--autofix-green`: verifiability is the gate, never auto-merge.** Auto-fix
   only issues that pass all four gates (unambiguous + verifiable-in-this-env +
   low-blast-radius + non-security); reproduce-first, one PR per issue, white-list
   categories only. Can't run a test that proves it here → 🟡 draft PR + human, not
   green. The set of 🟢 issues grows with the environment (TS-only vs full-platform
   build). 🟢 = auto-PR, **not** auto-merge — the merge gate (a same-SHA `<verification_entry>` PASS + merge-load) + a human still gate the merge (no CI on the PR path).
8. **Autonomous = ask on the issue, never block in-session.** This sweep runs
   unattended — no human is babysitting. Any time the per-issue work (including
   `design-review` / `build-phases` escalations) would normally stop and wait for
   a human answer, **post the question as a comment on that issue** (options +
   recommendation + what's blocked) and move on; don't sit on a blocking inline
   prompt. The human answers async on the issue and the next sweep resumes it.
