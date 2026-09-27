---
name: pr-review
description: >-
  Independent clean-context review of ONE open PR: verify every claim against live code, read the
  same-SHA verification fact (never run a gate), check bot threads and sibling conflicts, then a
  verdict (MERGE / COMMENT / SUPERSEDE / BLOCK / CLOSE). --post writes it. Never merges.
---

# PR Review — AI Agent Review for one pull request

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> **arc is the reference implementation.** Use the profile's values wherever this doc shows an
> arc default: `repo_slug` (the `gh -R` target), `gate_mode` (arc = `scripts`: no CI on PRs,
> so `gh pr checks` is empty and the verification scripts are the only gate;
> `ci`/`both` repos ALSO fold in `gh pr checks`), `verification_entry` / `merge_gate_entry` (`pre_merge_entry` is not part of review).
> Arc's own provenance for the lessons below is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

把一个 PR 处理到位:读 diff + 关联 issue + 已有 review → 对照已落地代码/测试逐条核验 → 读 verification 事实并判根因(reviewer 只读证据、不跑闸) → 检测兄弟 PR 冲突 → 带证据的合并就绪判定,落到 PR comment。这是 [`issue-review`](../issue-review/SKILL.md) 的 PR 版。

输出语言 = profile `comment_language`。标识符、路径、命令、测试输出保持原样。先一句话结论,再最少证据(UI 附截图);长日志放 `<details>`。

## Usage

```
/agentloop:pr-review <pr-number-or-url> [--post]
```

- `<pr-number-or-url>` — 要 review 的 PR。`gh` CLI 可用时直接用；无 `gh`（cloud routine）时用 `mcp__github__*` 工具替代（ToolSearch 加载）。
- `--post` — 把 verdict comment 发到 PR 上(默认 **read-only**:只产出给用户看,不发 comment、不动 label、**永不 merge**)

单 PR 用本 skill;**批量 + 去重关闭 + 受闸自动合并**用 [`pr-sweep`](../pr-sweep/SKILL.md)。

## When to Use

一个 PR 的独立、对照真实代码的合并前判断,或和兄弟 PR 的重复/冲突定责。纯本地 diff 用 `/code-review`;issue 设计评审用 `/agentloop:issue-review`。

## 判定词表(受控,5 类)

| recommendation | 含义 | 下一步 |
|---|---|---|
| `MERGE` | 声明已核实、verification 无真实阻断、无未解冲突、每条 actionable review thread 都已有原线程结论、无 OPEN 的 bot P1/High | 可合(由 pr-sweep / epic-conductor 按风险闸自动合,或人合) |
| `COMMENT` | 原则可合但有值得提的关注点(部分修复、缺测试、小问题),**或**是重复对中的**保留方**(注明要关掉的 peer) | 发 comment,通常仍可合 |
| `SUPERSEDE` | 是重复/矛盾对中**冗余/较差的一方** | 发 comment 说明 + 指向保留方 → **关闭本 PR**(关闭是 pr-sweep 的动作) |
| `BLOCK` | 有真实缺陷 / verification 失败是本 PR 的错 / 未解冲突 | 发 comment 指出,**不可合** |
| `CLOSE` | 陈旧/已被合并的工作取代/不再需要 | 发 comment 说明 → 关闭 |

> **要人介入的 verdict(`BLOCK` escalate、`COMMENT` 带阻断关注,以及 pr-sweep 侧的 🔴/security/`awaiting-direction|judgment|caution`)→ comment 必带「需人确认块」(`awaiting-glance` 不带——它只请人看一眼,没有要人判的问题)(Step 5.5):要你判什么 + 怎么验(可照跑步骤,security 逐条列) + 推荐。别停在"请人工确认"。**

## ★ 发现即修(fix-now)——review 产出的默认动作是修复,不是转述

确定性缺陷的默认动作是**当场修**,不是转述。四门(证据坐实 · 修法无歧义 · 非安全 · 无需方向拍板)全过:本 PR 引入的 → `--post` 模式在 PR 分支修(read-only 给可直接套用的修法);main 上既有且有界的 → tracking issue + 确定性分支 `claude/issue-<N>`(push 前 `git ls-remote` 认领检查)+ 独立 fix PR。任一门不过 → comment + `needs-human-confirm`(Step 5.5)。开 issue 前一刻再搜一次防重复。

判据表、反模式与并发纪律: Read [reference/fix-now.md](reference/fix-now.md).

## How It Works(冷启动)

