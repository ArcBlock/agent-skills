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

**开单前先过 Step 6 的开单预算与同类塌缩**——成本闸是**逐条**的，它看不见「你这一轮已经开了五条、
其中四条是同一个形状」。那是组合层，只有 Step 6 管。

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
  ⚠️ **「记成后续 issue」是螺旋的主入口。** 选它之前先过 Step 6 的**同类塌缩**：
  如果这条 finding 与**本轮已修的那条**是同一个缺陷类的另一个实例，正确动作是
  **把当前修复扩大到覆盖整类**，不是开一条新单。
- **inline review 线程的回执协议（含 bot findings、defer 的 owner 与再处理条件、缺回执
  是否挡合并）只有一处真相：`epic-conductor` §6。照它执行，不要在这里另立一份**——
  两份一定会漂。
- 修完之后 gate **必须重跑**（SHA 变了，旧的绿不作数）。

#### review 轮次上限：**3 轮**（硬规矩，不是建议）

**一个 PR 最多跑 3 轮 review。第 3 轮之后只有两个出口：merge，或者 fail。没有第 4 轮。**

一轮 = 「派 reviewer → 收 findings → 修 → 重新盖章」的一整圈。

第 3 轮（及之后的修复）里冒出来的**新**问题，按下面处理，**不得因此再开一轮**：

| 新 finding | 动作 |
|---|---|
| 是真问题，且**与本 PR 的改动同类** | 先过**同类塌缩**：能扩大当前修复覆盖就修在这里 |
| 是真问题，但**另属一个改动面** | **开一条新 issue**（进 Step 6 账本），本 PR 照常 merge |
| 不是真问题 / 判断分歧 | 在 PR 上回复 REJECT 并说明理由，merge |
| 是真问题，且**让这个 PR 不能合**（P1 且修不动） | **fail**——停在「已开 PR、未合」，按停止协议交回 |

**为什么是硬上限：** 一个足够复杂的改动**永远**能再找出一条 finding——第 4 轮、第 5 轮同样成立。
「再审一轮就干净了」在任何一轮上都读起来合理，所以它不能由判断来终止，只能由**计数**终止。
**「这个 PR 还不够好」与「我们在无限精修」在每一轮的报告上完全同色**；3 轮是把这两者分开的那条线。

**第 3 轮的 spin-off 仍然受 Step 6 约束**——同类必须塌缩，理由必须取自闭集，条目必须进账本。
「拿开新单当第 4 轮的替代品」正是螺旋的另一种形态。

#### 一个上限自带的洞：**第 3 轮的修复没有人审**

一轮的定义是「派 reviewer → 收 findings → 修 → 重新盖章」，所以第 N 轮的**修复**只会在
第 N+1 轮被看到。硬顶在 3 ⇒ **第 3 轮那次修改在一个「闸绿即合」的仓库里由谁都没审过就合了**，
而这个仓库的立身教训恰恰是**闸绿与改对是两件事**。

两个出口，选一个，并在 PR 上说明选了哪个：

- 第 3 轮的修复必须是**单点/机械**的（一行 guard、一处改名、一句文档）——否则判 **fail**；
- 或者跑一次**确认轮**：它**只允许确认前一轮的 findings 是否闭合，不得提出新 findings**
  （新东西一律按上表开新单）。这样的确认轮**不计入 3 轮**，因为它不能产生新的修复。

不许两个都不选就合——那正好是「闸绿即合」。

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

## Step 6 — 收敛闸（开单预算 · 同类塌缩 · 三轮停止）

> **land 的目的是把问题修掉，不是修一个再开一堆。** 一轮 land 结束时仓库的**未决问题应该更少**。
> 如果更多了，这一轮就没有完成它的工作——哪怕每一条新单单看都是对的。

### 为什么成本闸挡不住这件事

仓库的 issue 成本闸（`ISSUE_OPENING_ROUTINES`）是**逐条**的：它问「这一条值不值得开」。
六条各自都值得开的单，能全部通过它，同时构成一次失控。**「这一条合理」与「这一轮在发散」
在成本闸上完全同色**——它没有跨条目的视野。这是 accept-path 铁律在**组合层**的又一个同构体，
和 host-gate / oversight / interop 那几条同源：单点判据全绿，组合仍然坏掉。

所以收敛只能在这里管。

### 开单账本（必须维护，必须出现在输出里）

本轮**每开一条「不在这里修」的决定**就记一行——编号、`kind`、为什么不是现在修。

