---
name: land
description: >-
  Take ONE thing from wherever it is all the way to merged. Accepts an issue
  number, a PR number/URL, several of them, or nothing at all (the thing being
  discussed right now, or stated in the invocation). Resolves the target,
  proves it is a single coherent piece of work, then routes: an epic goes to
  epic-conductor; a PR skips to review + gate + merge; a plain issue gets an
  isolated implementer, an independent clean-context reviewer, the repo's
  verification gate, and a merge. Files the issue first when none exists. This
  skill ORCHESTRATES existing skills — it never reimplements review, gating, or
  epic decomposition. Use when you want one instruction to finish something.
allowed-tools: Agent, Bash, Read, Grep, Glob, Skill, AskUserQuestion
---

# land — 把一件事从当前状态推到 merged

## Usage

```
/agentloop:land <issue#>                  # 单个 issue
/agentloop:land <PR#>                     # 已有 PR：跳过实现，直接 review + gate + merge
/agentloop:land <url>                     # issue 或 PR 的完整链接
/agentloop:land <n1> <n2> <n3>            # 多个（每件一个隔离 subagent）
/agentloop:land                           # 当下正在讨论的这件事（要过一致性闸）
/agentloop:land <一句话描述>               # 还没开 issue 的事（要过一致性闸）
```

**可选参数**

| 参数 | 默认 | 作用 |
|---|---|---|
| `--merge=auto` | 单件 | 闸绿 + review 干净就直接合 |
| `--merge=confirm` | 批量 | 跑到「已绿待合」停下来等确认 |
| `--merge=never` | — | 只跑到绿，永不合并 |

## Repo profile

先读 `.claude/repo-profile.md`。本 skill 用到的键：
`repo_slug`、`default_branch`、`plugin_root`、`verification_entry`、`pre_merge_entry`、
`merge_gate_entry`、`agent_identity_script`、`comment_language`、`gate_mode`。
**不要硬编码任何仓库字面量**——没有 profile 就先跑 `/agentloop:repo-setup`。

## 这个 skill 是什么 / 不是什么

**是**：一个**路由器 + 单件驱动器**。它认清目标是什么，然后把活派给已经存在的 skill。

**不是**：review 的实现、gate 的实现、epic 分解的实现。这三件事分别住在
`/agentloop:pr-review`、`/agentloop:verification`、`/agentloop:epic-conductor` 里。
**本 skill 里若出现「重新实现某个 sub-skill 的逻辑」，那是缺陷，不是优化。**

与邻居的边界：

| 场景 | 用谁 |
|---|---|
| 整个 epic，端到端 | `/agentloop:epic-conductor`（本 skill 遇到 epic 会转给它） |
| 无人值守地批量扫存量 | `/agentloop:issue-sweep` / `/agentloop:pr-sweep` |
| 一个 issue 的多阶段实现计划 | `/agentloop:build-phases` |
| **手上这一件，现在就要它 merged** | **本 skill** |

---

## Step 0 — 解析目标

四种入口，按显式程度排序：

| 形态 | 例 | 解析方式 |
|---|---|---|
| 显式编号 | `land 5649` | `gh issue view` 与 `gh pr view` 都试，判定是 issue 还是 PR |
| 显式 URL | `land https://github.com/<org>/<repo>/pull/5643` | 直接取 |
| 多个 | `land 5649 5651 5652` | 逐个解析，进批量模式（见下） |
| **无引用** | 裸 `land`，或 `land <一句话描述>` | **必须先过 Step 1 的一致性闸** |

一个编号同时命中 issue 和 PR 时（GitHub 编号空间共享），**报出两者让人选**，不要猜。

---

## Step 1 — 一致性闸（只在**没有**显式引用时执行）

> **这是本 skill 最重要的一步，也是唯一会让它拒绝干活的一步。**

### 为什么需要它

**同色陈述：上下文里「装着一件清楚的事」和「装着三件缠在一起的事」，
都能让你写出一个自信的计划。** 一个直接开干的 skill 分辨不了这两者——它在两种情况下
都会产出一份读起来很合理的方案，然后在第二种情况下开出一个混装 PR、或者悄悄只做了三件里的一件。

