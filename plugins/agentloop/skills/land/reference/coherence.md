# land — Step 1 coherence check and Step 2 routing detail

> On-demand reference for [`land`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## Step 1 — 一致性检查（只在**没有**显式引用时执行）

> **这是本 skill 最重要的一步，也是唯一会让它拒绝干活的一步。**

### 为什么需要它

**同色陈述：上下文里「装着一件清楚的事」和「装着三件缠在一起的事」，
都能让你写出一个自信的计划。** 一个直接开干的 skill 分辨不了这两者——它在两种情况下
都会产出一份读起来很合理的方案，然后在第二种情况下开出一个混装 PR、或者悄悄只做了三件里的一件。

所以这道检查的机制不是「判断是否清楚」（那等于凭感觉），而是——

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

### 2d. 还没有 issue？

**先开 issue**，再走 2c。理由：PR 需要一个可引用的 `Fixes #N`，而且这件事会因此有一份
durable 记录，不只活在某个 session 的上下文里。issue 正文写清楚发现（现象、根因、
证据、以及**你已知的陷阱**），语言按 `comment_language`，顶部身份行由
`agent_identity_script` 生成——**不要手拼**。

```bash
bash <agent_identity_script> --header "" --skill land > /tmp/body.md   # 身份行，脚本生成
# …把发现写进 /tmp/body.md：现象 / 根因 / 证据 / 已知的错误修法…
gh issue create -R <repo_slug> --title "<Conventional Commits 风格标题>" --body-file /tmp/body.md
```

**开单前先查同类**：这一轮已经开过同一个形状（同文件、同症状）的单，就扩大那条，不再开新的。

**开完必须复核正文长度非空**——`gh issue create` 在 body 为空时照样返回 URL 和 exit 0，
「开成功了」和「开出了一个空壳」在终端上同色。
**用 `--body-file`，不要用 `--body @path`**（后者会把路径本身当正文发出去，且被 hook 硬 deny）。
