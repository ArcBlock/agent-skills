---
name: pr-review
description: Independent clean-context review of ONE open GitHub pull request — read PR diff + linked issue + verify every claim against live code/tests + run the verification gate (pre-merge) and diagnose its root-cause + detect conflicts with sibling PRs, then emit an evidence-backed merge-readiness verdict (MERGE / COMMENT / SUPERSEDE / BLOCK / CLOSE). Runs verification every time (read-only safe); --post writes one verdict comment. Never auto-merges (that gated step belongs to pr-sweep). Use /agentloop:pr-review <pr#> for a single PR; pr-sweep batches this engine across all open PRs.
---

# PR Review — AI Agent Review for one pull request

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> **arc is the reference implementation.** Use the profile's values wherever this doc shows an
> arc default: `repo_slug` (the `gh -R` target), `gate_mode` (arc = `scripts`: no CI on PRs,
> so `gh pr checks` is empty and the verification scripts are the only gate;
> `ci`/`both` repos ALSO fold in `gh pr checks`), `verification_entry` / `pre_merge_entry`.
> Arc's own provenance for the lessons below is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

把**一个 PR 处理到位**:读 PR diff + 关联 issue + 已有 review/comments → **对照已落地代码/测试逐条核验** → **跑 verification 门控(pre-merge)并判读根因**(PR 上已无 CI) → **检测与兄弟 PR 的冲突/重复** → 产出**带证据**的合并就绪判定,落回 PR(comment),而不是埋在某次对话里。

这是 [`issue-review`](../issue-review/SKILL.md) 的 PR 版:同一台引擎(读 → 对照现实 → 带证据落 comment),对象换成 PR,多了三件 issue-review 没有的事——**跑 verification 门控并判读、跨 PR 冲突检测、合并就绪判定**。

> **输出语言与写作规范 = profile `comment_language`。** verdict comment、「需人确认块」等一切面向团队的产出一律用该语言写叙述(团队阅读语言);代码标识符、路径、命令、`path:line`、`gh` 输出、测试输出**保持原样**(不翻译)。**不堆砌**:内容太多本身就是阅读负担——先一句话结论,再最少但足够的证据(文档 / 代码 `path:line` / 真实测试输出,**UI 相关必附截图**——ui-verify 产出的截图/录屏即此类证据);长日志折叠进 `<details>`,verdict 只引用结论不重复全量日志。

## Usage

```
/agentloop:pr-review <pr-number-or-url> [--post]
```

- `<pr-number-or-url>` — 要 review 的 PR。`gh` CLI 可用时直接用；无 `gh`（cloud routine）时用 `mcp__github__*` 工具替代（ToolSearch 加载）。
- `--post` — 把 verdict comment 发到 PR 上(默认 **read-only**:只产出给用户看,不发 comment、不动 label、**永不 merge**)

单 PR 用本 skill;**批量 + 去重关闭 + 受闸自动合并**用 [`pr-sweep`](../pr-sweep/SKILL.md)。

## When to Use

- 想在 merge 前对**一个 PR** 拿一个独立的、对照真实代码的判断(不只看门控红绿)。
- 怀疑某 PR 和别的 PR **重复/冲突/矛盾**,要定责到"留哪个、关哪个"。
- 在搭"定时自动 review+merge PR 的机器",需要一个可复用、产物可追溯的 per-PR 动作。

**不适用**:纯本地 diff 的 review(用 `/code-review`);issue 里的设计评审(用 `/agentloop:issue-review`)。

## 判定词表(受控,5 类)

| recommendation | 含义 | 下一步 |
|---|---|---|
| `MERGE` | 声明已核实、verification 无真实阻断、无未解冲突 | 可合(由 pr-sweep 按风险闸自动合,或人合) |
| `COMMENT` | 原则可合但有值得提的关注点(部分修复、缺测试、小问题),**或**是重复对中的**保留方**(注明要关掉的 peer) | 发 comment,通常仍可合 |
| `SUPERSEDE` | 是重复/矛盾对中**冗余/较差的一方** | 发 comment 说明 + 指向保留方 → **关闭本 PR**(关闭是 pr-sweep 的动作) |
| `BLOCK` | 有真实缺陷 / verification 失败是本 PR 的错 / 未解冲突 | 发 comment 指出,**不可合** |
| `CLOSE` | 陈旧/已被合并的工作取代/不再需要 | 发 comment 说明 → 关闭 |

> **要人介入的 verdict(`BLOCK` escalate、`COMMENT` 带阻断关注,以及 pr-sweep 侧的 🔴/security/`awaiting-direction|judgment|caution`)→ comment 必带「需人确认块」(`awaiting-glance` 不带——它只请人看一眼,没有要人判的问题)(Step 5.5):要你判什么 + 怎么验(可照跑步骤,security 逐条列) + 推荐。别停在"请人工确认"。**

## ★ 发现即修(fix-now)——review 产出的默认动作是修复,不是转述

review 中发现的**确定性缺陷**(尤其截图一眼可见的 UI 缺陷:重叠/裸样式/交互失效/Unknown 框),
默认动作是**本轮当场修掉**,不是留 comment 等下一轮。判据是「要不要人拍板」,不是「是不是本 PR 的锅」:

