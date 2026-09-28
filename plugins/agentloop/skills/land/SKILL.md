---
name: land
description: >-
  Take ONE thing (work DID, issue, PR, or the current topic) all the way to merged: prove it is
  one coherent piece of work, then route an epic to epic-conductor, or implement → independent
  review → gate → merge. Orchestrates existing skills. Use for "finish this".
allowed-tools: Agent, Bash, Read, Grep, Glob, Skill, AskUserQuestion
---

# land — 把一件事从当前状态推到 merged

## Usage

```
/agentloop:land <work DID | w_<32hex>>
/agentloop:land <40-char sha>
/agentloop:land <issue#>            # 先 /work，miss 才是投影 alias
/agentloop:land <PR#>               # 跳过实现
/agentloop:land <url>               # sourceUrl 反查 /work
/agentloop:land <n1> <n2> <n3>      # 每件一个隔离 subagent
/agentloop:land                     # 无引用：先过一致性闸
/agentloop:land <一句话描述>         # 同上
```

**可选参数**

| 参数 | 默认 | 作用 |
|---|---|---|
| `--merge=auto` | 单件 | 闸绿 + review 干净就合 |
| `--merge=confirm` | 批量 | 停在「已绿待合」等确认 |
| `--merge=never` | — | 只到绿，不合 |

## Repo profile

先读 `.claude/repo-profile.md`。本 skill 用到的键：`repo_slug`、`default_branch`、`plugin_root`、`verification_entry`、`merge_gate_entry`、`agent_identity_script`、`comment_language`、`gate_mode`、`change_set_record_entry`。
（`pre_merge_entry` 不在本 skill 的流程里：合并闸认同一 SHA 上 `verification_entry` 的 PASS，合并时刻的风险由合并闸的 merge-load 门判定。）
**不要硬编码任何仓库字面量**——没有 profile 就先跑 `/agentloop:repo-setup`。

**是**路由器 + 单件驱动器，不是 review / gate / epic 分解的实现。在这里重写 sub-skill 是缺陷。邻居：epic → `/agentloop:epic-conductor`；扫存量 → `/agentloop:issue-sweep` / `/agentloop:pr-sweep`；多阶段 → `/agentloop:build-phases`；这一件要 merged → 本 skill。

## Step 0 — 解析目标

**身份顺序（禁止跳过 `/work` 直接 `gh issue view`）：**

1. **work DID / CS@sha** — 参数是 `did:…`、`w_<32hex>`、或 40-char git sha 时，先查 `/work`：
   ```bash
   arc --json afs exec /.actions/query --args '{"path":"/work","where":{"field":"meta.objectId","eq":"<DID>"},"limit":8}'
   # Change Set @ sha:
   arc --json afs exec /.actions/query --args '{"path":"/work","where":{"all":[{"field":"meta.workType","eq":"change-set"},{"field":"meta.head","eq":"<40-char-sha>"}]},"limit":8}'
   ```
2. **`/work` 命中** → 这就是目标。`sourceUrl` 是 GitHub 投影，不是调度身份。DID 也可用 path stem。
3. **`/work` 未命中** → alias lookup（`gh issue view` / `gh pr view`，含 inbound ref）。输出写明这是 alias。GitHub-only 成功 ≠ `/work` 已查。
4. **无引用** → Step 1。多个编号逐个解析，进批量模式。

work 与 GitHub 同时命中：**以 `/work` 为准**。miss 且 issue 与 PR 都命中：**报出两者让人选**，不要猜。

When matching a land argument shape, read [reference/resolve-target.md](reference/resolve-target.md).

## Step 1 — 一致性闸（只在**没有**显式引用时执行）

无显式引用则先枚举候选。A 一句话说清、B 一个 PR、C 用户明确指认、D 当前工作线，四条全过才是 `single`。三态 `single` / `multiple` / `unclear`，**不得把 `unclear` 塌缩进 `single`**；后两态报枚举、不派工。显式引用豁免，**但 D 仍要做**：`gh` 核对 state、label、已有 PR（`agent:processing` 或已关联 PR 时先说出来）。

When the coherence gate is unclear or you need the four criteria in full, read [reference/coherence.md](reference/coherence.md).