所以这道闸的机制不是「判断是否清楚」（那等于凭感觉），而是——

### 先枚举，再判定

**必须先把上下文里所有候选事项逐条列出来，然后数数。**
「只有一件」必须是**枚举的结果**，不能是**开工的前提**。

枚举范围：本次对话中出现过的、尚未落地的、可执行的事项。每条写成一行
`<可观察的现状> → <期望的变化>`。

### 四条判据，全过才算 `single`

| # | 判据 | 不过的样子 |
|---|---|---|
| **A** | 能用**一句话**说成「`<可观察的错误行为/期望改动>` 在 `<具名的文件/组件/面>`」 | 句子里需要「以及 / 还有 / 顺便」连接两个独立缺陷 |
| **B** | 这份活会落成**一个** PR | 你会自然地想开两个 PR |
| **C** | 是**用户明确指认**的事，不是你自己分析出来顺手要修的 | 你在替用户决定优先级 |
| **D** | 来自**当前**这条工作线 | 是很久以前提过的 —— 这不判 `multiple`，而是**先去仓库核对它是否还成立**，核对完再按 A–C 判 |

### 三态结论——不得把 `unclear` 塌缩进 `single`

**边界（别把三态用成两态）：**

- 枚举出 **0 条** → 不是三态里的任何一个：没有可做的事，直接说「没找到要做的事」并停。
- 枚举出 **≥2 条**且每条都能独立通过 A–C → **`multiple`**。
- 枚举出 **1 条但有判据不过**，或候选之间边界本身就说不清（分不出是一条还是两条）→ **`unclear`**。

- **`single`** → 继续 Step 2。
- **`multiple`** → **不要开工**。把枚举结果逐条列出，问用户要哪一件、或是否全部（全部则进批量模式）。
- **`unclear`** → **不要开工**。说清楚缺哪一条判据。

**无人值守时**（`AskUserQuestion` 被禁用）：`multiple` / `unclear` 一律**不派工**，
把枚举结果作为报告输出；若有对应 issue/PR 就落成 comment 并挂 `needs-human-confirm`。
**绝不因为「看起来只有一件」就代替人拍板。**

### 显式引用为什么豁免

给了 `5649` 就是用户已经指认了目标——**判据 C 由用户的输入直接满足**，无需重新枚举。
但 D 仍然要做：开工前用 `gh` 核对它当前的 state、label、是否已有 PR 在推进
（有 `agent:processing` 或已关联 PR 时，先说出来，不要撞车）。

---

## Step 2 — 分类与路由

对每个已解析的目标：

### 2a. 是 PR？

跳过实现。直接进 Step 4（review）→ Step 5（gate + merge）。

### 2b. 是 epic？

判定（任一成立即 epic，**通用检测，不依赖某仓库的具体标签名**）：

```bash
# ① 自身带 epic 标签，或带指向**自己**的 epic:<N>（N == 自己的编号）
gh issue view <N> -R <repo_slug> --json labels --jq '.labels|map(.name)|join(",")'
# ② 有成员挂在它下面
gh issue list -R <repo_slug> --label "epic:<N>" --limit 1 --json number
# ③ 正文是一张 ≥3 条 #编号 的清单
```

> ⚠️ **`epic-managed` 不是 epic 判据。** 它是 fleet 排除键，`epic-conductor` 会把它贴到
> **epic 本身、每一个 sub-issue、以及每个 PR** 上。拿它判 epic，会让 `land <某个 sub-issue>`
> 把一个叶子任务当 epic 分解——用户要的那件事反而没人做。
> 同理 `epic:<N>` 只有在 **N == 自己的编号**时才说明「我是 epic」；贴在成员上时 N 是**父**的编号。

**是 epic ⇒ 交给 `/agentloop:epic-conductor`，本 skill 就此退出。**
不要试图用单件流程驱动一个 epic——那正是 epic-conductor 存在的理由。

### 2c. 是普通 issue？

