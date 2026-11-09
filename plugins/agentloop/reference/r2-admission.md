# R2 准入：`needs-human-confirm` 只给 R2 决定

本文件是 `needs-human-confirm`（下称 NHC）准入规则的唯一出处。所有 skill、routine 和 fleet
prompt 只链接这里，不各写一份。来源：2026-10-25 的 NHC 全量审计（44 项里只有 1 项是真 R2），
以及 #5500 提出的准入 lint。

## 1. 什么交给人（R2 清单）

人只决定 R2：agent 自己不该做的事。这张表是 R2 清单的唯一出处，factory-planner 的 `approve.md` 级别表与它一致。
repo 可以在 profile 里收紧这张表，不能放宽。评论里用左列的 token：

| `R2: <category>` | 含义 |
|---|---|
| `breaking` | 没有迁移路径的 breaking change（对外接口、数据格式、CLI 行为的不兼容改动） |
| `external-commitment` | 对外承诺（对客户、合作方、公开渠道说的话） |
| `market` | 市场方向（做不做某类产品、面向谁） |
| `permission` | 授予权限或凭据，**放宽**安全策略（收紧不算） |
| `spend` | 花钱 |
| `data-delete` | 删除真实数据、不可逆迁移 |

**不再等人**（agent-factory#24：Robert 在 #factory 514/516 的决定，评判团 claude-fa4c + antigravity-c49a 在
#factory 522/524 通过）：原来的 `release`、`deploy-prod`、`r2-list`、`merge-criteria` 四类。它们照常走评审和评判团，
合并后在 PR 上事后通告，不再等人点头：

- `release`：自动发布仍要满足原来的前提：nightly 是绿的，`scripts/release-check.sh` 通过（AGENTS.md §7）。
- `deploy-prod`：经 `scripts/deploy.sh` 的部署走自动通道；不经它的部署是硬底线（1.2 第 3 项），直接拒绝。
- `r2-list` / `merge-criteria`：改 R2 清单、改「开发期只有 build-break / data-loss / security 挡合并」这条判据、改闸和 panel / 评判团的代码，走 boundary lane（1.1）；gate 路径上的走严格 lane，决定底线本身的文件是硬底线（1.2）。
  改硬底线本身不行（1.2 第 4 项）。

### 1.1 R2 边界与 boundary lane

「R2 清单本身」包括执行它的东西：禁区清单、R2 边界声明（目标仓库默认分支上的 `.claude/factory-r2-boundary.txt`，#9637）、合并闸和 panel / 评判团的代码、
禁止自合并的 hook 和脚本。改它们走 boundary lane（下面），不按普通 PR 合并；工厂不能在 R1 里放松自己的闸。
闸的运行时输入和闸的代码一样属于 R2：它读的配置和 profile（例如 `.claude/repo-profile.md` 的 `factory_merge_check_entry`），
以及决定它的代码怎么解析的清单（`package.json`、`tsconfig.json`、`pnpm-workspace.yaml`）。

R2 边界是「目标仓库声明的名单 + 从 PR 自己的 checkout 运行的闸入口的 import 闭包」，外加下面几条规则（#9637）：

