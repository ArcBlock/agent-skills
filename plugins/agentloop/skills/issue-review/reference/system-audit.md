# issue-review — system-audit (comprehensive code audit)

> On-demand reference for [`issue-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

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

**热启动三条硬规则(省 token 的规矩):**

1. **issue thread 是累积状态。** 既往已核验的证据(`path:line`、测试 pass/fail 数)默认**信任**,不重新推导——除非"文件变了"或"human 质疑了这一条"。
2. **不重 build、不重跑整套测试、不重读全部文档。** 只在「目标代码变了 / human 点名要重查」时,重跑**那一个**测试、重读**那一节**。
3. **判断"变没变"用便宜的命令**:`git log --oneline --since="<上条 comment 时间>" -- <unit 路径>`。没动过 → 既往证据成立,直接进下一步。

**human comment 是后续轮的方向,但不是圣旨。** 它确认/否决某结论、提新事实(如"这协议其实是给反向注入用的")、指下一步——优先按它走,但**不盲从**:

- human 没提到的真问题**不要因此丢掉**——该指出还指出(他可能没 cover 全)。
- human comment 是**疑问 / 不确定**(带"?"、"是不是"、"我不确定")时,当作**要回答的问题**,不是要执行的命令——给带证据的答复,必要时坦白你也不确定、列出选项让人定。
- **多条 comment / 来自不同人**时,逐一列出、**调和分歧**;别只听最后一条或最大声的那条。有冲突就摆出来让人拍板,不要自己悄悄选一个。

后续轮的产出往往不是"再来一份完整 review",而是一个**针对性的下一步**(确认某结论 / 解某个 gap / 起草 crystal / 回答疑问)。
