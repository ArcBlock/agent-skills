# pr-review — fix-now discipline (full text)

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## ★ 发现即修(fix-now)——review 产出的默认动作是修复,不是转述

review 中发现的**确定性缺陷**(尤其截图一眼可见的 UI 缺陷:重叠/裸样式/交互失效/Unknown 框),
默认动作是**本轮当场修掉**,不是留 comment 等下一轮。判据是「要不要人拍板」,不是「是不是本 PR 的锅」:

| 缺陷在哪 | 四门判据(全过才修) | 当场动作 |
|---|---|---|
| **本 PR diff 引入** | 证据坐实(截图/测试/`path:line`)· 修法无歧义 · 非安全 · 无需方向拍板 | `--post` 模式:直接在 **PR 分支**上修(fix commit + push + comment 说明改了什么);read-only 模式:comment 给出可直接套用的修法。`BLOCK` 只留给修不动/要方向的 |
| **main 上既有**(review 顺带撞到,如截图里暴露的布局 bug) | 同上四门 + 有界(单点 CSS/renderer 级,非架构) | **开 tracking issue(带截图)+ 从 origin/`<default_branch>` 切分支修 + before/after 截图 + 改动包的测试 + 开独立 fix PR** 双向回链;verdict comment 里一句话指向。一轮闭环,不写「建议复核」「留给其他 agent」 |
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
