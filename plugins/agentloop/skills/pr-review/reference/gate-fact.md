# pr-review — Step 3 gate fact and root-cause table (full text)

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Step 3 — ★ 读 verification 门控事实并判读根因(reviewer 不跑闸)

**门控形态 = profile `gate_mode`**(arc = `scripts`:删了 `ci.yml`/`pr-title.yml`,`gh pr checks` 恒为空,verification 脚本是**唯一门控信号**;`ci`/`both` 的 repo 还要把 `gh pr checks` 纳入判定)。出判定前要有一份 **current** verification 事实——**同一个 HEAD SHA 上 `<verification_entry> --comment` 贴出的报告**。合并闸认的就是它:arc 的 `<merge_gate_entry>` 只要求 sticky 的 `sha=` 等于 PR head 且 `result=PASS|NA`,**不需要另跑 `pre-merge`**,main 前进了也不需要;合并时刻两边改动叠在一个文件里的风险由它的 merge-load 门对着 main 当前 tip 判。

**reviewer 只读事实,从不跑闸**(不跑 `<verification_entry>`、不跑 `<pre_merge_entry>`、不跑 e2e-gate / ui-verify,
**也不跑 `<merge_gate_entry>`**)。读的只有两样:PR 上**与 head 同 SHA 的 verification sticky**,和 Step 0.4 的 `bot-clean.ts`。

```bash
# 同 SHA 的 verification sticky:只看每条评论第一条非空行上的 marker(与 postOnce 的定位规则一致)
gh api "repos/<owner>/<repo>/issues/<n>/comments" --paginate \
  --jq '.[] | .body | split("\n")[0] | select(startswith("<!-- verification-report "))' | tail -1
# → <!-- verification-report sha=<40-char> result=<PASS|NA|FAIL|…> -->   (比对 sha= 与 PR head)
```