- **名单由目标仓库在默认分支上声明**：`.claude/factory-r2-boundary.txt`（grammar 见 `packages/aos-factory/src/work-r2-declaration.ts`）。宿主只读 GitHub 证明的默认分支 tip 上的那一份（经宿主自己的 bare mirror 交叉核对），从不读 PR head 或 worktree：一个 PR 改声明，评判它的仍是它要替换的那一版。
- **工厂代码里的下限**并进每个仓库的边界，声明删不掉：声明文件自己、`.claude/factory-planner-deny.txt`、`.claude/settings.json`、`.claude/settings.local.json`、`.claude/hooks/**`、`.claude/repo-profile.md`、`.gitmodules`。规则（闭包、下面的 1–4）也在代码里（`packages/aos-factory/src/work-r2-boundary.ts`），声明只能往上加。
- **没声明、格式不对、条目在默认分支上不存在**（`r2-undeclared` / `r2-malformed` / `r2-stale`）：不派工（drain、`arc drain`、`arc work dispatch`）、不准入、不决定、不合并，并打一次 `attention(kind=boundary)`；**读不到**（`r2-unreadable`：GitHub / mirror 故障）只拒绝、冷却后重试，不打 attention。
- **剩余路径**：直接 exec `/dev/code-agents/.actions/dispatch-work`（work-board 的 Schedule、任何 loopback 调用者）不经过这道闸。在未声明的仓库上，这样派出的 run 照常运行，仍能用共享 token push 分支、发评论；被挡住的只是合并（merge-check 以 `r2-undeclared` 拒绝）。
- **R2 边界内的改动走 boundary lane，由宿主 merger 自动合并，不等人**（agent-factory#24，扩展了原来只收声明文件的
  boundary-change lane）。条件都在代码里（`packages/aos-factory/src/work-merge-check.ts`）：
  - correctness + security panel；
  - 跨引擎评判团：至少 `BOUNDARY_LANE_MIN_JURY_ENGINES`（2）个**互不相同**、都不在 coder 集合里的引擎 approve，
    同一个引擎投两次只算一个；
  - 0 条 open P0–P2：当前 round 上任何 non-approve 都挡合并，除非评判团按第 3 节计票通过；
  - 只有 daemon 的 host merger 判 lane：没有 PR head 树的调用方（`arc work merge-check`、coder 自己）一律 `deny-path`，
    不打 attention；coder 从不合并自己的改动。
- **lane 保留的不变量**：改闸的 PR 由默认分支 tip 上的闸判（它要替换的那一版，不是它自己）；PR 改声明时，声明在
  PR head 上校验（能解析、下限完整、没有 stale 条目、闭包算得出），记录前后两个 blob；共享的管理员 token 绕过工厂直接改
  main 上的声明只做检测（宿主读到新的声明 blob 时写一条 `r2-boundary-changed` 事件），不阻断；nightly 是 substrate
  上的独立检查，被监督方写不了它（1.2 第 1 项）。
- **合并之后**：host merger 写一条 `boundary-lane-merged` 事件（带 merge commit 和改到的 R2 文件），并在 PR 上贴一条事后
  通告，里面有一行 `PR #N · git revert <sha>`，一步回退（GitHub 还没给出 merge commit 时写成 `git revert <merge commit>`，
  后面附一条放在代码段里的 `gh pr view` 查询命令，不是 shell 展开，也从不用 PR head 代替）。通告发不出去不影响合并。通告目前只发到 PR 上，不发 #factory 频道（频道通知读的工作事件流没有这个字段）。
- **lane 里仍交给人的**：diff 里看得出的权限放宽，即 `.claude/settings.json` / `settings.local.json` 加 allow 或
  additionalDirectories、去掉 deny 或 ask、改 defaultMode、删 hook 命令、打开 disableAllHooks、启用 MCP server、
  新增或修改 env、`enabledPlugins` 新开一个、`extraKnownMarketplaces` 新增或改动、`sandbox` 有任何改动；
  `statusLine` 改动、插件 `.lsp.json` 和 `plugin.json` 的 `lspServers`、skill / agent / command frontmatter 里的 `hooks`、
  `mcpServers`、`permissionMode`、`allowed-tools`（按 YAML 解析，合并键 `<<:` 展开，BOM 不影响）、hook 条目（event + matcher + command）新增、被改或被删（新 hook 可以对所有工具答 `permissionDecision: "allow"`）；
  `.claude/factory-planner-deny.txt` 去掉条目；新增或删掉 `.claude/hooks/**` 里的文件，或改动已有 hook 的正文（任何改动都算：
  提前 `exit(0)`、永不匹配的正则和改措辞分不开）；`.mcp.json` 新增或改动 MCP server（`packages/aos-factory/src/work-r2-permission.ts`）。不管在不在
  R2 边界里，这些都判 `deny-path` 并打 `attention(kind=boundary)`。收紧不算（`sandbox` 例外：任何改动都交给人）。
  其余 R2 类（`breaking`、`data-delete`、`spend`、`external-commitment`、`market`）在 diff 里看不出来，没有机械闸：
  lane 里由 panel 和评判团判，需要它们的 work 在派工前就按第 2 节贴 `R2:`。
- **adopted PR**（工厂收养的外部 PR）改 R2 边界照旧 `deny-path` 交给人：它的 coder 引擎是自报的，评判团证明不了独立性。