Order: 0 read the PR → 0.4 thread receipts + bot findings → 0.6 re-review dedup → 1 diff + current code → 2 verify every claim → 2.5 cross-cutting → 3 read the same-SHA gate fact (never run a gate) → 4 sibling-PR conflicts → 5 verdict → 6 (`--post`) upsert the verdict. Never merge, never close.

The flow diagram: Read [reference/steps-detail.md](reference/steps-detail.md).

### Step 0 — 读 PR 全貌(便宜,先做)
```bash
gh pr view <n> --json title,body,author,headRefName,baseRefName,mergeable,additions,deletions,files,labels
gh pr view <n> --comments          # 会话区意见(AI 评论以 "> 🤖 AI Agent" 开头)
# ⚠️ 人类意见共有三个面,--comments 只显示第一个面,后两个必须补读
# (遗漏 = 人类的 inline 修改要求被忽略):
gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate \
  --jq '.[]|{user:.user.login, t:.created_at, path, line, body}'   # ② 代码行 inline review comment(带 path+行号,直接喂核验)
gh api repos/{owner}/{repo}/pulls/<n>/reviews --paginate \
  --jq '.[]|select(.body!="")|{user:.user.login, state, t:.submitted_at, body}'  # ③ review 总评(approve/request-changes 正文)
```

三个面本轮都必须有产出(哪怕是「无结果」);③ 的 `state`(`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`)要显式记下。MCP 等价调用: Read [reference/steps-detail.md](reference/steps-detail.md).

PR body 的 `Fixes #N` / `Part of #N` 是冲突检测的主键。读关联 issue(`gh issue view <N>`)确认这个 PR 要解决什么。

### Step 0.4 — ★ review-thread 回执 + bot findings 清单(Codex + Cursor + 同类 connector)

清点 review 意见;**等待 / 回线程 / 推进的协议只有一处**(shared, also used by pr-sweep / land / epic-conductor)。每次 review 必做:

1. 从 Step 0 的 inline comments + reviews 筛 bot vendor(`chatgpt-codex-connector[bot]`、`cursor[bot]`、任何 inline connector)。**取失败 ≠ 没有 finding**(REST 404 → GraphQL `reviewThreads`)。`commit_id == HEAD` 不代表是新意见。
2. 每条 actionable inline comment(人或 bot,任意 severity)必须在**同一 thread** 有结论:fixed(完整 SHA + 改动 + 验证)/ REJECT(理由)/ 仅 P2/Medium/Low 可 defer(tracking issue + owner + 再处理条件)。任一 **P1/High OPEN → 不得 `MERGE`**;缺回执的低级别意见 → 至少 `COMMENT`。顶层 verdict / verification sticky / 「已 push」都不算回执。
3. **跑判据脚本,别读 summary 表**:`Completed` 不是 clean 的证据;权威的「无 finding」信号是 vendor 的 👍 reaction,且它须指向当前 head。
   ```bash
   bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/skills/pr-review/scripts/bot-clean.ts" \
     --pr <n> --repo <owner/name>
   # exit 0 = 全部 clean · 1 = 有 vendor 不 clean(含 absent) · 2 = 取不到面(fail-closed)
   ```
   verdict **逐字带上** `botFindings=<n>`(含 0;取不到写 `botFindings=UNAVAILABLE` 并降级)和 `vendorsSeen=`;`unknownBot=` 行要看。只有 `clean` 是 clean(`running` / `stale` / `incomplete` / `absent` / `unavailable` 都不是)。
4. 最新 commit 只为消一条 bot finding → 核验原来的 accept-path 还在。
5. PR 带 `agent:hold` → review 照常、人类新评论必须响应,verdict 写 `MERGE (held)`;合并冻结由 pr-sweep 执行。

state 表、每个 vendor 的判据与事故来源: Read [reference/review-receipt-protocol.md](../../reference/review-receipt-protocol.md).

### Step 0.5 — 只在真冲突时同步 `<default_branch>`

**只有 `CONFLICTING`,或分支上的红在 main 上已经修复,才 rebase**(`git fetch origin <default_branch>` + `gh pr update-branch <n> --rebase`)。只是落后 **不 rebase**——merge-load 门对着 main 当前 tip 判;rebase 后新 SHA 的 verification 由分支主人重跑,reviewer 不跑。

Why: Read [reference/steps-detail.md](reference/steps-detail.md).

### Step 0.6 — ★ 复审去重(跨 runner:先查既有 verdict,别重复劳动)

