# issue-review — research issues

> On-demand reference for [`issue-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## ★ Research(研究类 issue)——外部系统 × 本系统结合点调研

issue 要求研究一个**外部项目/技术**(开源系统、协议、竞品)与**本系统**的结合点、可行性或借鉴价值。范式如 perkeep × did-space 的结合点调研。这是 deep research 的 repo 内变体:**最大区别是我们身在一个 repo 里(知识库或产品代码),所以能做代码级深度,而不是只读对方的宣传页。**

**铁律(与其他各类的关键差异):**

1. **调研这一轮绝不改本 repo 代码。** 产物 = 一条证据化研究 comment(+ label),不是 PR、不是文件。skill 改进等衍生工作是另一件事,不混在 research 交付里。**边界:这条约束的是「research 交付本身」**——铁律 9/10 把 issue 转进 feature 管道之后,它就不再按 research 处理,那一轮该开 PR 就开 PR(切到 feature 的纪律)。**不许拿本条当「永远不动手」的挡箭牌。**
2. **默认只留 comment + 外部资源链接,不下载保存。** 外部 repo clone 到 scratchpad 用完即弃。**仅当 issue 明确说要收集数据保存在 repo 里**时,才在 `research/<task-slug>/` 开专门目录收集值得保存的(仍走 PR,人签名)。
3. **两侧都必须代码级,不许只读 README。** 外部侧:shallow clone 到 scratchpad,读架构文档 + 关键源码包,结论带 repo 内相对路径(尽量带行号)+ 官方 doc 链接;我方侧:读本 repo 代码/intent/planning,结论带 `path:line`。**并行 fan-out 两个 subagent(一侧一个)**,主控综合——两侧独立取证,防止先入为主。
4. **外部项目健康度必查**:`git log` 最近 12 个月提交曲线、最近 release、核心作者近期是否活跃、license、`gh api repos/<owner>/<repo>` 的 pushed_at/stars。结合点结论强依赖对方活性(死项目和刚复活的项目结论完全不同),这常是**独立发现**的来源(如发现 perkeep 2025-10 复活、7 年来首个 release)。
5. **诚实优先,反「为用而用」。** issue 主人常自带警惕(「不能为用 X 而用」),研究结论必须敢说「这个方向不建议」;每个结合点标注真实受益方和前提条件。
6. **产物结构**(comment,中文):TL;DR 逐条直接回答 issue 提出的具体问题 → 两侧架构对照表(均代码坐实) → 冲突面 → 结合点**分档**(⭐ 推荐 / ◐ 待定或仅借鉴 / ✗ 不建议,每条给理由) → **行动声明收尾**(铁律 10 的 ratchet 格式:「下一轮我会做 X,除非你说不」,X 默认取 ⭐ 档) → 外部资源链接清单。**首轮不自动开 spin-off**(先给人一个廉价的纠错点),但**收尾不是选项菜单**——异议窗口过了就按声明执行。
7. **Label**:`research`;并发锁照常(`agent:processing`)。**`needs-human-confirm` 只在存在真分叉(互斥且不可逆)时才加**——见铁律 10;能给安全默认的一律不加。issue 保持 open。
8. **投入档位**:调研深度不省(两侧 subagent 各自全量),但**验证层不同**——research 不跑本 repo 测试套件(没有要验收的实现),证据 = 双侧源码引用 + 官方文档 + 项目活性数据。
9. **★ 自带明确终局目标的 issue,调研只是 phase 0,不许停在调研(#1947 反馈,2026-07-19)。**
   〔本条原标题是「纯调研才以 needs-human-confirm 收尾」——**已被铁律 10 取代**:现在纯调研也不
   以 needs-human-confirm 收尾,而是 ratchet 行动声明。本条只保留它真正管的那一档:自带终局目标的。〕
   issue 同时载有**明确终局目标**(「不可动摇的目标」「最终应该…」式表述)时,research 只是 phase 0:调研 comment 落地后**立即转 feature 管道**(拆 sub-issue 图 + 原生边 + 可测终局验收写进父 issue,能做即做),不得以「待拍板选项」冻结。**拍板项必须是互斥分叉**——非互斥的工作项是依赖序,列成 phases 直接执行;可由工程判断决定的选择(API 形态、实现路线)由 agent 自决并在 PR/issue 记录 rationale;只有真正不确定的(不可逆分叉、审美、优先级)才需要人,且用「**推荐 + 默认执行的异议窗口**」(不同意在 issue 喊停)而不是阻塞等待。把工作分解包装成拍板项交给人 = 用拍板换工作量,禁止。(与 ★Idea 铁律 9 同源同判据——#1947/#1949 同日反馈;改其一必同步另一处及 issue-sweep 表对应两行。)
10. **★ 调研不得以「仍需拍板」收尾——收尾必须是 ratchet(2026-08-20 老冒反馈,镜像 ★Idea 铁律 10)。** 铁律 9 修的是「issue 自带明确目标」那一档;这条修的是**剩下的那档**——纯调研也不许无限期挂在「待人选方向」。研究 comment 的最后一段固定为行动声明:「**下一轮我会做 X**(具体到第一个 spin-off 的标题和第一步),**除非你在此之前说不**」;下一轮人若没有否决也没有改方向,**直接执行 X,不再重新调研**——再写一篇「更完整的调研」是本条明确禁止的动作。分档结论仍然照给,但 ⭐ 档就是默认选中的那个。完整措辞与三条边界见 ★Idea 铁律 10(两处同源,改其一必同步另一处及 issue-sweep 表对应两行)。

**后续轮**:人选定方向(如「做 A」)后,按选项拆自足 feature issue(照「partial → 拆分剩余工作」的自足配方),或转入 `/agentloop:design-review` → `/agentloop:build-phases` 管道;**人什么都没说 → 按铁律 10 的 ratchet 执行 ⭐ 档,不是再调研一轮**;若人只是追问,原地编辑/追加 comment 回答(仍以行动声明收尾)。