**「决定」不等于「issue」。** TODO 注释、`KNOWN MISS`、PR 正文里的「已知同源缺陷」段落、
写到别人 issue 下的 comment——**一样计数，一样占预算**。只数 `gh issue create` 会让预算
把 agent 推向「不开单的延期」，那是同一件事换个载体。

`kind` **不是随手起的短语**，它必须由两件可核对的东西拼成：

```
kind = <缺陷位点> + <症状动词>
       ↑ 修复要碰的**文件路径**，能对着 diff 验      ↑ 从固定表里选
```

**位点取文件路径，不取符号——同一个文件即同一个位点。** 这一条不是风格偏好：
「文件/符号」留两个抽象层就等于把选择权交还给想开单的 agent，而这在本节的**原始案例**上
就会翻车——#5682 的修复落在 `runtimes/node/src/core/commands/worker.ts`，#5693 也落在同一个文件：
按文件 ⇒ 同类 ⇒ 塌缩（正确）；按符号（`workerDev` vs `workerHealth`）⇒ 不同类 ⇒ 照开（螺旋）。

症状动词取自闭集：`not-propagated` / `not-verified` / `misclassified` / `collapsed-states` /
`stale-source` / `unguarded`。位点必须是**这条 issue 的修复会碰到的地方**，不是它的后果。

理由：把 `kind` 定义成「一个短的缺陷类键」，等于让**想开单的那个 agent** 自己选抽象层级——
选细一点就不同类（照开），选粗一点就万物同类（不可执行）。仓库的 oversight 纪律早写过这条：
**分类取自不可伪造的事实（改动路径，不是 issue 标题）**。位点能对着 diff 验，短语不能。

| # | kind | 不现在修的理由（闭集） |
|---|---|---|
| 5693 | `runtimes/node/src/core/commands/worker.ts:not-propagated` | `human-decision-required` |

（注意这一行**本身就是格式示范**：`kind` 左半是**文件路径**不是名词短语，右半取自下面那张闭集表。
一份规范里，agent 抄示例比读语法更可靠——所以示例不许违反它要示范的规则。）

`不现在修的理由`只能取这几个值，**没有「以后再说」**：

| 值 | 什么时候成立 |
|---|---|
| `out-of-scope-destructive` | 修它要动一个**不可逆动作**（删除 / kill / 发布），需要自己的 accept-path |
| `different-subsystem` | **修它要碰的位点**与本 PR 的改动位点**零文件交集**——注意判据是*修复落点*，不是*发现场合*：一条 review finding 当然是在本 PR 的 diff 上发现的，但它的修复可能落在别处，那仍然算 |
| `human-decision-required` | 有一个**人才能拍板**的分叉（优先级 / 产品语义 / 破坏性变更） |

取不到值 ⇒ **就是现在修**。

> **刻意删掉了 `needs-own-tests`。** 在一个严格 TDD 的仓库里，它对**每一条**延期都成立——
> 一个恒真的成员会让「取不到值 ⇒ 现在修」这条永远不触发，闭集也就不是闭集了。
> 需要新测试是**修复的成本**，不是**不修的理由**。

**账本必须进最终输出。** 不然「这轮没开单」与「开了六条没数」在报告上同色——
就是仓库度量纪律那条（`countExecutedTests` / #5638）在 land 自己身上的形态。

**但「要求写一个数」不等于「量了一个数」。** 一个开了 3 条却打印 `opened=0` 的 run，
与真的没开单的 run 在报告上仍然同色。所以账本**不许凭记忆写**——run 开始时记下 ISO 时间戳，
结束时让它自己数出来：

```bash
RUN_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)      # run 开始时记下，写进输出
gh issue list -R <repo_slug> --state all --limit 100 \
  --search "created:>=$RUN_START author:@me" --json number,state,title
```

这条命令**今天就能跑**，不需要任何新状态。凭记忆写的账本是断言，`gh` 数出来的是证据。

**但它只看得见四种载体里的一种。** TODO / `KNOWN MISS` / PR 正文段落 / 别人 issue 下的 comment
都不在 `gh issue list` 的射程里，所以那三种**今天仍然是自报**。说清楚而不是含糊过去：
账本的 issue 那一半是证据，另一半是断言——**这正是把它接成机器闸时第一个要补的洞**。

### 同类塌缩（最重要的一条）

开第 N+1 条之前，把它的 `kind` 与两处比对：

1. 本轮**已经开出**的每一条；
2. **本轮刚刚修掉**的那一条。

命中任一 ⇒ **它不是一条新 issue，它是同一个缺陷类的另一个未覆盖实例。** 二选一：

