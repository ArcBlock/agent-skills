# issue-review — running the verification (Step 4 detail)

> On-demand reference for [`issue-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Step 4 — ★ 真跑测试(doc-audit / 验收点名的验证)
找到相关测试(`pnpm --filter <pkg> test` / `bun test <path>`),**真的跑**,把**确切命令 + 真实 pass/fail 计数**记进结论。

> 上面的 targeted `bun test <path>` 是为坐实**某一条 doc-audit claim**(只想要那一个测试的输出当证据)——保持轻量,别为一条 claim 跑全量门控。**下面这套只在 issue 是 feature/task、验收标准或 human 点名了验证手段时适用。**

**当验收 / human 点名了验证——「本环境跑不动」是要被证明的结论,不是预设借口。** 用**仓库自己的 blessed skill**,别自己手搓命令再手填数字:

1. **结构性 PR 门控(build / lint / types / tests / architecture)走 `/agentloop:verification`。** 跑 `<verification_entry>`,**数字由脚本测出、不手填**。**不要**自己 `pnpm build` / `bun test` 再手写「759 pass」——那正是手搓命令 + 手填计数的反模式,也是 `/agentloop:verification` 要消灭的非确定性。见 [`verification` skill](../../verification/SKILL.md) + CLAUDE.md「Self-Verification」。
2. **验收点名的集成 e2e(blocklet render / mount / serve)走 `/e2e-verify`(该仓库的 companion，见 repo-profile 的 Companion Skills；没有就 stub 或跳过该步)——先尝试再下结论。** 它自己 `pnpm build` + boot **两个** runtime(`dev_server_node` + `dev_server_edge`,见 repo profile)——**边缘侧 = `<dev_server_edge>` 起本地环境,不需要云账号、不碰线上环境;所以 edge-parity / runtime 类验证本地就能做,绝不判成「需要云端环境」而 defer——那是错的。别把「别猛测线上环境」当成「本地验不了」**;**`<cli_binary>` 缺失/陈旧就先跑 `<cli_setup_command>`**(e2e-verify 自身也这么要求)。`/agentloop:verification`、`/e2e-verify`、`<cli_setup_command>` 你**完全可以调用**——没真跑过就写「需要 daemon / 本环境无法执行」= 失败,**也不能拿 unit test 顶替点名的 e2e**。
3. **缺依赖 = 多一步 setup,不是「跑不动」。** 原生插件没编译(如 better-sqlite3 → `npx node-gyp rebuild`)、CLI 没 link、没 build —— 先把 setup 做掉再跑,别当环境限制。
4. **真正的硬限制才算「跑不动」**:沙箱根本没那条工具链(repo profile **Deployment Environments** 列出的平台工具链,arc 例:无 Xcode → Swift、无 Android SDK → Kotlin、无 Playwright MCP → e2e-verify 的 Tier B 真浏览器),**且已实际撞墙**。**`dev_server_edge` 不在此列**——它是本地环境,永远不算「跑不动」。这时贴**确切命令 + 确切报错**,退而用能跑的那部分兜底(`/agentloop:verification` 脚本 / 别的 tier / 静态对照),并**显式标注跳过了哪一层**(如 `Tier B skipped/no-playwright`)。
5. **绝不假装跑过、不手填数字。** 没跑就说没跑;跑了就贴 skill / 脚本的真实输出。
