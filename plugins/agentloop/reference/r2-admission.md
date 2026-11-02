# R2 准入：`needs-human-confirm` 只给 R2 决定

本文件是 `needs-human-confirm`（下称 NHC）准入规则的唯一出处。所有 skill、routine 和 fleet
prompt 只链接这里，不各写一份。来源：2026-10-25 的 NHC 全量审计（44 项里只有 1 项是真 R2），
以及 #5500 提出的准入 lint。

## 1. 什么交给人（R2 清单）

人只决定 R2。这张表是 R2 清单的唯一出处，factory-planner 的 `approve.md` 级别表与它一致。
repo 可以在 profile 里收紧这张表，不能放宽。评论里用左列的 token：

| `R2: <category>` | 含义 |
|---|---|
| `breaking` | breaking change（对外接口、数据格式、CLI 行为的不兼容改动） |
| `release` | 发布节奏（什么时候发 stable、跳不跳版本） |
| `external-commitment` | 对外承诺（对客户、合作方、公开渠道说的话） |
| `market` | 市场方向（做不做某类产品、面向谁） |
| `permission` | 授予权限或凭据，**放宽**安全策略（收紧不算） |
| `spend` | 花钱 |
| `deploy-prod` | 生产部署（不经 `scripts/deploy.sh` 这类已授权通道的） |
| `data-delete` | 删除真实数据、不可逆迁移 |
| `r2-list` | 修改本 R2 清单本身 |
| `merge-criteria` | 修改「开发期只有 build-break / data-loss / security 挡合并」这条判据 |

「R2 清单本身」包括执行它的东西：禁区清单、R2 边界声明（目标仓库默认分支上的 `.claude/factory-r2-boundary.txt`，#9637）、合并闸和 panel / 评判团的代码、
禁止自合并的 hook 和脚本。改它们一律是 `r2-list`，工厂不能在 R1 里放松自己的闸。
闸的运行时输入和闸的代码一样属于 R2：它读的配置和 profile（例如 `.claude/repo-profile.md` 的 `factory_merge_check_entry`），
以及决定它的代码怎么解析的清单（`package.json`、`tsconfig.json`、`pnpm-workspace.yaml`）。

R2 边界是「目标仓库声明的名单 + 从 PR 自己的 checkout 运行的闸入口的 import 闭包」，外加下面几条规则（#9637）：

- **名单由目标仓库在默认分支上声明**：`.claude/factory-r2-boundary.txt`（grammar 见 `packages/aos-factory/src/work-r2-declaration.ts`）。宿主只读 GitHub 证明的默认分支 tip 上的那一份（经宿主自己的 bare mirror 交叉核对），从不读 PR head 或 worktree：一个 PR 改声明，评判它的仍是它要替换的那一版。
- **工厂代码里的下限**并进每个仓库的边界，声明删不掉：声明文件自己、`.claude/factory-planner-deny.txt`、`.claude/settings.json`、`.claude/settings.local.json`、`.claude/hooks/**`、`.claude/repo-profile.md`、`.gitmodules`。规则（闭包、下面的 1–4）也在代码里（`packages/aos-factory/src/work-r2-boundary.ts`），声明只能往上加。
- **没声明、格式不对、条目在默认分支上不存在**（`r2-undeclared` / `r2-malformed` / `r2-stale`）：不派工（drain、`arc drain`、`arc work dispatch`）、不准入、不决定、不合并，并打一次 `attention(kind=boundary)`；**读不到**（`r2-unreadable`：GitHub / mirror 故障）只拒绝、冷却后重试，不打 attention。
- **剩余路径**：直接 exec `/dev/code-agents/.actions/dispatch-work`（work-board 的 Schedule、任何 loopback 调用者）不经过这道闸。在未声明的仓库上，这样派出的 run 照常运行，仍能用共享 token push 分支、发评论；被挡住的只是合并（merge-check 以 `r2-undeclared` 拒绝）。
- **改声明的 PR 走 boundary-change lane**：只改声明文件的 PR，若声明在 PR head 上校验通过（能解析、下限完整、没有 stale 条目），按禁区处理（correctness + security panel 加跨引擎评判团），由工厂自动合并，记录前后两个 blob；混有其他 R2 文件的 PR 照旧按 R2 拒绝。共享的管理员 token 能绕过工厂直接改 main 上的声明：这一点只做检测（每次判定记录声明 blob，宿主读到新的声明 blob 时写一条 `r2-boundary-changed` 事件），不阻断。

只有从 PR 的 checkout 运行的闸，才保留 import 闭包（#9427，声明里的 `checkout:` 条目）：`.claude/hooks/**`（`settings.json` 用 `$CLAUDE_PROJECT_DIR` 运行，也就是 coder 或 reviewer 在 PR head 上的 worktree）、它们导入的自合并策略、arc 插件，以及 `merge-verified-pr.sh` 声明的运行时输入。其余闸（aos 里的判定模块、daemon 的 merger、`arc work merge-check`、code-agents、R2 准入脚本）运行在 supervisor 部署的 main slot 或 planner 自己的 main clone 上，对 PR 只调用 git / gh。它们的文件本身仍是 R2，但它们 import 的模块不是：这类改动要合并后才会进入闸，合并前照常评审；落在禁区清单里的，还要过 panel 和跨引擎评判团。会抢走显式 R2 模块 import 的新文件（`x.ts` 旁边的 `x.js` / `x.mjs` / `x.cjs` / `x.jsx` / 无扩展名的 `x`）按清单判 R2，与闭包无关。

