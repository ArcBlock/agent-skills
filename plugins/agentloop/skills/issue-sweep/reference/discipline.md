# issue-sweep — Step 4 discipline (full text)

> On-demand reference for [`issue-sweep`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

## Step 4 — Discipline (non-negotiable)

- **防重复:确定性分支名 + 创建前认领检查(根除多机重复 PR）。** 多台机器并行跑本
  sweep 时,若 branch 名是模型自创的描述性 slug(旧规则 `claude/fix-331-…`),两台机器
  对**同一个 issue** 会算出**不同**分支名 → 不碰撞 → 各开一个 PR → 重复(五条真实
  案例见本 repo 的 case-law 附录,repo-profile Case Law References)。
  修法两条,缺一不可:
  1. **分支名必须确定性、只由 issue 号(+ phase)派生**,不含模型自创 slug:
     `claude/issue-<N>`(单 PR);多 phase 用 `claude/issue-<N>-p<phase>`。两台机器算出
     **同名**分支 → 第二个 `git push` / `gh pr create` 自然碰撞、不再双开。
  2. **开 PR 前先认领检查**——已有开放 PR 指向 #N 就 **SKIP**(别人/别的机器在做):
     认领检查——**把它当一条普通命令跑,然后读输出**;别塞进 shell 变量、别包 `[ … ] && { …; exit 0; }`
     (沙箱 guard 会拒这类命令替换/复合结构,这一步会直接失败——实盘踩过;而且你本来就能读输出):

     ```bash
     gh pr list --state open --json number,headRefName,body --jq '.[] | select((.headRefName|test("(^|[-/])issue-<N>([-/]|$)|-<N>-")) or (.body|test("(Fixes|Part of) #<N>\\b"))) | .number'
     ```

     把 `<N>` 换成 issue 号再跑。**有输出 = 已有开放 PR 指向 #N → SKIP**(别人/别的机器在做);
     **无输出 → 认领,从最新 tip 切确定性分支**:

     ```bash
     git checkout -B claude/issue-<N> origin/<default_branch>
     ```
     **早层 advisory 锁已就位**:`issue-review` 一开工就 acquire `agent:processing`(TTL 30min,见其
     ★并发锁),Step 1 也据此跳过新鲜锁的候选——撞车在"读/核验/测试之前"就短路了。这里的
     **确定性分支 + 认领检查是收尾的硬去重兜底**(锁是 advisory、有残留竞态时它顶上)。两层互补,缺一不可。
  3. **清理由 [`pr-sweep`](../../pr-sweep/SKILL.md) 兜底**:已经产生的重复对,sweep 的去重
     关闭步骤会留一个、comment + 关其余。源头修好后这类清理会趋于零。
- **开任何派生/spin-off issue 必须写原生边(图精确性的来源)。** body 首行
  `<!-- spinoff-of: #N -->` 标记之外,**同时**执行
  `bun <plugin_root>/skills/issue-graph/scripts/link.ts --parent <N> --child <新号>`(幂等);
  phase 之间有硬次序的再加 `--issue <后> --depends-on <前>`。标记是 provenance,
  **原生边才进 Step 0.5 的确定性图计算**——不写边 = 这个 spin-off 对 close-kick /
  rollup 永久不可见,回到"要人 bump"的旧病。
- 一个 issue 一个 PR(确定性分支),`body references the issue（`Part of #N`;完全闭合
  才用 `Fixes #N`,部分修复留 issue 开放并说明处理了哪部分)。不要把无关改动塞一个 PR。
- PR body ends with `Fixes #N` so merge auto-closes the issue.
- **PR body 顶部带标准身份 header**（延伸到 PR 的同一套身份行约定；即 `agent_comment_marker`）：整行由
  `<agent_identity_script> --header "PR" --skill issue-sweep` 生成
  （→ `> 🤖 AI Agent PR @ <hostname> · runner:<runner> · skills@<hash>`），
  不能手拼/占位符。归属、环境、skills 版本从此 PR 本体可溯源，不用翻 comment。
- Commit messages follow **Conventional Commits**. **Never reach for `git commit
  --no-verify` as a default** — the pre-commit hook here is `simple-git-hooks`
  (not husky; this repo has no husky dependency), wired via the root
  `postinstall` script. A hook that fails to spawn (`biome: ENOENT` / the
  command not found at all) almost always means **`<package_manager> install`**
  hasn't run yet in this checkout — **run it (or, if
  that's impractical, `node node_modules/simple-git-hooks/cli.js` to just
  re-link the hook) and retry the real commit** before ever bypassing it. Only
  fall back to `--no-verify` if the hook is confirmed broken *after* install
  (rare), and even then keep changes clean by hand via the `<formatter>` per CLAUDE.md's "别随手
  `--no-verify`" rule — it also skips the formatter, so formatting/lint issues
  silently leak into the PR (nothing on the PR path catches them).
- **Safety before any deletion/edit:** `git grep` confirms no external code
  importers; `<package_manager> --filter <pkg> check-types` (or a
  targeted test) shows no
  *new* errors from the change (pre-existing/unbuilt-dep errors don't count —
  call them out). Adding/removing a dep → update `pnpm-lock.yaml` with
  `pnpm install --lockfile-only`, confirm the diff is scoped, **and `git add`
  it alongside `package.json`** — staging the manifest without the lockfile
  breaks `--frozen-lockfile` everywhere else. Conversely, if you didn't touch
  deps but the lockfile still shows a diff, it's a concurrent/unrelated change
  → don't stage it.