只有从 PR 的 checkout 运行的闸，才保留 import 闭包（#9427，声明里的 `checkout:` 条目）：`.claude/hooks/**`（`settings.json` 用 `$CLAUDE_PROJECT_DIR` 运行，也就是 coder 或 reviewer 在 PR head 上的 worktree）、它们导入的自合并策略、arc 插件，以及 `merge-verified-pr.sh` 声明的运行时输入。其余闸（aos 里的判定模块、daemon 的 merger、`arc work merge-check`、code-agents、R2 准入脚本）运行在 supervisor 部署的 main slot 或 planner 自己的 main clone 上，对 PR 只调用 git / gh。它们的文件本身仍是 R2，但它们 import 的模块不是：这类改动要合并后才会进入闸，合并前照常评审；落在禁区清单里的，还要过 panel 和跨引擎评判团。会抢走显式 R2 模块 import 的新文件（`x.ts` 旁边的 `x.js` / `x.mjs` / `x.cjs` / `x.jsx` / 无扩展名的 `x`）按清单判 R2，与闭包无关。

1. **文件本身是 R2，但不展开它的闭包**：`arc work merge-check` 运行的命令模块（`work.ts`、`lazy-registry.ts`）都是 R2，但不从它们往下展开 import。`merge-verified-pr.sh` 运行的是 PATH 上的 `arc`（slot 或安装版），不是 checkout 里的源码，所以 CLI 本身不进闭包。
2. **闭包内每个包的构建和工具配置都是 R2**：只要一个包里有闭包模块，这个包目录下所有 `*.config.{ts,js,mjs,cjs,json}`、`tsdown*`、`tsup*`、`vite*`、`rollup*`、`esbuild*`、`babel*`、`swc*`、`turbo.json` 都算，连同这些配置的 import 闭包。在这些包里新增的同类文件也算。
3. **仓库级的安装和构建输入一律是 R2**：根目录的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、`.pnpmfile.cjs`、`.yarnrc*`、`bunfig.toml`、`turbo.json`、`tsconfig*.json`、`.nvmrc`、`.node-version`、`biome.json`，根目录的构建脚本（`scripts/build*`），依赖补丁（`patches/`），以及整个 `tools/`（按路径判）。在这一类里新增的文件同样算。另外，root 和闭包内各个包的 `package.json` `scripts` 里，install / prepare / publish / build 这些 lifecycle 和构建命令（包括 build 链会调用的 turbo task 及其 `dependsOn`）引用到的文件也是 R2，连同它们的 import 闭包。命令里引用的路径解析不出来时，fail closed。
4. **会遮蔽现有解析的新文件是 R2**：在基线树上，对闭包内每个模块的每个 import，按解析器的顺序列出候选路径（同名不同扩展名、`<spec>.js/.ts/...`、`<spec>/index.*`、workspace 包的入口）。新增或重命名进来的文件，只有落在某条 import 的候选里、并且排在它当前实际解析到的文件之前，才判 R2，因为它会抢走这条 import。删除闭包内的文件也判 R2。新增一个现有 import 都不会解析到的普通文件不算；以后有闸去 import 它，改那个闸的 PR 本身就是 R2。候选集合算不出来时，闭包模块旁边的每个候选文件都按 R2 处理（fail closed）。

以后再发现绕过 R2 边界的路径，就扩展上面的规则，不往清单里加条目；每条绕过开一个 follow-up issue，并在这里记一笔。boundary lane 的评判团是在 correctness + security panel 之上额外加的一层，不能代替 panel。

### 1.2 三档：硬底线、严格 lane、lane（Robert 2026-11-03 定：窄 floor，`R2: r2-list`）

R2 边界内外的改动按下面三档判，代码在 `packages/aos-factory/src/work-r2-hard-floor.ts` 和 `work-merge-check.ts`：

- **硬底线**（下面标记段）：直接拒绝，只有 Robert 手改。
- **严格 lane**：gate 路径上的改动。correctness + security panel，加 `STRICT_LANE_MIN_JURY_ENGINES`（3）个**互不相同**、
  都不在 coder 集合里的引擎 approve，0 条 open P0–P2，只由 host merger 合并。approval drain 用同一个判定函数给这类 round
  雇 panel 和 3 个不同引擎，不会在第 2 个 approve 后就交给 merger。收养的 PR（coder 引擎自报）落在严格 lane 上照旧交给人。
  合并后写 `boundary-lane-merged` 事件（`strictLane: true, nightlyWatch: true`），PR 通告里提醒盯下一次 main 上的 nightly，
  并附一步回退的 `git revert` 行。`nightlyWatch` 目前**没有任何东西读它**：只是给人和以后的 nightly 侧留的标记。
