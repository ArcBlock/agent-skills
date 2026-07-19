---
name: pr-sweep
description: Batch-review every open GitHub PR and drive it to a terminal state autonomously — fan out a clean-context pr-review per PR (verify claims against live code, run the verification gate), cluster PRs by shared issue + shared files, DEDUP-CLOSE same-issue duplicates (keep the best one, comment + close the twin), and GATED auto-merge every verified non-breaking PR (docs/tests/fixes AND features) while escalating only security / breaking changes / architecture-direction decisions to a human. Designed to run on a schedule on an independent machine so PRs get reviewed + merged without a human in the loop. Run /agentloop:pr-sweep (review+comment+dedup-close only), /agentloop:pr-sweep --merge (also auto-merge gated PRs), or /agentloop:pr-sweep --dry-run (report only).
---

# PR Sweep — batch-review + dedup-close + gated auto-merge

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> **arc is the reference implementation.** Use the profile's values wherever this doc shows an
> arc default: `repo_slug` (the `gh -R` target), `gate_mode` (arc = `scripts`: no CI on PRs,
> so `gh pr checks` is empty and `pre-merge` is the only gate; `ci`/`both`
> repos ALSO require `gh pr checks` green), `verification_entry` / `pre_merge_entry`.
> Arc's own provenance for the lessons below is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

A **batch driver** over [`pr-review`](../pr-review/SKILL.md). `pr-review` handles
ONE PR (read → verify against code → run verification gate → detect conflicts → verdict).
`pr-sweep` runs that engine across **all open PRs**, then does the two things a
single-PR engine can't: **resolve cross-PR duplicate/conflict clusters** (keep
one, comment + close the rest) and **gated auto-merge** the clean ones.

This is the thing a cron schedules: one run = sync + review-all + dedup-close +
(optionally) merge. It is the PR-world twin of [`issue-sweep`](../issue-sweep/SKILL.md);
together they let an independent machine keep both issues and PRs moving with no
human in the loop — escalating only the genuinely human-only decisions.

> **输出语言按 profile `comment_language`。** 所有面向团队的产出——verdict comment、去重/关闭说明、升级给人的「需人确认块」、
> 本 sweep 自己开的 PR(verification-fix 等)的**描述正文**——按 body 语言写;代码标识符、路径、
> 命令、`path:line`、`gh` 输出保持原样。**PR 与 commit 标题**按 `comment_language` 的标题语言部分,
> 不得混用。
> **不堆砌**:先一句话结论,再最少但足够的证据(文档 / 代码 `path:line` / 真实测试输出,**UI 相关
> 必附截图**——ui-verify 的截图/录屏就是这类证据);长日志折叠进 `<details>`。

> **目标(为什么存在):** 让"定时机器"把 PR 从开放推进到终态——review、去重、合并——
> **尽量不需要人 review**。PR 上已无 CI,门控是 `pre-merge` verification
> 脚本;失败看根因,门控/脚本坏了就修脚本。人只在不可逆的高风险拍板点介入。

## Usage

```
/agentloop:pr-sweep              # 全量 review + 评论 + 去重关闭(不自动 merge)
/agentloop:pr-sweep --merge      # 以上 + 对通过「合并闸」的低风险 PR 自动 merge
/agentloop:pr-sweep --dry-run    # 只报告 WOULD-DO,不发 comment / 不关 / 不合
/agentloop:pr-sweep <pr#…>       # 限定到指定 PR
```

`--dry-run` 语义与所有 loop skill 一致 —— 见插件 README 的 **Dry-run contract**。

Repo 是 `<repo_slug>`。本地有 `gh` CLI 时直接用;无则用 `mcp__github__*`,ToolSearch 加载。

## Step 0 — 先 sync 本地 `<default_branch>`(不可跳过)

下游一切——`git grep` 安全检查、`check-types`、`gh pr diff` 对照、每个 rebase——都必须跑在**最新
`<default_branch>`**(全篇「main」指 `<default_branch>`;部分仓库用 `master`)上,不是容器碰巧
clone 的陈旧树。上一轮 sweep 可能已 merge 了 PR、移动了 `<default_branch>`。

当作**朴素命令**逐条跑、读结果——**你就是控制流**,别包成 shell 循环/条件/`$(…)`(沙箱的
Bash guard 会拒,这一步会在 sweep 开始前就硬失败——实盘踩过)。

```bash
git fetch origin <default_branch>   # 偶发失败就再跑一次(你自己就是重试循环)
git reset --hard origin/<default_branch>
git log --oneline -1                # 确认在真正的 tip
```

**别用 `git checkout <default_branch>`**:在 git worktree(如 fleet checkout)里该分支被
主 worktree 占着,checkout 必失败;上面的 fetch + reset 在分支上或 detached 都能用。
工作树有上一轮残留 → `git reset --hard` + `git clean -fd`。一次 sweep 从干净、最新的树开始。

## Step 1 — 枚举所有开放 PR + 元数据

```bash
gh pr list --state open --limit 100 \
  --json number,title,author,headRefName,baseRefName,mergeable,files,labels,body,createdAt
```
> 门控形态由 profile `gate_mode` 决定:arc = `scripts`(删了 `ci.yml`/`pr-title.yml`,`gh pr checks` 恒为空,`pre-merge` 脚本是唯一门控);`ci`/`both` 的 repo 还要 `gh pr checks` 绿——
> 门控信号来自 Step 3 扇出的 `pre-merge` verification,不再从 status check 读红绿。

## Step 1.5 — 轮次感知:只处理"有新输入/新可执行"的 PR(定时 routine 的命脉)

**最先:识别带 `agent:hold` 的 PR(人类保留)并给它套「终态冻结」。** Step 1 枚举时 `--json` 已带 `labels`,每个 PR 的 labels 已在手。**`agent:hold` 冻结的是不可逆终态动作,不是冻结处理**——人打这个 label 通常意味着"这个 PR 的去留我拍板,没我反馈之前别合",而不是"别理它":

- **hold 期间绝对禁止**:merge、close(含去重关闭)、摘 label——直到人摘掉 `agent:hold`。
- **hold 期间照常做**(轮次感知规则同 non-hold PR):**有人类新评论(在最后一条 agent 评论之后)或新 commit → 仍然 review + 响应**——读人类反馈、回 comment、按人类**明确给出的修改要求**在 PR 分支干活(修完 push + 重跑 `pre-merge`,verdict 标注 `held: 等人摘 label 后才可合`)。**无新输入 → 跳过**(和普通已 review PR 一样,不重复刷结论)。

**反例(hold≠别碰):** sweep 曾因 hold 完全跳过人类明确的修改要求,把「hold=别合」错读成「hold=别碰」。人类在 hold PR 上的新评论**恰恰是最高优先级的输入**(人专门来说话了),必须响应。

