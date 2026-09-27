# issue-review — doc-from-issue lifecycle and doc-audit flow

> On-demand reference for [`issue-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

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
| `drifted` | 实现了,但文档漂移(描述的接口面 ≠ shipped 面) | **按文档类别分流**(2026-07-17 Robert 拍板,#187 批): **`planning/`/`intent/` → 归档**,不修正文——ship 后它们是历史文物,真相源已转移到代码+living docs,修了必再漂(反例:#243 修一轮漂一轮)。归档 = 顶部打 historical tombstone banner(见下「historical 归档」),有价值的设计 rationale 先抽进 `docs/guides/`/README 再归档;tombstone PR merge 时 close issue。**`docs/` living guide → 修文档** → 转 `current` |
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

### historical 归档(drifted 的 planning/intent resolve 路径)

对无 YAML frontmatter 的老文档,tombstone 是顶部 banner(可 grep `doc-status: historical` 一把筛):

```markdown
<!-- doc-status: historical (archived <date>, doc-audit #N) -->

> ⚠️ **Historical** — 实现期 planning/intent 文稿,已归档(doc-audit [#N](.../issues/N))。
> 内容以写作当时为准,**不再随代码更新**;与现行代码的已知漂移明细见上述 audit issue。
> 现状以代码与 living docs(`docs/`、各包 README)为准。
```

主文档用全量 banner,同目录 sibling(tasks/plan/review)用一行简版指回主文档。**不删文件、不搬目录**——
tombstone 保住反向引用的链接(反例:#253 想删 context-builder,结果 2 处活跃文档链接指着它)。
漂移明细**不抄进文档**,留在 audit issue 里(单一真相源)。归档后该单元退出后续 doc-audit 扫描范围。

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
4. **KB body 单点编辑。** 并行 agent **只读 KB、不写 body**;新事实由主控在每段/每批后统一折叠(见「共享 KB」)。**仅交互式 session** 可用 Workflow 编排(批量跑应 resumable,失败/限速可续);**无人值守 routine 绝不 Workflow、绝不 AskUserQuestion**——由 [`issue-sweep` 的 bounded worker pool](../../issue-sweep/SKILL.md) 使用无需确认的 agent fan-out;runtime 不支持时才串行 inline。待拍板问题照常落 comment。

### Spin-off issue(自动开,不问)

review/audit 中常会撞到**独立于本文档 status 的真问题**(安全漏洞、未接线死代码该不该留、明确的 bug)。这些**不要埋在审计 comment 里**,也**不要等用户点头**——**直接开一个独立 issue**:贴切 label、assign 相关代码提交者、双向回链审计 issue,并在审计 comment 里一句话提"已 spin-off 到 #N"。开 issue 可逆可追溯,属"自动做"。

- **只为「清楚 / 已确认」的问题自动开**:有坐实证据的 bug/漏洞、或 human 已批准要开的。**仍悬而未决的疑问 / 方案 A-B-C 没定的,不要先开 issue**——留在 comment 里给人拍板,定了再开。**「定了」包含 ratchet 选定**(★Idea/★Research 铁律 10:上一轮声明了默认方向、异议窗口已过而人未否决)——那已经是「已确认」,不是「没定」;本条禁的是**方向从没被声明过**就先开 issue,不是禁 ratchet。
- **开完必写原生边(写边纪律)**:body 首行 `<!-- spinoff-of: #N -->` 标记之外,同时
  `bun <plugin_root>/skills/issue-graph/scripts/link.ts --parent <N> --child <新号>`(幂等)。
  标记是 provenance,**原生边才进确定性图计算**(close-kick / rollup);不写边 = 这个
  spin-off 关闭时永远不会 kick 回父 issue。
- **发现即修升级**(对齐 [`pr-review` ★ 发现即修](../../pr-review/SKILL.md)):spin-off 里满足四门(证据坐实 · 修法无歧义且有界 · 非安全 · 无需方向拍板)的缺陷——尤其截图一眼可见的 UI 缺陷——**开 issue 的同时当场修并开 fix PR**(before/after 截图 + verification),issue 只作 tracking 回链,不留给「下一轮/其他 agent」。
- **优先级用受控词表**(防 label 漂移,和 status 同理):`P0`(紧急 / 安全)· `P1` · `P2` · `P3`(低优);安全类另加 `security`。缺这些 label 就建,但**只用这套词**,别再造 `priority:high` / `urgent` 等变体。

### partial → 拆分剩余工作(status:partial 的主结论处理)

上面 Spin-off 讲的是 review 中**附带撞到**的独立问题。**这一节讲不同的场景**:当审计的**主结论就是 `partial`**(主体已落地、剩几个有界子任务没做),正确动作是把**剩余工作分解成独立、无依赖、自足的实现 issue**——别只在 comment 里列 gap 等人。

**触发(证据坐实即自动拆,不问):** gap 有 `path:line` 坐实确属未完成(如「`grep this.emit providers/iot/frigate/` → 0 命中」),就自动拆。**仍推测性 / 方案 A-B-C 没定的 gap 不拆**,留 comment 给人拍板,定了再拆(和 Spin-off 同一条原则,「定了」同样包含 ratchet 选定)。

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
   - **本 issue 还有残留**(典型:文档漂移——「已完成但文档没更新」)→ 换 `status:drifted`(open;resolve 按 status 表分流:`planning`/`intent` → historical 归档,`docs/` → 修文档转 `current`;均由人签名 PR 落地 → close)。
   - **完全无残留**(gap 全 track + 无漂移)→ 换 `status:current`(或无 status)+ 保留 `needs-human-confirm`,作「审计完成,待人最终 close」信号。
   - **拆分≠完成,但「本 issue 的 partial 工作已分诊完毕」= 完成**——区别在于:剩余实现工作的家已搬到 spin-off,本 issue 只剩 doc resolve(或无)。
   - **仍绝不自动 close / 改 frontmatter**(那是人的不可逆动作);最终 resolve(写 frontmatter + 修 doc + close)由人签名 PR。label 归 AI(可逆)、frontmatter 归人(签名)。