进 Step 3。可选先跑 `/agentloop:issue-review` 确认这个 issue 仍然成立、描述足够实现
（issue 陈旧或含糊时值得，刚由你自己写的则可跳过）。

### 2d. 还没有 issue？

**先开 issue**，再走 2c。理由：PR 需要一个可引用的 `Fixes #N`，而且这件事会因此有一份
durable 记录，不只活在某个 session 的上下文里。issue 正文写清楚发现（现象、根因、
证据、以及**你已知的陷阱**），语言按 `comment_language`，顶部身份行由
`agent_identity_script` 生成——**不要手拼**。
开单本身要过仓库的 **issue 成本闸**（`land` 已登记在 `ISSUE_OPENING_ROUTINES` 里，
disposition `gated`）——先回答四问模板再开，不要绕过。

```bash
bash <agent_identity_script> --header "" --skill land > /tmp/body.md   # 身份行，脚本生成
# …把发现写进 /tmp/body.md：现象 / 根因 / 证据 / 已知的错误修法…
gh issue create -R <repo_slug> --title "<Conventional Commits 风格标题>" --body-file /tmp/body.md
```

**开完必须复核正文长度非空**——`gh issue create` 在 body 为空时照样返回 URL 和 exit 0，
「开成功了」和「开出了一个空壳」在终端上同色。
**用 `--body-file`，不要用 `--body @path`**（后者会把路径本身当正文发出去，且被 hook 硬 deny）。

---

## Step 3 — 实现（隔离的 subagent）

派**一个** subagent，`isolation: "worktree"`。

**worktree 隔离不是可选项**：当前工作区可能带着与本任务无关的未提交改动，
在原地干活会把它们卷进分支。

给 subagent 的 brief 必须包含：

- issue 号 + 让它**自己去读**完整正文（不要靠你转述）
- 你已知的**陷阱**——尤其是**显而易见但错误的修法**。这是本 skill 最值钱的一段：
  你在诊断时排除掉的错误方案，如果不写进 brief，实现者会重新走一遍。
- 仓库的硬性纪律：**严格 TDD**（先写失败测试）、**accept-path 铁律**
  （只测「坏输入被拒」等于没测——一个全拒的实现满足所有 reject 断言）、
  **变异验证**（把实现改坏，确认对应测试真的变红，再恢复）
- 分支名含 `issue-<N>`（便于 PR↔issue 关联），PR 正文 `Fixes #<N>` + 身份行
- push 前跑 `verification_entry`，全绿再 push；**永远不要 `--no-verify`**
- 开 PR 后立刻 `<verification_entry> --comment <PR#>`——**「跑」和「贴」是焊在一起的**，
  不能只跑不贴，也不能用 `tsc` / 单项 build 命令代替
- 要它交回：PR 号、变异验证的**实际结果**、以及它做过的每个设计决定和理由
- **明确允许它反驳你的诊断**：「如果发现我的分析有错，直接说，不要将就着实现」

---

## Step 4 — Review（**另一个** clean-context subagent）

调 `/agentloop:pr-review`，在**独立的 subagent** 里跑。

**reviewer 必须与 implementer 是不同的 subagent。** 同一个上下文既实现又评审，
等于自己审自己——它会把实现时的假设当成已验证的事实带进评审。

评审结果的处理：

- **P1 / High** → 必须**修掉**，或在 PR 上**回复 REJECT 并说明理由**，才能进 Step 5。
- **P2 / P3** → 修，或记成后续 issue，二选一，**不要静默略过**。
- **inline review 线程的回执协议（含 bot findings、defer 的 owner 与再处理条件、缺回执
  是否挡合并）只有一处真相：`epic-conductor` §6。照它执行，不要在这里另立一份**——
  两份一定会漂。
- 修完之后 gate **必须重跑**（SHA 变了，旧的绿不作数）。

---

## Step 5 — Gate 与 merge（按仓库规矩）