取 HEAD oid,与**任何 runner** 最近一条 verdict trace 比对(轮次问脚本:`bun <plugin_root>/scripts/pr-review-round.ts --pr <n>`,非零退出 = 未知,不当 0)。新鲜度键是 `(sha, val)`:

| 判定 | 动作 |
|---|---|
| fresh(`sha == HEAD`,无人类新评论) | 不重复 review;只并入能推进的新证据,否则零产出结束 |
| fresh + 人类新评论 | 响应人类反馈,刷新同一条 canonical verdict |
| 机械重生成(release 类)sha 变 | 视同 fresh:只 upsert sha,不新发 comment |
| stale 但结论与上轮 `val` 相同且已 `awaiting-*` / hold | 静默 upsert sha,不再 @ 人 |
| stale | **增量复审** `git diff <旧sha>..<HEAD>`,继承仍有效的核验,upsert 同一条 verdict |
| 无 verdict | 首轮完整流程 |

事故来源与机械重生成的判据: Read [reference/rereview.md](reference/rereview.md).

### Step 1 — 读 diff + 受影响代码现状

`gh pr diff <n>`;读 diff 触碰的文件在**最新 `<default_branch>`** 里的真实样子,不在 diff 内自洽地判断。真要跑 PR 分支的代码时,建独立 worktree 于 `$AGENTLOOP_WORKTREE_BASE/pr-<n>.$$`(绝不动共享主 checkout、绝不硬编码 `/tmp`),结束必 `git worktree remove --force`。

Commands: Read [reference/steps-detail.md](reference/steps-detail.md).

### Step 2 — ★ 逐条核验声明 vs 已落地代码/测试(最关键)
把"读起来对"和"其实是对的"分开。按 PR 类型定核验深度:

| PR 类型 | 怎么核验 |
|---|---|
| **bug fix / 行为变更** | 这个 diff 真的修了 title 说的问题吗?逻辑对吗?有没有**对应测试**(新增或既有覆盖)?`grep`/读测试,能跑就跑那一个:`<package_manager> --filter <pkg> test` / `<test_runner> <path>`,记**确切命令 + pass/fail**。 |
| **test-only** | 测试有意义吗(真断言、非空跑)?符合 `runProviderTests` / 既有范式吗?**真跑一遍**确认绿。 |
| **docs-drift** | 每一条文档改动**对得上 shipped 现实吗**?逐条 `grep` 代码坐实(path:line),还是只是"听起来合理"的散文?(issue-review 纪律:`status` frontmatter 普遍不可信,必对照代码。) |
| **release(release-please 自动 PR)** | 机械件:确认是当前 release 分支、版本号连续、CHANGELOG 由工具生成。**同类只能有一个**(见冲突检测)。 |
| **feature** | 范围、正确性、测试覆盖、是否触碰共享配置(lockfile / wrangler.toml / package.json)引入冲突面。强语义面留强模型。 |

每条声明 → 定位 `path:line` **或标 NOT FOUND**。无证据不写。

### Step 2.5 — ★ 横切影响核验(diff 之外必查,不分 PR 类型)

逐维度过,每维度**给证据或显式判「不适用」**:反向引用(删/rename/改签名 → [`impact-check`](../impact-check/SKILL.md))· 跨包 parity(runtime 镜像、枚举新增项的消费端)· 端到端交付(新能力有没有接进真实使用场景)· 性能回退(不把 O(N) 压进每请求/冷启路径)· 测试覆盖(核心逻辑无测试 → `BLOCK`)· 测试质量(`/agentloop:test-audit` diff 模式 + 读测试:**测的能不能失败**,accept 臂在不在)· 清理收尾(旧实现/flag/死代码删了没)。

每个维度的查法与处置: Read [reference/cross-cutting.md](reference/cross-cutting.md).

### Step 3 — ★ 读 verification 门控事实并判读根因(reviewer 不跑闸)

出判定前要有 **current** verification 事实:同一个 HEAD SHA 上 `<verification_entry> --comment` 贴出的报告(`sha=` == PR head,`result=PASS|NA`);不需要另跑 `pre-merge`,main 前进也不需要——merge-load 门对着 main 当前 tip 判。

**reviewer 只读事实,从不跑闸**(不跑 `<verification_entry>`、`<pre_merge_entry>`、e2e-gate / ui-verify,**也不跑 `<merge_gate_entry>`**——它 exit 0 会写 `merge-verified-pr.sh` 当作合并授权的判决记录)。`<merge_gate_entry>` **只由合并者**在 `merge-verified-pr.sh` **之前紧接着**跑,同一台机器、同一个 head。

