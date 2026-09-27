# pr-review — Step 3.5 / 3.6 UI screenshots and backend gates

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Step 3.5 — UI 改动:核对作者截图(advisory,不设闸)

`verification`(Step 3)是无 daemon、无浏览器的**静态**门控——它看不到"页面还渲不渲染、
用户流程还走不走得通"。所以当 PR diff **命中 UI 面**时,review 要看 UI 证据。**arc 自 #7025 起
UI 证据不设合并闸**(merge-gate 的 ui-verify 门是 advisory,L1 捕网的 `uiShotSmoke` 负责);纪律是
**作者把运行截图贴进 PR body**。

```bash
# diff 命中 UI Face Paths(regex 见 repo-profile.md「UI Face Paths」;下方为 arc 的值)
gh pr diff "$n" --name-only | grep -Eq '^(blocklets/|providers/runtime/ui/|providers/runtime/web-device/|providers/.+/aup/|packages/aup/)' \
  && echo "UI 面命中 → 核对 PR body 截图"
```

- **看 proposing agent 有没有交图(截图左移契约)**:PR body 已内嵌运行截图 → 作为证据,不重新生图;
  截图是在最后一次改 UI 面之前拍的、或与 diff 对不上 → 一条 `COMMENT` 级关注点(请作者在最终 HEAD 补拍一次)。
  非 UI 的修复不需要重拍。复用前先做**破图检查**:对 body 里每个内嵌图片 URL 无凭据
  `curl -s -o /dev/null -w '%{http_code}'` 必须 200(camo 匿名视角)——非 200 = 所有读者看到的都是破图,按「没交图」处理。
- **PR 命中 UI 面却没带截图** = 一条 `COMMENT` 级关注点(提醒 proposing 侧补)。reviewer 自己**不跑** `/ui-verify`
  或 `<ui_shot_script>`——那是作者的活;review 看的是图。
- **图里的明显缺陷**(重叠/裸样式/交互失效/Unknown 框)按「★ 发现即修」处置——包括暴露出的 main 既有 bug,
  当场 issue + fix PR,不写「与本 PR 无关的观察,建议复核」了事。
- **profile 把 `ui-verify` 列进 `additional_merge_gates` 的仓库**(arc 没有):那里 UI 证据**是**合并闸,要求一条对当前
  HEAD 的 `<!-- ui-verify-report` sticky(`.claude/skills/ui-verify/scripts/gate-comment.ts` 生成,8 字段 evidence),
  daemon 不可用时打 `ui-verify:pending` label 留给带 daemon 的 routine 补跑。
- **未命中**(纯后端/文档/脚本/测试) → 跳过,在 verdict 注明"无 UI 面"。

### Step 3.6 — 后端/数据面改动:profile `additional_merge_gates`(arc:空)

`verification`(Step 3)看不到「provider 挂不挂得上、`list`/`read`/`write` RPC 一跑就 500、
`/user` 数据面往返坏不坏」——这类**只有起服务才看得见**的运行时问题。**本步只在 profile 的
`additional_merge_gates` 非空时适用。** arc 自 #7025 起该字段为 `[]`:e2e-gate 是 advisory(merge-gate
打印 `⚠ advisory e2e-gate=<status>`,不影响退出码),后端 smoke 由 L1 捕网的 `e2eFleet` 负责——
arc 上**本步整体跳过**,在 verdict 注明"repo 无 additional_merge_gates"。

适用的仓库(字段非空)才在 PR diff **命中 `<Backend Face Paths>`** 时要求那道门的 sticky 证据:

```bash
# diff → scope 推断(命中 Backend Face Paths → RUN,纯文档/UI/前端/测试 → N/A)
bun .claude/skills/e2e-gate/scripts/scope.ts --pr "$n" --json   # backendHit + 要起的 blocklets(arc 的 e2e-gate 脚本,作示例)
```

- 证据由**分支主人**跑出来(需要 daemon;占 2 个闸位之一),reviewer 只读 sticky。daemon 起不来 → 记
  "`additional_merge_gates` 门需 daemon,本环境未跑",留给带 daemon 的 routine。**smoke 命中的运行时缺陷
  (本 PR 引入的 500/往返坏)按「★ 发现即修」处置。**
- **未命中**(纯文档/UI/前端/测试,或仅非 fleet blocklet 后端改动)→ 跳过,不是 FAIL。
