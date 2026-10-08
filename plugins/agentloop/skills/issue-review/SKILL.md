---
name: issue-review
description: >-
  Process one GitHub issue end-to-end: read it with its docs, code and comments, verify against
  the landed implementation, and post evidence-backed findings. Covers doc-review, doc-audit,
  system-audit, research and idea issues; issue-sweep calls it per issue.
---

# Issue Review — AI Agent Review / Audit for Doc-from-Issue

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic;
> **arc is the reference implementation.** Use the profile's `repo_slug`, `package_manager` / `test_runner`,
> `kb_issue`, `plugin_root` (where issue-graph's scripts live), and toolchain wherever this doc shows an arc default. Arc's own provenance
> for the lessons below is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

把一篇 issue 处理到位:读 issue + 引用的 repo 文档/代码 + 已有 comments + **对照已落地的实现/代码/intent**,产出**带证据**的发现,作为 comment 落回 issue(而不是埋在某次对话里)。覆盖五类:

- **Doc-review**:人起源的**新设计**在 issue 里被讨论/评审(找漂移、独立发现、reframe)。轻量、讨论导向,产出 = 评审 comment + 拆分建议。
- **Doc-audit**:repo 里的**存量老文档**被逐篇审计(对照代码重验、跑测试、给 5 类结论)。**有界**单元,按价值分档投入。
- **System-audit(comprehensive code audit)**:issue 要求对一个**子系统 / 跨平台 parity / runtime 本身**做全面代码审计(如「Swift/Kotlin 实现是否落后于 Node/CF 参考」)。**无界**任务,**完整执行是契约**——见下「★ System-audit」。
- **Research(研究类)**:issue 要求**调研一个外部系统/技术与本系统的结合点**(如「研究 perkeep 和 did space 的结合点」)。**调研这一轮只产出 comment,不改 repo 代码**;下一轮按 ratchet 转执行管道——见下「★ Research」(铁律 1 与铁律 10)。
- **Idea(想法类)**:issue 是一个**内部提案/想法**(如「提供一个 DID Space + MCP endpoint 给 loop 里的 agent」)——可能可行、可能不可行、可能太模糊、可能与现有设计矛盾。**首轮是 clarify,不是执行**;首轮产出 = 评估 comment + 澄清问题 + 行动声明,**首轮不改 repo 代码、不开 spin-off**;**第二轮起按 ratchet 开工**——见下「★ Idea」(铁律 2 与铁律 10)。

五类共用同一台引擎(读 → 对照现实 → 带证据落 comment),但**投入档位和产出形态不同**:doc-review 轻、doc-audit 按价值分档、**system-audit 必须全量**、research/idea 深调但**首轮**只落 comment(下面「省 token」那套**不适用于 system-audit 和 research/idea 的调研深度**)。**research/idea 的「只落 comment」是首轮限定,不是永久状态**——两者的铁律 10 都要求第二轮起转成动作,否则就是原地打转。

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

两个 label:`agent:hold` = 人类保留(只人加只人摘;冻结 close/merge 等终态动作,**不**冻结处理——人类新评论照常响应);`agent:processing` = advisory 互斥锁(TTL 30min):开工 acquire,见**新鲜**锁就 SKIP,过期则抢;收尾(成功/跳过/出错)必 release。`--dry-run` 不动锁。

加锁/摘锁的命令、TTL 判定、与 issue-sweep 分支的关系: Read [reference/lock-and-rounds.md](reference/lock-and-rounds.md).

## ★ 轮次感知 + 省 token(每次调用先做这件事)

先 `gh issue view <n> --comments` 判轮次:**首轮**(无既往 AI 结论)→ 按价值分档(明显废弃的只轻确认,不 build/不跑测试;真活的才全量 `path:line` + 真跑测试);**后续轮**(已有 AI 结论 + human 意见)→ 不重做,既往证据当既成事实,只做 human 指定的下一步。分档只约束 doc-review/doc-audit,**System-audit 不省**。

分档细则: Read [reference/lock-and-rounds.md](reference/lock-and-rounds.md).

## ★ System-audit(comprehensive code audit)——完整执行是契约

issue 要求全面代码审计(子系统 / 跨平台 parity / runtime)时,**完整执行是契约,粗略 = 失败**:逐文件/逐面覆盖,不按价值省 token。

When the issue is a system-audit (覆盖清单、编排/model、跨 repo 一致性审计、共享 KB、Memory MCP): Read [reference/system-audit.md](reference/system-audit.md).

## ★ Research(研究类 issue)——外部系统 × 本系统结合点调研

When the issue is a research issue (外部系统 × 本系统结合点调研;流程、产物、ratchet 收尾): Read [reference/research.md](reference/research.md).

## ★ Idea(想法类 issue)——先 clarify,open 评估,不当指令

想法类 issue:先 clarify,open 评估,**不当指令**;回应人类时收尾写「下一轮我会做 X,除非你说不」(ratchet),`needs-human-confirm` 只留给互斥且不可逆的真分叉。

When the issue is an idea issue (完整流程与铁律): Read [reference/idea.md](reference/idea.md).

## ★ 父级 rollup(孩子全关的父 issue 收尾)——授权的自动 close 例外

孩子全关的父 issue 是本 skill **唯一**授权的自动 close 例外;其余 close/merge/删文件永不自动。

When a parent issue's children are all closed (判据、综合 comment、close 条件): Read [reference/parent-rollup.md](reference/parent-rollup.md).

## ★「建议关闭」类结论清单 → 落地时立即挂 `agent:hold`(arc#2914)

任何列出多个 issue 并给「建议关闭 / 合并 / 删除」结论的清单,**落地的同一时刻**给清单点名的每个 issue 挂 `agent:hold`(摘除只人)。

细则与例外: Read [reference/parent-rollup.md](reference/parent-rollup.md).

## Doc-from-Issue 生命周期(这个 skill 所处的流程)

When the issue is a doc-review / doc-audit (生命周期、人/AI 边界、5 类 status 枚举、命名、frontmatter 契约、historical 归档、批量建/审 issue、spin-off、partial 拆分): Read [reference/doc-audit.md](reference/doc-audit.md).

## Doc-audit 流程(审计存量老文档)

status 只用受控 5 类(见 reference);存量审计只改 frontmatter `status` + 回链 issue,**不搬目录**;`deprecated` 才删文件(内容先进 issue + 人确认 + 单独 PR)。Spin-off issue 自动开、不问,并写原生边(`link.ts`)。`status:partial` 的剩余工作拆成独立 spin-off,gap 全部 routed 后立即摘 `status:partial`。

完整流程: Read [reference/doc-audit.md](reference/doc-audit.md).

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
│ 5.5 能给安全默认就别升级(needs-human-confirm 硬前置)         │
│ 5.7 沉默规则:agent 自发 + 无动作无新信息 → 本条不发,只记账    │
│                                                             │
│  6. 落 comment(中文),挂 status(+ 真分叉才挂                │
│     needs-human-confirm);不 close、不删文件、不改 frontmatter│
└────────────────────────────────────────────────────────────┘
```

## Implementation Instructions

### Step 0 — acquire 并发锁 + 判轮次 + 读 KB 热启动(先做,决定省不省)
**最先 acquire 并发锁**(见「★ 并发锁」):已被新鲜 `agent:processing` 持有 → SKIP 退出;否则加锁(`--dry-run` 不加)。并行 `issue-sweep` 的主控只分配 slot、**不替 worker 预加锁**;worker 到这里自行即时 acquire。再读共享 KB(`gh issue view <kb_issue>` 的 body)拿 repo 拓扑热启动,别从零探索。再 `gh issue view <n> --comments`:有既往 AI 结论 + human 意见 → 走「轮次感知」热启动路径,**跳过**下面会重复的全量步骤,只做 human 指定的下一步;否则走冷启动 Step 1–6(冷启动也按价值分档)。**收尾**:普通单 issue 调用把本轮新学到的拓扑事实 append/修正进 KB body;作为并行 `issue-sweep` worker 时不直接改 KB body,把结构化 KB delta 返回主控统一折叠。两种模式都由本 worker **release 锁(Step 7)**。

**claim 后、任何实现/worktree 写入前必须检查开放 PR 路径重叠。** 当本轮将进入实现时，
先从已核验的执行计划形成结构化 `allowedPaths`（repo-relative file/directory prefixes；不得从
issue 标题或自然语言猜），再运行：

```bash
bun <plugin_root>/scripts/check-pr-path-overlap.ts --run-args '{"allowedPaths":["<prefix>"]}'
```

目录 prefix 包含具体文件，所以 `scripts/` 与 PR 的 `scripts/foo.ts` 是 overlap。`overlap`
必须在开工前报告 PR 号和具体文件，再由人/既有策略决定是否继续；`clean` 才表示确实查过且
无重叠；`unavailable`（paths 缺失/为空、`gh`/网络/auth/数据不可读）必须停止实现并显式回报，
不得当成 clean。comment-only 的 review 无 repo write，不伪造 `allowedPaths`，也不得声称已做
路径重叠检查。

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

找到相关测试,**真的跑**,把确切命令 + 真实 pass/fail 计数记进结论(单条 doc-audit claim 只跑那一个 targeted 测试)。验收 / human 点名了验证时:跑改动包的测试(`<package_manager> --filter <pkg> test`,贴确切命令 + 计数,**不手填**);点名的集成 e2e 走 `/e2e-verify`(`<cli_binary>` 缺/陈旧先跑 `<cli_setup_command>`;`<dev_server_edge>` 是本地环境,永远不算「跑不动」)。缺依赖 = 多一步 setup。只有 repo profile **Deployment Environments** 所列工具链真缺且已撞墙才算跑不动:贴确切命令 + 报错,显式标注跳过了哪一层。**不拿 unit test 顶替点名的 e2e,不假装跑过。**

逐条展开与反例: Read [reference/verification.md](reference/verification.md).

### Step 5 — 出结论
- **逐条验证表**:claim → `path:line` 或 NOT FOUND。
- **测试结果**:命令 + pass/fail。
- **gap 列表** + **phase 完成度**(doc-audit)。
- **推荐 status**(doc-audit 5 类之一)或 **分级发现**(doc-review:🔴 回归/方向错 · 🟡 真增量 · 🟢 已落地复述 · ⚪ 可删)。
- **reframe**(如适用):文档整体站错层/重开已结的题时,直接说"这一轮真正该产出什么"。
- 价值在**独立发现**,不在复述 human。

### Step 5.5 — needs-human-confirm 硬前置(issue #1860)

打 `needs-human-confirm` 标之前先问一遍:**我能不能说出一个安全默认动作?** 能 → 禁止升级,当场按 ratchet(默认放行,出问题再收紧,同 [`pr-review` Step 5.5](../pr-review/SKILL.md))执行该动作并留 trace;不能,才是真判断题,才配打 `needs-human-confirm` 走 Step 6 的结构化拍板块。这条硬前置在**打标动作之前**过,不是打完标再补。

### ★ Step 5.7 — 沉默规则:没有状态变化就不要发言(硬前置,在 Step 6 之前过)

**发 comment 前先答:这一轮让世界发生了什么变化?** 有动作(开 issue/PR、改 label)或有新信息 → 发;两者都没有 → **不发**,只进 run report。**只管 agent 自发的复核;对人类输入必须回应**(否则 round-awareness 认定未处理、每轮重跑)。

适用面与边界细则: Read [reference/silence-rule.md](reference/silence-rule.md).

### Step 6 — 落 comment(产物归宿)
用 `comment_language` 指定的正文语言写(arc 默认:中文),顶部标 AI 身份与读取/运行范围:

```
> 🤖 AI Agent Audit @ <hostname> · runner:<runner> · skills@<hash>[ · engine:<kind>[/<model>]]。读取:<文档+代码+测试>。运行:<测试命令>。每条发现附可复现证据。
```

整行 header **必须由单点脚本生成**(`<agent_identity_script>`;环境/归属/skills/engine 四维溯源,不能用日期、占位符或手拼代替——尤其别再手写死 "Claude Code(<model>)",脚本按 `ARC_AGENT_ENGINE`/`ARC_AGENT_MODEL` 自动带出真实 engine,Codex 下跑手写死会错误自称 Claude),行尾追加读取/运行范围:
```bash
bash <agent_identity_script> --header "Audit" --skill issue-review
# → "> 🤖 AI Agent Audit @ vm · runner:<name> · skills@a2298a3b"
```
runner 解析优先级、skills hash 语义、前缀谓词纪律见根 CLAUDE.md「Agent Comment 格式」。

```bash
# ★ 先过 Step 5.7 沉默规则:agent 自发路径 + 无动作 + 无新信息 ⇒ 这三行一行都不跑。
gh issue comment <n> --body-file <draft.md>                 # 新发现 = 新 comment
gh issue comment <n> --edit-last --body-file <draft.md>     # 改写/补充既有结论(如翻译)= 原地编辑,不新发
gh issue edit <n> --add-label "status:<x>"                  # needs-human-confirm 另说,见下
```

- **`needs-human-confirm` 不是默认搭配。** 上面的命令刻意只加 `status:<x>`——这个标要过 Step 5.5
  硬前置(说得出安全默认就禁止升级),★Research/★Idea 另有铁律 7 收紧到「只贴真分叉(互斥且不可逆)」。
  确属真分叉时单独加:`gh issue edit <n> --add-label needs-human-confirm`。
- **新发现 = 新 comment;更新既有结论(翻译、补证据、回应 human)= 原地编辑那条 comment**,别堆重复 comment。
- **截图证据的两道硬验收**(破图事故的防复发规则,issue #3010 扩了第三条):① 上传**只走**
  `<ui_upload_script>`(`agent_identity_script` 同节的 Agent Tooling,arc 默认 `<ui_upload_script>`;
  `ASSET_CONTEXT=issue-<N>`),脚本 **exit 3** = 本地脚本与 origin/<default_branch> 不一致(陈旧
  checkout,正是事故根因)→ `git checkout origin/<default_branch> -- <ui_upload_script>` 后重跑,
  不许 `ALLOW_STALE_UPLOADER=1` 绕过;② 任何要内嵌进 comment 的图片 URL 必须**无凭据 curl 200**
  (camo 匿名视角;脚本已内置该抽查)——非 200 的 URL 内嵌必破图,禁止发出;③ **上传器两条通道都不可用
  (exit 2)时的确定性兜底是浏览器原生附件上传**(已登录 GitHub 的浏览器打开 issue/PR 评论框 → file
  chooser 附件 → GitHub 附件 CDN `user-attachments`/`user-images.githubusercontent.com` URL → 提交前
  截图确认已渲染,不是破链接;用 `scripts/ui-shot/` 截图)——
  **不再有"MCP 直传"这条路**(旧文案已随 #1037 收编移除,MCP 二进制写会双重 base64 损坏,#1079)。
  **无论走哪条通道,上传/发布失败绝不能被写成"已完成验证"或"截图待处理"**——评论里必须显式标注
  "截图发布失败,证据缺失"(与 `ui-verify`/`pr-sweep` 的 `BLOCKED` 语义一致),不得用中性措辞掩盖。
- **默认自动发/改、自动开 spin-off issue、自动调 label,不必先问**(agent 有判断力)。`--dry-run` 是显式 opt-out:用户想先预览时才用(不做任何 outward 写)。**「自动发」的前提是有东西可发**——Step 5.7 判定沉默的那一轮,「自动」的正确表现是**什么都不发**,不是照旧发一条。两者不冲突:5.7 决定发不发,本条决定发的时候要不要请示(不请示)。
- **审计阶段产物 = verdict comment + labels,不动 body**(body 精简、comment 紧随其下,人已易读);body 补全留到 resolve 阶段、且可选。

### Step 7 — release 并发锁(收尾必做)
处理结束(成功、跳过、出错都算)摘掉 `agent:processing`:`gh issue edit <n> --remove-label agent:processing`。**`agent:hold` 不动**(那是人的预约,只有人摘)。`--dry-run` 没加锁则无需摘。漏摘也不致死——TTL 30min 自动失效。

## Key Principles

1. 先判轮次 + 按价值分档。2. human comment 是方向不是圣旨:没 cover 的真问题仍指出,多人冲突摆出来让人定。3. 产物落 issue,不落会话。4. 每条发现带可复现证据(`path:line` / 真实测试输出),无证据不写。5. 对照已落地实现第一优先,doc-audit 必须真跑测试。6. 价值在独立发现。7. 按后果可逆性划自主边界:comment/label/开 issue 自动做;删文件、搬目录、merge/close、改架构方向挂 `needs-human-confirm`;**绝不**自动 merge/close/删文件/改 frontmatter(唯一例外 = 父级 rollup)。8. 不另起炉灶,增量叠在已有真相源上。9. 不搬目录。10. 共享 KB 热启动。11. partial 剩余工作要拆,拆完即摘 label。12. 开工 acquire 锁,收尾 release。13. 验收点名的验证是契约:改动包的测试真跑,点名 e2e 走 `/e2e-verify`;「跑不动」要贴确切报错先证明,不拿 unit test 顶替、不手填数字。15. 沉默规则 + ratchet 收尾。16. 产出方案时 grounding 同样严:现状断言 `path:line`、数字要么实测要么标注未验证、区分 as-is/proposed;post 前过 `/agentloop:design-review`。

每条的原因与事故来源: Read [reference/principles.md](reference/principles.md).

## ★ sweep-trace 埋点（round-awareness 判据 / L2 可观测层）

本 skill 发往 issue 的**每一条** comment(verdict / Research / Idea / 父级 rollup)末尾必须附:

```html
<!-- sweep-trace: {"ver":1,"issue":N,"step":"review","val":"<val>","run":"<ISO8601>","runner":"<runner>","skills":"<hash>"} -->
```

它是 issue-sweep 轮次感知的机器标记(identity 头人和 agent 逐字节相同,不算标记);不带 trace 的评论会被当成未处理的人类输入,每轮重复处理。沉默轮(Step 5.7)不发 comment 也就没有 trace;人类触发的轮次必发、必带 trace。

为什么是机器标记、与沉默规则的关系、val 取值: Read [reference/comment-format.md](reference/comment-format.md).