```bash
gh api "repos/<owner>/<repo>/issues/<n>/comments" --paginate \
  --jq '.[] | .body | split("\n")[0] | select(startswith("<!-- verification-report "))' | tail -1
```

- 同 SHA PASS/NA → 事实成立。没有 / 过期 → **不自己跑**;verdict 写「gate fact missing at `<sha7>`」,不得 `MERGE`,点名分支主人跑 `<verification_entry> --comment <n>`。
- **`pre-merge` 不在 PR 流程里**(同一 marker,一次 FAIL 会覆盖有效 PASS)。
- verification 报告只由 `--comment` 投递;verdict 正文绝不逐字粘贴任何 upsert marker。

**门控是信号不是判官,失败必定根因:** (a) 本 PR 缺陷 → `BLOCK`(`path:line` + 检查名 + `rawTail`);(b) 不是本 PR 造成的红 → **仍挡合并**,出路只有两条:二分找到根因修掉,或分支主人带 witness issue 跑 `<verification_entry> --comment <n> --blocked-by <open issue#>` 由闸判定;**禁止盲目重跑、禁止调大超时让它变绿**(唯一例外:`TIMEOUT` 且 `failed=0`,只增旋钮重跑一次并写明取值);(c) `CONFLICTING` 或红已在 main 修复 → Step 0.5 rebase,只是落后不 rebase;(d) 机械噪音 → `--post` 自修并入同一批,谁 push 谁跑那一次闸;(e) `format` 红 → blocking,按该行打印的 remedy 修。FAIL 或缺失 → verdict 不得为 `MERGE`。运行时 parity 面只在「声称无测试」或 security panel 要复现时补跑 `/e2e-verify`(占一个重闸位)。

完整根因表与为什么: Read [reference/gate-fact.md](reference/gate-fact.md).

### Step 3.5 — UI 改动:核对作者截图(advisory,不设闸)

diff 命中 UI Face Paths → 核对 PR body 里作者在当前 HEAD 拍的截图并用 vision 看;缺图/过期 = `COMMENT` 级关注(advisory,不设闸)。

判据与命令: Read [reference/ui-backend.md](reference/ui-backend.md).

### Step 3.6 — 后端/数据面改动:profile `additional_merge_gates`(arc:空)

只有 profile `additional_merge_gates` 列出的门才要求同 SHA sticky(arc:空,e2e-gate / native-verify 为 advisory)。

细节: Read [reference/ui-backend.md](reference/ui-backend.md).

### Step 4 — ★ 跨 PR 冲突 / 重复 / 矛盾检测

两个主键:**同 issue**(`Fixes|Part of #N` / 分支名同号)与**同文件**。同 issue → 比 diff:精确重复 / 矛盾(先查权威源);留谁:更完整 > 更正确 > 有测试 > 更新 base > 先到,另一个 `SUPERSEDE`。同文件 → 行级冲突 / 独立 / 语义矛盾;共享配置文件重叠提示合并顺序。判据和证据写进 comment。

Commands: Read [reference/steps-detail.md](reference/steps-detail.md).

### Step 5 — 出判定
- 逐条核验表:claim → `path:line` 或 NOT FOUND。横切六维度各给证据或「不适用」。
- verification:同 SHA 的 PASS / FAIL / 缺失 @ `<sha7>` + 根因 (a/b/c/d/e)。冲突:peer、关系、留谁关谁。
- recommendation:5 类之一。**`MERGE` 必须以 Step 3 通过且 Step 0.4 无 OPEN 的 bot P1/High 为前提**。有 hold → `MERGE (held)`(本 skill 永不 merge)。
- 「PR 类型是 feature」不是升级理由。要人介入的只有 security、breaking、架构 A/B 未定、人已明确异议。判据见 [`pr-sweep` Step 5](../pr-sweep/SKILL.md)。

### Step 5.5 — 需人确认块(human-escalation verdict 必带)

**硬前置:升级前先问「我能不能说出一个安全默认动作?」**——能 → 不升级,按 ratchet 执行并留 trace。不能 → verdict 必带结构化「需人确认块」,钉在当前 HEAD `<sha7>`:要定的一个决定 · 为什么停 · agent 已核验 · 请你验证(确切命令 + 预期/现状)· 选项及后果 + 推荐 · 定了之后的解锁动作。问题必须封闭且附建议回答;给不出 → 写「⚠️ 无法形成建议」+ 缺什么。绝不造假命令。

模板与铁律全文: Read [reference/escalation.md](reference/escalation.md).