`agent:hold` 是 issue/PR 通用的「人类保留」(GitHub label 仓库级共享);它与处理中互斥锁正交,PR 侧**不**引入 `agent:processing`(并发去重靠确定性分支 + 认领检查 + disposition label)。

**不做这一步,每小时会把同一批"已 review、没人回、又自动合不了"的 PR 重新起 agent + 重复刷 comment——烧 token、刷屏、可能 race。** 规则:**默认信任上一轮结论,只在「有新输入」或「外部阻塞已解除」时才动手。** 这是 [`issue-review`](../issue-review/SKILL.md) "轮次感知"在 PR 侧的对偶。

**先用 gh 元数据廉价分流(不起 agent)。** agent 评论 = 带**机器标记**(sweep-trace / `Generated by [Claude Code]` footer / 作者是 Bot);其余 = 人类(见下方 needsReview 代码块)。**不按 `> 🤖` 头判**——`agent-identity.sh` 给人和 agent 生成同样的头,人手贴的评论会被误判成 agent 裁决而跳过(实盘 arc#1722 跳了 19h)。presence `> 📡` 心跳是唯一按首行认的例外。给每个**未终结**的 PR 打一个受控 disposition label,下一轮靠它分流:

| disposition label | 含义 | 下一轮动作 |
|---|---|---|
| (无 / 已合 / 已关) | 上轮已终结 | 已不在 open 列表,自然跳过 |
| `pr-sweep:needs-fix` | BLOCK,但**修复路线已明确**(review 或人给了确切路径) | **agent 拥有 → 接着修**:在 PR 分支实现那条路线 → 跑绿 → **过 Step 5 合并闸再定合不合**(风险档重算;路线来自人类修改要求的要回人批准)。这是「有明确的活要 agent 干」,**不是等人**(见 Step 5「PR 即工作单元」)。**最多连续 3 轮**(见下方「修复轮次上限」);第 3 轮跑完仍不绿 → 改打 `pr-sweep:awaiting-direction`,不再自动发起第 4 轮 |
| `pr-sweep:awaiting-glance` 🟢淡绿 | **看一眼即合**:AI 已全部验证(verification 绿 + 声明核验),UI 面已附对当前 HEAD 的截图,人只需视觉/常识确认一下 | 等人类**明确批准语** → 过 Step 5 通用前置直接合。这是人类负担最轻的一档;comment 里给出「看什么 + 哪张图 + 一句话确认即可」。**AI 侧无未尽事项才准打此标**——证据不全(截图缺/过期)= 还是 `needs-fix`,不是 glance |
| `pr-sweep:awaiting-direction` 🔵蓝 | **等方向拍板**:AI 困惑或面临 A/B 选择,需要人给**高层方向**(产品意图、架构取向、范围裁剪)——**不是底层细节**(细节该 AI 自己啃或归 needs-fix) | 等人类新评论。comment 必须把问题抬升到人该管的高度:选项 + 各自后果 + AI 推荐 + 什么证据能 settle;绝不让人替 AI 读代码 |
| `pr-sweep:awaiting-judgment` 🟡黄 | **风险拿不准**:AI 感知到潜在风险(语义边界、回退面、影响面)但没把握自决,请人判"这个风险真不真、可不可接受" | 等人类新评论。verdict 里**写明拿不准的具体是什么**(不是"是 feature 所以升级");人判"无风险/可接受"= 批准语 → 可合 |
| `pr-sweep:awaiting-caution` 🔴深红 | **制度性审慎**:security 面 / breaking change / 不可逆操作 / 改 verification 门控语义——即 Step 5 的 🔴 档,无论 AI 多有把握都必须人批 | 等人类**明确批准语**;comment **必带 pr-review「需人确认块」**(security 逐条列安全属性 + 验证命令)。红色只保留给这一档——它才配"紧急/危险"的视觉信号 |
| `pr-sweep:awaiting-human`(旧,弃用) | 未分档的存量升级 | **迁移**:读最后一条 verdict 的升级理由重分档——纯等确认→glance;方向题→direction;风险疑虑→judgment;security/breaking→caution;理由已不在现行 🔴 表(如仅因"是 feature")或其实有明确的活→按 needsReview 重审/转 `needs-fix`。换标后删旧标,**不再新打此标** |

> **awaiting-\* 四档的共同语义**:真·等人输入,agent 本轮 0 动作(直到新 commit 或人类新评论);区别只在**要人付出什么**——glance 是 10 秒确认,direction 是一个方向决定,judgment 是一次风险评估,caution 是一次制度性审查。**打标时按人的负担从轻到重就低不就高**;这一族都只放"等人",不放"有明确的活"(那是 `needs-fix`)。**人类新评论解锁的是「处理」,不是「合并」**(下一条)。

> **★ 修改要求 ≠ 合并批准(铁律)。** `awaiting-*` / 🔴 档 PR 上人类的新评论要**分两类读**:
> - **明确批准语**("LGTM" / "可以合" / "approve" / "merge it")→ 解锁合并(仍要过 Step 5 通用前置)。
> - **修改要求**(其余一切:改样式、补功能、换实现——哪怕修法完全明确)→ 只解锁「干活」:agent 在 PR 分支实现 → push → **贴证据(UI 面必附对新 HEAD 的 before/after 截图)** + 重跑 `pre-merge` → **置 `pr-sweep:awaiting-glance`(证据已备齐,人看一眼确认),comment 里@人请其确认**——**绝不因"要求已满足"自行合并**。人提修改要求 = 人在 review 这个 PR = 人要看到改后的样子再拍板(人提修改要求后 agent 未等确认就直接 merge)。
| `pr-sweep:blocked-deps` | 仅因**无关 dependent 包**在 `<default_branch>` 上红而被挡(PR 代码已核验) | **不重 review**;只跑 Step 5 廉价 gate 重查,绿了就合(不新发评论)。dependent 修好它自动落地 |

**修复轮次上限(Bounded repair,issue #1204,人类拍板:"自动修复的时候每次最多不超过3轮,也就是三轮依然不行,那么报告现状,请人类给出输入和方向"):**

`pr-sweep:needs-fix` 不是无界重试——`needs-fix` 状态下每次 full-review 起 agent 修复都算一轮,连续 3 轮仍不能跑绿(或跑绿但过不了合并闸)就必须停手升级给人,不许第 4 次重试烧 token。

- **计数载体**:轮次计数嵌在 verdict comment 里,与 `sweep-trace` 标记同段,不新开存储:`<!-- pr-sweep-attempt: N -->`(`N` = 本轮是第几次修复尝试)。起 agent 前先读最后一条 `🤖 AI Agent PR Review` 评论里的这个标记;没有该标记 = 这是第 1 轮修复(`N=1`)。
- **递增时机**:每次因 `needs-fix` 起 agent 修复并 push 新 commit,新 verdict comment 的 `N` = 上一条 `N + 1`。只读 verdict 重查(廉价 gate、无新代码改动)不计入轮次。
- **重置时机**:第 3 轮升级为 `pr-sweep:awaiting-direction` 之后,人类给出新方向的评论(不是简单"继续"式追问)视为新一轮修复的起点,`N` 从 1 重新计数——旧的 3 次是对旧方向的穷尽,不该沿用到新方向上。
- **第 3 轮仍不绿的升级动作**:改打 `pr-sweep:awaiting-direction`(现有非弃用档位里最贴合"agent 卡住、需要人给方向"的一档,不新造 label),verdict comment 需包含每轮尝试摘要,格式:
  ```
  ## 修复上限已达(3/3 轮),需要人类给方向
  - 第 1 轮(<sha>):尝试了 X,失败原因 Y
  - 第 2 轮(<sha>):尝试了 X',失败原因 Y'
  - 第 3 轮(<sha>):尝试了 X'',失败原因 Y''
  **agent 判断仍缺**:Z(需要人类决定/提供)
  ```
- **不适用**:因外部依赖(`pr-sweep:blocked-deps`)红而 BLOCK 的不计入轮次(那是等 dependent 修好,不是 agent 自己反复失败)。

**判定"需要重新 full review"(起 agent)—— 满足任一:**

1. 从没 review 过(无 agent 评论 —— 按下方谓词判,不是按某个字面前缀);或
2. **head commit 时间 > 最后一条 agent 评论时间**(代码改了 → 旧结论作废,重判);或
3. 最后一条 agent 评论**之后有人类评论**(新反馈 → 进 resolve 阶段);或
4. **最后一次 Draft → Ready 事件时间 > 最后一条 agent 评论时间**(#1831 盲区二:转 ready
   既不动 head 也不产生评论,纯时间戳/sha 比对永远看不见——作者标 ready 就是"请 review"信号)。

```bash
# 每个 PR:head commit vs 最后 agent 评论 vs 最后 human 评论 vs 最后 ready_for_review 事件
# ⚠️ 人类意见散在三个面:①会话 comment ②代码行 inline review comment(pulls/comments)
# ③review 总评(pulls/reviews)。只查 --json comments 会漏 ②③,人类 inline 修改要求会看不见。
# 必须三面并集:
head=$(gh pr view <n> --json commits --jq '.commits|last|.committedDate')
all=$( gh api repos/{owner}/{repo}/issues/<n>/comments --paginate --jq '.[]|{t:.created_at, body, bot:(.user.type=="Bot")}'
       gh api repos/{owner}/{repo}/pulls/<n>/comments  --paginate --jq '.[]|{t:.created_at, body, bot:(.user.type=="Bot")}'
       gh api repos/{owner}/{repo}/pulls/<n>/reviews   --paginate --jq '.[]|select(.body!="")|{t:.submitted_at, body, bot:(.user.type=="Bot")}' )
# 「是 agent 评论」= 带**机器标记**,human = 它的否定。判据不是 `🤖` 头:
# scripts/agent-identity.sh 给**人和 agent 生成同样的** `> 🤖 AI Agent @host·runner:…·skills@…` 头,
# 人手贴的评论逐字节相同 —— 按头判会把人类指令当成 agent 裁决跳过(实盘 arc#1722 跳了 19h)。
# 机器标记(可靠、人不会手写):① sweep-trace HTML 注释(本 skill 每条 verdict 强制附,见文末);
# ② `Generated by [Claude Code]` footer;③ 作者是 Bot(云端 runner 走 GitHub App → claude[bot])。
# 例外:presence board 的 `> 📡` 心跳脚本发的、不带 trace,靠首行 `📡` 认(否则每轮重刷 board)。
# 标记可能 HTML 转义(`&lt;!-- … --&gt;`,#1278),先 decode。老的无标记评论按人类处理(新规范)。
JQ='
  def dec: gsub("&lt;";"<") | gsub("&gt;";">");
  def firstline: .body | split("\n")
     | map(select((test("^[ \t\r]*$")|not) and (test("^[ \t]*<!--")|not))) | first // "";
  def isAgent: ((.body|dec) | test("<!--[ \t]*sweep-trace:"))
            or (.body | test("Generated by \\[Claude Code\\]"))
            or (.bot // false)
            or (firstline | test($pre));'
PRE='^[ \t]*(#{1,6}[ \t]*)?(>[ \t]*)?📡'
ai=$(jq -rs --arg pre "$PRE" "$JQ"'[.[]|select(isAgent)]    |max_by(.t)|.t // empty' <<<"$all")
hu=$(jq -rs --arg pre "$PRE" "$JQ"'[.[]|select(isAgent|not)]|max_by(.t)|.t // empty' <<<"$all")
# Draft→ready 也要触发重审(#1831 盲区二):PR 从 Draft 转 ready_for_review 后应重新 full-review。
rfr=$(gh api repos/{owner}/{repo}/issues/<n>/timeline --paginate \
      --jq '[.[]|select(.event=="ready_for_review")|.created_at]|max // empty')
# needsReview = ai 为空(从没 review 过)/ head > ai(新 commit)/ hu > ai(人类新意见)/ rfr > ai(Draft 转 ready)
if [[ -z "$ai" || "$head" > "$ai" || ( -n "$hu" && "$hu" > "$ai" ) || ( -n "$rfr" && "$rfr" > "$ai" ) ]]; then echo needsReview; fi
```
(reviews 里 body 为空的 COMMENTED 行是 inline comment 的壳,已被 ② 覆盖,故滤掉;
「响应人类意见」时 inline comment 要用 `pulls/<n>/comments` 的 `path`+`line` 定位到具体代码。
人机判据的 TS 参照实现(带回归测试):`issue-sweep/test/sweep-golden/lib.ts` 的
`isAiAgentComment` / `scripts/team-report.ts` 的 `isHumanComment`——改判据先改那两处 + 测试,再同步这里。)

> **★ sha 优先于时间戳(#1812 复盘):** 若最后一条 AI verdict 的 `sweep-trace` 带 `sha` 字段
> ([pr-review Step 0.6](../pr-review/SKILL.md)),直接比 `sha == headRefOid`——精确、跨 runner
> 可机器判重;上面的时间戳比对仅作旧格式(无 sha)时的回退。**但 sha 相等只短路判据 2(新
> commit),不短路判据 3/4**——人类新评论和 Draft 转 ready 都不动 head,sha 照样相等(#1831)。且 needsReview 成立时,fan out 的
> pr-review agent 按其 Step 0.6 做**增量复审 + canonical verdict 原地 upsert**——不从零重做、
> 不追加新 comment(#1812:三个 runner 各 full review 一轮、6 条评论堆叠、没有一条对当前 HEAD
> 有效的拍板块,就是缺这两条)。

**否则(已 review、无新 commit、无人类新评论):**
- `pr-sweep:awaiting-*`(四档任一)→ **本轮 0 动作**,直接跳过。
- `pr-sweep:blocked-deps` → 跳过 review,只做 Step 5 的廉价 gate 重查;满足闸就合(治本仍是修那个坏 dependent 包)。

**幂等收尾(每个 full-review 完的 PR):** 据结论**刷新** disposition label(终结=合/关、去 label;held=打对应 label),verdict comment 按 [pr-review Step 6](../pr-review/SKILL.md) 的 canonical upsert **原地更新**而非新发(marker `<!-- pr-review-verdict -->` 定位 + PATCH,跨 runner 也能刷同一条;`--edit-last` 只覆盖「上一条恰是自己发的」情形)。**绝不在「无新输入」时重发同一结论。** 缺这些 label 就建,只用这套受控词(`pr-sweep:needs-fix` / `pr-sweep:awaiting-glance` / `pr-sweep:awaiting-direction` / `pr-sweep:awaiting-judgment` / `pr-sweep:awaiting-caution` / `pr-sweep:blocked-deps`),别再造变体、**不再新打已弃用的 `pr-sweep:awaiting-human`**。

> **只有 Step 1.5 判定 needsReview 的 PR 才进 Step 2 聚类 + Step 3 review。** 其余只走"廉价 gate 重查 + 可合就合"。这把每轮的 agent 起数从「所有 open PR」压到「真正变了的 PR」,routine 长期稳定、不刷屏。

## Step 2 — 聚类(去重 + 冲突的基础)

**两把主键,先算簇,再 review——这样每个 review agent 能带着"它的 peer 是谁"上下文。**

1. **同 issue 簇**(去重关闭的主战场)。从 `headRefName` 抽 issue 号(`claude/<verb>-<N>-<slug>` → `<N>`),并从 body 抽 `Fixes #N` / `Part of #N`。**同一个 `<N>` 的多个开放 PR = 重复嫌疑簇。**
   ```bash
   gh pr list --state open --json number,headRefName,body --jq '
     .[] | {n:.number, br:.headRefName,
	     issue:(.headRefName|capture("-(?<i>[0-9]+)-")?.i
		    // (.body|capture("(?:Fixes|Part of) #(?<i>[0-9]+)")?.i))}' \
   | python3 -c "import json,sys,collections; \
       d=[json.loads(l) for l in sys.stdin]; \
       m=collections.defaultdict(list); [m[x['issue']].append(x['n']) for x in d if x['issue']]; \
       [print('issue #%s -> PRs %s'%(k,v)) for k,v in m.items() if len(v)>1]"
   ```
2. **同文件簇**(行级冲突 / 共享配置风险)。算 `file -> [PRs]` 倒排,>1 的即重叠。**排除噪音**:release-please 自动 PR 会触碰每个 `package.json` + `CHANGELOG.md`,这类全局重叠不算冲突,单独识别 release 簇。

把每个 PR 的 peer 列表喂给它的 review agent(Step 3)。

## Step 3 — 扇出 pr-review(clean context,每 PR 一个)

每个开放 PR 交给 [`pr-review`](../pr-review/SKILL.md) 引擎,**干净上下文、独立判断**,带上它的 peer 簇信息。返回**结构化 verdict**(5 类 + verification 结果 + 冲突结论 + 证据 + 问题件的 comment 草稿)。pr-review 每次都会跑 `pre-merge` verification 并把结果纳入 verdict(PR 上已无 CI)。

> **UI 改动的 PR:** pr-review 的 Step 3.5 会在 diff 命中 profile **UI Face Paths**时条件触发 [`ui-verify`](../../../../skills/ui-verify/SKILL.md)(截图 + 录屏贴回 PR)——**前提是本 routine 环境有跑着的 daemon**。无 daemon 的纯静态 sweep 环境会打 `ui-verify:pending` label + 注明,由带 daemon 的 routine 用下面的 pending 扫描步骤补跑(#1205)——不再只留一行注记就算数,label 让补跑成为确定性闭环而不是靠人翻 verdict 文本发现遗漏。

### Step 2.5 — `ui-verify:pending` 补跑扫描(仅本 routine 有 daemon 时)

**本 routine 环境有跑着的 daemon** 时,在正常 Step 3 review 扇出之前,先扫一遍这个确定性 label 队列,把无 daemon 环境欠下的 ui-verify 补上:

```bash
gh api "repos/{owner}/{repo}/issues?state=open&labels=ui-verify:pending&filter=all" \
  --jq '.[] | select(.pull_request != null) | .number'
```

对每个命中的 PR:HEAD 若在打 label 之后又有新 push(重新走 Step 1.5 fresh 判定),仍按新 HEAD 补跑;跑 `/ui-verify --pr <n>`,截图/录屏贴回 PR 后 `gh pr edit <n> --remove-label ui-verify:pending`。**本 routine 没有 daemon → 跳过本步(静默,不是 fail)**,这是"两路环境互补"的另一半:纯静态环境负责发现+标记,daemon 环境负责补跑+摘标。

- **Model:** per-PR review 是**有界任务**(读 1 个 diff + 关联 issue + 核验 + 跑 1 次 `pre-merge` + 可能 1 个测试)→ **Sonnet**。**跨 PR 综合(定簇胜负、判矛盾真伪、合并闸决策)用强模型(Opus)** 在主控做,别下放。成本差 ~5×。
- **并发/编排——按运行环境分两路(这条决定 routine 能不能无人值守):**
  - **无人值守(cron routine)→ 串行 inline review,绝不调 Workflow。** `Workflow` 工具需要**交互式 opt-in 确认**,且通常不在 routine 的 `allowed_tools` 里 → 它弹一个确认框,routine 里没人点 → **永久挂死**(实测:pr-sweep routine 整夜卡在"请允许 Workflow"上)。所以 routine 里**只用 allowed_tools 内、不弹确认的工具**(`Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep`/`Skill`),per-PR review 由本 session **逐个 inline 做**(读 diff + 核验 + 判 verdict)。**Step 1.5 轮次感知**已把每轮 PR 压到"真正变了的几个",串行完全够、还更省。
  - **交互式(人在场 / 显式 opt-in)→ 可用 Workflow 扇出**加速:`parallel(PRS.map(pr => () => agent(prReviewPrompt(pr), {model:'sonnet', schema: VERDICT_SCHEMA})))`,主控 Opus 综合,可 resume。
  - **铁律:任何无人值守运行,绝不调用会弹确认 / 等待用户 / 需 opt-in 的工具(Workflow、AskUserQuestion、EnterPlanMode,以及任何不在 `allowed_tools` 里的工具)——会卡死整条 routine。** 拿不准某工具会不会弹确认 → 当它会,改用 inline / `gh` / `Skill`。需要人拍板 → 问题(选项 + 推荐)作为 comment 挂 `needs-human-confirm` 落到对应 PR/issue,继续下一项。repo hook(`.claude/hooks/deny-interactive-unattended.py`)在无人值守 session 硬 deny 这三个工具兜底——被 deny 就按本条走,不要重试。
- review **read-only**:只分析、只产出 verdict + comment 草稿,**不发 comment、不合、不关**。所有 outward 写在 Step 4–5 统一做(限速可控、决策集中)。

## Step 4 — 去重关闭(dedup-close):同 issue 重复对,留一个、关其余

**这是 sweep 相对单 PR 引擎的核心增量,也是当前最高频的清理动作。** 一个同-issue 簇里有 ≥2 个开放 PR 时:

1. **选保留方(keeper):** 用 pr-review 的留谁判据——更完整 diff > 更正确(对照权威源)> 有测试 > 更新 base > 先到。综合用 Opus 拍板,带证据。
1.5. **second opinion（关错 PR 不可逆——作者会收到关闭通知，值得多花一轮验证；#1055 方向五 / #1208）:** 定 keeper 前,再扇出**一个独立全新 context** 的 agent（`Agent` 工具,`general-purpose`),给它同一簇 PR 的摘要(diff 概要 + 判据表,不带主 session 的结论),要求它按同一判据独立选 keeper,返回结构化结果 `{keep: <PR号>, reason: "<一句话>"}`(自然语言对比不可靠,见 #1208 评估——只比较 `keep` 的 PR 号,不比较 `reason` 措辞)。
   - **两个 `keep` 一致** → 按本判据继续走步骤 2-4。
   - **不一致** → **不去重关闭这一簇本轮**,在簇内每个 PR 上打 `pr-sweep:awaiting-direction`,comment 列出两个 agent 的选择 + 理由,等人拍板选哪个当 keeper。
   - **仅对 dedup-close 的 keeper 选择触发**——其余高风险决策(security 标红、verification gate 语义)按现行的保守路径处理,不加 second-opinion,不拖慢日常 sweep 速度(评估结论见 #1208:security 已是 comment-only 足够保守,verification gate 场景在 issue-sweep/pr-sweep 里不存在)。
2. **矛盾必查权威源:** 簇内两 PR **断言冲突**(如同一处 license,一个 `BUSL-1.1` 一个 `BSL-1.1`)→ 先查 repo 权威源(`LICENSE` / 既有 canonical 文档)定哪个对,**正确的那个才可能当 keeper**;若两个都错,两个都不合,comment 指正。
3. **关冗余方(twin):** 对每个非-keeper:
   ```bash
   gh pr comment <twin> --body-file <note.md>   # 说明:与 #<keeper> 重复(同 issue #N),保留 #<keeper> 因 <判据+证据>;本 PR 关闭
   gh pr close <twin> --comment "superseded by #<keeper>"   # 或先 comment 再 close
   ```
   comment 顶部带完整身份行（整行由 `<agent_identity_script> --header "PR Review"` 生成，不能用日期、占位符或手拼代替；行尾追加 ` — Claude Code(<model>)。…`）。
   正文一句话定责 + 指向 keeper。
4. **keeper 上留一条**:注明"已关闭重复 #twin,本 PR 为保留方",便于人追溯。

> **关闭是可逆的**(可 reopen),且这里有明确证据 + 双向回链 → 属"自动做"。但**别误关**:只有坐实"同 issue、同改动面、确为冗余/被取代"才关;拿不准就两个都留 `COMMENT`,把冲突摆出来等人。**簇内任一 PR 带 `agent:hold`(人类保留)→ 不参与去重关闭**(hold 冻结终态动作,close 属终态:它既不被当 twin 关掉,也不被拿来当 keeper 去关别人——它自己的去留人还没拍板;冲突事实照常写进 verdict comment 供人参考)。

## Step 5 — 合并闸(`--merge` 时):分风险档自动合,高风险升级给人

**门控 = profile `gate_mode`(arc = `scripts`:PR 上无 CI,`pre-merge` 脚本即门控;`ci`/`both` 叠加 `gh pr checks` 绿),也不无脑合。** 每个 `MERGE`/`COMMENT`-可合 verdict 过这道闸:

**通用前置(全档都要):**
- **★ Verification 闸(强约束,真正的 merge 门控,不可跳过)**:merge 前运行 `<merge_gate_entry>`
  确认 PR comment 的 sha 与当前 PR HEAD 匹配且
  result=PASS 或 result=NA:
  ```bash
  <merge_gate_entry> <pr#>
  ```
  exit 0 → 可合;exit 1 → 打印原因,止步:没有 comment / SHA 过期(push 后未重验)/ result=FAIL。
  没有时先跑 `<pre_merge_entry> --comment <pr#>`贴报告;
  简单错误自己修后重跑;复杂错误把失败诊断 + 完整日志贴 comment 升级给人。
  **这是取代 CI 的合并门控**——pr-review 只判定不 merge,故门控落在这里。
  **`<merge_gate_entry>` 还会要求 profile `additional_merge_gates` 列出的每道门都通过**——当
  diff 命中**可起的后端面**时还要求 e2e-gate sticky
  comment(SHA==HEAD 且 PASS/NA);它自己跑 `scope.ts` 独立判后端命中,纯文档/UI/前端/测试 PR
  自动记 e2e-gate=N/A、不阻挡。exit 1 的新增原因:后端面命中却无 e2e-gate comment / e2e-gate
  result=FAIL / e2e-gate SHA 过期。`additional_merge_gates` 为空的仓库没有这层,只看 verification 闸。且
- **PR 不带 `agent:hold`**(人类保留;hold 期间 review/响应照常但**合并一律冻结**——这里是合并前的硬闸,带 hold 一律不合,即使风险档是 🟢、即使 verdict 是 MERGE。verdict 写成 `MERGE (held)` 等人摘 label);且
- **★ UI 证据闸(与 pre-merge 同级的 SHA 匹配硬门)**:diff 命中 profile **UI Face Paths** →
  merge 前必须有 **对当前 PR HEAD** 的 ui-shot / ui-verify 截图证据(PR 里已内嵌且截图之后无新 push)。
  **任何 push——包括 agent 自己的 fix commit——都使既有截图作废**,重拍再合;**无法截图的环境**（注：renderer/widget 级改动走 ui-shot 无需 daemon，仅页面级 /ui-verify 才需要 daemon——"无 daemon"≠"无法截图"，不得以"无 daemon"为由跳过 renderer 截图）→ 不合,留给带 daemon 的 routine 或人。静态 `pre-merge` 看不见"popup
  长什么样",这道闸补的就是这只眼;且
- **★ 后端数据面闸(与 UI 证据闸对称,由 `<merge_gate_entry>` 焊死)**:diff 命中 profile
  **Backend Face Paths**
  → merge 前必须有 **对当前 PR HEAD** 的 [`e2e-gate`](../../../../skills/e2e-gate/SKILL.md) sticky
  comment(PASS/NA,SHA==HEAD)。由 `<merge_gate_entry>` 自动强制(它跑 `scope.ts` 判命中,不靠
  自觉)——**任何 push 都使既有 e2e-gate comment 作废,重跑再合**。缺 comment 时先跑
  [`/e2e-gate --pr <n>`](../../../../skills/e2e-gate/SKILL.md)(diff 命中的 blocklet 起服务跑
  Tier A+C smoke,贴回 PR);daemon 起不来的纯静态环境 → 不合,留给带 daemon 的 routine 补跑。
  这道闸补的是「静态全绿、一跑就 500」这只眼;且
  → agent 响应修改之后**不得自行合**,必须贴证据 + 等到人类**明确批准语**;且
- pr-review verdict ∈ {`MERGE`, 或 `COMMENT` 且关注点非阻断};且
- 声明已核实(Step 3 的逐条核验通过);且
- `mergeable == MERGEABLE`(非 `CONFLICTING`;冲突的先 rebase 或留给人);且
- 无未解的同-issue/同-文件冲突(Step 4 已收敛)。

(PR 上已无 CI status check;上面的 `pre-merge` PASS 就是唯一门控。失败根因为 (b)flaky/(d)噪音时按 pr-review Step 3 的判读处理——不阻断、可自修;(a)本 PR 缺陷一律不合。)

**风险档(决定自动还是升级)——方针:默认放行,出问题再收紧:**

> 积极开发阶段、无外部用户——**「是 feature」本身不是风险,「等人」才是成本**(升级给人的 feat
> PR 绝大多数被人零反馈直接合)。把全绿全核验的 PR 推给人 rubber-stamp
> 是把责任推卸给人,不是谨慎。判风险看**改动内容**(security 面?breaking?方向未定?),不看
> commit type 前缀、不看 diff 大小。

| 档 | PR 类型 | `--merge` 行为 |
|---|---|---|
| 🟢 低风险 | docs-drift、test-only、注释/类型/lint 修、依赖已在仓的 polyfill、release-please PR(keeper) | **自动 squash-merge** |
| 🟡 中风险 | 核心代码 bug fix(有测试)、行为变更、**非 breaking 的 feature**(含向后兼容的协议加法:新 action / 新可选字段 / 新枚举项+配套消费端)、跨平台 parity 补齐、大 diff 但语义为加法 | 默认**自动合**(前提:通用前置全过——`pre-merge` 绿 + 声明核验 + UI 证据闸 + 新行为有真测试);verdict 有任何保留(部分修复 / 缺测试 / parity 缺口 / 无 caller 疑点)→ 降级为 comment 等人 |
| 🔴 高风险 | **security 面**(认证/授权/支付/exec-gate/密钥/沙箱边界)、**breaking change**(判据见下)、**改架构方向 / 设计 A/B 未定 / 人明确表达过异议**、改 verification 门控语义(安全闸) | **永不自动合**;升级给人——security/breaking/门控语义 → `pr-sweep:awaiting-caution`,方向未定/人已异议 → `pr-sweep:awaiting-direction`;verdict **必带 pr-review「需人确认块」**(要你判什么 + 怎么验 + 推荐;security 逐条列安全属性 path:line + 验证命令) |

**升级前硬前置(issue #1860,同 [`pr-review` Step 5.5](../pr-review/SKILL.md) / [`issue-review` Step 5.5](../issue-review/SKILL.md)):** 判 🔴 之前先问「我能不能说出一个安全默认动作?」——能 → 不判 🔴,当场按 ratchet 执行该默认动作并留 trace;不能,才是真判断题,才配升级给人。

**breaking change 判据(命中任一才算;monorepo 内部同 PR 已修完的 rename/重构不算——
types/tests 绿就是证据):**
- 不兼容的协议/wire 变更:已部署客户端(Swift/Kotlin native、已发 blocklet)会因此断连或误解报文;
- schema 变更无迁移路径(D1/SQLite 已有数据会丢或错读——参照 d1-table-naming 的迁移纪律);
- 删除或语义翻转仍被 repo 外消费的公开 API/CLI 行为;
- 数据破坏性操作(删表、清数据、不可逆迁移)。
纯加法(新 provider、新 action、新可选字段、新页面、新 renderer)**不是** breaking。

> **★ 风险档在每次合并尝试前重算,对所有路径生效。** 不是首轮 review 定一次就完——
> `needs-fix` 续修跑绿后、`blocked-deps` 廉价重查后、响应人类修改要求 push 后,**合并前都要
> 重过这张表**。🔴 档(security/breaking/方向未定)**任何路径都不自动合**:即使人给过明确修复
> 路线、即使修完全绿——"跑绿 → 合"只对 🟢/🟡 成立,🔴 的终点永远是"跑绿 → 贴证据 → 等人批准"。
> 另注意,与档位无关、独立生效:人类发过修改要求的 PR,不论档位,响应后必须等
> 明确批准语(人类反馈重批准闸)。

> **★ 尺度演进(ratchet,唯一合法的收紧途径):** auto-merge 后被 revert / 造成真实事故的
> pattern → 把该 pattern **追加进 🔴 表并附 case 链接**(一次事故一条,精确到 pattern,不是
> 把整类 feature 打回 🔴)。反方向:某类 PR 反复被人零反馈 rubber-stamp → 是把它移出 🔴 的
> 信号。宁可从宽起步、按证据收紧;"拿不准就升级"不需要改表,但 verdict 里要写清拿不准的
> 具体是什么(而不是"是 feature 所以升级")。

```bash
gh pr merge <n> --squash --delete-branch    # 低风险闸通过
```

### 举手之劳自己修,不写"行动建议"甩给人(pr-sweep 的核心纪律)

**一个 PR 离合并只差『机械操作』时,agent 自己做完并合,绝不输出一份"请你照着做"的清单。** 这是 issue-sweep "可做即做" 在 PR 侧的对偶——**写"行动建议: 删个空格、rebase、re-trigger、然后就能合"然后甩给人 = bug**。这些都是 agent 自己能做的:

| 机械阻塞 | agent 自己做 |
|---|---|
| 格式/空格/lint 噪音(profile `formatter` 报的) | 在 **PR 分支**上 `<formatter>`/ 删空格 → commit → `git push`(push 到对方分支需有权限;无权限才升级) |
| base 落后 / `BLOCKED-behind` | `gh pr update-branch <n> --rebase`,然后重跑 `pre-merge` |
| verification 过期(push 后未重验) | 重跑 `<pre_merge_entry> --comment <n>` → `<merge_gate_entry> <n>` 过闸 |
| review **已明确指出**的一处小确定性改动(补一行、改个 id、删冗余) | 直接在 PR 分支补上 |

**做完这些机械修复后,PR 通常就过闸了 → 直接合。** 只有当机械修复后仍剩**真实判断/逻辑/设计/安全**问题时,才升级给人。判据:**"我现在能不能用 gh/git/编辑器把它推到可合?" 能 → 做;不能(要改逻辑、要拍设计、要人授权) → 才 `pr-sweep:awaiting-*`(按四档就低不就高)+ comment。**(verdict 已判定可机械推进却仍甩给人)

**自主梯度(autonomy ladder),与 issue-review 同源、按后果可逆性划:**
- **自动做**:发/改 comment、调 label、**去重关闭冗余 PR**、rebase / update-branch、**格式/空格/lint 自修 + push 到 PR 分支**、补 review 已点名的小确定性 diff、重跑 `pre-merge` verification、🟢/🟡 档合并。
- **升级给人(`pr-sweep:awaiting-*`,按人的负担选档:纯确认→glance / 方向→direction / 风险评估→judgment / security·breaking·门控→caution)**:🔴 档合并、真实逻辑/设计/安全缺陷、关一个**非重复**的活 PR、改 verification 门控/脚本这类安全闸、A-vs-B 没定的方向。升级时**把来源 issue 的 author + assignees 设为该 PR 的 reviewer**(继承规则见 [`issue-sweep` Step 4](../issue-sweep/SKILL.md);已是 assignee 的补 reviewer 即可,指派失败跳过不 block)——升级要落到对的人的 review 队列里,不是发一条没人认领的 comment。**——只有机械修完仍卡的才升级。升级的 comment 必带 pr-review「需人确认块」**(要你判什么 + agent 已核验什么免重做 + 怎么验:可还原成命令就给命令+path:line+预期、security 逐条列,判断题给选项+判据+推荐,绝不造假命令 + 定了之后各分支解锁动作)。**不许停在"请人工确认"。**
- **铁律**:**绝不 force-merge 越过未解冲突**;🔴 档绝不自动合;关 PR 必带证据 + 回链。**绝不把『自己举手之劳能做的』写成行动建议交给人。**

### PR 即工作单元:pr-sweep 负责把 PR 推到终态(含修被拒的 PR),不回弹给 issue

**一个 PR 一旦存在,活就在 PR 上**——分支、diff、verification、review 线程都在这里。被 pr-sweep 拒了(BLOCK)之后,**继续修复的责任在 pr-sweep,不回弹到 issue-review**。回弹是有害的间接层:丢上下文(分支/验证/线程)、所有权两头不靠、且会撞 AI→AI 冻结(下条)。issue-sweep/issue-review **创建** PR,pr-sweep **把它开到终态**(修好合 / 或升级一个真实决定)。**BLOCK 的三种货色:**

| BLOCK 类型 | 处置 | label |
|---|---|---|
| 机械(空格/format/rebase/re-trigger) | agent 当场修 + 合(上节) | — |
| **路径已明确的实质缺陷**:review 或**人**已给出确切修复路线(如某 reviewer 确认「改继承 `BaseMessageProvider` + 补 conformance fixture」) | **agent 在 PR 分支上实现这条已确认路线** → 跑绿 → **重过 Step 5 合并闸**(风险档重算 + UI 证据闸 + 人类反馈重批准闸):🟢/🟡 且无人类未批准的修改要求 → 合;🔴 或修复路线来自人类修改要求 → 贴证据(UI 面附新 HEAD 截图)等人批准。**"实现"不待人,"合并"按闸走** | `pr-sweep:needs-fix`(agent 拥有、下一轮续做,**非 awaiting-\***) |
| **真·待人决定**:无人定过的设计 A/B、安全、不可逆、"我不同意这个做法" | 升级,带 pr-review「需人确认块」(要你判什么 + 已核验什么 + 怎么验/判据 + 推荐 + 各分支解锁动作) | `pr-sweep:awaiting-direction`(方向) / `pr-sweep:awaiting-caution`(安全·不可逆) |

`pr-sweep:needs-fix` ≠ `pr-sweep:awaiting-*`:前者「有明确的活要 agent 干」,后者「等一个人类**输入**」——且四档写明了等的是哪种输入(确认/方向/风险评估/审慎批准)。

### 触发器看状态,不看"最后一条谁评的"(解开 AI→AI 冻结)

**根因**:用"最后一条评论是不是人类发的?"当"该不该动手"的总开关 → AI 把活交给 AI 时,看起来像"已处理、在等人",于是冻死。**这正是『comment 回 issue 让下一轮 issue-review 接』会卡的原因**:那条是 AI comment,issue-review 以为没人干预。

**解法:交接靠显式状态(label/checkbox),不靠评论者身份。** 一次交接 = **置一个状态**(`needs-fix` / `in-progress` / `needs-human`);接手方**按状态触发**,不问"刚才谁说的话"。"人类回复了"只是 `awaiting-*`(真等人输入)那一族的解锁信号,**不是所有活的总闸**。推论:**别把活回弹到 issue 来换 agent 接力**——同一个 PR 上 pr-sweep 自己置 `needs-fix` → 下一轮自己接着修,全程在 PR 上、零跨技能跳转、零冻结。这就是"全部由 PR 处理的 agent 执行,本无本质区别"的正解:**收口在 pr-sweep,PR 是工作单元,issue 只是 provenance。**

## Step 6 — verification 门控自愈(门控坏了就修门控,不让每个 PR 陪绑)

arc `gate_mode=scripts`:PR 上无 CI,`pre-merge` 脚本是唯一门控(`ci`/`both` repo 叠加 `gh pr checks`)
(`.claude/verify/`)。review 中若发现门控因**可修的脚本/基础设施**
反复误报(非某个 PR 的错,而是某个 `check-*` 过严/某测试 flaky/某依赖没编译):
- **不要**让每个 PR 手动绕 / 一直挂红。
- **诊断根因**(`check-*.ts` 的判定逻辑 / 某个 flaky 测试 / 缺原生依赖 build),开一个独立
  **verification-fix PR**(走本 sweep 的低风险闸),把"门控该不该这么严/这么脆"当可独立修的工程问题。
- 例:某测试因 WASM 重编译 flaky → 修测试或调超时;`format` 噪音 → 已是 warn-only(`check-format.ts`)。
- 改门控判定语义(哪个检查算 blocking)= 安全闸 → 属 🔴/需人确认那一类,**开 PR + 升级**,不自己合。
  升级 comment 带「需人确认块」:要人确认的那条门控改动 + 怎么验(前后 `pre-merge` 输出对比)+ 推荐。

## 限速 / 编排 / 幂等(批量必守)

1. **GitHub「内容创建」硬约束**:≤500/h、≤80/min。每 PR 最多 1 条 verdict comment;去重关闭每 twin 1 条 + 1 close;`gh` 遇 403 secondary limit → 退避重试(≤3)、仍失败标 `RATE-LIMITED` 不整批报错(可 resume 补)。
2. **并发**:~10–14 × 每 agent ~2–3min ≈ ~250–300 POST/h,稳在限速下。别盲目拉高触发 80/min burst。
3. **幂等**:重复跑 sweep 不应重复评论/重复关。发 comment 前看 PR 上是否已有本轮 agent 评论(同上谓词;同结论就 `--edit-last` 不新发);已关的跳过;已合的从候选移除。
4. **Resumable**:**仅交互式**用 Workflow 编排可续(`resumeFromRunId`)。**无人值守 routine 不用 Workflow**(见 Step 3 铁律)——靠幂等(第 3 条)实现"可续":挂了/限速了,下一轮 cron 凭 disposition label + 既有 verdict comment 自然接着干,不重复、不挂死。

## 源头治理:别再产生重复 PR(指回 issue-sweep)

去重关闭是**治标**。**治本**在 PR 的产生方——多台机器跑 [`issue-sweep`](../issue-sweep/SKILL.md) 对同一 issue 各开一个 PR(branch `claude/<verb>-<N>-<slug>`,issue 号同、slug 不同 → 不碰撞 → 双开)。源头修法(已写进 issue-sweep "Step 4 — Discipline" 的防重复条):

- **确定性分支名**:`claude/issue-<N>`(或 `claude/issue-<N>-p<phase>`),**不要**模型自创的 verb/slug → 两台机器算出同名分支,第二个 push/`gh pr create` 自然碰撞。
- **创建前认领检查**:开 PR 前 `gh pr list --search` 查是否已有开放 PR 指向 #N,有则 SKIP。

sweep 每轮可顺手核对:新出现的重复簇若仍来自非确定性分支名 → 说明某台机器的 issue-sweep 还没更新到确定性命名,在汇总里标一句。

## 实战经验(本仓首次运行沉淀,autonomous 机器必读)

见本 repo 的 case-law 附录(arc:`.claude/case-law/pr-sweep/first-run-lessons.md`;新 repo 自建)——第一次跑
`pr-sweep` 时踩出的 7 条坑:review 数据易过期、verification 失败要逐层剥(格式→flaky
测试)、门控失败的修法可能已躺在别的 PR 里、大 pull 后 dist 陈旧导致 `check-types` 假红、
无 CI required check(合并门控是 `pre-merge` PASS,不是 `gh pr checks`)、rebase 后 base
还会动、门控只跑 affected 不跑全量。

## Key Principles

1. **每 PR 干净上下文独立判断,主控集中决策。** Sonnet 扇出 review,Opus 综合定簇胜负 + 合并闸。
2. **verification 门控是信号不是判官(PR 上已无 CI)。** 失败诊断根因,只对 (a)本 PR 缺陷阻断;噪音/flaky 不挡合并;门控本身坏了/过严去修脚本(Step 6)。
3. **去重:留一个、关其余,带判据 + 回链。** 矛盾对必查权威源;拿不准两个都留等人。
4. **合并分风险档,且档位在每次合并尝试前重算——所有路径无豁免。** 🟢🟡 自动(含**非 breaking 的 feature**——"是 feature"不是升级理由,判风险看改动内容:security/breaking/方向未定才 🔴)、🔴 升级(任何路径都不自动合,含 needs-fix 跑绿后);出过事故的 pattern 按「尺度演进 ratchet」逐条追加进 🔴,不整类回退;UI 面 PR 必须有对当前 HEAD 的截图证据(push 即作废);**人类的修改要求 ≠ 合并批准**——响应之后贴证据置 `awaiting-glance` 等明确批准语;绝不 force-merge 越过冲突;关闭可逆但只关坐实的冗余。
   **升级给人(🔴/security/`awaiting-direction|caution`)的 comment 必带 pr-review「需人确认块」**:要你判什么 + agent 已核验什么(免重做)+ 怎么验(可还原成命令就给可照跑步骤+path:line+预期,security 逐条列安全属性;判断题给选项+判据+推荐,绝不造假命令)+ 各分支解锁动作。**不许停在"请人工确认"**。
5. **产物落 PR + git history,不落会话。** 一轮 sweep = 若干 PR 进入终态 + 可追溯的 verdict/close/merge 记录。
6. **治本在源头。** 去重是治标;确定性分支 + 认领检查(issue-sweep)才根除重复。
7. **轮次感知:无新输入不重做(定时 routine 必守)。** 已 review 且无新 commit、无人类新评论的 PR
   默认跳过;只对真正变了的 PR 起 agent,只对外部阻塞已解除的 PR 廉价重查并合。`pr-sweep:awaiting-*`(四档)
   / `pr-sweep:blocked-deps` 等 disposition label 承载跨轮状态。**绝不重发同一结论 comment**(见 Step 1.5)。
8. **`agent:hold` = 终态冻结,不是处理冻结。** 人给 PR 打 `agent:hold` 表示"没我反馈别合/别关",
   不是"别理它":hold 期间 merge/close/摘 label 绝对禁止(Step 5 合并闸硬拦,即使 🟢 档;Step 4 去重
   不拿它当 twin/keeper),但**人类新评论/新 commit 照常触发 review + 响应**——尤其人类在 hold PR 上
   留的修改要求,是最高优先级输入,必须接(回 comment、按明确要求在 PR 分支修、push 后重验,verdict 标
   `held`)。只人加只人摘,agent 永不自动摘。与 issue 侧同名同义
   ([`issue-review` ★并发锁](../issue-review/SKILL.md));PR 侧**不**引入 `agent:processing`(并发去重靠
   确定性分支 + 认领检查 + disposition label)。

## ★ sweep-trace 埋点（L2 可观测层）

每条本 skill 发出的 AI comment 末尾**必须**附一行 sweep-trace HTML 注释（人不可见、grep 可查、L1 eval 复用为 golden baseline 数据来源）：

```html
<!-- sweep-trace: {"ver":1,"pr":N,"gate":"<gate>","val":"<val>","sha":"<head-oid>","run":"<ISO8601>"} -->
```

字段：
- `ver`：schema 版本，当前 `1`
- `pr`：对应 PR 编号（数字）
- `gate`：决策闸门名称，取受控词表：`needsReview` / `disposition`
- `sha`：本判定针对的 PR HEAD（40 位 commit oid）——跨 runner 新鲜度判定的机器键（Step 1.5 sha 优先规则；旧 trace 无此字段视为 stale）
- `val`：决策值，取对应受控词表：
  - `needsReview` gate：`true` / `false`
  - `disposition` gate：`pr-sweep:needs-fix` / `pr-sweep:awaiting-glance` / `pr-sweep:awaiting-direction` / `pr-sweep:awaiting-judgment` / `pr-sweep:awaiting-caution` / `pr-sweep:blocked-deps` / `merged` / `closed`（`pr-sweep:awaiting-human` 仅历史 trace 中存在,已弃用）
- `run`：UTC 时间，`new Date().toISOString()` 格式

**trace 只附在本 skill 实际发出的 verdict comment 末尾；dry-run 模式不发 comment，不附 trace。**