1. `<pre_merge_entry> --comment <PR#>`，然后 `<merge_gate_entry> <PR#>`。

   > ⚠️ **PR 号必须写成 `--comment <PR#>`。** 裸位置参数（`<pre_merge_entry> <PR#>`）会被
   > **静默忽略**——`lib/comment.ts` 的 `parseCommentArgs` 只认 `--comment` / `--dry-run` 系列，
   > 不报错也不投递。闸照样跑、照样给判决，所以「跑了」和「这一轮结果贴到了这个 PR 上」
   > 在终端上完全同色。写错的后果是：fixer 推了新 commit、SHA 变了，你按字面重跑，
   > PR 上却一个字都没多，于是**带着过期证据合并**。
   >
   > `merge_gate_entry` 是**硬闸**（exit 0 才代表可以合），不是「若 profile 声明了」的可选项。

2. **红了不要自己判定是不是 flake，也不要盲目重跑。** 判据住在闸里，不在这里——
   本 skill 复述一份只会漂移（这正是第 31 行禁止的事）。
3. 外来红（不是本 PR 造成的）走带 witness issue 的归因重跑：
   `<pre_merge_entry> --comment <PR#> --blocked-by <open issue#>`。
   **这不是豁免**——闸**自己**跑证据、自己判定，你只负责提供 witness issue。
   `--no-verify` 和 `force` 在任何情况下都不是答案。
4. 绿了之后按合并权限（见下）执行 `<plugin_root>/scripts/merge-verified-pr.sh <PR#>`。
   **不要用裸 `gh pr merge`**：该脚本在**链接 worktree 里是安全的**（不会让 gh 去 checkout
   默认分支），而 Step 3 强制 worktree 隔离；它还带 `state=OPEN` / `mergeable` 前置
   和 head-SHA 原子提交。
5. 复核 `merged: true`，并确认关联 issue 被关闭。

### 合并权限

| 模式 | 行为 |
|---|---|
| **单件（默认 auto）** | 闸绿 + review 干净 ⇒ 直接合，合完报告 |
| **批量（默认 confirm）** | 每件各自跑到「已绿待合」，**一次性列给用户确认后再合** |
| `--merge=auto` | 批量也自动合 |
| `--merge=confirm` | 单件也停下来问 |
| `--merge=never` | 只跑到绿，永不合并 |

**批量默认要确认的理由**：一条指令产生 N 个不可逆的对外动作，这个决定属于用户，不属于 skill。

**无人值守下的批量**（`AskUserQuestion` 被 hook 硬 deny，而显式多引用跳过了 Step 1，
所以「不派工」那条不适用）：**跑到「已绿待合」为止就停**，把清单落成 comment 并挂
`needs-human-confirm`，**不要自己合**。要无人值守直合，必须由用户显式给 `--merge=auto`。

---

## 批量模式

`land 5649 5651 5652`：

- **每件一个 subagent，各自 `isolation: "worktree"`**，互不共享上下文。
- 编排**串行 inline**——不要用 Workflow。
- 逐件独立汇报，一件失败不影响其余；**最后统一报一次**：哪些合了、哪些绿着待合、
  哪些卡住了、卡在哪。
- 开工前检查各 PR 之间的**文件重叠**（`<plugin_root>/scripts/check-pr-path-overlap.ts`）。
  有重叠时必须在 PR 正文里互相引用、写明合并序，**未声明的重叠 PR 不得合并**。

---

## 卡住时怎么办

**不要静默降级，也不要反复重试同一个失败动作。**

| 情况 | 动作 |
|---|---|
| 实现 agent 反驳了诊断且理由成立 | 采纳，更新 issue，不要将就着实现 |
| review 出了 P1 而 fixer 修不动 | 停在「已开 PR、未合」，报告清楚 |
| 闸持续红且不是负载型 | 停，报告失败的具体检查和 rawTail |
| 一致性闸判 `multiple` / `unclear` | 报枚举结果，不派工 |
| 目标其实是 epic | 转 `/agentloop:epic-conductor` |

**报告要说实话**：测试红了就贴输出，跳过了哪步就说跳过了，只有真的做完并验证过才说完成。

---

## 输出

结束时给出：每个目标的**终态**（merged / 待合 / 卡住）、PR 号与链接、
gate 的实际结论、review findings 的处置、以及下一条命令（如果还需要人做什么）。
