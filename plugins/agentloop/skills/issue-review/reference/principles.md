# issue-review — key principles (full text)

> On-demand reference for [`issue-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

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

13. **验收 / human 点名的验证是契约,「本环境跑不动」要先证明。** 结构性门控走 `/agentloop:verification`(`pre-pr.ts`,数字由脚本测、不手填);验收点名的集成 e2e 走 `/e2e-verify`(`<cli_binary>` 缺/陈旧先跑 `<cli_setup_command>`)——这些 skill 你完全能调,缺依赖先补 setup(编译原生插件、link CLI、build),只有实际撞上硬工具链缺失(repo profile **Deployment Environments** 所列平台工具链,arc 例:无 Xcode/Android SDK/Playwright)才算「跑不动」,且贴确切报错 + 显式标注跳过哪层。**不拿 unit test 顶替点名的 e2e,不手搓命令手填数字,不预先开脱,不假装跑过。**

15. **发言要有由头,评估要有出口(2026-08-20 老冒反馈,两条配套)。** ① **沉默闸**(Step 5.7):agent **自发**跑完一轮核验、既无动作也无新信息时,**不发 comment**,结果只进 run report——「我看过了,没变」对人是净负担,且多机覆盖同一 repo 时会退化成两个 agent 互相附和而无人动手。**但对人类输入必须回应**,否则 round-awareness 认定「未处理」,每轮重新全额核验(比刷屏更糟)。② **ratchet 收尾**(★Idea / ★Research 铁律 10):回应人类时,收尾必须是「下一轮我会做 X,除非你说不」,不是「仍需拍板」;异议窗口过了就开工,**禁止再写一篇更完整的评估**。`needs-human-confirm` 只留给互斥且不可逆的真分叉。两条分工:①管**要不要开口**,②管**开口说什么**。

16. **生成方案设计时,grounding 纪律和审计时一样严:客观、精确、实事求是。** issue-review 不只审计既有文档——也常被用来给 feature/design issue **产出新方案**(issue-sweep feature 行)。产出设计时同样守纪律:① 每条关于**现状**的断言(架构、存储后端、API、文件布局、现有行为)`path:line` 坐实——**代码是唯一权威**,与引用的 planning/docs 冲突时以代码为准**并指出文档过时**;② 每个**数字**(延迟/吞吐/大小/数量/上限)要么**实测**(附命令+输出)、要么**显式标注为未验证估计**、否则删掉——**凭空的延迟/性能数字是最高发的幻觉**,与 human 在 issue 给的实测冲突时以实测为准;③ 明确区分 **as-is(已核实)** 与 **proposed(新增)**。臆造的后端/布局会让后续所有 phase 建在错地基上。方案 **post 回 issue 前过 `/agentloop:design-review`**(其事实+数字 grounding 是 HARD GATE),别手 post 未审的设计。