> **为什么不能拿 `<merge_gate_entry>` 当「只读」:** 它不是只读的。exit 0 时它写一份判决记录
> (arc:`.verify/merge-gate.<sha>.json`),而 `merge-verified-pr.sh` 正是把这份记录当作**合并授权**。
> reviewer 跑一次,就在 review / bot-clean 还没完成时留下一份可用的授权;main 前进之后这份记录还能被
> 拿去合并,而 merge-load 并没有对新的 tip 重判(合并脚本侧的时效加固另见 #7106)。所以
> `<merge_gate_entry>` **只由合并者**在 `merge-verified-pr.sh` **之前紧接着**跑,同一台机器、同一个 head。

- **有同 SHA 的 PASS/NA** → 事实成立,进根因判读(没有红就直接进 Step 3.5)。
- **没有 / 过期 / 只有旧 SHA 的** → 不要自己去跑。verdict 写明「gate fact missing at `<sha7>`」,判决不得为 `MERGE`(至多 `COMMENT`),并点名**分支主人**(worker / fixer / conductor)去跑 `<verification_entry> --comment <n>`——(合并者跑 merge-gate 时它打印的也是这个 hint)。
- **`pre-merge` 不在 PR 流程里。** 它和 pre-pr 贴在**同一个 marker** 下,一次 FAIL(例如 main 前进后选择面变宽)会覆盖掉一份有效的 PASS;它的重型/全量覆盖属于仓库的 main 捕网(arc:L1 main catch-net)。

`renderReport` 已生成 markdown(状态/耗时表 + `rawTail` + 折叠 `rawFull`),直接引用,不手写数字。

**verification 报告只能通过 `--comment` 投递,禁止手写。** 不要把 verification 结果手抄进
一条自己写的 review verdict comment(哪怕带上了 `<!-- verification-report ... -->` 标记)——
`postComment()` 的 upsert 生成逻辑(sha/result 编码、PATCH-vs-POST 判断)只在脚本内部,手写
marker 容易和真实 sha 不一致(短 sha 手写 marker 被全量比对判 mismatch)。verdict comment 和 verification report 分开发:
verdict 写成独立的普通 PR comment(`gh pr comment`/`mcp__github__add_issue_comment`),
verification 结果永远由分支主人用 `<verification_entry> --comment <n>` 单独投递,不要合并成一条手写 comment。

**verdict/讨论类评论正文里绝不逐字粘贴任何 upsert marker(`<!-- verification-report ...` / `<!-- pr-review-verdict ...` 等)**——哪怕只是引用/说明它是什么。`postOnce` 的 upsert 定位只认评论**第一条非空行**上的 marker(#3576 起收紧,narrows #1246),按此规则一条纯讨论评论不会被误覆盖;但更安全的做法是**根本不要逐字粘贴**——要提及就用代码块转义、去掉尖括号或加空格断开,别让它以合法 marker 形态出现在评论正文里。

**核心原则:门控是信号不是判官。** 失败必须定根因:

| 根因 | 信号 | 处置 |
|---|---|---|
| **(a) 本 PR 真实缺陷** | 失败的测试/类型/架构检查由 diff 引入 | → `BLOCK`,comment 指出 `path:line` + 失败检查名 + `rawTail` |
| **(b) 不是本 PR 造成的红(flaky / 存量 / 基础设施)** | 失败文件在 diff 之外,与改动无关 | → **仍然挡合并**(FAIL sticky 过不了合并闸)。出路只有两条:二分找到根因修掉;或由分支主人带 witness issue 跑 `<verification_entry> --comment <n> --blocked-by <open issue#>`,**闸自己**判定(arc:`PREEXISTING` / `LOAD_FLAKE`)。**禁止盲目重跑、禁止调大超时让它变绿、禁止写「不阻断」**。唯一的超时例外:测试行 `TIMEOUT` 且 `failed=0` 时,用仓库的只增旋钮(arc:`ARC_VERIFY_TEST_TIMEOUT_MS`)重跑一次并写明取值 |
| **(c) main 已前进 / 分支冲突** | mergeable=`CONFLICTING`;或失败在 main 上已修复 | → 冲突、或红在 main 上已修复:Step 0.5 rebase(闸归因不了已修复的红),由分支主人重跑一次闸。只是落后:**不 rebase**,合并风险归 merge-load 门 |
| **(d) 可自修的噪音** | 单行 lint/import 等机械件(**不含 `format`**,见 (e)) | → `--post` 模式可在 PR 分支自修,和其他修复攒成一批(不为它单独跑闸);**谁 push 谁就是这一次的分支主人**,由它跑那一次 `<verification_entry> --comment <n>` |
| **(e) `format` 红** | 自 arc#5805 起 `check-format` 是 **blocking** | → **阻断,不得放行**;必须真修后重跑。**修复命令取自该红行自己打印的 remedy**(次选 repo-profile 的 `<formatter>`),绝不硬编码某个包管理器的命令 |

**结果进 verdict:** 同 SHA 事实为 PASS/NA → 允许 `MERGE`;FAIL 或缺失 → **verdict 不得为 `MERGE`**。
- **简单失败**(格式/import/单行 lint):`--post` 模式在 PR 分支修,攒进同一批修复;read-only 模式在 verdict 里指出。
- **复杂失败**(测试/类型/架构违规):发 `BLOCK`,verdict 带失败检查名 + `rawTail` + 折叠 `rawFull`,给后续 agent 接力上下文。

> **这一步在 pr-review 是判定输入,不是合并门控。** 真正不可跳过的硬门控是**合并者**在合并前紧接着跑的 `<merge_gate_entry> --cs-head <40-char-sha> <n>` exit 0(verification 同 SHA PASS/NA + merge-load,以及 profile `additional_merge_gates` 列出的门;arc 为空),在 [`pr-sweep` 合并闸](../../pr-sweep/SKILL.md) / [`epic-conductor` §7](../../epic-conductor/SKILL.md) 执行(机制点:SHA 比对由该脚本执行、不靠自觉)。pr-review 只判不合。
>
> 不能用「同一 HEAD + 时间较新」的人工启发式,也不能手读/手贴旧报告来绕过脚本。FAIL 不得被洗成 sibling 的 PASS。

**运行时 / CF-parity PR(改 `<Backend Face Paths>` 的多运行时 parity 面,或 blocklet render/mount/serve 语义)**:静态门控看不到「跑起来对不对」,这一面的常规覆盖在仓库的 main 捕网(arc:L1 的 `e2eFleet`,Node + CF miniflare)。**只在两种情况下**在 review 里补跑 `/e2e-verify`(该仓库的 companion,见 repo-profile 的 Companion Skills;没有就跳过该步):① PR **声称**了某种运行时 parity 行为、而没有任何单元测试覆盖它;② security panel 要求对某个利用做复现。跑的时候它本地 boot **两个** runtime:Node = `<dev_server_node>`,**CF = `<dev_server_edge>` 本地 miniflare(自带 D1 + migration,不需要 CF 账号、不碰 staging)**——绝不判成「需要云端 CF/wrangler 环境」而 defer。`<cli_binary>` 缺/陈旧先跑 `<cli_setup_command>`(arc `cli_binary` = `arc`)。它算一个重闸(占 conductor 的 2 个闸位之一)。