| 缺陷在哪 | 四门判据(全过才修) | 当场动作 |
|---|---|---|
| **本 PR diff 引入** | 证据坐实(截图/测试/`path:line`)· 修法无歧义 · 非安全 · 无需方向拍板 | `--post` 模式:直接在 **PR 分支**上修(fix commit + push + comment 说明改了什么);read-only 模式:comment 给出可直接套用的修法。`BLOCK` 只留给修不动/要方向的 |
| **main 上既有**(review 顺带撞到,如截图里暴露的布局 bug) | 同上四门 + 有界(单点 CSS/renderer 级,非架构) | **开 tracking issue(带截图)+ 从 origin/`<default_branch>` 切分支修 + before/after 截图 + verification + 开独立 fix PR** 双向回链;verdict comment 里一句话指向。一轮闭环,不写「建议复核」「留给其他 agent」 |
| **任一门不过**(security / 方向 A-B 未定 / 大改动 / 语义争议) | — | comment + `needs-human-confirm`,把「要人判什么 + 怎么验 + 推荐」写全(Step 5.5) |

**反模式:** 截图发现一个确定性、CSS 级、非安全的缺陷 → 只写「与本 PR 无关的观察,建议复核(不影响合并)」→ 没人跟进,bug 继续躺着。正确动作:当场按上表第二行处置(修 + issue + fix PR),人看到的是
「已修,PR #N」而不是一句转述。**发现的缺陷「顺手能修却没修」= 本次 review 不完整。**

**fix-now 的并发纪律(同 bug 撞出双 issue):** 多个 actor 会同时盯上同一个
bug——「开工时搜过没有 issue」≠「提交时还没有」(调查窗口里别人可能已建,TOCTOU)。三条:
① **开 tracking issue 前的一刻再搜一次**(标题关键词 + `--state all` 按 created 降序看近期),已存在
同 bug issue → 不另开,根因/证据 comment 进它;不小心开重了 → 自己关掉并 comment 注明并入哪个。
② 修复分支**必须**用确定性名 `claude/issue-<N>`(全 repo 硬去重键,与 issue-sweep/pr-sweep 同款),
push 前 `git ls-remote origin refs/heads/claude/issue-<N>` 做认领检查——已有人推 → 读对方进度再定
并入还是让位。③ 目标 issue 带新鲜 `agent:processing` 锁但**无分支无 PR**(对方仍在调查),而你已有
验证过的修复 → 直接推 `claude/issue-<N>` 认领(先推先得,对方的认领检查会短路)并在 issue comment
说明;只有想法没有修复时,别抢锁,comment 留证据即可。

## How It Works(冷启动)

```
┌────────────────────────────────────────────────────────────┐
│ 0. 读 PR 全貌 + 关联 issue + 已有 review/comments            │
│ 0.6 ★ 复审去重(sha 机器键):fresh→跳过;stale→增量,不从零   │
│ 1. 读 diff + 受影响文件在「当前 main」里的真实样子            │
│ 2. ★ 逐条核验声明 vs 已落地代码/测试(path:line 或 NOT FOUND)│
│ 2.5 ★ 横切:反向引用/parity/端到端/性能/测试/清理           │
│ 3. ★ 运行 verification (pre-merge) —— PR 上已无 CI,这是唯一 │
│    门控信号;每次必跑(read-only 安全),--comment 落 PR      │
│    简单失败可自修;复杂失败 → BLOCK + 完整日志 context       │
│ 4. ★ 检测与兄弟 PR 的冲突/重复/矛盾(同 issue + 同文件)       │
│ 5. 出判定:5 类之一 + 证据;MERGE 必须以 Step3 通过为前提     │
│ 6. (--post)落 verdict comment;never merge、never close    │
└────────────────────────────────────────────────────────────┘
```

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

> **★ 三面检查对工具无关——`gh api` 只是其中一种实现,换成 MCP 等其他工具时,以下三个调用
> 本轮必须都有对应产出(哪怕是"无结果"),缺一路 = Step 0 未完成**:
>
> | 面 | `gh` | MCP 等价(`gh` 不可用时) |
> |---|---|---|
> | ①会话评论 | `gh pr view <n> --comments` | `pull_request_read(method="get_comments")` |
> | ②inline 代码行评论 | `gh api pulls/<n>/comments` | `pull_request_read(method="get_review_comments")` |
> | ③review 总评(**含 `state`**) | `gh api pulls/<n>/reviews` | `pull_request_read(method="get_reviews")` |
>
> ③ 的 `state` 字段(`APPROVED`/`CHANGES_REQUESTED`/`COMMENTED`)必须显式记下、不能只看 `body` 文本——
> 一条 `CHANGES_REQUESTED` 是比普通评论更强的信号,merge 前另有独立硬闸拦([pr-sweep Step 5](../pr-sweep/SKILL.md))。

PR body 通常带 `Fixes #N` / `Part of #N` → 记下**关联 issue 号**(冲突检测的主键)。读关联 issue(`gh issue view <N>`)拿"这个 PR 到底要解决什么"。

> **`agent:hold`(人类保留 = 终态冻结,不是处理冻结):** Step 0 已取到 `labels`;若见 PR 带 `agent:hold`——**显式手工 `/agentloop:pr-review <n>` 只提示不挡**(人点名就是要看;且本 skill 默认 read-only、永不 merge,风险低)。hold 的含义是"没人反馈之前别合/别关",**不是"别处理"**:review 照常做,**人类在 hold PR 上的新评论必须读并响应**(那往往是修改要求或拍板条件)。verdict 上的体现:即使全绿,也写 `MERGE (held)` 并注明"等人摘 `agent:hold` 后才可合";若人类评论给了明确修改要求 → 按 `COMMENT`/`BLOCK` 处理并把"响应人类反馈"作为下一步(--post 模式可直接在 PR 分支实现人类明确要求的改动)。真正执行合并闸拦截(带 hold 一律不合)的是 [`pr-sweep`](../pr-sweep/SKILL.md)。只人加只人摘,agent 永不自动摘。

### Step 0.5 — PR 分支同步 `<default_branch>`(不可跳过)

**单独运行 pr-review 时必须自己做；pr-sweep 调用时已在自己的 Step 0 后处理。** `<default_branch>` = profile 字段(部分 repo 用 `master`——下文及全篇「main」皆指该字段,不逐处再注)。

