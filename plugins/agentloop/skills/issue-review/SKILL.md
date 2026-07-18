---
name: issue-review
description: Process one GitHub issue end-to-end — read the issue + referenced repo docs/code + existing comments, verify against the landed implementation/intent, and post evidence-backed findings as a comment on the issue. Covers doc-review, doc-audit, system-audit, research, and idea issue types. Use when handling a single issue (issue-sweep calls this per issue).
---

# Issue Review — AI Agent Review / Audit for Doc-from-Issue

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> **arc is the reference implementation.** Use the profile's `repo_slug`, `verification_entry`,
> `kb_issue`, `plugin_root` (where issue-graph's scripts live), and toolchain wherever this doc shows an arc default. Arc's own provenance
> for the lessons below is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

把一篇 issue 处理到位:读 issue + 引用的 repo 文档/代码 + 已有 comments + **对照已落地的实现/代码/intent**,产出**带证据**的发现,作为 comment 落回 issue(而不是埋在某次对话里)。覆盖五类:

- **Doc-review**:人起源的**新设计**在 issue 里被讨论/评审(找漂移、独立发现、reframe)。轻量、讨论导向,产出 = 评审 comment + 拆分建议。
- **Doc-audit**:repo 里的**存量老文档**被逐篇审计(对照代码重验、跑测试、给 5 类结论)。**有界**单元,按价值分档投入。
- **System-audit(comprehensive code audit)**:issue 要求对一个**子系统 / 跨平台 parity / runtime 本身**做全面代码审计(如「Swift/Kotlin 实现是否落后于 Node/CF 参考」)。**无界**任务,**完整执行是契约**——见下「★ System-audit」。
- **Research(研究类)**:issue 要求**调研一个外部系统/技术与本系统的结合点**(如「研究 perkeep 和 did space 的结合点」)。**只产出 comment,绝不改 repo 代码**——见下「★ Research」。
- **Idea(想法类)**:issue 是一个**内部提案/想法**(如「提供一个 DID Space + MCP endpoint 给 loop 里的 agent」)——可能可行、可能不可行、可能太模糊、可能与现有设计矛盾。**第一步是 clarify,不是执行**;产出 = 评估 comment + 澄清问题,**绝不改 repo 代码、不开 spin-off**——见下「★ Idea」。

五类共用同一台引擎(读 → 对照现实 → 带证据落 comment),但**投入档位和产出形态不同**:doc-review 轻、doc-audit 按价值分档、**system-audit 必须全量**、research 双侧深调但产物只落 comment、idea 对照现有架构评估但产物只落 comment(下面「省 token」那套**不适用于 system-audit 和 research/idea 的调研深度**)。

> **怎么判类型**:issue 锚定**单篇文档** = doc-review / doc-audit;issue 说「comprehensive audit」「review 整个 runtime / 跨平台是否一致」「需要完整 test run」「发现 gap/bug 开 issue」= **system-audit**;标题带 `[research]` / 正文是「研究一下 X 和我们的 Y」「调研 X 是否适合我们」= **research**;标题带 `idea:` / 正文自称「这是个 idea,首先需要分析可行性和价值」/ 是一段**提案性质**的构想(常附 Slack/讨论原文,无验收标准、无明确 spec)= **idea**。拿不准 audit 类就按 system-audit 的高标准做(宁可多投入,不可粗略);**拿不准「指令还是想法」就按 idea 处理**(先 clarify 的代价远低于把模糊想法当指令执行错方向)。

> **输出语言与写作规范(遵循 `comment_language`,信雅达)。** 所有面向团队的产出——issue comment、spin-off issue 标题与正文、**PR 描述正文**、评估/验证报告——一律用 repo profile 的 `comment_language` 指定的正文语言(arc 默认:中文,团队阅读语言);代码标识符、路径、命令、`path:line`、测试输出**保持原样**(不翻译代码)。**PR 与 commit 标题遵循 `comment_language` 的标题惯例**——完整 Conventional Commits(`type(scope): description`,arc 默认标题全英文,冒号后的描述也用英文,不得混用);issue 标题(含 spin-off)随正文语言(arc 默认:中文)。**追求信雅达,不堆砌**:内容太多本身就是阅读负担——先给一句话结论,再给最少但足够的证据,不为显得全面而铺陈;每条断言配证据(文档 / 代码 `path:line` / 真实测试输出,**UI 相关必附截图**);长日志折叠进 `<details>`,不平铺刷屏。

## Usage

```
/agentloop:issue-review <issue-number-or-url> [--dry-run]
```

- `<issue-number-or-url>` — 要处理的 GitHub issue(用 `gh` 读取)
- `--dry-run`(旧名 `--no-post` 仍兼容)— 只产出给用户看,**不**发/改 comment、**不**自动开 spin-off issue、不动 label、**不加锁**(用于人想先预览)。语义见插件 README 的 **Dry-run contract**。

### Examples

```
/agentloop:issue-review 115            # doc-review:评审一篇新设计
/agentloop:issue-review 120            # doc-audit:审计一篇存量老文档
/agentloop:issue-review 756            # idea:先 clarify + open 评估一个提案
/agentloop:issue-review 120 --dry-run
```

## When to Use

- 一个 issue 在讨论/评审一篇 repo 内文档(`planning/`、`docs/`、`intent/`),需要**有据可查**的 AI 处理。
- 已有人类 reviewer 留意见,想要一个**独立的、能发现人类没提到的问题**的视角。
- 你在搭"自动处理 issue 的 agent loop",需要一个可复用、产物可追溯的动作。

**不适用**:纯代码 PR 的 review(用 `/code-review` / `/review`);纯本地文档、不走 issue 的(用 `/agentloop:design-review <path>`)。

## ★ 并发锁(每次 run 先 acquire,收尾必 release)

多个 actor 会同时碰同一个 issue:定时 `issue-sweep`(cron)、多人本地手工 `/agentloop:issue-review`、本地 agent。不协调就**重复读+核验+跑测试+重复评论**(白烧 token),严重时重复开 PR。两个 label 各管一件事:

| label | 含义 | 谁加/摘 | 谁尊重 |
|---|---|---|---|
| **`agent:hold`** | **人类保留 = 终态冻结**——"没我反馈别做不可逆动作(close/merge)",**不是"别理它"**(**issue/PR 通用**) | **只人加、只人摘**;agent 永不自动摘 | **`issue-sweep` / `pr-sweep` 冻结终态动作**(永不 close/去重关闭/合并),但**人类新评论/新 commit 照常触发 review + 响应**(人的反馈是最高优先级输入);无新输入才跳过。**`issue-review` / `pr-review` 显式手工调用只提示不挡**(人点名就是要处理) |
| **`agent:processing`** | **处理中互斥锁**(advisory,带 TTL 30min) | agent 开工 acquire、收尾 release | 任何 run 见**新鲜**的锁就 **SKIP**;**过期**(上一个 runner 崩了)则抢锁重做 |

> **跨 issue/PR 边界:** `agent:hold` 两边通用——「人类保留」是与对象类型无关的预约(GitHub label 仓库级共享),两侧语义一致:**冻结终态动作(close/merge),不冻结响应**——人类新评论照常处理,`pr-review` 显式调用只提示不挡(见各自 SKILL)。`agent:processing`(TTL 互斥锁)**只用于 issue**:PR 侧的并发去重由 `pr-sweep` 自己的确定性分支 `claude/issue-<N>` + 开 PR 前认领检查 + disposition label 承载,不复用这个锁。

**定位要诚实:`agent:processing` 是 advisory(省重复工作),不是完美分布式锁**——本仓库人和 AI 同账号/可能同 token,label-add 幂等,两机同瞬起步有残留竞态。**真正的硬去重仍是 `issue-sweep` 已有的「确定性分支 `claude/issue-<N>` + 开 PR 前认领检查」**,这层不动、兜底。`agent:processing` 只是把撞车从"收尾才发现"提前到"开工就短路",省掉前面的读/核验/测试。

**无分支兜底的终态动作(comment+close 类,如 ★父级 rollup)另有硬互斥:claim-comment fencing。** 分支碰撞兜不住它们,label 又无 CAS——用 [`issue-graph`](../issue-graph/SKILL.md) 的 `claim.ts`(comment id 全序裁决,先写后读、最早未过期 claim 赢):

```bash
bun <plugin_root>/skills/issue-graph/scripts/claim.ts --issue <N> --action rollup   # exit 0=赢/3=输(输了自删claim退出)
# …执行动作(动手前最后重读一次目标状态)…
bun <plugin_root>/skills/issue-graph/scripts/claim.ts --release <claimId>           # 完成必调;崩溃靠TTL 30min兜底
```

> **命名消歧**:本 skill 里 `in-progress` 这个**词**已是「多轮续做的 comment disposition」(轮次感知接力),所以互斥锁**另起名 `agent:processing`**,别复用 `in-progress`。

**acquire(Step 0 最前,读 thread 之前):**

```bash
N=<issue>; TTL_MIN=30
# 缺 label 自建(幂等,best-effort)
gh label create agent:hold       --color D4C5F9 --description "人类保留:自动化别碰,只人摘" 2>/dev/null || true
gh label create agent:processing --color FBCA04 --description "处理中互斥锁(advisory,TTL 30min)" 2>/dev/null || true

labels=$(gh issue view "$N" --json labels --jq '.labels[].name')
# agent:hold —— 人类保留:显式手工调用只提示(sweep 才真跳过)
grep -qx 'agent:hold' <<<"$labels" && echo "⚠️ #$N 带 agent:hold(人类保留);显式调用继续。"
# agent:processing —— 互斥锁:新鲜则 SKIP,过期则抢
if grep -qx 'agent:processing' <<<"$labels"; then
  since=$(gh api --paginate repos/{owner}/{repo}/issues/$N/timeline \
    --jq '[.[]|select(.event=="labeled" and .label.name=="agent:processing")]|last|.created_at')
  now=$(date -u +%s)
  then=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$since" +%s 2>/dev/null || date -u -d "$since" +%s)
  age_min=$(( (now - then) / 60 ))
  if [ "${age_min:-9999}" -lt "$TTL_MIN" ]; then
    echo "🔒 #$N 正被处理中(since $since, ${age_min}min<${TTL_MIN}) — SKIP"; exit 0
  fi
  echo "♻️ #$N 锁已过期(${age_min}min) — 抢锁重做"
fi
gh issue edit "$N" --add-label agent:processing      # 加锁
```

**release(收尾,成功/失败都做):**

```bash
gh issue edit "$N" --remove-label agent:processing
```

- **`--dry-run` 不 acquire/不 release**(不做任何 outward 写);只在发现已上锁时打印一句提示。
- **★ 解读→执行的升级点 = 重新过 Step 0。** 会话以「帮我看看/解释一下」开场(dry-run 语义,不加锁)后,用户中途说「解决掉/实现它」——**升级为执行的那一刻必须先 acquire 锁再动手**,不能带着 dry-run 的无锁状态直接开工(实战教训:曾因此被并发 agent 重复实现)。
- **长任务续锁**:预计超过 TTL(30min)的执行(实现+验证+PR),每 ~20min 重新 `gh issue edit <n> --add-label agent:processing` 一次(label-add 幂等,timeline 会刷新 labeled 时间戳),否则锁中途过期照样被抢。
- **崩溃/被 kill 没 release** → 锁靠 TTL(30min)自动失效,下一个 run 抢锁重做,不会永久卡死。
- **手工想长期独占**某条:人**先打 `agent:hold`**(sweep 永久绕开),处理完人摘掉——比临时锁更强、更明确的预约。

## ★ 轮次感知 + 省 token(每次调用先做这件事)

**不要无脑全量重跑。** 一篇 issue 会被处理多轮;后续轮的成本应该远低于首轮。先读 thread(`gh issue view <n> --comments`,便宜),判断轮次:

| 轮次 | 信号 | 该做什么 |
|---|---|---|
| **首轮(冷启动)** | 没有既往 AI review/audit comment | **先 triage 价值,按档投入**(见下):明显废弃的只轻确认;真活的才全量(对照代码 + 跑测试) |
| **后续轮(热启动)** | 已有 AI 结论 + human 意见 | **不重做**:读 thread,把既往证据当既成事实,按 human 意见走下一步 |

**冷启动也要按价值分档,别一上来就 full build / 全测:**

- **先廉价判类别**:读 frontmatter(`superseded` / `superseded_by` / `deprecated`)+ `ls`/`grep` 扫一眼对应代码在不在。**明显已废弃 / 不再有价值**的(显式 superseded、方案被取代、对应代码已移除)→ 只做**轻确认**:用 `grep`/`ls`/`git log` 坐实"代码确实没了 / 已被取代"即可下 `deprecated`,**不 build、不跑测试套件、不逐条 `path:line`**。
- **只有判断它「真活着」**(可能 drifted/partial/current、细节要紧)时,才上全量:逐条 `path:line` + 真跑测试。
- 一句话:**投入与文档的价值成正比。** 给一篇要删的死文档做全量审计,本身就是浪费。

> ⚠️ **以上「按价值分档 / 轻确认 / 省 token」只约束 doc-review 和 doc-audit。System-audit 不走这套**——见下。

## ★ System-audit(comprehensive code audit)——完整执行是契约

当 issue 要求**全面代码审计**(子系统 / 跨平台 parity / runtime 本身),「省 token」让位于「不漏」。**粗略 = 失败。** 铁律:

1. **不许轻确认、不许靠 frontmatter 下结论。** 每条 parity claim 必须 `path:line` 坐实(在 / 不在 / 漂移),两侧都查(参考实现面 vs 目标实现面)。
2. **必须真跑测试,缺测试就补。** issue 通常明说「要有完整 test run」——跑得动的全跑、记确切命令 + pass/fail;**跑不动要说清原因**(见 repo profile 的 **Deployment Environments** 列出的平台工具链缺口,arc 例:沙箱无 Xcode/Android SDK → Swift/Kotlin 测试 `describe.skip`/无法编译),并退而用**静态对照 + conformance 套件**兜底,**不能假装跑过**。**「跑不动」的判定纪律同 Step 4**:先真尝试 + 先补 setup(编译原生依赖、link CLI 不算环境限制),只有实际撞上硬工具链缺失才算,且贴确切报错——别预先开脱。
3. **先分解再审计。** 把大审计拆成**子系统单元**(core / aup / session / 各 provider …),逐元对照,别糊成一团。每元独立给证据。
4. **gap/bug/security 当场开 issue(合理颗粒度),不必等确认。** 一类 gap 一个 issue;bug、security 各自独立开(`security` + `P0`)。审计 comment 汇总矩阵 + 一句话指向各 spin-off。
5. **产出 = 现状矩阵(参考×目标,逐元 ✅/⚠️/❌ + 证据)+ 测试结果 + gap 清单 + 已开 issue 列表。** 这是「报告现状」的交付物,不是给一个 status label。

### Model / 编排(System-audit)

- **不要为省钱用弱模型做整体综合。** 主控(synthesis + 开 issue + 判 parity 真伪)用**强模型(Opus)**;**分解后的有界子元审计可以下放 Sonnet**(读 1 个子系统两侧代码 + 跑 1 个测试 + 给结构化发现),但**关键语义面**(core 语义、协议/校验、安全降级)留 Opus。
- **该并行就并行**:子系统之间相互独立,用 subagent 扇出(每个 agent 一个子系统,返回结构化 parity 发现),主控汇总。这既快又能各自深入——**比单线程顺序扫更完整,不是更省**。
- 一句话:**doc-audit 选 Sonnet 是因为它有界;system-audit 反过来——宁可 Opus + 扇出多 agent,把它做透。**

### 跨 repo / reference×target 一致性审计(system-audit 的常见形态)

很多 system-audit 是「**审 A 是否正确消费了 B 的抽象**」——如「下游 repo 是否 protocol-first 并正确复用上游核心抽象」「某平台实现是否落后于参照 runtime」(arc 例:「aside 是否 AFS-first + 用 ARC AUP」「Swift/Kotlin 实现是否落后于 Node/CF 参照」)。审计物在 target repo、参照实现在 reference repo,**两个 repo 都本地 checkout、路径不同**。纪律:

1. **先定 reference 与 target,两侧都读。** reference = 权威抽象/协议真相源(`<reference-repo-path>`,arc 例:`platforms/swift`、`platforms/kotlin`、`providers/runtime/ui`、`packages/aup`、AFS core);target = 被审代码(`<target-repo-path>`,arc 例:aside `ios/` `android/` `.aup/`)。**每条 parity claim 两侧各给 `path:line`**:target 到底在「消费 reference 的抽象」还是「平行重造一套」。
2. **`gh` 全部带 `--repo <owner/repo>`。** 审计 issue、verdict comment、spin-off issue、label 全落在 **target 的 repo**(issue 所在处);reference repo **只读**,不在里面开 issue。跨 repo 时 `repos/{owner}/{repo}` 占位符会解析成当前 cwd 的 repo,**别依赖它**,显式写 `--repo`。
3. **核心透镜:「真用」vs「用不彻底」要分层,别二值判。** 常见形态是**壳复用、肉不复用**:renderer/接口是通用的 ✅,但喂给它的东西(UI tree / 数据)在各端**手搭/平行重写** ❌。精确结论(「是真 AUP renderer,但每屏在 native 手搭 AUPNode、不加载 canonical `.aup`,三套并行必然漂移」)远比「违反 AUP」有价值。**先肯定做对的部分,再精确定位违规在哪一层。**
4. **单一真相源(SSOT)判定是这类审计的核心产出。** 同一界面/能力有没有「一份 canonical 定义被各端 render/消费」,还是 N 份平行实现(JSON + Swift + Kotlin…)?列出**同名单元的重叠矩阵**坐实。
5. **跨 repo 根因回溯 + 分段修复。** target 的违规常**根因在 reference 的能力缺口**(如「热读绕过 AFS」根因是「ARC AFS 缺 reactive/watch API」)。spin-off 要写清**两段**:reference 侧补能力(可能需在 **reference repo** 另立 issue)+ target 侧改用。
6. **fix 需方向时,issue 框成「确认的 gap + 待定方向 A/B/C」,别预设。** 现状(违规)已坐实就开 tracking issue(system-audit 契约要求开),但把统一/修复方案作为**待人拍板的选项列出**,不替人选(呼应 spin-off 的「needs-decision 不预设」)。纯营销页/需人定性的(如 bespoke landing HTML)留 verdict comment,不自动开 issue。
7. **平台专属工具链测试大概率跑不动——诚实退档。** 具体平台见 repo profile 的 **Deployment Environments**(arc 例:Xcode(Swift)/gradle+Android SDK(Kotlin)在沙箱通常缺);先真尝试 + 先补 setup,撞硬阻塞就**贴确切命令+报错**(arc 例:`gradle.properties` 硬编码 JBR、composite build 期望的同级 repo 布局不符、缺 `compileSdk`),退回**静态对照 + 读测试源**坐实结构,**显式标注跳过哪层、绝不假装跑过**。结论基于代码结构的确定事实,不依赖测试通过。
8. **批量开 spin-off 后必须核对 title↔body↔label 对齐。** 循环里捕获 issue number 易错位(首个 create 漏号→整体偏移),后续 body 回填会打到**错误的 issue**。开完**逐个 dump body 首行比对 title**,发现错位立即 `gh issue edit` 修正 + 补建漏掉的。宁可多一步核对。

### 共享 KB(热启动 repo 拓扑,免重复探索)

有一个 **pinned 知识库 issue**(repo profile 的 `kb_issue`,arc 默认 label `doc-audit-kb`),body 是 repo 拓扑 hints(子系统在哪、测试命令、大迁移、meta 事实)。**每次 run 先读它热启动,末尾把新学到的 append 回去:**

1. **开工前先读 KB body**(`gh issue view <kb_issue>`,**只读 body**——comment 是原始追加流,别全读)拿热启动事实——别再从零 grep "CLI 在哪 / 测试命令是什么 / 哪些大迁移"。
2. **hints 非真相**:信它**快速定位**,但**便宜复查**(代码会动)。读到错条目(如"X 在 `packages/cli`"但其实已迁)→ **编辑 KB body 改那行** + 留一条 comment 说改了什么。一条 stale 的 hint 比没有还坏。
3. **末尾 append**:本轮新发现的拓扑 / 命令 / 迁移 / meta 事实,加进 KB body 对应小节,带"最后确认 commit/日期"。
4. **范围**:KB 只放拓扑 / 命令 / 迁移 / meta;**不放**审计账本(账本 = `gh issue list --label doc-audit`)。
5. **并行批处理时**(暂未启用):agent 只**追加 comment**,由一个整理步骤折叠进 body,避免 body 写冲突;顺序审计时直接编辑 body。

### Memory MCP（可选，当已配置时）

如果运行环境的 MCP 工具列表包含 AFS 命名空间（如 `afs_read` / `afs_write` / `afs_search`，来自已连接的 ARC instance MCP 端点），在 Step 0 中增加两步：

**热启动前先 recall（与读 KB 同时做，并行）：**
```
afs_search /user/memory 关键词:<issue 相关术语 / 路径 / 子系统>
```
读到的内容（observations / patterns / principles）补充进热启动上下文——和 KB hint 同等地位：「快速定位，需代码便宜复查」。

**处理完毕后 store（追加，不覆写已有条目）：** 写入时机——本轮发现以下任一：
- **非显而易见的代码约束**（某函数在某场景不可用的原因、隐藏副作用、hook 执行顺序）
- **团队决策**（为什么选 A 不选 B、某字段命名的历史原因）
- **revert 理由**（某 PR 回退的真实原因，防止下次重蹈）
- **跨 issue 的规律**（同类 bug 反复出现的根因模式）

写入三层（粒度由小到大）：
- `observation`：具体事实 + `path:line`（最小粒度、最贴代码）
- `pattern`：跨多次观察归纳出的规律（「X 类 issue 根因通常是 Y」）
- `principle`：推断出的工作原则（「做 Z 前必须先检查 W」）

路径：`afs_write /user/memory/<memory_namespace>/<namespace>/<id>`（`memory_namespace` 见 repo profile Agent Tooling，arc 默认 `arc-loop`）；caller 身份自动隔离（不同 loop agent 互不干扰）。

**未配置 MCP = 本节跳过**，skill 其余行为完全不变。

**热启动三条硬规则(省 token 的闸):**

1. **issue thread 是累积状态。** 既往已核验的证据(`path:line`、测试 pass/fail 数)默认**信任**,不重新推导——除非"文件变了"或"human 质疑了这一条"。
2. **不重 build、不重跑整套测试、不重读全部文档。** 只在「目标代码变了 / human 点名要重查」时,重跑**那一个**测试、重读**那一节**。
3. **判断"变没变"用便宜的命令**:`git log --oneline --since="<上条 comment 时间>" -- <unit 路径>`。没动过 → 既往证据成立,直接进下一步。

**human comment 是后续轮的方向,但不是圣旨。** 它确认/否决某结论、提新事实(如"这协议其实是给反向注入用的")、指下一步——优先按它走,但**不盲从**:

- human 没提到的真问题**不要因此丢掉**——该指出还指出(他可能没 cover 全)。
- human comment 是**疑问 / 不确定**(带"?"、"是不是"、"我不确定")时,当作**要回答的问题**,不是要执行的命令——给带证据的答复,必要时坦白你也不确定、列出选项让人定。
- **多条 comment / 来自不同人**时,逐一列出、**调和分歧**;别只听最后一条或最大声的那条。有冲突就摆出来让人拍板,不要自己悄悄选一个。

后续轮的产出往往不是"再来一份完整 review",而是一个**针对性的下一步**(确认某结论 / 解某个 gap / 起草 crystal / 回答疑问)。

## ★ Research(研究类 issue)——外部系统 × 本系统结合点调研

issue 要求研究一个**外部项目/技术**(开源系统、协议、竞品)与**本系统**的结合点、可行性或借鉴价值。范式如 perkeep × did-space 的结合点调研。这是 deep research 的 repo 内变体:**最大区别是我们身在一个 repo 里(知识库或产品代码),所以能做代码级深度,而不是只读对方的宣传页。**

**铁律(与其他各类的关键差异):**

1. **绝不改本 repo 代码。** 产物 = 一条证据化研究 comment(+ label),不是 PR、不是文件。skill 改进等衍生工作是另一件事,不混在 research 交付里。
2. **默认只留 comment + 外部资源链接,不下载保存。** 外部 repo clone 到 scratchpad 用完即弃。**仅当 issue 明确说要收集数据保存在 repo 里**时,才在 `research/<task-slug>/` 开专门目录收集值得保存的(仍走 PR,人签名)。
3. **两侧都必须代码级,不许只读 README。** 外部侧:shallow clone 到 scratchpad,读架构文档 + 关键源码包,结论带 repo 内相对路径(尽量带行号)+ 官方 doc 链接;我方侧:读本 repo 代码/intent/planning,结论带 `path:line`。**并行 fan-out 两个 subagent(一侧一个)**,主控综合——两侧独立取证,防止先入为主。
4. **外部项目健康度必查**:`git log` 最近 12 个月提交曲线、最近 release、核心作者近期是否活跃、license、`gh api repos/<owner>/<repo>` 的 pushed_at/stars。结合点结论强依赖对方活性(死项目和刚复活的项目结论完全不同),这常是**独立发现**的来源(如发现 perkeep 2025-10 复活、7 年来首个 release)。
5. **诚实优先,反「为用而用」。** issue 主人常自带警惕(「不能为用 X 而用」),研究结论必须敢说「这个方向不建议」;每个结合点标注真实受益方和前提条件。
6. **产物结构**(comment,中文):TL;DR 逐条直接回答 issue 提出的具体问题 → 两侧架构对照表(均代码坐实) → 冲突面 → 结合点**分档**(⭐ 推荐 / ◐ 待定或仅借鉴 / ✗ 不建议,每条给理由) → 待人拍板的下一步选项(**不预设、不自动开 spin-off**——research 的结论天然是 needs-decision,人选定方向后才拆自足的 feature issue) → 外部资源链接清单。
7. **Label**:`research` + `needs-human-confirm`;并发锁照常(`agent:processing`)。issue 保持 open 等人拍板方向。
8. **投入档位**:调研深度不省(两侧 subagent 各自全量),但**验证层不同**——research 不跑本 repo 测试套件(没有要验收的实现),证据 = 双侧源码引用 + 官方文档 + 项目活性数据。

**后续轮**:人选定方向(如「做 A」)后,按选项拆自足 feature issue(照「partial → 拆分剩余工作」的自足配方),或转入 `/agentloop:design-review` → `/agentloop:build-phases` 管道;若人只是追问,原地编辑/追加 comment 回答。

## ★ Idea(想法类 issue)——先 clarify,open 评估,不当指令

issue 是一个**内部提案/想法**——作者自己都标注「可能可行,可能不可行,可能太模糊,也可能和现有的东西矛盾」。范式如「给 loop agent 提供 DID Space + MCP endpoint」这类提案。**这类 issue 最大的处理风险不是做得不深,而是做错性质:把 idea 当指令,直接开工实现一个方向未定、边界未清的东西。**

**铁律(与其他四类的关键差异):**

1. **不当指令,当提案。** 第一步是**理解复述**(把 idea 用自己的话讲一遍,分解成可独立评估的价值主张),而不是拆任务。复述放 comment 最前——它给人一个廉价的纠错点(「你理解错了」比「你做错了」便宜一百倍)。
2. **绝不改 repo 代码、不开 PR、不开 spin-off。** idea 的结论天然是 needs-decision;方向没定之前开 issue/写码都是预设。产物 = 一条证据化评估 comment + label。
3. **Open 评估,三个方向都真查:** ① **可行且有价值**——对照代码找「地基已有多少」(常见惊喜:构件早已存在,idea 只缺接线);② **不可行 / 价值不明**——缺口带 `path:line` 坐实,不糊「应该可以」;③ **与现有设计矛盾**——点名矛盾对象(哪个机制/纪律/在途设计),把张力摆出来而不是悄悄选边。**每条断言 `path:line` 坐实**,grounding 纪律与审计同级。
4. **诚实优先,敢泼冷水。** idea 作者(常是 founder/架构师)要的是可行性分析,不是附和。「这半个价值主张有实打实的工程量缺口」比「好主意」有价值;同时**先肯定确实成立的部分**再指缺口(同 system-audit 的分层判定)。
5. **信息不足 → 列具体澄清问题,请人下一轮补,不硬编方案。** 问题要**具体到能拍板**(「作用域是共享还是 per-repo?」「认证接受 owner token 共享吗?」),不是开放式的「你觉得呢」。每个问题说明**为什么它 block 后续**(影响什么设计分叉)。issue 保持 open,多轮迭代收敛。
6. **产物结构**(comment,中文):理解复述(价值主张分解)→ 现状对照表(地基已有什么,`path:line`)→ 真实缺口(要落地必须补的,带证据)→ 张力/矛盾检查(与现有机制、与在途设计、拓扑分叉)→ 价值评估分档(⭐/◐/✗,按主张分别给,不整体二值判)→ 需人补充的 context(具体澄清问题)→ 下一步选项(A/B/C,不预设)。
7. **Label**:`idea` + `needs-human-confirm`;并发锁照常(`agent:processing`)。issue 保持 open 等人拍板。
8. **投入档位**:评估深度不省(对照代码逐主张坐实),但**验证层不同**——idea 不跑测试套件(没有要验收的实现),证据 = 本 repo 源码引用 + 既有设计文档 + 相关讨论原文。

**与 Research 的区别**:research 调研**外部系统**与本系统的结合点(双侧 subagent、查对方项目活性);idea 评估**内部提案**(单侧,但重点在「对照现有架构找已有/缺口/矛盾」+「把模糊处变成可拍板的问题」)。一个 idea 可能内嵌 research 需求(「用 X 来做这个」)——那就在评估里嵌套 research 那套双侧纪律。

**后续轮**:人答了澄清问题/拍了方向 → 按选定项拆自足 feature issue,或转 `/agentloop:design-review` 出设计;人否决 → 建议 close(人来 close,agent 不动手);人追问 → 原地编辑/追加 comment 回答。**多轮之后 idea 常收敛成 feature/design issue——那一刻起它就不再按 idea 处理**,切到对应类型的纪律。

## ★ 父级 rollup(孩子全关的父 issue 收尾)——授权的自动 close 例外

触发:`issue-sweep` Step 0.5 的 `graph-scan` 报出 `rollupCandidates`(open 父 issue
∧ 原生 sub-issue 全部已关),或人点名。**这是本 skill「绝不自动 close」铁律的唯一
显式例外,需 repo owner 授权**——修的是「孩子
全做完、父 issue 敞着等人 bump」的存量病。close 可逆(可 reopen),风险等级是噪音不是损坏。

**流程(顺序硬性):**

1. **幂等检查**:issue 已关 → 结束;已有 `<!-- rollup-done -->` marker comment → 结束。
2. **fencing 抢锁**:`claim.ts --issue <N> --action rollup`(见 ★并发锁)。输了 → 结束
   (另一台机器在做)。`agent:hold` 的父 issue **不做 rollup close**(hold = 人类保留
   终态,见并发锁表),只写综合 comment 不关。
3. **核对验收**:读父 issue 的验收标准/问题清单/body 意图,逐条对应到子 issue/PR 的
   落地证据(`path:line`、PR 链接、测试输出)。**动手前最后重读一次 issue state**
   (已关/有新人类 comment → 放弃动作,先按新输入走)。
4. **综合 comment**(中文,`> 🤖 AI Agent` 头 + `@ <hostname>`):逐条覆盖表 +
   每个子 issue 一句话结论 + 残留 gap(如有)。末尾带 `<!-- rollup-done -->` marker
   (幂等 key)。
5. **处置**:全覆盖 → `gh issue close <N> -r completed`;有残留 gap → 列出并**留开**
   (残留是有界任务就按「partial → 拆分」拆自足 spin-off 并写边)。research/idea 类
   父 issue 同样综合后 close——结论已在子 issue/comment 落地,父级只是收口。
6. **release claim**:`claim.ts --release <claimId>`;带 `agent:ready` 的同时摘掉
   (消费方处理完摘——close 的 producer 下轮也会清,留开的必须现在摘,否则队列视图
   一直显示"可干"误导人和其他 worker)。

## Doc-from-Issue 生命周期(这个 skill 所处的流程)

人起源的文档**从 issue 开始**,讨论到可落盘,再像代码一样提交进 repo。两层:

| 层 | 角色 | 性质 |
|---|---|---|
| **Issue = raw / 工作层** | 一切输入 + AI 铺开 + **AI review/audit(本 skill)** | 可变、可以脏、累积、AI 辅助;**永不进 repo** |
| **Repo = crystal / 结晶层** | 人逐字负责的极简文档,走 PR commit,回链 issue 作 provenance | 像代码一样;人对每个字负责 |

**方向单向**:脏的往精炼走;精炼的不回流污染(要改 = 开新一轮)。**Provenance 是 append-only 链**:`doc → 本轮 issue → 上轮 issue → …`,closed issue 永久可达。

### 人 / AI 的边界(按"后果可逆性"划,不按"是不是 outward")

agent 要**有判断力、自己动手**,不要事事请示。可逆的、可追溯的操作直接做;只有大动作 / 不可逆才停下来等人。

- **自动做,不问**(有判断力地做):发/改 comment、打/调 label、指派 assignee、判定并标 `status`、维护"活的 crystal"草稿;以及**该单独开 issue 的就直接开**——review 中发现的、明显独立于本文档的问题(安全漏洞、未接线的死代码、明确的 bug),**自动开新 issue**(挂好 label/milestone/assignee + 双向回链),**不征求用户意见**。
- **需人确认(只有大动作 / 不可逆)**:删除内容或文件、搬目录、PR merge、**close issue**、改架构方向的拍板。这些挂 `needs-human-confirm` 等人——理由:这是后果的承担点,AI 没有后果。
- **铁律**:产出始终带证据;**绝不**自动 merge / close issue / 删文件 / 改文档 frontmatter。**close 的唯一显式例外 = ★父级 rollup**(孩子全关 + fencing 互斥 + 验收核对全覆盖,close 可逆)与 `issue-sweep` 的「PR merged 未自动关」清理。

## Doc-audit 流程(审计存量老文档)

存量 `intent/` `planning/` 的逐篇清理。**不搬目录**(搬目录会破坏 issue↔文档路径 key、断 git history),只用 frontmatter `status` 标记 + 回链 issue;唯一物理改动是 `deprecated` 类删文件。

### 5 类 status 枚举(受控词表,替换历史上 30+ 种乱标)

| `status:` | 含义 | issue 去向 |
|---|---|---|
| `planned` | 有价值,还没实现 | **open**(tracker;创建前先 dedup 现有 issue/roadmap) |
| `partial` | 实现了,但不完整(**「待分诊」信号**) | **open**;gap 有 `path:line` 坐实 → **自动拆成独立自足 spin-off** 后**摘掉本 label**、换残留状态(剩漂移→`drifted`;无残留→`current`+待人 close);仍推测/未定的 gap 留 comment 给人确认。见「partial → 拆分剩余工作」 |
| `drifted` | 实现了,但文档漂移(描述的接口面 ≠ shipped 面) | **open** → 修文档 → 转 `current` |
| `current` | 实现了,文档准确 | **closed** + 审计记录 |
| `deprecated` | 废弃 | **closed**;内容先存 issue → 人确认 → 单独 PR 删文件 |

(在途新设计用 `draft`,不属审计 5 类。)

### 命名 / 归类约定

- **Milestone = 目录批次**:命名与归类跟随 repo profile 的 **Milestone Conventions**(arc 默认:`Doc Audit: intent/` / `Doc Audit: planning/` / `Doc Audit: docs/`),一个个清,防 issue 爆炸。
- **Label**:`doc-audit`(meta,全挂)+ `status:<x>`(本轮结论挂)+ `needs-human-confirm`(给了建议、待人确认 close/delete)。
- **标题**:`[<area>] <doc-name> — doc audit`,如 `[intent] session-protocol — doc audit`。
- **幂等 key**:issue body 首行 `<!-- doc-audit-key: <doc-path> -->`;创建前先 `gh issue list --search` 搜它防重复建。
- **Assignee(让对的人来 review)**:把 issue 指派给两类人——
  - **文档创建者**(创建 issue 时就能拿到):文档首次提交的作者。
    `sha=$(git log --reverse --format=%H -- <doc-path> | head -1); gh api repos/{owner}/{repo}/commits/$sha --jq .author.login`
  - **实现代码的提交者**(review 中定位到 `path:line` 后顺手拿):从实现文件的近期提交取、去重。
    `gh api "repos/{owner}/{repo}/commits?path=<impl-file>&per_page=5" --jq '.[].author.login'`
  - `gh issue edit <n> --add-assignee <login>`。**指派失败 / 非协作者就跳过并记一句,别 block。** 同一个人只指派一次。

### 文档侧 frontmatter 契约(resolve 时由人签名的 PR 写入)

```yaml
status: current        # 受控词表,grep ^status: 一把筛
audit: "#<N>"          # 回链审计 issue(issue body 反指文档路径,双向)
verified: 2026-06-24   # current 时记确认日期
```

### 生命周期

`create(一篇=一 issue,挂 milestone+doc-key)` → `review(冷启动:对照代码+跑测试,见下)` → `human 给意见(comment)` → `resolve(热启动:按 human 意见起草修复/crystal)` → `人确认 → close`。

### 批量建 issue(精简;review 时补全)

存量批量 issue 化时,**create 步骤刻意精简、不深读**:每个 issue 只放 doc-key + 目录/主文档链接 + frontmatter status + 文档自己的 anchor 行 + 通用 audit 任务模板。目的只是让人**快速浏览、给初步判断**,不是当场分析。**深度 overview 留到真正 review 时补。**

- **幂等**:create 前用 `doc-audit-key` 搜一遍,已存在就跳过——可重复跑、绝不重复建。这就是"哪些 doc 已 issue 化"的记录,不需要额外文件。
- **覆盖跟踪**:账本 = doc-audit issue 集合;覆盖率 = `(所有单元) − (已存在 doc-key)`;milestone 做可见聚合。
- **老式合集**(per-feature 约定前的扁平目录,如 `specs/`/`bugs/`/`*.legacy/`):**先 1 目录 = 1 issue 粗审**(整体是否 legacy),review 若发现需拆再拆 per-file。
- **审计阶段不必改 issue body**:结论 + 证据放 **verdict comment** 即可(body 保持精简,comment 紧随其下、足够清晰)。**仅在 resolve 阶段、或多轮后 body 已明显误导时,才(可选)补 body**——别为补 body 给每篇多烧 token。

### 批量 review 编排(model / 限速 / 并发)

几十~几百篇一起跑时,**skill 之外的编排层**有四条经验,务必守:

1. **Model 选最合适的,别默认继承 Opus。** doc-audit 是**有界任务**(读 1 篇 + skill + KB + grep 代码 + 可能 1 个测试 + 归 5 类 + 写 comment)→ **用 Sonnet**;**不用 Opus、不用 1M context**(单 agent 上下文远不到 200k)。`needs-human-confirm` 兜底,Sonnet 偶尔偏差人会接住。**Opus 只按需留给少数难/有争议的篇**(如安全 spin-off 复核)单独重跑。成本差 ~5×。
2. **限速:GitHub「内容创建」是硬约束(≤500/h、≤80/min)。** 批量 POST 大头是 comment,所以:
   - **每 agent 只发 1 条 verdict comment**;
   - **大批量时 agent 不各自发 KB comment**(否则 POST 翻倍)——新拓扑事实写进 agent 返回行,**KB 由单点(主控)集中折叠**;
   - spin-off 仅在确有独立真问题时;
   - gh 遇 403 secondary limit → 退避重试(≤3 次),仍失败标 `RATE-LIMITED`、不整篇报错(可 resume 补);
   - 估算:N 篇 ≈ N 个 POST,确保 < 500/h;N 很大就分段/降并发拉长时间。
3. **并发 = 吞吐 × 限速的平衡。** ~10–14 并发 × 每 agent ~2–3min ≈ ~4–5 POST/min(~250–300/h),稳在限速下;别盲目拉高并发触发 80/min burst。
4. **KB body 单点编辑。** 并行 agent **只读 KB、不写 body**;新事实由主控在每段/每批后统一折叠(见「共享 KB」)。**仅交互式 session** 可用 Workflow 编排(批量跑应 resumable,失败/限速可续);**无人值守 routine 绝不 Workflow、绝不 AskUserQuestion**——串行 inline + 待拍板问题落 comment(见 [`issue-sweep` 无人值守铁律](../issue-sweep/SKILL.md))。

### Spin-off issue(自动开,不问)

review/audit 中常会撞到**独立于本文档 status 的真问题**(安全漏洞、未接线死代码该不该留、明确的 bug)。这些**不要埋在审计 comment 里**,也**不要等用户点头**——**直接开一个独立 issue**:贴切 label、assign 相关代码提交者、双向回链审计 issue,并在审计 comment 里一句话提"已 spin-off 到 #N"。开 issue 可逆可追溯,属"自动做"。

- **只为「清楚 / 已确认」的问题自动开**:有坐实证据的 bug/漏洞、或 human 已批准要开的。**仍悬而未决的疑问 / 方案 A-B-C 没定的,不要先开 issue**——留在 comment 里给人拍板,定了再开。
- **开完必写原生边(写边纪律)**:body 首行 `<!-- spinoff-of: #N -->` 标记之外,同时
  `bun <plugin_root>/skills/issue-graph/scripts/link.ts --parent <N> --child <新号>`(幂等)。
  标记是 provenance,**原生边才进确定性图计算**(close-kick / rollup);不写边 = 这个
  spin-off 关闭时永远不会 kick 回父 issue。
- **发现即修升级**(对齐 [`pr-review` ★ 发现即修](../pr-review/SKILL.md)):spin-off 里满足四门(证据坐实 · 修法无歧义且有界 · 非安全 · 无需方向拍板)的缺陷——尤其截图一眼可见的 UI 缺陷——**开 issue 的同时当场修并开 fix PR**(before/after 截图 + verification),issue 只作 tracking 回链,不留给「下一轮/其他 agent」。
- **优先级用受控词表**(防 label 漂移,和 status 同理):`P0`(紧急 / 安全)· `P1` · `P2` · `P3`(低优);安全类另加 `security`。缺这些 label 就建,但**只用这套词**,别再造 `priority:high` / `urgent` 等变体。

### partial → 拆分剩余工作(status:partial 的主结论处理)

上面 Spin-off 讲的是 review 中**附带撞到**的独立问题。**这一节讲不同的场景**:当审计的**主结论就是 `partial`**(主体已落地、剩几个有界子任务没做),正确动作是把**剩余工作分解成独立、无依赖、自足的实现 issue**——别只在 comment 里列 gap 等人。

**触发(证据坐实即自动拆,不问):** gap 有 `path:line` 坐实确属未完成(如「`grep this.emit providers/iot/frigate/` → 0 命中」),就自动拆。**仍推测性 / 方案 A-B-C 没定的 gap 不拆**,留 comment 给人拍板,定了再拆(和 Spin-off 同一条原则)。

**拆分纪律:**

1. **先分清「未完成的任务」 vs 「已完成但文档漂移」——只拆前者。**
   - **未完成的功能任务**(代码确实没写)→ 拆成 feature spin-off。
   - **已完成但文档没回头更新**(测试计数过时、checkbox 没勾、decisions「待定」其实已决)→ 这是**本审计自身的 resolve**(由人签名 PR 修文档),**不拆 issue**,否则制造噪音。在审计 comment 里明说这几项留给 resolve。
2. **颗粒度:独立可完成、无步骤依赖。** 一个能被一个人独立做完、不依赖另一个的单元 = 一个 issue(如不同 provider / 不同 API 各一个)。**绝不**拆出「先做 A 才能做 B」的链式 issue。
3. **feature spin-off ≠ doc-audit**:**不挂** `doc-audit` label、**不挂**审计 milestone(这是实现任务不是文档审计);用 `feature` + 优先级(受控词表)。标题用实现口吻,如 `[frigate] emit events into AFS EventBus`。
4. **每个 spin-off 必须自足**(让只看 issue 的 agent 就能开工),固定配方:
   - **目标**:一句话 + 现状证据(`grep`/`path:line` 证明缺什么)。
   - **背景**:一句话点明所属系统。
   - **参考实现**:已落地的同类范式 `path:line`(照抄即可),含关键签名 / 约定。
   - **具体任务** + **命名/路径约定**(对齐范式)。
   - **验收标准**(可勾选;含具体测试命令 + 要贴 pass/fail)。
   - **Optional research**:回引原审计 issue #N + 相关 spec——标明是**可选**研究,不是必读前置。
5. **双向回链 + 原生边**:spin-off body 首行 `<!-- spinoff-of: #N ... -->` + Optional research 引 #N;原 issue 落一条 comment 列出拆出的 #X/#Y(表格:范围 + 独立性)+ 剩余 resolve 动作。**每个拆出的 spin-off 同时 `link.ts --parent <N> --child <#X>` 写原生边**(写边纪律,close-kick/rollup 依赖它)。
6. **拆完立即摘掉 `status:partial`,换成残留真实状态(否则误导 human review)。** `status:partial` 是**「待分诊」信号**;`path:line` 坐实的 gap 一旦全部 routed 到 tracking issue,它就会让 human 误判本 issue 还有未处理的实现缺口。摘 label / 换 label 可逆 → **自动做**:
   - **本 issue 还有残留**(典型:文档漂移——「已完成但文档没更新」)→ 换 `status:drifted`(open,等人签名 PR 修 doc 文本 → 转 `current` → close)。
   - **完全无残留**(gap 全 track + 无漂移)→ 换 `status:current`(或无 status)+ 保留 `needs-human-confirm`,作「审计完成,待人最终 close」信号。
   - **拆分≠完成,但「本 issue 的 partial 工作已分诊完毕」= 完成**——区别在于:剩余实现工作的家已搬到 spin-off,本 issue 只剩 doc resolve(或无)。
   - **仍绝不自动 close / 改 frontmatter**(那是人的不可逆动作);最终 resolve(写 frontmatter + 修 doc + close)由人签名 PR。label 归 AI(可逆)、frontmatter 归人(签名)。

## How It Works(冷启动首轮)

```
┌────────────────────────────────────────────────────────────┐
│  0. 读 thread,判轮次。后续轮 → 走上面"轮次感知",别全量重跑   │
│                                                             │
│  1. 读 issue 全貌(body + 全部 comments,含 human 意见)      │
│                                                             │
│  2. 读被处理文档 + 引用的 spec/design / 对标范式             │
│                                                             │
│  3. ★ 对照已落地实现/代码/intent(最关键)                    │
│     逐条声明 → grep/read 定位 `path:line`,或标 NOT FOUND     │
│                                                             │
│  4. ★ 真跑测试(doc-audit 必做)                              │
│     找到相关测试 → 跑 → 记录确切命令 + pass/fail              │
│                                                             │
│  5. 出结论:逐条验证表 + 测试结果 + gap + 推荐 status,带证据  │
│                                                             │
│  6. 落 comment(中文),挂 status + needs-human-confirm 标签   │
│     不 close、不删文件、不改 frontmatter                     │
└────────────────────────────────────────────────────────────┘
```

## Implementation Instructions

### Step 0 — acquire 并发锁 + 判轮次 + 读 KB 热启动(先做,决定省不省)
**最先 acquire 并发锁**(见「★ 并发锁」):已被新鲜 `agent:processing` 持有 → SKIP 退出;否则加锁(`--dry-run` 不加)。再读共享 KB(`gh issue view <kb_issue>` 的 body)拿 repo 拓扑热启动,别从零探索。再 `gh issue view <n> --comments`:有既往 AI 结论 + human 意见 → 走「轮次感知」热启动路径,**跳过**下面会重复的全量步骤,只做 human 指定的下一步;否则走冷启动 Step 1–6(冷启动也按价值分档)。**收尾**:把本轮新学到的拓扑事实 append/修正进 KB body,并 **release 锁(Step 7)**。

### Step 1 — 读 issue 全貌
`gh issue view <n> --json title,body,author,labels,state,milestone` + `--comments`。记下:文档路径、引用的 spec/范式、关键 commits、**全部 human/AI 意见**(human 意见优先级最高)。

### Step 2 — 读文档 + 引用物
Read 被处理文档全文 + 它引用的 spec/design / 声称对齐的范式(如 `docs/architecture/did-space.md`)。

### Step 3 — ★ 对照已落地实现/代码/intent
**这是把"读起来对"和"其实已落地 / 方向反了 / 接口面漂了"区分开的关键。** 不要只在文档间比对——查真实代码:

```bash
find . -path ./node_modules -prune -o -iname "*<topic>*" -print
grep -rniE "<关键路径或符号>" -l . | grep -vi node_modules
ls intent/<topic>/ ; sed -n '1,80p' intent/<topic>/INTENT.md
```

逐条声明 → 定位 `path:line` **或标 NOT FOUND**。注意:历史文档常见 `TASK.yaml` 标 done 但 `INTENT.md`/`plan.md` 没回头更新 → **status frontmatter 普遍不可信,必须对照代码重验,绝不信 status。**

### Step 4 — ★ 真跑测试(doc-audit / 验收点名的验证)
找到相关测试(`pnpm --filter <pkg> test` / `bun test <path>`),**真的跑**,把**确切命令 + 真实 pass/fail 计数**记进结论。

> 上面的 targeted `bun test <path>` 是为坐实**某一条 doc-audit claim**(只想要那一个测试的输出当证据)——保持轻量,别为一条 claim 跑全量门控。**下面这套只在 issue 是 feature/task、验收标准或 human 点名了验证手段时适用。**

**当验收 / human 点名了验证——「本环境跑不动」是要被证明的结论,不是预设借口。** 用**仓库自己的 blessed skill**,别自己手搓命令再手填数字:

1. **结构性 PR 门控(build / lint / types / tests / architecture)走 `/agentloop:verification`。** 跑 `<verification_entry>`,**数字由脚本测出、不手填**。**不要**自己 `pnpm build` / `bun test` 再手写「759 pass」——那正是手搓命令 + 手填计数的反模式,也是 `/agentloop:verification` 要消灭的非确定性。见 [`verification` skill](../verification/SKILL.md) + CLAUDE.md「Self-Verification」。
2. **验收点名的集成 e2e(blocklet render / mount / serve)走 `/e2e-verify`——先尝试再下结论。** 它自己 `pnpm build` + boot **两个** runtime(`dev_server_node` + `dev_server_edge`,见 repo profile)——**边缘侧 = `<dev_server_edge>` 起本地环境,不需要云账号、不碰线上环境;所以 edge-parity / runtime 类验证本地就能做,绝不判成「需要云端环境」而 defer——那是错的。别把「别猛测线上环境」当成「本地验不了」**;**`<cli_binary>` 缺失/陈旧就先 `/setup-local-cli`**(e2e-verify 自身也这么要求)。`/agentloop:verification`、`/e2e-verify`、`/setup-local-cli` 你**完全可以调用**——没真跑过就写「需要 daemon / 本环境无法执行」= 失败,**也不能拿 unit test 顶替点名的 e2e**。
3. **缺依赖 = 多一步 setup,不是「跑不动」。** 原生插件没编译(如 better-sqlite3 → `npx node-gyp rebuild`)、CLI 没 link、没 build —— 先把 setup 做掉再跑,别当环境限制。
4. **真正的硬限制才算「跑不动」**:沙箱根本没那条工具链(repo profile **Deployment Environments** 列出的平台工具链,arc 例:无 Xcode → Swift、无 Android SDK → Kotlin、无 Playwright MCP → e2e-verify 的 Tier B 真浏览器),**且已实际撞墙**。**`dev_server_edge` 不在此列**——它是本地环境,永远不算「跑不动」。这时贴**确切命令 + 确切报错**,退而用能跑的那部分兜底(`/agentloop:verification` 脚本 / 别的 tier / 静态对照),并**显式标注跳过了哪一层**(如 `Tier B skipped/no-playwright`)。
5. **绝不假装跑过、不手填数字。** 没跑就说没跑;跑了就贴 skill / 脚本的真实输出。

### Step 5 — 出结论
- **逐条验证表**:claim → `path:line` 或 NOT FOUND。
- **测试结果**:命令 + pass/fail。
- **gap 列表** + **phase 完成度**(doc-audit)。
- **推荐 status**(doc-audit 5 类之一)或 **分级发现**(doc-review:🔴 回归/方向错 · 🟡 真增量 · 🟢 已落地复述 · ⚪ 可删)。
- **reframe**(如适用):文档整体站错层/重开已结的题时,直接说"这一轮真正该产出什么"。
- 价值在**独立发现**,不在复述 human。

### Step 6 — 落 comment(产物归宿)
用 `comment_language` 指定的正文语言写(arc 默认:中文),顶部标 AI 身份与读取/运行范围:

```
> 🤖 AI Agent Audit @ <hostname> · runner:<runner> · skills@<hash> — Claude Code(<model>)。读取:<文档+代码+测试>。运行:<测试命令>。每条发现附可复现证据。
```

整行 header **必须由单点脚本生成**(`agent_identity_script`,arc 默认 `scripts/agent-identity.sh`;环境/归属/skills 版本三维溯源,不能用日期、占位符或手拼代替),行尾追加模型与范围:
```bash
bash <agent_identity_script> --header "Audit"
# → "> 🤖 AI Agent Audit @ vm · runner:<name> · skills@a2298a3b"
```
runner 解析优先级、skills hash 语义、前缀谓词纪律见根 CLAUDE.md「Agent Comment 格式」。

```bash
gh issue comment <n> --body-file <draft.md>                 # 新发现 = 新 comment
gh issue comment <n> --edit-last --body-file <draft.md>     # 改写/补充既有结论(如翻译)= 原地编辑,不新发
gh issue edit <n> --add-label "status:<x>,needs-human-confirm"
```

- **新发现 = 新 comment;更新既有结论(翻译、补证据、回应 human)= 原地编辑那条 comment**,别堆重复 comment。
- **截图证据的两道硬验收**(破图事故的防复发规则):① 上传**只走** `<ui_upload_script>`(`agent_identity_script` 同节的 Agent Tooling,arc 默认 `<ui_upload_script>`;`ASSET_CONTEXT=issue-<N>`)或 ui-verify Path B(MCP),脚本 **exit 3** = 本地脚本与 origin/<default_branch> 不一致(陈旧 checkout,正是事故根因)→ `git checkout origin/<default_branch> -- <ui_upload_script>` 后重跑,不许 `ALLOW_STALE_UPLOADER=1` 绕过;② 任何要内嵌进 comment 的图片 URL 必须**无凭据 curl 200**(camo 匿名视角;Path A 脚本已内置,MCP 路径手动验)——非 200 的 URL 内嵌必破图,禁止发出。
- **默认自动发/改、自动开 spin-off issue、自动调 label,不必先问**(agent 有判断力)。`--dry-run` 是显式 opt-out:用户想先预览时才用(不做任何 outward 写)。
- **审计阶段产物 = verdict comment + labels,不动 body**(body 精简、comment 紧随其下,人已易读);body 补全留到 resolve 阶段、且可选。

### Step 7 — release 并发锁(收尾必做)
处理结束(成功、跳过、出错都算)摘掉 `agent:processing`:`gh issue edit <n> --remove-label agent:processing`。**`agent:hold` 不动**(那是人的预约,只有人摘)。`--dry-run` 没加锁则无需摘。漏摘也不致死——TTL 30min 自动失效。

## Key Principles

1. **先判轮次 + 按价值分档,别浪费 token。** issue thread 是累积状态;后续轮信任既往已核验证据,只对"变了/被质疑"的部分做新鲜验证。**冷启动也分档**:明显废弃的只轻确认(不 build、不跑测试、不逐条 path:line),全量审计只留给真活着、细节要紧的文档。投入与文档价值成正比。

2. **human comment 是方向,不是圣旨。** 优先按它走,但容忍其不完整、可能有疑问、可能多人冲突:human 没 cover 的真问题仍要指出;是疑问就答而非盲从;多条来自不同人就逐一调和、把冲突摆出来让人定——不替人悄悄选。

3. **产物落 issue,不落会话。** 一次处理跑完 = issue 里多了可被下一轮接力的 comment,而不是某人脑子里多了点印象。

4. **每条发现都要有可复现证据。** `path:line` / grep 命中 / **真实测试输出** / `gh` 输出。无证据 = 不写。

5. **对照已落地实现是第一优先,doc-audit 必须真跑测试。** 文档自洽 ≠ 和现实一致;`status` frontmatter 普遍不可信。最有价值的发现是"已实现 / 方向反了 / 接口面漂了",且用测试结果坐实。

6. **价值在独立发现,不在复述 human reviewer。**

7. **按后果可逆性划自主边界,要有判断力。** 发 comment / 打 label / 指派 / **该开的 issue 直接开**——可逆可追溯的自动做,不请示。只有删内容或文件、搬目录、merge/close issue、改架构方向这类大动作或不可逆操作才挂 `needs-human-confirm` 等人。**绝不**自动 merge/close/删文件/改 frontmatter(close 唯一例外 = ★父级 rollup,经授权)。开 spin-off 必写原生边(`link.ts`)。

8. **不在已有的家旁边另起炉灶。** 起草任何新 crystal 前,先确认这块内容是不是已有 intent/planning/provider 在承载;增量叠在已有真相源上并显式指向它。

9. **不搬目录。** 存量审计只改 frontmatter `status` + 回链 issue;`deprecated` 才删文件(内容先安全进 issue + 人确认 + 单独 PR)。搬目录会断 issue↔路径 key 和 git history。

10. **用共享 KB 热启动,别重复探索。** 先读 repo profile 的 `kb_issue`(pinned 知识库 issue)拿 repo 拓扑;hints 非真相,信任 + 便宜复查、读到错就改;末尾 append 新事实。免得每个 agent 傻乎乎重新发现同一批拓扑。

11. **partial 的剩余工作要拆,拆完即摘 label。** `status:partial` 主体已落地、剩有界子任务没做时,把 `path:line` 坐实的未完成任务自动拆成**独立、无依赖、自足**的 feature spin-off(配方见「partial → 拆分剩余工作」);**已完成但文档漂移**的不拆(那是本审计的 resolve)。**gap 全部 routed 后立即摘掉 `status:partial`**(它是「待分诊」信号,留着会误导 human review),换成残留真实状态:剩漂移 → `status:drifted`;无残留 → `status:current`/无 status + `needs-human-confirm`(待人最终 close)。label 归 AI 可逆自动调;close / frontmatter 归人签名 PR。
12. **开工先 acquire 锁,收尾必 release。** 多 actor(cron sweep + 多人本地手工)并发处理同一 issue 会重复烧 token、重复评论。`agent:processing`(TTL 30min advisory 锁)在 `issue-review` 开工最前获取——新鲜则 SKIP、过期则抢——把撞车从"收尾才发现"提前到"开工就短路";`agent:hold` 是人类预约(自动化永久绕开,只人摘)。锁是 advisory,**硬去重仍靠 `issue-sweep` 的确定性分支 + 认领检查兜底**。`--dry-run` 不动锁。

13. **验收 / human 点名的验证是契约,「本环境跑不动」要先证明。** 结构性门控走 `/agentloop:verification`(`pre-pr.ts`,数字由脚本测、不手填);验收点名的集成 e2e 走 `/e2e-verify`(`<cli_binary>` 缺/陈旧先 `/setup-local-cli`)——这些 skill 你完全能调,缺依赖先补 setup(编译原生插件、link CLI、build),只有实际撞上硬工具链缺失(repo profile **Deployment Environments** 所列平台工具链,arc 例:无 Xcode/Android SDK/Playwright)才算「跑不动」,且贴确切报错 + 显式标注跳过哪层。**不拿 unit test 顶替点名的 e2e,不手搓命令手填数字,不预先开脱,不假装跑过。**

14. **生成方案设计时,grounding 纪律和审计时一样严:客观、精确、实事求是。** issue-review 不只审计既有文档——也常被用来给 feature/design issue **产出新方案**(issue-sweep feature 行)。产出设计时同样守纪律:① 每条关于**现状**的断言(架构、存储后端、API、文件布局、现有行为)`path:line` 坐实——**代码是唯一权威**,与引用的 planning/docs 冲突时以代码为准**并指出文档过时**;② 每个**数字**(延迟/吞吐/大小/数量/上限)要么**实测**(附命令+输出)、要么**显式标注为未验证估计**、否则删掉——**凭空的延迟/性能数字是最高发的幻觉**,与 human 在 issue 给的实测冲突时以实测为准;③ 明确区分 **as-is(已核实)** 与 **proposed(新增)**。臆造的后端/布局会让后续所有 phase 建在错地基上。方案 **post 回 issue 前过 `/agentloop:design-review`**(其事实+数字 grounding 是 HARD GATE),别手 post 未审的设计。


## ★ sweep-trace 埋点（round-awareness 判据 / L2 可观测层）

每条本 skill 发往 issue 的 review verdict comment 末尾**必须**附一行 sweep-trace HTML 注释（人不可见、grep 可查）：

```html
<!-- sweep-trace: {"ver":1,"issue":N,"gate":"review","val":"<val>","run":"<ISO8601>","runner":"<runner>","skills":"<hash>"} -->
```

**这不只是可观测——它是 issue-sweep 轮次感知的判据。** sweep 靠**机器标记**（sweep-trace / `Generated by [Claude Code]` footer / Bot 作者）区分「agent 裁决（跳过）」与「人类输入（响应）」，**不靠 `> 🤖` 头**——因为人和 agent 用同一个 `agent-identity.sh` 生成头、格式逐字节相同（实盘 arc#1722：人手贴的指令被当成 agent 裁决跳过 19h）。**本 skill 的评论若不带 trace，会被 issue-sweep 误判成「未处理的人类输入」→ 每轮重复处理/重复评论**（arc#1722 的反向作用正是这个缺口）。identity 头和 `runner:…·skills@…` 行**不算**机器标记（人也会有）。