## Step 2 — 分类与路由

### 2a. 是 PR？

跳过实现。直接 Step 4（review）→ Step 5（gate + merge）。

### 2b. 是 epic？

是 epic(自身 `epic` 标签，或 `epic:<N>` 且 **N == 自己的编号**，或有成员，或正文 ≥3 条 #编号)→ 转 `/agentloop:epic-conductor`。⚠️ **`epic-managed` 不是 epic 判据**。是 epic 时本 skill 不做。

When classifying an epic, read [reference/coherence.md](reference/coherence.md).

### 2c. 是普通 issue？

进 Step 3。可选先跑 `/agentloop:issue-review`（陈旧或含糊时值得；刚由你写的可跳过）。

### 2d. 还没有 issue？

先开 issue(现象 / 根因 / 证据 / 已知的错误修法),正文顶部是 `<agent_identity_script> --header` 生成的身份行,再走 2c。

When opening an issue, read [reference/coherence.md](reference/coherence.md).

## Step 3 — 实现（隔离的 subagent）

派**一个** subagent，`isolation: "worktree"`。无关的未提交改动不得卷进分支。

给 subagent 的 brief 必须包含：

- issue 号 + 让它**自己去读**完整正文（不要转述）
- 诊断时排除掉的错误方案（尤其是显而易见但错误的修法）
- **严格 TDD**（先写失败测试）、**accept-path 铁律**（只测「坏输入被拒」等于没测）、**变异验证**（把实现改坏，确认对应测试变红，再恢复）
- 分支名含 `issue-<N>`，PR 正文 `Fixes #<N>` + `agent_identity_script` 身份行。往已有 PR 正文上写必须带 `--prior-engines <现有 engine: 集合>`（追加，不覆盖）。新 PR 不传该旗。评论身份是本 session，不要把 coder 集合写进评论行。
- **顺序：实现 → review → 一次修完 → 只跑一次闸 → 开 PR。** 实现阶段只跑改动包的定向测试；**写完先停下来交回**（分支 / worktree 路径）。review 意见一次修完之后，push 前跑**一次** `verification_entry`，全绿才推；**永远不要 `--no-verify`**
- 闸报 `TIMEOUT` 且 `failed=0` 时，只用 `ARC_VERIFY_TEST_TIMEOUT_MS`（只能调大）重跑**一次**并写明取值；`failed>0` 不许用它
- 开 PR 后立刻 `<verification_entry> --comment <PR#>`（同一 SHA 复用证据，不重跑）。不能用 `tsc` / 单项 build 代替。
- **`gh pr create` 之后，以及之后每一次 push 到这个 PR 分支（含 review 修复）之后**，把 Change Set 记到 work ledger（#6920）：
  ```bash
  bash <plugin_root>/scripts/record-change-set.sh --entry "<change_set_record_entry>" --pr <PR URL>
  ```
  同一 head 重跑是重放；新 head 则 round + 1。**非零退出 = 没记上：停，不要当作已记上**（不许 `|| true`）。`none` 与非工厂 run 由脚本自己打印。
  When the host arc lacks `work changeset` or another N/A form applies, read [reference/change-set-na.md](reference/change-set-na.md).
- 交回：PR 号、变异验证的**实际结果**、每个设计决定。允许反驳诊断，不要将就着实现。

When worktree isolation, prior-engines, or the welded run-and-post is unclear, read [reference/implement-brief.md](reference/implement-brief.md).

## Step 4 — Review（**另一个** clean-context subagent，**先于闸**）

调 `/agentloop:pr-review`，独立 subagent。还没有 PR 时只用 Step 1–2.5（0 / 0.5 / 0.6 / 4 要 PR）。重叠交给 merge-load 与 `check-pr-path-overlap.ts`。

**reviewer 必须与 implementer 是不同的 subagent。**

**review 在第一次跑闸之前做**（普通 issue）：审 `merge-base..HEAD`，只读，**不跑任何闸**。命中 `epic-conductor` §4（Backend Face Paths，或鉴权 / exec-gate / 密钥 / 沙箱 / 支付）→ §4B 的 correctness + security 双人 panel。然后：

1. findings 过 `compact-findings.ts`，原 worktree **一次修完**；
2. 跑**一次** `verification_entry`，绿了再 push、`gh pr create`、`--comment`，并记下 Change Set（`record-change-set.sh`）；
3. 贴第 1 轮 verdict（`post-verdict.ts`，`round:1`，`sha` = 被审的修复前 sha）。`botFindings=` / `vendorsSeen=` 没齐就写 `COMMENT（待闸事实 / bot-clean）`，不写 `MERGE`。实质或安全修复 → 对 `<被审 sha>..<head>` 增量复审，记第 2 轮。

已有 PR：照常审，不跑闸；之后只复审修复（Step 0.6）。

- **P1 / High** → 修掉，或 PR 上 REJECT 并给理由，才能进 Step 5。
- **P2 / P3** → 修，或记后续 issue（先同类塌缩：与本轮已修同类则扩大修复，不开新单）。不要静默略过。
- 回执（bot findings、defer 的 owner 与再处理条件、缺回执是否挡合并）只认 [`reference/review-receipt-protocol.md`](../../reference/review-receipt-protocol.md)。
- **一轮意见一次修完、一次 push**，随后记下新 head（`record-change-set.sh`）。措辞且非 P1/High：随下次实质修复带上，或按回执协议 defer，不单独重跑闸。
- 每个修复批次 gate 一次，并刷新 verdict。缺一则这一轮不算闭合。

When review would share the implementer context, or the verdict sha would be the post-fix head, read [reference/review-before-gate.md](reference/review-before-gate.md).

#### review 轮次上限：**3 轮**

最多 3 轮;之后只有 merge 或 fail。一轮 = 新 head 上重新核验并刷新 verdict。从 PR 上读,不从记忆里写:

```bash
bun <plugin_root>/scripts/pr-review-round.ts --pr <PR#>
```

`0`–`2` 可再审;`≥3` 不可。**非零退出 = 读不到,停,不当成第 1 轮。** 数字进 `review_rounds=`。第 3 轮后:同类塌缩修在这里;另一面开新 issue;不成立则 REJECT;P1 修不动则 fail。**第 3 轮的修复必须是单点/机械的,否则 fail**。不存在「只确认」的额外一轮。

When a third-round fix is not a one-line mechanical change, or the round counter's edges matter, read [reference/rounds.md](reference/rounds.md).

## Step 5 — Gate 与 merge（按仓库规矩）

0. 合并前先跑**一次** bot 检查（回执协议 Part A 第 5 条，`bot-clean.ts`）；P1/High 未修且未 REJECT 则挡。不要每次提交后等 bot。
1. 跑 merge-gate，**带 CS `head`**。读同一 SHA 上 `--comment` 贴的 PASS，不重跑 `pre-merge`（落后 main 由 merge-load 对**当前** tip 判）：

   ```bash
   # --cs-head must be current HEAD. sourceUrl → also --source-url.
   <merge_gate_entry> --cs-head <40-char-sha> <PR#>
   ```

   **merge-gate 只由合并者跑，且紧接着第 4 步的 `merge-verified-pr.sh`**（同一台机器、同一个 head；review 与 bot-clean 之后）。exit 0 写入判决，reviewer 绝不跑它。main 已前进或隔了很久 → 合并前重跑。

   丢掉 `--cs-head` 改跑 `<merge_gate_entry> <PR#>` 禁止。`--data-file` 仍要显式 PR#。`verification fact is not current` → 分支主人跑 `<verification_entry> --comment <PR#>`，再跑 merge-gate。arc 上 e2e-gate / ui-verify / native-verify 是 advisory，不挡；`additional_merge_gates` 才挡（arc 为空）。
   **只在 `mergeable=CONFLICTING` 时才 rebase**；落后 main 不 rebase。真要 rebase，push 之后按 Step 3 记下新 head（`record-change-set.sh`）。
   PR 号必须写成 `--comment <PR#>`。`merge_gate_entry` exit 0 才可以合。

   When a bare positional PR number is silently ignored, or a bare `gh pr merge` would skip the verdict file, read [reference/gate-comment.md](reference/gate-comment.md).

2. 红了不要判 flake、不要盲目重跑、不要调超时洗绿。二分找到根因，或走第 3 条。
3. 外来红：`<verification_entry> --comment <PR#> --blocked-by <open issue#>`。不是豁免。禁止 `--no-verify` / `force`。
4. `<plugin_root>/scripts/merge-verified-pr.sh <PR#>`。核对 `merge-gate.<sha>.json`（`$ARC_MERGE_VERDICT_DIR`，否则 `<repo 根>/.verify/`；exit 0 时写）。对不上就拒绝，闸与合并必须同一台机器、同一个 head。缺记录不要手敲 `gh pr merge`。不可抗力：`--no-gate-record "<理由>"`。**不要用裸 `gh pr merge`**。
5. 复核 `merged: true`，确认关联 issue 已关。

### 合并权限

| 模式 | 行为 |
|---|---|
| **单件（默认 auto）** | 闸绿 + review 干净 ⇒ 直接合 |
| **批量（默认 confirm）** | 每件到「已绿待合」，列给用户再合 |
| `--merge=auto` | 批量也自动合 |
| `--merge=confirm` | 单件也停下来问 |
| `--merge=never` | 只到绿，不合 |

无人值守（`AskUserQuestion` 被 hook 硬 deny，显式多引用跳过了 Step 1）：**跑到「已绿待合」就停**，清单落成 comment 并挂 `needs-human-confirm`，**不要自己合**。直合必须用户显式 `--merge=auto`。

When a batch would merge without a person, read [reference/merge-authority.md](reference/merge-authority.md).

## Step 6 — 收敛闸（开单预算 · 同类塌缩 · 三轮停止）

未决问题必须**更少**。输出里记开单账本：每个「不在这里修」(issue、TODO、`KNOWN MISS`、PR 已知缺陷段、别人 issue 下的 comment)一行，`kind = <修复要碰的文件路径>:<症状动词>`。

- **同类塌缩**: `kind` 等于本轮已开或刚修的 → 扩大当前修复(仍是一个 PR 时),否则只开**一条** class issue。
- **螺旋**(任一,先复盘再派工): `opened > closed`(只算修好而关) · 某 `kind` ≥ 3 · 开出的 `kind` 等于本轮关掉的 · 每目标开单 > 2。不得把 `spiral` 写成 `converging`;`spiral` → 停止派工。
- **三轮不降就停**: 本 run 自开且仍 OPEN 的数连续三轮不降 → 交回账本 + 三轮数字 + 一条建议。与 Step 4 的 3 轮是两个计数器。

When posting the ledger, collapsing a kind, or stopping after three rounds, read [reference/convergence.md](reference/convergence.md).

## 批量模式

`land 5649 5651 5652`:每件一个 subagent(`isolation: "worktree"`),编排串行 inline。**同一台机器上同时最多 2 个重闸**(`verification_entry` / advisory 门 / 全量 build/test)。闸位按正在跑的闸计数,不看 `load1`。调度,不是锁。开工前用 `<plugin_root>/scripts/check-pr-path-overlap.ts` 查文件重叠,重叠 PR 互相引用并写明合并序,未声明的不得合并。最后统一报一次。

When running more than one target, read [reference/batch-and-stuck.md](reference/batch-and-stuck.md).

## 卡住时怎么办

不静默降级,不反复重试同一个失败动作。闸持续红 → 不盲目重跑:二分找根因,或带 witness issue 走 `--blocked-by` 让闸自己判;都不成立就停,报失败检查和 rawTail。P1 修不动 → 停在「已开 PR、未合」。目标其实是 epic → 转 `/agentloop:epic-conductor`。报告说实话。

When the run is stuck, read [reference/batch-and-stuck.md](reference/batch-and-stuck.md).

## 输出

每个目标的终态(merged / 待合 / 卡住)、PR 链接、gate 实际结论、review findings 的处置、下一条命令;**外加无条件的收敛账本**(`RUN_START=`、`review_rounds=<n>`、`decisions=` / 因修好而关 / 自开仍 OPEN、每条 `kind` + 理由、收敛判定)——都是数出来的,`opened=0` 也要印。

When writing the final report, read [reference/batch-and-stuck.md](reference/batch-and-stuck.md).