- **lane**：其余 R2 边界改动走 1.1 的 boundary lane（2 个不同引擎）；不在边界里的走普通评审。

<!-- r2-hard-floor:begin -->
下面四项直接拒绝合并（拒绝码 `hard-floor`，按 security finding 记录）：**不交给人**，有满票评判团、security panel、
0 条 P0–P2 也不自动合并。agent 不做这些事，只有 Robert 手改。清单固定在代码里
（`packages/aos-factory/src/work-r2-hard-floor.ts`），本段与它逐项一致，目标仓库的声明删不掉它：

1. `oversight-substrate`：让被监督方写自己的监督 substrate。按名字族判：`scripts/`、`.github/`、`.claude/routines/`、
   `routines/`、`blocklets/factory/test/`、`blocklets/factory/src/daemon/factory-routines/` 下任意深度，文件名（去掉
   `io.arcblock.arc.`、`factory-` 前缀后）以 `nightly`、`oversight`、`supervisor`、`attach-supervisor`、`absence`、`watchdog`、
   `epic-watchdog`、`epic-status`、`heartbeat`、`presence-heartbeat`、`stall-watchdog`、`test-shards` 开头，或文件名里任意位置
   含 `oversight`；另有 `scripts/nightly/**`、`scripts/lib/factory-layout.*`、`docs/architecture/oversight-discipline.md`。
2. `jury-bypass`：绕过评判团，或让 coder 合并自己的改动：在 merger 以外新增一处合并 PR 的调用（`gh … pr … merge`、
   `["pr", "merge"]` 这类 argv、REST 的 `pulls/<n>/merge`、GraphQL 的 `mergePullRequest` 等，按命令文本比，测试和文档除外）；
   PR head 上新出现的、把 merge 入口传到调用方的 importer（见下）；在宿主和库代码里新增的几种**明显**写法（快速通道，不是
   完整判定）：非字面量路径的 `import()` / `require()` / `createRequire` 函数、既拉起 `gh` 又提到 merge（拼接的字符串按拼好后读）、
   Octokit 的 `pulls.merge` / `merge_pull_request`；`scripts/lib/factory-self-merge-policy*`、
   `scripts/test/factory-self-merge-policy*`、任意 `hooks/` 目录下的 `*self-merge*`；`.claude/settings*.json` 和插件 `hooks.json`
   里 self-merge 守卫的 hook 条目（matcher 加 hook 的全部字段，`if`、`timeout` 都算）被改或被删；`disableAllHooks` 被打开；
   `.claude/repo-profile.md` 的 `factory_merge_check_entry` 被改或被删；`merge-verified-pr.sh`。
3. `deploy-outside-channel`：不经 `scripts/deploy.sh`（只认这个大小写）的部署：在部署面（`.github/**` 的 yml、shell 脚本、
   `package.json`、Makefile、`.husky/` `.githooks/` 下的 git hook、任意深度 `scripts/` `tools/` `bin/` 下的脚本，含测试和
   `.mts` / `.cts`）新增或改动一条部署命令：同一条命令里 `wrangler` 之后出现 `deploy` / `publish`（中间夹 flag、反斜杠续行、
   一行内的 `spawn` / `execa` argv、先把 `wrangler` 赋给变量再 `"$W" deploy` 都算）；包管理器跑一个以部署命名的 package script
   （`pnpm --filter x run deploy-worker`、`npm run publish-worker`、`… ship`）；`cloudflare/wrangler-action`、`cloudflare/pages-action`。
   按命令文本比，`--env staging` 改成 `--env production` 也算。
4. `floor-list`：决定底线本身的文件，整文件判，连同所有解析候选（无扩展名的同名文件、`<名>.<任意扩展名>`、`<名>/**`）：
   `work-r2-hard-floor.ts`（含门槛 `BOUNDARY_LANE_MIN_JURY_ENGINES = 2`、`STRICT_LANE_MIN_JURY_ENGINES = 3`）和它的测试、
   调用底线并复核计数的 `work-merge-check.ts`、merge 入口（`work-factory-merge.ts`、daemon 的 `factory-merge.ts`、CLI 的
   `work-merge-check-run.ts`）、提供 base 树的 `r2-boundary-snapshot.ts`、floor 模块唯一的依赖 `work-r2-boundary.ts`（它算 head 上的
   importer 和 gate 路径的范围），以及本段文字。gate 路径算不出来时按底线拒绝
   （fail closed）。