Step 0 已拿到 `mergeable` 字段。若为 `CONFLICTING`，或已知 PR 分支落后 `<default_branch>`，先 rebase 再继续——否则 `pre-merge` 会因 base 陈旧产生虚假失败(`<default_branch>` 已修复的错误会被误判为本 PR 引入):

```bash
git fetch origin <default_branch>
gh pr update-branch <n> --rebase   # 把 origin/<default_branch> 带进 PR 分支并 push；已是最新则无操作
```

rebase 成功后，重新取一次 `mergeable`（应为 `MERGEABLE`），再进行后续步骤。

### Step 0.6 — ★ 复审去重(跨 runner:先查既有 verdict,别重复劳动)

**真实事故(PR #1812):三个 runner 的 agent 先后 full review 同一个 PR,每轮各发一条新 comment,6 条评论里没有一条对当前 HEAD 有效的拍板块——人要自己从评论堆里拼状态,结果谁也没法拍板。** 根因两个:①新鲜度靠时间戳比对,跨 runner 无法机器判重;②结论以**追加式**落盘——旧 verdict 不刷新,后续轮只发增量 FYI。修法:verdict 以 **HEAD sha 为机器键**(sweep-trace 的 `sha` 字段),以**每 PR 唯一的 canonical comment 为载体**(Step 6)。

Step 0 已拿到全部评论;取 HEAD oid,与最近一条 verdict trace(**任何 runner 发的都算**)比对:

```bash
head=$(gh pr view <n> --json headRefOid --jq .headRefOid)
# 从已取回的会话 comments 里抓最近一条 gate:"verdict" 的 sweep-trace,读其 sha 字段
# (旧格式 trace 无 sha → 一律视为 stale)
```

| 判定 | 动作 |
|---|---|
| **fresh**(`sha == HEAD`,且其后无人类新评论) | **不重复 review。** 只在能「推进」时行动:补跑上一轮环境跑不了的门控(daemon 型 ui-verify / e2e-gate)、把新证据并入 canonical verdict(Step 6 upsert)。什么都推进不了 → 报告「HEAD `<sha7>` 已有 fresh verdict(runner:`<x>`),跳过」,**结束,零产出是正确产出**。 |
| **fresh + 人类新评论** | 进「响应人类反馈」:读三个面的人类意见(Step 0),针对性处理,**刷新同一条 canonical verdict**(不新开)。 |
| **stale**(`sha != HEAD` 或无 sha) | **增量复审,不从零重做**:`git diff <旧sha>..<HEAD>` 只核验 delta(新 commit 改了什么、旧结论哪几条失效),仍有效的核验结果直接继承(注明「继承自 `<sha7>` 轮」),**upsert 同一条 canonical verdict** 并把 sha 刷成当前 HEAD。**绝不新开一条只写 delta 的 FYI comment——那正是 #1812 的堆叠形态。** |
| **无 verdict** | 首轮,走完整流程。 |

> `sha` 只免**结论性劳动**,不免**响应义务**——人类新评论永远要读要答(同 Step 0 hold 段)。read-only 模式(无 `--post`)判定逻辑相同,只是产物呈现给用户而非 upsert 到 PR。

### Step 1 — 读 diff + 受影响代码现状
```bash
gh pr diff <n>
```
本地 checkout 须在**最新 `<default_branch>`**(pr-sweep 已 sync;单跑先 `git fetch origin <default_branch>`)。读 diff 触碰的文件在当前树里的真实样子——**不要只在 diff 内自洽地判断**,要看它落到现实代码里对不对。

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

Step 2 核验"这个 PR **声称**改的";这一步核验它对**系统其他部分**的影响——diff 内自洽看不出,必须跳出 diff 主动去搜。**这是 agent review 最常漏的一层**:只盯着改动本身,不问"谁依赖它、别处要不要同步改、有没有真接进使用场景、会不会变慢、测了没、旧的清了没"。逐维度过,每维度**要么给证据、要么显式判"不适用"**——漏查和查过判"不适用"是两回事:

| 维度 | 何时查 | 怎么查 | 命中处置 |
|---|---|---|---|
| **反向引用** | diff 删文件 / 删或 rename export / 改公开签名 | 跑 [`impact-check`](../impact-check/SKILL.md):按 basename 反向搜全 repo(含多行 import、`readSource`/动态引用),别只搜单行 `import` | 悬空引用 = 确定性 break `check-types`/`test` = 本 PR 真实缺陷 → 归 Step 3 根因 (a),可 `BLOCK`,列每处 `path:line`。**先于 Step 3 跑**,能预判 verification 红在哪、把根因钉在本 PR 而非陈旧 base |
| **跨包 parity(镜像 + 配套)** | ①改 runtime 层(`node`↔`cloudflare`)/双端共享 provider;②给枚举·联合类型·注册表·factory **新增一项**(新 widget/组件/消息类型/provider kind 等) | ①对照另一 runtime 同语义两边是否都改;②grep 消费该枚举的 switch/dispatch/renderer(常在**另一个包**)是否加了对应 `case`/handler | 缺对等 → `BLOCK`(确定性 bug)或 `COMMENT`(单侧有意为之)。**②最隐蔽:消费端有 `default`/兜底分支(渲染 "Unknown"/静默 no-op)时,`check-types`/build 全绿、只在运行时降级——和"反向引用"相反(删东西响亮 break 编译,加东西不 break 却静默坏)** |
| **端到端交付(使用场景闭环)** | diff 新增 export / 函数 / 能力 / provider / API / 抽象层 | ①grep 该 symbol 全 repo 调用点(impact-check 同一趟出);②再往上一层:这条新能力有没有**接进一个真实的用户可见流程 / 实际使用场景**,还是只落了一半 infra | 零 caller 且非对外 API/SDK 导出 → `COMMENT`;**有 caller 但没端到端接进使用场景**(建了能力没建用它的功能、只 wire 了一半)→ `COMMENT`,要作者说明使用场景闭环在哪 / 哪个后续 PR 补齐。**基础能力建设不脱离实际使用场景——没有真实消费场景的底层不该独立落地** |
| **性能回退** | 改**请求处理链**任意一环(路由 / 中间件 / 鉴权 / provider mount / 序列化)、冷启 / init 路径、DB 查询、循环内 I/O、缓存 | 读改动:①是否引入 N+1、全表扫描、丢索引命中或缓存、同步阻塞、大 payload;②**是否把 scale-work(fleet / 租户级 / O(N))压进了每请求 / 冷启 / init 路径**——那里必须 O(1) 或挪后台 | 可疑 → `COMMENT`,要作者给 before/after 实测(性能改动必须有数据,不接受"应该更快");**请求链 / init 上的 per-request·per-tenant 开销不实测不放行** |
| **测试覆盖** | 任何行为变更 / 新功能 / bug fix | 有无对应新增或既有覆盖的自动化测试,且真断言、非空跑 | 核心逻辑无测试 → `BLOCK`;边缘无测试 → `COMMENT`(缺测试) |
| **清理 / 收尾** | PR 替换 / 迁移 / 重命名了某实现、加了替代路径或临时 flag | diff 有没有**删掉被取代的旧代码 / 旧 code path / 死 feature flag / 过时测试 / 注释掉的代码**;新增文件是否对应一个该删的旧文件;迁移是否留了双份实现 | 只加新不删旧(死代码堆积 / 双实现并存)→ `COMMENT`,列该清理的 `path:line`;**废弃的旧路径仍有 live caller**(留着会被误用)→ `BLOCK` |

> **同名重定义 ≠ 反向引用漏**:符号因新/ported 模块重新定义而被 grep 命中(rename/rewrite 常见)是噪音,只有仍指向已删/改定义的悬空引用才算(判据见 [`impact-check`](../impact-check/SKILL.md))。

### Step 3 — ★ 运行 verification 门控(pre-merge)并判读根因

**门控形态 = profile `gate_mode`**(arc = `scripts`:删了 `ci.yml`/`pr-title.yml`,`gh pr checks` 恒为空,verification 脚本是**唯一门控信号**;`ci`/`both` 的 repo 还要把 `gh pr checks` 纳入判定)。出判定前**每次必跑 `<pre_merge_entry>`**(profile 字段;只读、不写远端,与默认 read-only 不冲突;
`--comment` 会把报告贴到 PR):

```bash
# <pre_merge_entry> from repo-profile.md
<pre_merge_entry>                       # read-only:报告呈现给用户
<pre_merge_entry> --comment <n>         # --post 模式:一步跑 + 贴到 PR
```

`pre-merge` 用最新 `origin/<default_branch>` 作 affected base(兄弟 PR 合并后环境已前进,能抓 pre-pr 看不到的破坏)。
`renderReport` 已生成 markdown(状态/耗时表 + `rawTail` + 折叠 `rawFull`),直接引用,不手写数字。

**verification 报告只能通过 `--comment` 投递,禁止手写。** 不要把 verification 结果手抄进
一条自己写的 review verdict comment(哪怕带上了 `<!-- verification-report ... -->` 标记)——
`postComment()` 的 upsert 生成逻辑(sha/result 编码、PATCH-vs-POST 判断)只在脚本内部,手写
marker 容易和真实 sha 不一致(短 sha 手写 marker 被全量比对判 mismatch)。verdict comment 和 verification report 分开发:
verdict 写成独立的普通 PR comment(`gh pr comment`/`mcp__github__add_issue_comment`),
verification 结果永远用 `pre-merge.ts --comment <n>` 单独投递,不要合并成一条手写 comment。

**核心原则:门控是信号不是判官。** 失败必须定根因:

| 根因 | 信号 | 处置 |
|---|---|---|
| **(a) 本 PR 真实缺陷** | 失败的测试/类型/架构检查由 diff 引入 | → `BLOCK`,comment 指出 `path:line` + 失败检查名 + `rawTail` |
| **(b) flaky / 基础设施** | 与改动无关的偶发(网络/超时/沙箱抖动) | → 不阻断;comment 注明"失败与本 PR 无关(flaky)",重跑坐实 |
| **(c) base 陈旧需 rebase** | mergeable=`CONFLICTING`,或失败因 main 已前进(`pre-merge` base 已抓) | → Step 0.5 已 auto-rebase；若未执行（异常情况），`COMMENT` 要求人工 rebase |
| **(d) 可自修的噪音** | `format` 是 warn-only(脚本已非阻断);单行 lint/import 等机械件 | → **不阻断**;`--post` 模式可在 PR 分支自修 → push → 重跑 |

**结果进 verdict:** 全 blocking ✅ PASS → 允许 `MERGE`;非 PASS → **verdict 不得为 `MERGE`**。
- **简单失败**(格式/import/单行 lint):`--post` 模式在 PR 分支修 → 重跑;read-only 模式在 verdict 里指出。
- **复杂失败**(测试/类型/架构违规):发 `BLOCK`,verdict 带失败检查名 + `rawTail` + 折叠 `rawFull`,给后续 agent 接力上下文。

> **这一步在 pr-review 是 advisory(判定输入),不是不可跳过的合并门控。** 真正不可跳过的硬门控——"`<merge_gate_entry> <pr#>` exit 0(SHA 匹配 + result=PASS/NA;profile 字段,arc = `<merge_gate_entry>`)"——在 [`pr-sweep` 合并闸](../pr-sweep/SKILL.md)(机制点:SHA 比对由该脚本执行、不靠自觉)。pr-review 只判不合,门控在那边执行。
>
> 例外:已有一份对同一 HEAD、时间在最后一次 diff 之后的验证报告 → 复用,不重跑。

**运行时 / CF-parity PR(改该仓库的多运行时 parity 面 `<Backend Face Paths>`,或 blocklet render/mount/serve 语义):`/agentloop:verification` 的静态门控看不到「跑起来对不对」——补跑 `/e2e-verify`(该仓库的 companion，见 repo-profile 的 Companion Skills；没有就 stub 或跳过该步)。** 它本地 boot **两个** runtime 做匿名 + 认证 roundtrip 核验:Node = `<dev_server_node>`,**CF = `<dev_server_edge>` 本地 miniflare(自带 D1 + migration,不需要 CF 账号、不碰 staging)**。所以 CF 那侧**本地就能验**——绝不判成「需要云端 CF/wrangler 环境」而 defer;别把「别猛测线上 staging」当成「CF 本地验不了」。`<cli_binary>` 缺/陈旧先跑 `<cli_setup_command>`(arc `cli_binary` = `arc`)。

### Step 3.5 — UI 改动:条件触发 `ui-verify`

`verification`(Step 3)是无 daemon、无浏览器的**静态**门控——它看不到"页面还渲不渲染、
用户流程还走不走得通"。所以当 PR diff **命中 UI 面**时,把 `ui-verify`
作为一个 review 步骤跑,把 UI 报告并入 verdict 证据(不进 `pre-pr.ts`/`pre-merge.ts` 确定性脚本
——那会破坏其 hermetic/确定性;衔接就在这一层的编排)。

```bash
# diff 命中 UI Face Paths(regex 见 repo-profile.md「UI Face Paths」;下方为 arc 的值)→ 触发
gh pr diff "$n" --name-only | grep -Eq '^(blocklets/|providers/runtime/ui/|packages/aup/|packages/core/)' \
  && echo "UI 面命中 → 跑 /ui-verify --pr $n"
```

- **先看 proposing agent 有没有交图(截图左移契约,issue-sweep 侧)**:PR body 已内嵌
  运行截图 → **复用为证据基线,不重新生图**;只在「截图之后 diff 又变了」或「截图可疑
  (与 diff 对不上)」时抽查重拍。**截图证据和 `pre-merge` 报告同一套 SHA 匹配语义:
  只对拍摄时的 HEAD 有效——之后任何 push(包括本 review agent 自己的 fix commit,
  哪怕只改一行 CSS)都使它作废,改了 UI 面就重拍**(只重跑静态 verification 就合并、没人看过新样式的反例)。合并侧的硬拦截在
  [`pr-sweep` 合并闸的「UI 证据闸」](../pr-sweep/SKILL.md)。**PR 命中 UI 面却没带截图 = 一条 COMMENT 级关注点**
  (提醒 proposing 侧补,或本轮代生)。复用前先做**破图检查**:对 body 里每个内嵌图片
  URL 无凭据 `curl -s -o /dev/null -w '%{http_code}'` 必须 200(camo 匿名视角)——
  非 200 = 所有读者看到的都是破图,按「没交图」处理并留 COMMENT。
- **命中 `<UI Face Paths>`**（`.claude/repo-profile.md`）→
  **先判 renderer/widget 级 vs 页面级（判据优先于 daemon 有无）：**
  - **renderer/widget 级**（改的是 `<UI Face Paths>` 内的 renderer/primitive/widget/css 代码、无独立 blocklet 页面可跑）→ **必须用 `<ui_shot_script>`**（真实 shipped bundle 渲染 fixture，**无需 daemon**，参数矩阵/前后对比/交互序列）。**"无 daemon"在此路径不是跳过理由**——`<ui_shot_script>` 本来就不需要 daemon；命中此路径必须出图，不得以"无 daemon"为由跳过。
  - **页面级**（改 `blocklets/**` 的页面逻辑、需要跑着的 blocklet 渲染整页）→ 需有跑着的 daemon（cloud routine / 本地），跑 `/ui-verify --pr <n>`，它自动从 diff 推断场景、截图 + 录屏、贴回 PR；**daemon 不可用 → 打 `ui-verify:pending` label（`gh pr edit <n> --add-label ui-verify:pending`，label 不存在则先 `gh label create`）+ 注明"ui-verify 需 daemon,本环境未跑"** —— label 是让带 daemon 的 routine 能确定性扫描到（而不是靠解析 verdict 文本猜"哪些 PR 还欠 ui-verify"，见 #1205）；带 daemon 的 routine 补跑成功后摘掉该 label（见 [`pr-sweep`](../pr-sweep/SKILL.md) 的 pending 扫描步骤）。但若同时含 renderer 改动，renderer 部分仍须 `<ui_shot_script>`（不受 daemon 有无影响）。
  verdict 里引用截图 pass/fail（与 `pre-merge` 并列为门控输入）。**截图/自查 checklist 命中的明显缺陷(重叠/裸样式/交互失效/Unknown 框)按「★ 发现即修」处置——包括暴露出的 main 既有 bug,当场修 + issue + fix PR,不写「与本 PR 无关的观察,建议复核」了事。**
- **未命中**(纯后端/文档/脚本/测试) → 跳过,不是 FAIL(在 verdict 注明"无 UI 面,跳过 ui-verify")。

### Step 3.6 — 后端/数据面改动:条件触发 profile `additional_merge_gates`(arc: `e2e-gate`)

`verification`(Step 3)看不到「provider 挂不挂得上、`list`/`read`/`write` RPC 一跑就 500、
`/user` 数据面往返坏不坏」——这类**只有起服务才看得见**的运行时问题。**本步只在 profile 的
`additional_merge_gates` 非空时适用**(arc 声明了 `[e2e-gate]`;该字段为 `[]` 的 repo 把本步整体跳过,
在 verdict 注明"repo 无 additional_merge_gates")。适用时,当 PR diff **命中后端面**,把该 gate 作为一个
review 步骤跑(与 Step 3.5 UI 面对称,不进确定性脚本——衔接在这一层编排),把后端 smoke 报告并入 verdict
证据。

```bash
# diff → scope 推断(命中 Backend Face Paths → RUN,纯文档/UI/前端/测试 → N/A)
bun .claude/skills/e2e-gate/scripts/scope.ts --pr "$n" --json   # backendHit + 要起的 blocklets(arc 的 e2e-gate 脚本)
# backendHit:true → /e2e-gate --pr $n(起受影响 blocklet 跑 Tier A+C,贴 sticky comment)
```

- **命中 `<Backend Face Paths>`**(`.claude/repo-profile.md`)
  → 跑 `additional_merge_gates` 声明的门(arc: `e2e-gate`):只起 diff 命中的 blocklet(不全量 7×2),Tier A 结构探针 + Tier C 认证
  往返,结果 sticky comment 贴回 PR。**需跑着的 daemon(CF 端 = 本地 miniflare `<dev_server_edge>`,不碰 staging;
  `<cli_binary>` 缺/陈旧先跑 `<cli_setup_command>`)**;daemon 起不来 → 记 "`additional_merge_gates` 门需 daemon,本环境跳过" 并注明,门控由带
  daemon 的 routine / pr-sweep 补跑(同 ui-verify 的 daemon 缺席处理)。**smoke 命中的运行时缺陷(本 PR 引入的
  500/往返坏)按「★ 发现即修」处置。**
- **未命中**(纯文档/UI/前端/测试,或仅非 fleet blocklet 后端改动)→ 跳过,不是 FAIL(在 verdict 注明
  "无后端面,跳过 `additional_merge_gates`")。截图/静态门与本门互不替代:UI 面走 Step 3.5,后端面走本步。
- 合并侧的硬拦截在 [`pr-sweep` 合并闸的「后端数据面闸」](../pr-sweep/SKILL.md)——本步是 advisory 判定输入,
  真正不可跳过的门控由 `<merge_gate_entry>` 双门执行(见 Step 3 末的机制点说明)。

### Step 4 — ★ 跨 PR 冲突 / 重复 / 矛盾检测
两个主键:**同 issue** 和 **同文件**。

1. **同 issue 重复**(最常见,根因见下方"源头治理"):多台机器各自跑 issue-sweep,对**同一个 issue** 各开一个 PR,branch 名形如 `claude/<verb>-<N>-<slug>`——**issue 号 `<N>` 相同、verb/slug 不同**。判据:
   ```bash
   # 找所有 head branch 含同一 issue 号、或 body 同指一个 issue 的开放 PR
   gh pr list --state open --json number,headRefName,body \
     --jq '.[] | {number, headRefName, fixes: (.body|capture("(?<k>(Fixes|Part of) #\\d+)")?.k)}'
   ```
   两个 PR 同指 #N → 比 diff,分类:**精确重复**(一个冗余)/ **矛盾**(断言不同,如同一处 license 一个写 BUSL-1.1 一个写 BSL-1.1)。给出**留哪个**(更完整/更正确/证据更足者),另一个判 `SUPERSEDE`。
2. **同文件冲突**:两 PR 改同一文件。分类:**行级 merge 冲突**(同区段)/ **独立**(同文件不同区段,可共存)/ **语义矛盾**(都改同一配置成不同值)。共享配置文件(`pnpm-lock.yaml`、`wrangler.toml`、`package.json`)重叠 → 提示合并顺序/二次冲突风险。

**留谁的判据(供 SUPERSEDE 决策):** 更完整的 diff > 更正确的事实(对照权威源,如 repo `LICENSE`)> 有测试 > 更新的 base > 先到(同等条件下保留先开的,关后开的)。把判据和证据写进 comment,别只下结论。

### Step 5 — 出判定
- **逐条核验表**:claim → `path:line` 或 NOT FOUND。
- **横切影响结论**(Step 2.5 六维度):每维度给证据或显式判"不适用"——反向引用悬空清单(`path:line`)/ parity 缺口 / 端到端使用场景闭环(不只看有没有 caller)/ 性能可疑点(含请求链·init)/ 缺测试 / 该清理的死代码。
- **verification 结果**:`pre-merge` PASS/FAIL + 失败根因归类(a/b/c/d)。
- **冲突结论**:与哪个 peer、什么关系、留谁关谁、为什么。
- **recommendation**:5 类之一。**`MERGE` 必须以 Step 3 验证通过为前提**;未运行或未通过 = 不得发 MERGE。
- **「PR 类型是 feature」不是升级/降档理由。** 全绿 + 逐条核验过 + 非 breaking 的 feature,verdict 就是 `MERGE`,不写"feat 需人批准合并"。要人介入的只有:security 面、breaking change(不兼容协议/wire、schema 无迁移、数据破坏)、架构方向/设计 A/B 未定、人已明确异议——判据与风险档全文见 [`pr-sweep` Step 5](../pr-sweep/SKILL.md)(含「默认放行,出问题再收紧」ratchet)。升级时写清**具体拿不准什么**,而不是 commit type。
- 价值在**独立发现 + 定责**,不在复述已有 review。

### Step 5.5 — 需人确认块(human-escalation verdict 必带)

**硬前置(升级前必答,issue #1860):打拍板块之前先问「我能不能说出一个安全默认动作?」——能 → 禁止升级,当场按 ratchet(默认放行,出问题再收紧,见 [`pr-sweep` Step 5](../pr-sweep/SKILL.md))执行并留 trace;不能,才是真判断题,才配走下面的结构化拍板块。** 这条硬前置在结构化拍板块**之前**过一遍——先问能不能自己拍,答不出才落到需人确认。

当 verdict 要**人介入**——`BLOCK`(escalate 而非 agent 可自修)、`COMMENT`(带阻断关注)、以及 pr-sweep 侧的 🔴 高风险 / `awaiting-direction|judgment|caution` / security——**comment 不能停在"请人工确认"**(#660 就是反例:核验表很全,落到"请人工确认后合并"就断了,没说要人判什么、怎么验)。必带一个结构化「需人确认块」:

```
> 🛑 需人确认 — <一句话: 要你定的那一个决定>
>
> **为什么停在这:** <agent 不能自决的精确原因: 设计 A/B 未定 / 安全边界 / 不可逆 / 缺写权限>
> **agent 已核验(不必重做):** <已坐实的部分, path:line + 测试 pass/fail —— 省去人重复劳动>
> **请你验证(可照跑):**
>   1. `<确切命令>` → 预期 `<X>`;现状 `<Y>`
>   2. 看 `<path:line>` 确认 `<具体属性>`
> **要定的:** <选项 A / 选项 B,各自后果> · **我的推荐:** <X,因为…>
> **定了之后:** A → `<解锁动作/命令>` / B → `<解锁动作>`
```

**两要素硬性检查(缺任一 = 拍板块不合格,不许发)——源自 #1812 复盘:**

1. **问题 + 建议回答**:要人答的问题必须**具体、封闭**(一句话能答"是/否/选A"),且 agent 必须附上自己的建议回答——人只做确认/否决,不做开放式思考。"请人工确认后合并"这种开放句式不合格。
2. **选择 + 区别 + 推荐**:每个选项写清**选它之后会发生什么、和其他选项差在哪**(不是只列名字),并给推荐 + 理由。

**两个都给不出 → 这不是正常输出,是发现了真正的问题**:显式写「⚠️ 无法形成建议」+ 精确缺什么(哪条信息 / 哪个权限 / 哪个未定的前置决策),这本身就是最高优先级 escalation——比任何 BLOCK 都值得人先看。绝不允许用一句笼统的"需人工审阅"把"我没想清楚"伪装成"已完成 review"。

**时效**:拍板块必须钉在**当前 HEAD sha** 上(块首标 `针对 HEAD <sha7>`);PR 再收到 push 即作废,复审时按 Step 0.6 刷新同一条 canonical comment,不追加新块。

**铁律——能给步骤就给步骤,给不了就给判据,绝不造假命令:**

- **可还原成可照跑步骤**(verification 失败需人判 / 代码正确性 / 安全属性 / 去重冲突 / 缺权限的机械操作)→「请你验证」填**确切命令 + 看哪个 `path:line` + 预期 vs 现状**,让人(或人的 agent)照跑就能确认。
- **不可还原**(无先例的设计 A/B、架构方向、taste)→ **绝不编一个假装能验证的命令**;「请你验证」换成**选项 + 判据 + 推荐**,并明说这是判断题。
- **agent 已核验的别让人重做**:把机械正确性(sanitization、测试 pass/fail、verification 根因)的结论摆上去,人只聚焦那个真正要他判的点。

**per-type「请你验证」填什么:**

| escalation 类型 | 「请你验证」填 |
|---|---|
| verification 失败需人判 | 确切失败检查名(`check-*`)+ `pre-merge` 的 `rawTail` 摘录 + 根因(a/b/c/d) + "复现: 跑 `<pre_merge_entry>`, 预期 `<PASS/FAIL>`" |
| 代码/逻辑正确性 | 触发点 `path:line` + 复现测试命令(`<package_manager> --filter <pkg> test` / `<test_runner> <path>`) + 预期 vs 实际行为 |
| **security(必逐条列)** | **每个**安全属性单独一行:`<属性: const-time compare / path-traversal guard / authz / 注入过滤>` @ `path:line` + 验证它的命令或测试 + **失败长相**(怎样算被绕过)。决定仍归人,但给完整 checklist,**绝不**只说"涉及安全请人看" |
| 去重/冲突拿不准 | 两个 PR# + 冲突行 `path:line` + 权威源路径(repo `LICENSE` / canonical doc) + 对比命令(`gh pr diff` / `git show`) |
| 设计 A/B(判断题) | 不造命令:选项 A/B crisp 描述 + 各自 tradeoff + 触发它的 intent/issue 锚点 + 你的推荐 + 什么证据能 settle |

> **范围**:只有上面那几类**要人介入**的 verdict 带此块;`MERGE`(无需人)、agent 自修的机械件**不带**——别给不需要人的 PR 也堆一个空块。

### Step 6 — 落 comment(`--post` 时)
中文写,顶部标 AI 身份与读取/运行范围。**整行 header 由单点脚本生成**(不能手拼/占位符/日期代替),行尾追加模型与范围:
```bash
hdr=$(bash <agent_identity_script> --header "PR Review")   # profile 字段
# → "> 🤖 AI Agent PR Review @ <hostname> · runner:<name> · skills@<hash>"
echo "${hdr} — Claude Code(<model>)。读取:PR diff + 受影响代码/文档/测试 + 关联 issue。运行:/agentloop:verification (pre-merge) + <测试命令>。每条结论附可复现证据。"
```
详见根 CLAUDE.md「Agent Comment 格式」(前缀是 pr-sweep 检测谓词,由脚本保证不漂移)。
```bash
# canonical verdict comment:每 PR 唯一,body 必含 marker <!-- pr-review-verdict -->,复审 = 原地 upsert
# (--edit-last 只能编辑「自己」的上一条;上一轮 verdict 可能是别的 runner 发的,必须 marker 定位 + PATCH)
cid=$(gh api "repos/{owner}/{repo}/issues/<n>/comments" --paginate \
      --jq '[.[]|select(.body|contains("<!-- pr-review-verdict -->"))]|last|.id // empty')
if [[ -n "$cid" ]]; then
  gh api -X PATCH "repos/{owner}/{repo}/issues/comments/$cid" -F body=@draft.md   # 跨 runner 原地刷新
else
  gh pr comment <n> --body-file draft.md                                          # 首轮:新建
fi
# gh 不可用时：先安装（apt install gh -y），确实无法安装才用 mcp__github__add_issue_comment
# ⚠️ MCP add_issue_comment 会吃掉 ![截图](...) 的 `!`（图片变纯链接）——含截图时避免用 MCP
```
- **verdict comment 每 PR 唯一(canonical):body 必含 `<!-- pr-review-verdict -->` marker;任何复审(含跨 runner)= upsert 同一条**,历史版本留在 GitHub edit history 里可查。别堆重复——#1812 的 6 条评论堆叠就是这条规则缺位的直接后果。补充性产物(verification 报告、ui-verify 截图 comment)仍各自独立投递,verdict 只引用其结论。
- 默认 read-only;`--post` 才写。
- Step 3 的验证报告已用 `--comment` 单独贴出;verdict comment 只引用其结论(PASS/FAIL),不重复全量日志。

## Autonomy Boundary(铁律)

本 skill 是**引擎**,边界比 sweep 紧:

- **自动做(--post 时)**:发/改一条 verdict comment、调 label。可逆可追溯。
- **绝不做**:`gh pr merge`(合并是不可逆的,交给 pr-sweep 的受闸步骤或人)、`gh pr close`(关闭交给 sweep 的去重步骤)、push 到别人的分支、改 PR 作者的代码。
- 一句话:**pr-review 只判 + 只评论;merge/close 是 pr-sweep 的受闸动作。**

## Key Principles

1. **对照已落地代码是第一优先,核验范围含横切影响。** PR diff 自洽 ≠ 落到现实正确。最有价值的发现是"这个 fix 没真修 / 这条 doc 改动对不上 shipped 面 / 这个 test 是空跑"。**并且**:diff 自洽也 ≠ 对系统其余部分无害——必跳出 diff 查六件横切影响(Step 2.5):反向引用(删/rename 留下的悬空引用)、跨包 parity(node/cf 镜像 + 声明↔分派配套)、端到端使用场景闭环(不只看有没有 caller)、性能回退(含请求链·init·冷启)、测试覆盖、清理收尾。**这是 agent review 最常漏的一层。**
2. **verification 门控是信号不是判官(PR 上已无 CI)。** 失败必诊断根因(a/b/c/d),PASS 也不免逐条核验。噪音类失败(format warn-only / 单行 lint)不阻断,可自修;真实测试/类型/架构违规才 BLOCK。
3. **冲突要定责到留谁关谁,带判据。** 同 issue / 同文件两把主键;矛盾(如 license 串不一致)必须查权威源拍板,不能两个都留。
4. **每条发现都有可复现证据。** `path:line` / `gh` 输出 / 真实测试输出。无证据 = 不写。
5. **产物落 PR,不落会话。** 跑完 = PR 里多一条可被下一轮接力的 verdict comment。
6. **引擎只判不合。** merge/close 的不可逆动作留给 pr-sweep 的受闸 ladder + 人的边界。
7. **要人介入时,给可照跑的验证,不给笼统"请确认"。** escalation verdict 必带「需人确认块」(Step 5.5):要你判什么 + agent 已核验什么(免重做) + **怎么验(可还原成命令就给命令 + path:line + 预期,security 逐条列;还原不了的判断题给选项+判据+推荐,绝不造假命令)** + 定了之后各分支解锁动作。拍板块两要素硬性检查:**问题+建议回答、选择+区别+推荐——两个都给不出 = 发现真正的问题,显式升级,不许拿"请人工确认"糊过去**。
8. **一 PR 一 verdict,以 sha 为界。** verdict comment 全 PR 唯一(marker upsert,跨 runner 也刷同一条);sweep-trace 的 `sha` 是新鲜度机器键——fresh 就跳过(零产出是正确产出),stale 就增量复审。三个 agent 各自 full review、评论堆成六条、没一条对当前 HEAD 有效(#1812)是本条规则要根除的形态。

## ★ sweep-trace 埋点（L2 可观测层）

每条本 skill 发出的 AI verdict comment 末尾**必须**附一行 sweep-trace HTML 注释（人不可见、grep 可查、L1 eval 复用为 golden baseline 数据来源）：

```html
<!-- sweep-trace: {"ver":1,"pr":N,"gate":"verdict","val":"<val>","sha":"<head-oid>","run":"<ISO8601>"} -->
```

字段：
- `ver`：schema 版本，当前 `1`
- `pr`：对应 PR 编号（数字）
- `gate`：固定值 `verdict`
- `val`：决策值，取 pr-review 受控词表（5 类）：`MERGE` / `COMMENT` / `SUPERSEDE` / `BLOCK` / `CLOSE`
- `sha`：本 verdict 针对的 PR HEAD（40 位 commit oid，`gh pr view <n> --json headRefOid`）——Step 0.6 跨 runner 去重/新鲜度判定的**机器键**。旧 trace 无此字段 → 一律视为 stale
- `run`：UTC 时间，`new Date().toISOString()` 格式

**trace 只附在发出的 verdict comment 末尾；read-only 模式（无 `--post`）不发 comment，不附 trace。**