- **扩大当前修复**去覆盖整类——**首选，但只在 Step 1 判据 B（这份活仍然落成一个 PR）
  还成立的时候**。跨兄弟动词展开一个原本 scoped 的修复，正是 `single` 变成 `multiple` 的路径；
  一旦 B 不再成立，答案就是下面那条**一条** class issue；
- 开**一条** class issue，正文列出全部实例，而不是每个实例一条。

> **反面教材（真实，本 skill 因此扩写）**：一轮 land 修好了「`--port` 没传到兄弟解析路径」，
> 然后**开了一条**「`--port` 没传到另一个命令的兄弟解析路径」；同一轮修好了「`--home` 在客户端
> 寻址被忽略」，然后**开了一条**「`--home` 在 service 动词被忽略」。两次都是**修掉实例 1、
> 把实例 2 立成新单**。这正是螺旋的引擎：修复越精确，剩下的同类实例越显眼，开单越快。

### 这套规则的实际强度——不夸大

引发本节的那次实测（6 开 3 关）被独立复核走过一遍，结论是：**现实产出是 6 → 4，不是 6 → 1。**

- **能塌缩的那一半**（`--port` / `--home` 两组）之所以能，是因为**开单的 agent 自己已经把亲缘
  写进了标题**（「(#5682 同源)」「(#5659 同族)」）——塌缩规则不需要推断，只需要读它已经知道的。
- **不能塌缩的那一半**是三个子系统里的三种机制，只共享**后果**形状。细粒度上不撞；
  粗到「闸报了令人安心的颜色」这个层级则万物同类，不可执行。

并且在第 3、4、5、6 条上真正把手拦住的是**纯计数**（`累计开单 > 2`、`opened > closed`），
不是 kind-collapse。**kind-collapse 仍然列首**，因为它是唯一能**改变数目**的机制（预算只能让你
停下来看）——但别指望它做计数的活。

### 螺旋判据（机械的，不靠感觉）

一轮结束就算一次。满足**任一**条即进入**开单复盘**：

- 本轮 `opened > closed`——**`closed` 只算「因为被修好而关掉的」**，
  顺手关掉三条陈旧单不能买来三条新单；
- 任一 `kind` 家族累计 ≥ 3 条；
- 开出的某条 `kind` **等于本轮已关闭的某条**的 `kind`（修一个开一个）；
- 累计开单数 > **2**（默认预算，target 本身不算）。**按目标计，不按 run 计**——
  `land 5649 5651 5652` 是三个目标各 2 条，不是整轮 2 条，否则三件互不相干的事会互相挤占。
  **2 这个数是起点不是实测标定**（引发本节的那次实测是 6）；仓库偏好
  **基线偏离优于固定阈值**（oversight 纪律），有了 `gh` 账本的历史数据之后应当改成基线。

### 开单复盘（进入后**先做这个**，不要继续派工）

逐条回答，把答案写进输出：

1. 账本里有几个**不同**的 `kind`？（若 kind 数 ≪ issue 数 ⇒ 直接塌缩）
2. 这些是同一个缺陷类的 N 个实例吗？能不能用**一次**修复覆盖？
3. 我是不是在用「记成后续 issue」代替「修掉」？（Step 4 那个口子）
4. 我的扫描面是不是每轮都在扩大？越修越发现 ⇒ scope 本身没有边界，这是 epic，不是 land。

三态结论，**不得把 `spiral` 塌缩进 `converging`**：

- **`converging`** — 净未决数在下降，或全部新单塌缩成 ≤1 个 class ⇒ 继续。
- **`collapsible`** — 多条同类 ⇒ 先塌缩（扩大修复，或合并成一条 class issue），**然后**继续。
- **`spiral`** — 塌缩之后仍然发散 ⇒ **停止派工**，走下面的停止协议。

### 三轮不收敛 ⇒ 停止（硬上限）

**连续三轮「净未决数」没有下降，就必须停止，不得开始第四轮。**

**净未决数 = 本 run 自己开出、且此刻仍然 OPEN 的 issue 数。** 不是仓库的未决总数——
那个数被所有人的活动淹没（实测：这个仓库 24h 内 22 开 / 47 关，一个 run 的 ±2 在它下面
差着一个数量级），既会在 run 发散时读绿，也会在 run 收敛时读红。**只数自己开的。**

**一「轮」= 一次「派工 → 收结果 → 处置」的完整来回**（与 Step 4 的 review 轮次是两码事，见下表）。
一次 `/agentloop:land <单个 issue>` 通常只有一轮，那就没有三轮可数——这条闸是给**批量**和**反复派工**
的 run 用的。

两者都由上面那条 `gh` 命令数出来，配合输出里的 `RUN_START`，**不需要任何跨调用状态**。

「再试一轮就好了」在第四轮上永远成立，所以这条是**计数**，不是判断。三轮足够区分
「收敛得慢」和「不会收敛」；到第三轮还没降，多跑一轮只会多几条同类单。

**两个「三轮」是不同的计数器，别混：**

| | 数什么 | 到顶了怎么办 |
|---|---|---|
| **Step 4 的 3 轮** | **一个 PR** 的 review 轮次 | merge 或 fail；新 finding 开新单，不再开一轮 |
| **Step 6 的 3 轮** | **整个 land run** 的净未决数没下降的轮数 | 停止派工，交回给人 |

一个 PR 可以 3 轮 review 之后干净地 merge，而整个 run 仍在发散（每个 PR 都在生新单）——
那是 Step 6 抓的。反过来，run 在收敛而某个 PR 审不完，那是 Step 4 抓的。两个都要数。

### 这条纪律今天没有机器在跑——把它写在这里，而不是只写在 PR 里

**Step 6 是散文，不是闸。** 没有脚本在数这个账本，也没有正控在盯它。按仓库自己的判据，
**一条没有被机器检查的收敛规则，其「被遵守」与「被忽略」在报告上完全同色**——
这正是本节反对的那件事，发生在本节自己身上。

写在这里而不是只写在某个 PR 正文里，是因为**未来的 land run 只会读到这个文件**。
把这句话留在 PR 里，等于把唯一需要它的读者排除在外。

把账本变成 `pre-pr` 的一个 check（按 `RUN_START` 数 `gh`、按 `kind` 聚类、对三轮趋势设正控）
是正确的下一步。上面的 `gh` 配方是刻意选的：它让那一步**不需要重新设计**，只需要接线。

### 停止协议——给人的必须是信息，不是「我停了」

停止时输出（并落成对应 issue/PR 的 comment，挂 `needs-human-confirm`）：

1. **完整账本**：开了哪些、关了哪些、每条的 `kind`；
2. **三轮的净未决数**：例如 `3 → 5 → 6`，让人一眼看出方向；
3. **kind 家族划分**：几类、每类几条、为什么塌缩不掉；
4. **我试过什么**：塌缩尝试、扩大修复的尝试，以及各自为什么没成；
5. **一条具体建议**，不是「请指示」——通常是这三者之一：
   - 「这其实是一个 epic，建议转 `/agentloop:epic-conductor`」；
   - 「整类纳入范围需要人拍板，因为它会碰 X」；
   - 「这一类的根因在 <具体位置>，修它一处能消掉 N 条」。

**已经合入的东西不回滚。** 停止的是**派工**，不是撤销已完成的工作。

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
| 一轮里开的单比关的多 | 进 Step 6 开单复盘，先塌缩再决定要不要继续 |
| 连续三轮净未决数没下降 | **停止派工**，按 Step 6 停止协议给人账本 + 三轮数字 + 一条建议 |
| 一个 PR 审到第 3 轮还有 finding | 按 Step 4 的表：同类塌缩 / 开新单 / REJECT / fail——**不许开第 4 轮** |

**报告要说实话**：测试红了就贴输出，跳过了哪步就说跳过了，只有真的做完并验证过才说完成。

---

## 输出

结束时给出：每个目标的**终态**（merged / 待合 / 卡住）、PR 号与链接、
gate 的实际结论、review findings 的处置、以及下一条命令（如果还需要人做什么）。

**外加 Step 6 的收敛账本，无条件**（哪怕一条单都没开——那正是要看见的那种好结果）：

```
RUN_START=<ISO 时间戳>            ← run 开始时记下，账本靠它数出来
开单账本：decisions=<n>（其中 issue=<i>，其余为 TODO/KNOWN MISS/正文/comment）
          因修好而关=<m>   本 run 自开且仍 OPEN=<k>
  #<num>  kind=<文件路径>:<症状动词>  理由=<闭集里的值>   ← 每条一行
kind 家族：<f> 类 / <n> 条
收敛判定：converging | collapsible | spiral
```

`decisions` 与「仍 OPEN」是**两个不同的量**（前者含四种载体，后者只数 issue），
分开印，不要相加。

**`opened=0` 必须是数出来的，不是没写。** 报告里少一行和「这一轮很干净」在读者眼里同色——
这是本 skill 自己的度量对偶，别在自己身上犯。
