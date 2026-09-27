# pr-sweep — Step 5 merge gate, risk tiers and self-fix discipline (full text)

> On-demand reference for [`pr-sweep`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## Step 5 — 合并闸(`--merge` 时):分风险档自动合,高风险升级给人

**门控 = profile `gate_mode`(arc = `scripts`:PR 上无 CI,同 SHA 的 verification 报告 + `<merge_gate_entry>` 即门控;`ci`/`both` 叠加 `gh pr checks` 绿),也不无脑合。** 每个 `MERGE`/`COMMENT`-可合 verdict 过这道闸:

**通用前置(全档都要):**
- **★ Verification 闸(强约束,真正的 merge 门控,不可跳过)**:每一次 merge 尝试都运行
  `<merge_gate_entry>`,它**读** PR 上 `<verification_entry> --comment` 贴出的同 SHA 报告——
  sticky 的 sha 必须等于当前 PR HEAD 且 result=PASS 或 result=NA。**不需要另跑 `pre-merge`**,
  main 前进了也不需要:合并时刻两边改动叠在一个文件里的风险由 merge gate 的 **merge-load** 门对着
  main **当前** tip 判。
  ```bash
  # --cs-head is the 40-char PR/CS head, must be current HEAD.
  <merge_gate_entry> --cs-head <40-char-sha> <pr#>
  ```
  **只在合并这一步、紧接着 `merge-verified-pr.sh` 之前跑**(本轮其余闸都过了之后,同一台机器、同一个 head)。
  它不是只读的:exit 0 会写判决记录,`merge-verified-pr.sh` 把它当合并授权。Step 3 的 per-PR review
  只读同 SHA 的 verification sticky 与 `bot-clean.ts`,**不跑** `<merge_gate_entry>`。
  exit 0 → 可合;exit 1 → 打印原因并止步:没有 comment / SHA 过期(push 后未重验)/ result=FAIL /
  merge-load 红。`verification fact is not current` 时照它打印的 hint 跑
  `<verification_entry> --comment <pr#>`(sweep 是这个 PR 的推进者,占一个闸位),再重跑 merge gate。
  **绝不**为了「刷新」去跑 `<pre_merge_entry> --comment`:它贴在同一个 marker 下,一次 FAIL 会覆盖有效的
  PASS。简单错误自己修后重走;复杂错误把失败诊断 + 完整日志贴 comment 升级给人。
  **这是取代 CI 的合并门控**——pr-review 只判定不 merge,故门控落在这里。
  **`<merge_gate_entry>` 还会要求 profile `additional_merge_gates` 列出的每道门都通过**——arc 为 `[]`:
  e2e-gate / ui-verify / native-verify 在 arc 是 **advisory**(`⚠ advisory <gate>=<status>` 行,不影响退出码,
  L1 main 捕网负责),读一眼、写进 verdict,**不挡合并、不为它们重跑**。字段非空的仓库才多一层 sticky 要求。且
- **★ Review 闸(与 verification 闸同级,独立于 `mergeable_state` 的判读)**:
  merge 前**独立重新**取一次 `pulls/<n>/reviews`(或 MCP `pull_request_read(method="get_reviews")`),
  按 reviewer 取每人**最新一条** review 的 `state`。**只认人类 reviewer**(`user.type != "Bot"`;
  排除 `chatgpt-codex-connector[bot]` 等 bot-review connector——它们走下方「Codex / bot-review
  检查」条款 + [`codex-review-backlog`](../../codex-review-backlog/SKILL.md),**不是**这道人类
  `CHANGES_REQUESTED` 硬闸)。任一**人类** reviewer 的最新 state 为
  `CHANGES_REQUESTED` 且未被同一人后续的 `APPROVED` 覆盖 → **硬止,不自动合**——即使 Step 3
  verification 全绿、无论 GitHub 的 `mergeable_state` 显示什么(该字段不透明,不能拿它反推
  有没有 `CHANGES_REQUESTED`,也不能反过来假设它没报异常就等于没有,只认这次独立 fetch 的结果)。
  命中时按标准升级路径处理(comment 里贴出该 review 的 `state`+`body`,通常打
  `pr-sweep:awaiting-direction`:reviewer 提出的是要不要按其要求改范围的方向问题,不是可以
  自决的机械修复)。**这道闸独立于 Step 0/pr-review 是否已查过三面**——两处都要有,任一处漏了
  另一处仍能拦住,不互相依赖。且
- **★ Codex / bot-review 检查(合并前一次,不挂起):** 契约与
  [`epic-conductor` §6](../../epic-conductor/SKILL.md) **同一份**(Codex **和** Cursor Bugbot,
  以及任何 inline connector)。本 org 的 bot 在 open/ready/push 后通常数分钟内给 inline findings,
  或只留一个 **👍** 表示无意见。规则:
  - **合并前跑一次** pr-review 的 `bot-clean.ts`(Step 0.4 的判据脚本),不在每次 push 之后等 bot。
    仅当最后一次推送不到 10 分钟**且**脚本报 vendor `running` / `incomplete` / `stale`(👍 还指着旧 commit——修复刚推上去时的常态)/ `absent`(新 PR 还没出声)时,短等一次(≤10min)再判。
  - **👍 / 无 inline finding** → 不挡 merge(不算人类 review 闸)。
  - **有 P1 / High inline finding 且 agent 尚未 fix 或 in-thread REJECT-reply** → 当可执行活:打/保持
    `pr-sweep:needs-fix`,在 PR 分支修(和同轮其他意见攒成一批、一次推送、跑一次
    `<verification_entry> --comment <pr#>`)或 **in-thread** 回绝;
    **不要**因"等 bot 再评一次"挂数小时。新 top-level comment 不算 addressed。
  - **全量 actionable thread 回执:** 每条要求改动、澄清或取舍的 inline review（人或 bot，任意 severity）
    都须在**同一 thread** 留下结论，才可 merge：fix 回复当前完整 SHA、改动和验证；REJECT 回复理由；仅
    P2/Medium/Low 可 defer 并给 tracking issue / owner / 重新处理条件。P1/High 只能 fixed 或 REJECT，不能
    defer 后合入。P2/Medium/Low 可以不作为风险阻断，但缺回执仍须保持
    `pr-sweep:needs-fix`，不得把顶层 verdict、verification sticky 或「已 push」当作已回应。每次 merge
    前枚举当前所有 actionable thread；时间戳仅用于增量抓取，任何早于某次 fix/reply 但仍无结论的 thread
    依然未处理，不能被之后回复别的 thread 的 commit 掩盖。只改措辞/注释的非 P1/High 意见:线程里回复,
    随下一次实质修复带上,不为它单独重跑闸。
  - **合入后才到的 late Codex** → 不回滚本轮 merge 决策;交给
    [`codex-review-backlog`](../../codex-review-backlog/SKILL.md)。
  - 与 [`epic-conductor` §6](../../epic-conductor/SKILL.md) 同契约(epic PR 由 conductor 执行;
    本 skill 对非 `epic-managed` PR 执行同一语义)。且
- **PR 不带 `agent:hold`**(人类保留;hold 期间 review/响应照常但**合并一律冻结**——这里是合并前的硬闸,带 hold 一律不合,即使风险档是 🟢、即使 verdict 是 MERGE。verdict 写成 `MERGE (held)` 等人摘 label);且
- **UI 证据(arc:advisory,不是合并闸)**:diff 命中 profile **UI Face Paths** → PR body 应有作者在
  最终 HEAD 上拍的运行截图(`<ui_shot_script>` / `ui-verify` 产出;renderer/widget 级走 `<ui_shot_script>`,
  无需 daemon)。缺图 = verdict 里一条 `COMMENT` 级关注点,不挡合并;merge gate 的 ui-verify 门自 #7025 起
  advisory(`⚠ advisory ui-verify=<status>`),L1 main 捕网的 `uiShotSmoke` 负责。只有 profile 把 `ui-verify`
  列进 `additional_merge_gates` 的仓库,它才是 `<merge_gate_entry>` 强制的 sticky 闸(当前 SHA 无证据 / 过期 /
  `BLOCKED` 一律拒;daemon 不可用打 `ui-verify:pending`)。上传失败时的确定性兜底见
  [`ui-verify` SKILL 的 Step 3](../../../../../skills/ui-verify/SKILL.md);且
- **后端数据面(arc:advisory,不是合并闸)**:diff 命中 profile **Backend Face Paths** → arc 上
  e2e-gate 是 advisory(`⚠ advisory e2e-gate=<status>`),后端 smoke 由 L1 捕网的 `e2eFleet` 负责,**不为它
  逐 PR 起服务、不为它重跑**。profile 把 e2e-gate 列进 `additional_merge_gates` 的仓库才要求对当前 HEAD 的
  sticky(PASS/NA)。且
- **人类反馈重批准闸**:人类发过修改要求的 PR,agent 响应修改之后**不得自行合**,必须贴证据 + 等到人类
  **明确批准语**;且
- pr-review verdict ∈ {`MERGE`, 或 `COMMENT` 且关注点非阻断};且
- 声明已核实(Step 3 的逐条核验通过);且
- `mergeable == MERGEABLE`(非 `CONFLICTING`;**只有冲突、或分支上的红在 main 上已修复时才 rebase**,只是落后 main 不 rebase——merge-load 门兜底);且
- 无未解的同-issue/同-文件冲突(Step 4 已收敛)。

(PR 上已无 CI status check;上面的同 SHA verification PASS + merge-load 就是门控。任何 FAIL 都挡合并:(a)本 PR 缺陷一律不合;(d)噪音可自修后重跑一次;(b)不是本 PR 造成的红只有两条路——二分根治,或带 witness issue 跑 `<verification_entry> --comment <pr#> --blocked-by <open issue#>` 由闸自己判定。**不盲目重跑、不调超时洗绿**;唯一例外是 `TIMEOUT` 且 `failed=0` 时用只增的超时旋钮重跑一次并写明取值。)

**风险档(决定自动还是升级)——方针:默认放行,出问题再收紧:**

> 积极开发阶段、无外部用户——**「是 feature」本身不是风险,「等人」才是成本**(升级给人的 feat
> PR 绝大多数被人零反馈直接合)。把全绿全核验的 PR 推给人 rubber-stamp
> 是把责任推卸给人,不是谨慎。判风险看**改动内容**(security 面?breaking?方向未定?),不看
> commit type 前缀、不看 diff 大小。

| 档 | PR 类型 | `--merge` 行为 |
|---|---|---|
| 🟢 低风险 | docs-drift、test-only、注释/类型/lint 修、依赖已在仓的 polyfill、release-please PR(keeper) | **自动 squash-merge** |
| 🟡 中风险 | 核心代码 bug fix(有测试)、行为变更、**非 breaking 的 feature**(含向后兼容的协议加法:新 action / 新可选字段 / 新枚举项+配套消费端)、跨平台 parity 补齐、大 diff 但语义为加法 | 默认**自动合**(前提:通用前置全过——同 SHA verification 绿 + merge gate 过 + 声明核验 + 新行为有真测试(UI 面 PR 带作者截图));verdict 有任何保留(部分修复 / 缺测试 / parity 缺口 / 无 caller 疑点)→ 降级为 comment 等人 |
| 🔴 高风险 | **security 面**(认证/授权/支付/exec-gate/密钥/沙箱边界)、**breaking change**(判据见下)、**改架构方向 / 设计 A/B 未定 / 人明确表达过异议**、改 verification 门控语义(安全闸) | **永不自动合**;升级给人——security/breaking/门控语义 → `pr-sweep:awaiting-caution`,方向未定/人已异议 → `pr-sweep:awaiting-direction`;verdict **必带 pr-review「需人确认块」**(要你判什么 + 怎么验 + 推荐;security 逐条列安全属性 path:line + 验证命令) |

**升级前硬前置(issue #1860,同 [`pr-review` Step 5.5](../../pr-review/SKILL.md) / [`issue-review` Step 5.5](../../issue-review/SKILL.md)):** 判 🔴 之前先问「我能不能说出一个安全默认动作?」——能 → 不判 🔴,当场按 ratchet 执行该默认动作并留 trace;不能,才是真判断题,才配升级给人。

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
# 必须使用插件的 API 合并器；它以当前 head SHA 作原子前置条件，
# 不会在 linked worktree 中隐式 checkout 默认分支（arc#4963）。
bash "$AGENTLOOP_ROOT/scripts/merge-verified-pr.sh" <n> --method squash
```

### 举手之劳自己修,不写"行动建议"甩给人(pr-sweep 的核心纪律)

**一个 PR 离合并只差『机械操作』时,agent 自己做完并合,绝不输出一份"请你照着做"的清单。** 这是 issue-sweep "可做即做" 在 PR 侧的对偶——**写"行动建议: 删个空格、rebase、re-trigger、然后就能合"然后甩给人 = bug**。这些都是 agent 自己能做的:

| 机械阻塞 | agent 自己做 |
|---|---|
| 格式/空格/lint 噪音(profile `formatter` 报的) | 在 **PR 分支**上 `<formatter>`/ 删空格 → commit → `git push`(ff / 新提交;push 到对方分支需有权限;无权限才升级)。rebase/amend 后用 `bun scripts/git-push-lease.ts`，禁止裸 `git push --force-with-lease`（#5212） |
| `CONFLICTING`(或分支保护报 `BLOCKED-behind`),或分支上的红**在 main 上已修复**(闸归因不了:`--blocked-by` 要 open witness,且 diff 碰构建输入就不归因) | `gh pr update-branch <n> --rebase`,然后跑一次 `<verification_entry> --comment <n>`。**只是落后 main 不 rebase**——merge-load 门对着 main 当前 tip 判 |
| verification 过期(push 后未重验) | 跑 `<verification_entry> --comment <n>` → `<merge_gate_entry> --cs-head <40-char-sha> <n>` 过闸 |
| review **已明确指出**的一处小确定性改动(补一行、改个 id、删冗余) | 直接在 PR 分支补上 |

**做完这些机械修复后,PR 通常就过闸了 → 直接合。** 只有当机械修复后仍剩**真实判断/逻辑/设计/安全**问题时,才升级给人。判据:**"我现在能不能用 gh/git/编辑器把它推到可合?" 能 → 做;不能(要改逻辑、要拍设计、要人授权) → 才 `pr-sweep:awaiting-*`(按四档就低不就高)+ comment。**(verdict 已判定可机械推进却仍甩给人)

**自主梯度(autonomy ladder),与 issue-review 同源、按后果可逆性划:**
- **自动做**:发/改 comment、调 label、**去重关闭冗余 PR**、冲突时 rebase / update-branch、**格式/空格/lint 自修 + push 到 PR 分支**、补 review 已点名的小确定性 diff、为缺事实的 PR 跑一次 `<verification_entry>`、🟢/🟡 档合并。
- **升级给人(`pr-sweep:awaiting-*`,按人的负担选档:纯确认→glance / 方向→direction / 风险评估→judgment / security·breaking·门控→caution)**:🔴 档合并、真实逻辑/设计/安全缺陷、关一个**非重复**的活 PR、改 verification 门控/脚本这类安全闸、A-vs-B 没定的方向。升级时**把来源 issue 的 author + assignees 设为该 PR 的 reviewer**(继承规则见 [`issue-sweep` Step 4](../../issue-sweep/SKILL.md);已是 assignee 的补 reviewer 即可,指派失败跳过不 block)——升级要落到对的人的 review 队列里,不是发一条没人认领的 comment。**——只有机械修完仍卡的才升级。升级的 comment 必带 pr-review「需人确认块」**(要你判什么 + agent 已核验什么免重做 + 怎么验:可还原成命令就给命令+path:line+预期、security 逐条列,判断题给选项+判据+推荐,绝不造假命令 + 定了之后各分支解锁动作)。**不许停在"请人工确认"。**
- **铁律**:**绝不 force-merge 越过未解冲突**;🔴 档绝不自动合;关 PR 必带证据 + 回链。**绝不把『自己举手之劳能做的』写成行动建议交给人。**

### PR 即工作单元:pr-sweep 负责把 PR 推到终态(含修被拒的 PR),不回弹给 issue

**一个 PR 一旦存在,活就在 PR 上**——分支、diff、verification、review 线程都在这里。被 pr-sweep 拒了(BLOCK)之后,**继续修复的责任在 pr-sweep,不回弹到 issue-review**。回弹是有害的间接层:丢上下文(分支/验证/线程)、所有权两头不靠、且会撞 AI→AI 冻结(下条)。issue-sweep/issue-review **创建** PR,pr-sweep **把它开到终态**(修好合 / 或升级一个真实决定)。**BLOCK 的三种货色:**

| BLOCK 类型 | 处置 | label |
|---|---|---|
| 机械(空格/format/rebase/re-trigger) | agent 当场修 + 合(上节) | — |
| **路径已明确的实质缺陷**:review 或**人**已给出确切修复路线(如某 reviewer 确认「改继承 `BaseMessageProvider` + 补 conformance fixture」) | **agent 在 PR 分支上实现这条已确认路线** → 跑绿 → **重过 Step 5 合并闸**(风险档重算 + 人类反馈重批准闸;UI 面附最终 HEAD 截图):🟢/🟡 且无人类未批准的修改要求 → 合;🔴 或修复路线来自人类修改要求 → 贴证据(UI 面附新 HEAD 截图)等人批准。**"实现"不待人,"合并"按闸走** | `pr-sweep:needs-fix`(agent 拥有、下一轮续做,**非 awaiting-\***) |
| **真·待人决定**:无人定过的设计 A/B、安全、不可逆、"我不同意这个做法" | 升级,带 pr-review「需人确认块」(要你判什么 + 已核验什么 + 怎么验/判据 + 推荐 + 各分支解锁动作) | `pr-sweep:awaiting-direction`(方向) / `pr-sweep:awaiting-caution`(安全·不可逆) |

`pr-sweep:needs-fix` ≠ `pr-sweep:awaiting-*`:前者「有明确的活要 agent 干」,后者「等一个人类**输入**」——且四档写明了等的是哪种输入(确认/方向/风险评估/审慎批准)。

### 触发器看状态,不看"最后一条谁评的"(解开 AI→AI 冻结)

**根因**:用"最后一条评论是不是人类发的?"当"该不该动手"的总开关 → AI 把活交给 AI 时,看起来像"已处理、在等人",于是冻死。**这正是『comment 回 issue 让下一轮 issue-review 接』会卡的原因**:那条是 AI comment,issue-review 以为没人干预。

**解法:交接靠显式状态(label/checkbox),不靠评论者身份。** 一次交接 = **置一个状态**(`needs-fix` / `in-progress` / `needs-human`);接手方**按状态触发**,不问"刚才谁说的话"。"人类回复了"只是 `awaiting-*`(真等人输入)那一族的解锁信号,**不是所有活的总闸**。推论:**别把活回弹到 issue 来换 agent 接力**——同一个 PR 上 pr-sweep 自己置 `needs-fix` → 下一轮自己接着修,全程在 PR 上、零跨技能跳转、零冻结。这就是"全部由 PR 处理的 agent 执行,本无本质区别"的正解:**收口在 pr-sweep,PR 是工作单元,issue 只是 provenance。**
