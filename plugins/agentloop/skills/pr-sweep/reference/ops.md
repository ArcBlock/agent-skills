# pr-sweep — ui-verify:pending rescan, dedup-close detail, gate self-heal, rate limits, field notes, principles

> On-demand reference for [`pr-sweep`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Step 2.5 — `ui-verify:pending` 补跑扫描(仅当 profile `additional_merge_gates` 含 `ui-verify`,且本 routine 有 daemon 时)

**arc 的 `additional_merge_gates` 为 `[]`,本步在 arc 上整体跳过。** 适用的仓库里,**本 routine 环境有跑着的 daemon** 时,在正常 Step 3 review 扇出之前,先扫一遍这个确定性 label 队列,把无 daemon 环境欠下的 ui-verify 补上:

```bash
gh api "repos/{owner}/{repo}/issues?state=open&labels=ui-verify:pending&filter=all" \
  --jq '.[] | select(.pull_request != null) | .number'
```

对每个命中的 PR:HEAD 若在打 label 之后又有新 push(重新走 Step 1.5 fresh 判定),仍按新 HEAD 补跑;跑 `/ui-verify --pr <n>`,截图/录屏贴回 PR 后 `gh pr edit <n> --remove-label ui-verify:pending`。**本 routine 没有 daemon → 跳过本步(静默,不是 fail)**,这是"两路环境互补"的另一半:纯静态环境负责发现+标记,daemon 环境负责补跑+摘标。

> **`ui-verify:pending` ≠ `BLOCKED`(issue #3010,术语不能混用)**:`pending` label 表示"daemon/浏览器
> 本身不可用,这轮根本没跑",不产出任何证据 comment;`BLOCKED` 是 sticky 证据 comment 的一个可能
> `result` 值,表示"跑了、截图存在,但没能发布成公开可读的 URL"。在把 `ui-verify` 列为合并闸的仓库里两者都不放行合并,但语义不同——
> **pending 的 PR 永远不能被描述成"UI 已验证"或"截图待处理即可合并"**,补跑成功前它就是缺证据。

- **Model:** per-PR review 是**有界任务**(读 1 个 diff + 关联 issue + 核验 + 读一次同 SHA 的 verification 事实 + 可能 1 个测试)→ **Sonnet**。**跨 PR 综合(定簇胜负、判矛盾真伪、合并闸决策)用强模型(Opus)** 在主控做,别下放。成本差 ~5×。
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
   comment 顶部带完整身份行（整行由 `<agent_identity_script> --header "PR Review" --skill pr-sweep` 生成，不能用日期、占位符或手拼代替、也别再手写死 `Claude Code(<model>)`——engine/model 由脚本按 `ARC_AGENT_ENGINE`/`ARC_AGENT_MODEL` 自动带出；行尾追加读取/运行范围）。
   正文一句话定责 + 指向 keeper。
4. **keeper 上留一条**:注明"已关闭重复 #twin,本 PR 为保留方",便于人追溯。

> **关闭是可逆的**(可 reopen),且这里有明确证据 + 双向回链 → 属"自动做"。但**别误关**:只有坐实"同 issue、同改动面、确为冗余/被取代"才关;拿不准就两个都留 `COMMENT`,把冲突摆出来等人。**簇内任一 PR 带 `agent:hold`(人类保留)→ 不参与去重关闭**(hold 冻结终态动作,close 属终态:它既不被当 twin 关掉,也不被拿来当 keeper 去关别人——它自己的去留人还没拍板;冲突事实照常写进 verdict comment 供人参考)。

## Step 6 — verification 门控自愈(门控坏了就修门控,不让每个 PR 陪绑)

arc `gate_mode=scripts`:PR 上无 CI,verification 脚本(`<verification_entry>`)是唯一门控(`ci`/`both` repo 叠加 `gh pr checks`)
(`.claude/verify/`)。review 中若发现门控因**可修的脚本/基础设施**
反复误报(非某个 PR 的错,而是某个 `check-*` 过严/某测试 flaky/某依赖没编译):
- **不要**让每个 PR 手动绕 / 一直挂红。
- **诊断根因**(`check-*.ts` 的判定逻辑 / 某个 flaky 测试 / 缺原生依赖 build),开一个独立
  **verification-fix PR**(走本 sweep 的低风险闸),把"门控该不该这么严/这么脆"当可独立修的工程问题。
- 例:某测试因 WASM 重编译 flaky → **二分到根因修测试或修被测代码**(「变绿」不等于「修好」:调大超时让它变绿是 patch,不是根治;仓库的 flake 纪律见 arc `docs/architecture/flake-root-cause-discipline.md`)。**`format` 不再是噪音类**——arc#5805 把
  `check-format.ts` 翻成 blocking(它曾是闸上唯一的非阻断检查,main 因此带着未格式化文件
  合了两天)。红了就照**该红行自己打印的 remedy** 修(次选 repo-profile 的 `<formatter>`);
  一条命令的事,但**不作为「可忽略」处理**,也不要在本 skill 里硬编码某个包管理器的命令。
- 改门控判定语义(哪个检查算 blocking)= 安全闸 → 属 🔴/需人确认那一类,**开 PR + 升级**,不自己合。
  升级 comment 带「需人确认块」:要人确认的那条门控改动 + 怎么验(前后 `<verification_entry>` 输出对比)+ 推荐。

## 限速 / 编排 / 幂等(批量必守)

1. **GitHub「内容创建」硬约束**:≤500/h、≤80/min。每 PR 最多 1 条 verdict comment;去重关闭每 twin 1 条 + 1 close;`gh` 遇 403 secondary limit → 退避重试(≤3)、仍失败标 `RATE-LIMITED` 不整批报错(可 resume 补)。
2. **并发**:重闸(`<verification_entry>` / advisory 门 / 全量 build/test)同一台机器最多 2 个,放行前看负载;API 侧 ~10–14 × 每 agent ~2–3min ≈ ~250–300 POST/h,稳在限速下。别盲目拉高触发 80/min burst。
3. **幂等**:重复跑 sweep 不应重复评论/重复关。发 comment 前看 PR 上是否已有本轮 agent 评论(同上谓词;同结论就 `--edit-last` 不新发);已关的跳过;已合的从候选移除。
4. **Resumable**:**仅交互式**用 Workflow 编排可续(`resumeFromRunId`)。**无人值守 routine 不用 Workflow**(见 Step 3 铁律)——靠幂等(第 3 条)实现"可续":挂了/限速了,下一轮 cron 凭 disposition label + 既有 verdict comment 自然接着干,不重复、不挂死。

## 源头治理:别再产生重复 PR(指回 issue-sweep)

去重关闭是**治标**。**治本**在 PR 的产生方——多台机器跑 [`issue-sweep`](../../issue-sweep/SKILL.md) 对同一 issue 各开一个 PR(branch `claude/<verb>-<N>-<slug>`,issue 号同、slug 不同 → 不碰撞 → 双开)。源头修法(已写进 issue-sweep "Step 4 — Discipline" 的防重复条):

- **确定性分支名**:`claude/issue-<N>`(或 `claude/issue-<N>-p<phase>`),**不要**模型自创的 verb/slug → 两台机器算出同名分支,第二个 push/`gh pr create` 自然碰撞。
- **创建前认领检查**:开 PR 前 `gh pr list --search` 查是否已有开放 PR 指向 #N,有则 SKIP。

sweep 每轮可顺手核对:新出现的重复簇若仍来自非确定性分支名 → 说明某台机器的 issue-sweep 还没更新到确定性命名,在汇总里标一句。

## 实战经验(本仓首次运行沉淀,autonomous 机器必读)

见本 repo 的 case-law 附录(arc:`.claude/case-law/pr-sweep/first-run-lessons.md`;新 repo 自建)——第一次跑
`pr-sweep` 时踩出的 7 条坑:review 数据易过期、verification 失败要逐层剥(格式→flaky
测试)、门控失败的修法可能已躺在别的 PR 里、大 pull 后 dist 陈旧导致 `check-types` 假红、
无 CI required check(合并门控是同 SHA 的 verification PASS + merge gate,不是 `gh pr checks`)、rebase 后 base
还会动、门控只跑 affected 不跑全量。

## Key Principles

1. **每 PR 干净上下文独立判断,主控集中决策。** Sonnet 扇出 review,Opus 综合定簇胜负 + 合并闸。
2. **verification 门控是信号不是判官(PR 上已无 CI)。** 失败诊断根因;任何 FAIL 都挡合并(合并闸只认同 SHA 的 PASS/NA)。(a)本 PR 缺陷修掉;噪音自修;不是本 PR 的红只能二分根治或 `--blocked-by` 由闸自己判定,不盲目重跑、不调超时洗绿;门控本身坏了/过严去修脚本(Step 6)。
3. **去重:留一个、关其余,带判据 + 回链。** 矛盾对必查权威源;拿不准两个都留等人。
4. **合并分风险档,且档位在每次合并尝试前重算——所有路径无豁免。** 🟢🟡 自动(含**非 breaking 的 feature**——"是 feature"不是升级理由,判风险看改动内容:security/breaking/方向未定才 🔴)、🔴 升级(任何路径都不自动合,含 needs-fix 跑绿后);出过事故的 pattern 按「尺度演进 ratchet」逐条追加进 🔴,不整类回退;UI 面 PR 带作者在最终 HEAD 上的截图(arc 上是 review 关注点,不是合并闸);**人类的修改要求 ≠ 合并批准**——响应之后贴证据置 `awaiting-glance` 等明确批准语;绝不 force-merge 越过冲突;关闭可逆但只关坐实的冗余。
   **升级给人(🔴/security/`awaiting-direction|caution`)的 comment 必带 pr-review「需人确认块」**:要你判什么 + agent 已核验什么(免重做)+ 怎么验(可还原成命令就给可照跑步骤+path:line+预期,security 逐条列安全属性;判断题给选项+判据+推荐,绝不造假命令)+ 各分支解锁动作。**不许停在"请人工确认"**。
5. **产物落 PR + git history,不落会话。** 一轮 sweep = 若干 PR 进入终态 + 可追溯的 verdict/close/merge 记录。
6. **一轮的成本要和它能推动的事成正比(冻结集 + 早退,Step 1.5)。** 「跳过」这个判断本身也要花钱——
   每个 PR 三次评论面 API。所以:`awaiting-*` 且 `updatedAt` 超过 `pr_sweep_freeze_ttl_days`(缺省 14 天)
   的 PR **连判都不判**,只吃 Step 1 那一次 list;`needs-fix` / `blocked-deps` / `ui-verify:pending`
   永不冻结(那三档是 agent 还有活干)。actionable 集为空就**立刻早退**,不做任何 per-PR 工作。
   **但 run report 的 summary 必须报出冻结数和超 30 天的 PR 号**——沉默截断会让「今天真的没事」
   和「8 个 PR 卡了一个月」在报表上同色。实测反例:did 一周 85 轮、23.9 小时、0 终态动作。
6. **治本在源头。** 去重是治标;确定性分支 + 认领检查(issue-sweep)才根除重复。
7. **轮次感知:无新输入不重做(定时 routine 必守)。** 已 review 且无新 commit、无人类新评论的 PR
   默认跳过;只对真正变了的 PR 起 agent,只对外部阻塞已解除的 PR 廉价重查并合。`pr-sweep:awaiting-*`(四档)
   / `pr-sweep:blocked-deps` 等 disposition label 承载跨轮状态。**绝不重发同一结论 comment**(见 Step 1.5)。
   **「新输入」判的是「结论会不会变」,不是「字节变没变」**:机械重生成 PR 的 sha churn 不算新输入
   (Step 1.5 的机械重生成条款);已升级等人的 PR,增量复审后结论不变就静默刷 sha,不再重述
   ([pr-review Step 0.6](../../pr-review/SKILL.md))。**升级过一次就够了——人没回话之前再升级一次只是噪音。**
8. **`agent:hold` = 终态冻结,不是处理冻结。** 人给 PR 打 `agent:hold` 表示"没我反馈别合/别关",
   不是"别理它":hold 期间 merge/close/摘 label 绝对禁止(Step 5 合并闸硬拦,即使 🟢 档;Step 4 去重
   不拿它当 twin/keeper),但**人类新评论/新 commit 照常触发 review + 响应**——尤其人类在 hold PR 上
   留的修改要求,是最高优先级输入,必须接(回 comment、按明确要求在 PR 分支修、push 后重验,verdict 标
   `held`)。只人加只人摘,agent 永不自动摘。与 issue 侧同名同义
   ([`issue-review` ★并发锁](../../issue-review/SKILL.md));PR 侧**不**引入 `agent:processing`(并发去重靠
   确定性分支 + 认领检查 + disposition label)。