<!-- r2-hard-floor:end -->

**严格 lane 的范围（gate 路径）**：在默认分支的树上，从 merge 入口模块（floor 模块、merge check、factory merge、daemon 的 merger、
CLI 的 merge check）出发：
- **正向闭包**：它们 import 的所有非测试模块，任意 import 边都算。daemon 的 merger import 整个 barrel，所以整个
  `packages/aos-factory/src`（review gate、review output、jury、deny paths、R2 声明、change set、panel、permission……）
  和宿主侧被加载的模块都在里面。
- **反向闭包**：把入口传到调用方的模块。在 `packages/aos-factory/src` 里只算 `export … from`，也就是 barrel；
  在宿主侧任何 import 都算，即 daemon、CLI、bundle 入口。
- 以上每个模块的所有解析候选（大小写折叠）。
- gate 包的构建配置；gate 包和根目录的 `package.json` / `tsconfig*.json` / `bunfig.toml`，**只在**解析相关的键变化时：
  - `package.json`：`exports` `imports` `main` `module` `bin` `type` `workspaces` `overrides` `resolutions`
    `patchedDependencies` `pnpm` `dependencies` `peerDependencies` `optionalDependencies`，以及构建链里的 scripts；
  - tsconfig：`paths` `baseUrl` `extends` `references` `rootDirs` `moduleResolution` `customConditions`；
  - bunfig：`preload` `plugins` `loader` `define` `alias` `registry`；
  - 改版本号、改 devDependencies、改不在构建链里的 scripts，不进严格 lane；但根目录和闭包内各包的 `package.json`、
    `tsconfig*.json` 本身仍在 R2 边界里（1.1 的规则 2、3），所以这类改动走 2 引擎的 boundary lane，不是普通评审。
- gate 模块所在目录一直往上到根目录，任何一层新增或改动 `tsconfig*.json`、`jsconfig*.json`、`package.json`、`bunfig.toml`、
  `.npmrc`（例如 `src/tsconfig.json` 的 `paths` 把一个依赖指到 shim）；仓库里任何深度的 `node_modules/**`。
- 一律算严格 lane 的：`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.pnpmfile.*`、`patches/**`、`scripts/build-factory-bundle.*`、
  已提交的 bundle `blocklets/factory/providers/**`、`blocklets/factory/blocklet.yaml`、`vendor/arc` gitlink 和 `.gitmodules`、
  根 `.npmrc`、`turbo.json`。gitlink 的提升还要求新 commit 在子模块的默认分支上（host merger 用 GitHub compare 核对；子模块地址取自**默认分支**的
  `.gitmodules`，不是 PR head 的；核对不了就拒绝）。

**daemon 加载的代码一律严格 lane（按位置，不按写法）**：daemon 的 bundle（`scripts/build-factory-bundle.ts` 的两个入口
`blocklets/factory/src/index.ts`、`packages/code-agents-factory/src/index.ts`）正向闭包里的模块，以及 `blocklets/factory/src/**`、
`packages/code-agents-factory/src/**` 下任何源文件（含还没被 import 的新文件），以及 bundle 加载的每个包（gate 包
`packages/aos-factory` 在内）的 `src/**` 下任何文件，改动都走严格 lane，不管今天的闭包有没有走到它：两步走的 PR（先让 gate 模块
`import("./later.js")` 或 import `./zzutil`，再只加 `src/later.ts` 或抢先于 `zzutil/index.ts` 的 `src/zzutil.ts`）第二步也要 3 个引擎。
闭包本身仍用来判仓库级、配置和影子文件。理由：这些代码和 merger 共用
同一份 gh 凭据，任何写法的合并都只隔着一次评审。所以「merger 以外的合并调用一律是硬底线」**不成立**：上面的快速通道只抓明显
写法，混淆过的合并（变量里的 `gh` 路径、拼出来的 verb、解构的 Octokit、拼出来的 URL 上的 `fetch`、`eval` / `new Function`）
只靠严格 lane 的 3 引擎评审拦（残余风险）。