### Step 6 — 落 comment(`--post` 时)
中文写,顶部标 AI 身份与读取/运行范围。**整行 header 由单点脚本生成**(不能手拼/占位符/日期代替;engine/model 由脚本按 `ARC_AGENT_ENGINE`/`ARC_AGENT_MODEL` 自动带出,别再手写 "Claude Code(<model>)"——Codex 下跑会错误自称 Claude),行尾追加读取/运行范围:
```bash
hdr=$(bash <agent_identity_script> --header "PR Review" --skill pr-review)   # profile 字段
# → "> 🤖 AI Agent PR Review @ <hostname> · runner:<name> · skills@<hash>[ · engine:<kind>[/<model>]]"
echo "${hdr}。读取:PR diff + 受影响代码/文档/测试 + 关联 issue。读取:同 SHA 的 verification 报告;运行:<测试命令>。每条结论附可复现证据。"
```
前缀是 pr-sweep 的检测谓词,由脚本生成,不要手写。

**canonical verdict 的第一条非空行必须是 marker**(`<!-- pr-review-verdict -->`);identity header 是第二行。lookup 只认第一条非空行(#3576 / #6404)——marker 写在表格/引用/正文中间会被当成「提到了 marker 的讨论」,下一轮会另 POST 一条,而**绝不会 PATCH 那条讨论**(aside#1514 就是非锚定子串匹配把演示评论整条覆盖掉)。

**upsert 走引擎,禁止手写非锚定子串匹配 / 裸 `--jq`。** `postOnce` 已按第一条非空行锚定;`pr-review` 的入口是:

```bash
# draft.md 首行 = <!-- pr-review-verdict -->
# 第二行起 = ${hdr} + 裁定正文 + sweep-trace
# (--edit-last 只能编辑「自己」的上一条;上一轮 verdict 可能是别的 runner 发的,必须 marker 定位 + PATCH)
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/scripts/post-verdict.ts" \
  --pr <n> --body-file draft.md
# 已有第一条非空行即 marker 的评论 → PATCH;没有 → POST。正文只是引用 marker 的评论不会被选中。
# gh 不可用时：先安装（apt install gh -y）。本脚本走 `gh api`；MCP add_issue_comment 会吃掉图片 `!`，含截图时不要用 MCP。
```
- verdict 每 PR 唯一:第一条非空行必须是 `<!-- pr-review-verdict -->`;任何复审 = upsert 同一条。补充产物各自投递,verdict 只引用结论。
- 默认 read-only;`--post` 才写。
- Step 3 的验证报告已用 `--comment` 单独贴出;verdict comment 只引用其结论(PASS/FAIL),不重复全量日志。

## Autonomy Boundary(铁律)

本 skill 是**引擎**,边界比 sweep 紧:

- **自动做(--post 时)**:发/改一条 verdict comment、调 label。可逆可追溯。
- **绝不做**:`gh pr merge`(合并是不可逆的,交给 pr-sweep 的受闸步骤或人)、`gh pr close`(关闭交给 sweep 的去重步骤)、push 到别人的分支、改 PR 作者的代码。
- 一句话:**pr-review 只判 + 只评论;merge/close 是 pr-sweep 的受闸动作。**

## Key Principles

1. 独立、干净上下文。2. verification 门控是信号不是判官;reviewer 读事实、不跑闸;不是本 PR 的红仍挡合并,只能二分根治或 `--blocked-by` 由闸判定。3. 证据优先。4. 只判不合(合并在 pr-sweep / epic-conductor / land)。5. 一个 PR 一条 canonical verdict。

全文: Read [reference/principles.md](reference/principles.md).

## ★ sweep-trace 埋点（L2 可观测层）

每条发出的 verdict comment 末尾**必须**附:

```html
<!-- sweep-trace: {"ver":1,"pr":N,"gate":"verdict","val":"<val>","sha":"<head-oid>","round":<n>,"run":"<ISO8601>"} -->
```

`val` ∈ `MERGE`/`COMMENT`/`SUPERSEDE`/`BLOCK`/`CLOSE`;`sha` = 本 verdict 针对的 40 位 HEAD(Step 0.6 的机器键);`round` = **这一轮真的重新核验了 ⇒ 上一条 trace 的 `round` + 1,否则照抄**(机械重生成绝不 +1;读不到 ⇒ `1`;不猜)——`land` 的 3 轮上限读它。read-only 模式不发 comment,不附 trace。

Field-by-field table and why rounds count review labor: Read [reference/principles.md](reference/principles.md).