1. **文件本身是 R2，但不展开它的闭包**：`arc work merge-check` 运行的命令模块（`work.ts`、`lazy-registry.ts`）都是 R2，但不从它们往下展开 import。`merge-verified-pr.sh` 运行的是 PATH 上的 `arc`（slot 或安装版），不是 checkout 里的源码，所以 CLI 本身不进闭包。
2. **闭包内每个包的构建和工具配置都是 R2**：只要一个包里有闭包模块，这个包目录下所有 `*.config.{ts,js,mjs,cjs,json}`、`tsdown*`、`tsup*`、`vite*`、`rollup*`、`esbuild*`、`babel*`、`swc*`、`turbo.json` 都算，连同这些配置的 import 闭包。在这些包里新增的同类文件也算。
3. **仓库级的安装和构建输入一律是 R2**：根目录的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、`.pnpmfile.cjs`、`.yarnrc*`、`bunfig.toml`、`turbo.json`、`tsconfig*.json`、`.nvmrc`、`.node-version`、`biome.json`，根目录的构建脚本（`scripts/build*`），依赖补丁（`patches/`），以及整个 `tools/`（按路径判）。在这一类里新增的文件同样算。另外，root 和闭包内各个包的 `package.json` `scripts` 里，install / prepare / publish / build 这些 lifecycle 和构建命令（包括 build 链会调用的 turbo task 及其 `dependsOn`）引用到的文件也是 R2，连同它们的 import 闭包。命令里引用的路径解析不出来时，fail closed。
4. **会遮蔽现有解析的新文件是 R2**：在基线树上，对闭包内每个模块的每个 import，按解析器的顺序列出候选路径（同名不同扩展名、`<spec>.js/.ts/...`、`<spec>/index.*`、workspace 包的入口）。新增或重命名进来的文件，只有落在某条 import 的候选里、并且排在它当前实际解析到的文件之前，才判 R2，因为它会抢走这条 import。删除闭包内的文件也判 R2。新增一个现有 import 都不会解析到的普通文件不算；以后有闸去 import 它，改那个闸的 PR 本身就是 R2。候选集合算不出来时，闭包模块旁边的每个候选文件都按 R2 处理（fail closed）。

以后再发现绕过 R2 边界的路径，就扩展上面的规则，不往清单里加条目；每条绕过开一个 follow-up issue，并在这里记一笔。R2 边界是在 correctness + security panel（两个引擎）之上额外加的一层人工判断，不能代替 panel。

开发期只有三类问题挡合并：build-break、data-loss、security。其余 finding 不挡，记下来跟进。

## 2. 贴标的格式

贴 NHC 的那条评论，**身份行之后的第一行**必须是：

```
R2: <category> — <一句话问题>
```

`<category>` 取上表的 token。人手写的评论没有身份行，取第一行非空行。接着写选项、推荐、
被 block 的内容。**agent 贴的** NHC 没有这一行，就不是合法的 NHC：读到它的 agent 按第 5 节
立即复判，不当成「等人」。人自己贴的 NHC 没有这一行也照样等人，只适用 7 天复判。
（agent 评论按 machine marker 认：sweep-trace 或 Claude Code footer；只有身份行的评论按人算。）

## 3. 其余一律不等人

需要决定时，先过安全默认（issue-review Step 5.5）：说得出安全默认，就按 ratchet 执行，写明
选了什么、怎么回退，留异议窗口。说不出，按下表分流，都不贴 NHC：

| 情况 | 交给谁 |
|---|---|
| 技术分歧：方向 A/B、大改动、语义争议、review 循环不收敛 | 评判团（review jury） |
| 价值和优先级：做不做、先做哪个 | portfolio（`factory-portfolio`） |
| 分诊失败：推断不出 work-type | 默认 `research`，下一轮按 research 处理 |
| security finding | correctness + security panel；panel 判定确实是漏洞而且修不动，才 park |
| 流程立法：AGENTS.md、`.claude/` 下的 skill 和 routine、`docs/guides/` 里的规则 | 评判团；只有 `r2-list` 和 `merge-criteria` 两类仍是 R2 |

**评判团**就是 #9147 落地的 review jury 机制：至少两个不同于 coder（或作者）引擎的 juror，各自在
clean-context 里审同一个 head，对每条 open finding 投 blocking 或 non-blocking；按 Gate 6
计票，每条取多数；平票算 blocking（例外：每个 juror 都把这条归为 `other` 时不算，#9218）；
security finding 要全票 non-blocking 才算 non-blocking。工厂内由 approval drain 召集
（`packages/aos-factory/src/work-review-jury.ts`，#9144 / #9147）；工厂外的 PR 由作者找两个不同引擎的
clean-context reviewer，计票写进 PR 评论。工厂外这一步目前没有机械闸，靠合并的人核对计票。

## 4. 关 issue、删文件是可逆的

close issue 可以 reopen，删掉的文件可以从 git 恢复，都不是 R2。附上证据去做，评论里写明
**reopen 条件**（出现什么情况应当重开）。父级 rollup 和 doc-audit「无残留」都直接关闭。

## 5. 7 天复判

带 NHC 超过 7 天的 issue 或 PR，由评判团或 portfolio 复判（issue-sweep 每轮扫一次）。复判
只有两种合法结果：

- 执行 A / B / D：A 交工厂或评判团接手，B 由 agent 直接给出决定并执行，D 已完成或过时就关闭；
  执行后摘掉 NHC。
- 改写成 C 类：是真 R2，就**新发一条**第 2 节格式的评论，一句话问题加推荐。7 天从这条评论
  重新计（不改旧评论：旧评论的时间不会重置窗口，sweep 会每轮重判）。

「维持 `needs-human-confirm`」不是合法结论。agent 贴的、没有 `R2:` 行的 NHC 同样按本节复判，
不用等满 7 天。可执行判据：issue-sweep 的 `nhcNeedsRejudge()`（`skills/issue-sweep/test/sweep-golden/lib.ts`）。