**文件模式**：host merger 从 mirror 用 `git ls-tree -z` 读每个变更文件在 head 上的 git 模式（路径不转义）。**任何**新增或改动的
符号链接（`120000`），以及 `vendor/arc` 以外的任何 gitlink（`160000`）→ 交给人：approval drain 不读模式，放进严格 lane 会让
drain 和 merge check 互相等。`vendor/arc` 的提升走严格 lane，且新 commit 要在 arc 默认分支上。读模式失败一律拒绝；碰到
gate 路径、daemon 加载的路径、权限面或 agents / skills / commands / hooks / `.claude` / `.claude-plugin` / `node_modules`
目录、却读不到模式（或某个在 head 上存在的路径缺模式）→ 拒绝（fail closed）。gate 路径的正向闭包顺着符号链接走到目标文件。
被**删掉**的符号链接（默认分支上是链接）同样交给人。名为 `node_modules` 的路径、daemon 加载根和 gate 路径下的测试 / fixture
文件也算严格 lane；gate 模块 import 的测试 / fixture 文件会被打进 bundle，所以正向闭包也沿着这些 import 走（只有测试文件自己
发出的 import 不算把 merge 入口传出去）。`plugin.json` 的 `agents` / `commands` /
`skills` / `outputStyles` 路径改动、`.claude-plugin/marketplace.json` 的改动 → 交给人。

非工厂 PR 碰到 gate 路径时，严格 lane 只能由 host merger 判，所以拒绝，由人合并。

哪些能机械判定，哪些不能：
- 底线第 1、2、4 项的路径按路径判（大小写折叠，新文件落进名字族或影子候选也算），改动整个文件都算。
- 按内容判的：self-merge hook 条目、`disableAllHooks`、`factory_merge_check_entry`、本段文字（标记之间与默认分支不同，
  或标记被删）、第 3 项。
- 交给人、不直接拒绝的：`instances.json`、`wrangler*.toml` / `wrangler*.json(c)` 的任何改动，以及含部署命令的文件在命令不变时的
  改动（例如 env 值 `TARGET: staging` 改成 `production`）。

残余风险（明确接受，不在底线上）：
- gate 路径上的改动只要 3 个不同引擎一致 approve 就能合并，包括 `findingBlocksMerge`、计票、R2 声明读取器这类会改变判定的
  模块。合并后的 nightly 只是提醒：nightly 侧还**没有**接上「红了就自动开 revert PR / 报警」，那需要改 nightly（底线），
  要 Robert 手改。
- bundle 没有新鲜度检查（「bundle 等于 head 源码的构建结果」）：这次按要求没有在这里重建 bundle，可复现性没测。所以 bundle
  重建 PR 走严格 lane，而不是普通评审。
- PR head 上**新改**的 import 只对新出现的 importer 判（底线第 2 项）；正向闭包只按默认分支的树算。head 上被 gate 模块新
  import 的新文件不单独判，因为改了那个 gate 模块的 PR 本身已经在严格 lane 里。
- 别的云厂商 CLI、直接调 API 的部署；跨多行写的 argv；名字不像部署的 package script（不解析 script 内容）；`scripts/` `tools/`
  `bin/` 以外源码里拉起的部署；写在 skill 或 prompt 里让 agent 去执行的部署。
- 没有 head 读取器的调用方（CLI 的收养路径）跳过 head 上的 importer、合并调用和插件 hook 检查，交给 daemon merger 判。
- 进程内的运行期篡改：被 daemon 加载、却不在 gate 路径上的模块理论上可以在运行时改全局对象（例如经 `globalThis` 拿到
  已加载的 merger）。
- `merge-verified-pr.sh` 找不到 factory（没有 arc / daemon）时，凭调用方的 `--not-factory` 断言合并，不过任何底线；只在非
  `factory/*` 分支上，而且要显式写出理由。

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
| 流程立法：AGENTS.md、`.claude/` 下的 skill 和 routine、`docs/guides/` 里的规则 | 评判团；改 R2 清单（原 `r2-list`）和挡合并判据（原 `merge-criteria`）落在 R2 边界里的走 boundary lane（第 1.1 节），改硬底线不行（第 1.2 节） |

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