- **Deletion provenance:** content is recoverable via git history; the audit
  comment preserves it. AI **never** auto-merges; humans merge.
- Push: `git push -u origin <branch>` for a fast-forward / new branch. After rebase/amend, `bun scripts/git-push-lease.ts` — never bare `git push --force-with-lease` (fetch updates the tracking ref and the lease silently passes; #5212). Retry on network error with backoff.
- **★ 测试(proposing 侧):** push 前跑改动包的测试(`<package_manager> --filter <pkg> test`),红了
  **不得** push / 开 PR;PR 正文写确切命令 + 通过/失败计数。pre-commit 只跑 Biome,nightly 才跑全量。
- **★ 验收点名的集成验证不可预先开脱:** 当 issue 的验收标准 / human **点名** `/e2e-verify`
  (该仓库的 companion，见 repo-profile 的 Companion Skills；没有就 stub 或跳过该步)
  等集成验证(blocklet render / mount / serve),proposing 侧**必须真跑**——`<cli_binary>`
  CLI 缺失/陈旧就先跑 `<cli_setup_command>`,**不得**以「需要 daemon / 本环境无法执行」开脱,**也不得**拿 unit
  test 顶替点名的 e2e。缺依赖 = 多一步 setup(编译原生插件、link CLI),只有实际撞上硬工具链缺失(无
  Xcode/Android SDK/Playwright)才算跑不动,且贴**确切报错** + 标注跳过层。见 `e2e-verify` skill。
- **★ UI 改动的截图左移(proposing 侧生图,不留给 review 侧):** diff 命中
  `<UI Face Paths>`(`.claude/repo-profile.md`)时,**开 PR 前必须生成
  UI 运行截图**——renderer/widget 级用 `<ui_shot_script>`(真实 shipped
  bundle 渲染 fixture;参数矩阵 / 前后对比 / 状态序列三型按需多幅),
  页面级流程用 `/ui-verify`。三个硬要求:
  1. **先自查再提**:生成后用 vision 看图过 `<ui_shot_script>` README 的 checklist(裸样式 =
     css.ts 没配套、hover/点击前后两幅无变化 = 交互失效、Unknown 降级框 = 类型没注册、
     布局叠压)——任何一条命中先修再提。单测全绿看不出这些,别把它们留给 reviewer 或人。
  2. **截图内嵌进 PR body**(`<ui_upload_script>` 上传,
     `ASSET_CONTEXT=pr{N}`;开分支阶段还没有 PR 号就先用 `issue-{N}`),开 PR 时就带图,
     不是事后 comment。脚本自带两道硬自检:**exit 3** = 脚本与
     `origin/<default_branch>` 不一致(陈旧 checkout——曾经破图的真实根因)→
     `git checkout origin/<default_branch> -- <ui_upload_script>`
     后重跑;**exit 4** = raw URL 匿名不可达 → 禁止内嵌。内嵌前的通用验收:URL 必须
     **无凭据 curl 200**(camo 视角;脚本路径已内置,MCP 路径手动验)。
  3. **同一组截图回贴关联 issue**(一条简短 comment:图 + 一句话说明),让人在 issue
     里一目了然,不必点进 PR。
- **PR 继承来源 issue 的 milestone(+ labels/assignee 的 provenance)。** 开 PR 后立刻把
  issue 的 milestone 复制到 PR——否则 PR 不进 release/批次的里程碑视图,看板就漏了它。
  milestone 命名/归类约定见 **Milestone Conventions**（`.claude/repo-profile.md`）。
  ```bash
  ms=$(gh issue view <N> --json milestone --jq '.milestone.title // empty')
  [ -n "$ms" ] && gh pr edit <PR#> --milestone "$ms"
  ```
  对**每一个**由 issue 派生的 PR 都做(fix / doc-update / delete / feature-phase PR 一视同仁)。
  issue 无 milestone 就跳过(别瞎设)。
- **PR 的 assignee/reviewer 继承来源 issue 的人。** 开 PR 后把来源 issue 的 **author +
  assignees**(去重)设为 PR 的 assignee——他们是这件事的知情人和责任人,PR 出现在他们的
  待办里才不会漏。**需要 human review 的 PR**(🔴 高风险 / security / A-vs-B 待拍板 /
  🟡 draft `needs-human-review`)**同时把这些人设为 reviewer**;判断**不需要人确认**的
  (🟢 机械修复、低风险档,pr-sweep 的合并规则内可自动合)可不指定 reviewer,免得制造无意义的
  review 请求。
  ```bash
  people=$(gh issue view <N> --json author,assignees \
    --jq '([.author.login] + [.assignees[].login]) | unique | join(",")')
  [ -n "$people" ] && gh pr edit <PR#> --add-assignee "$people"
  # 仅当 PR 需要 human review 时:
  gh pr edit <PR#> --add-reviewer "$people"
  ```
  指派失败(reviewer 恰是 PR 作者本人 / bot / 非协作者)就跳过并记一句,别 block——
  与 issue-review 的 assignee 纪律一致。
