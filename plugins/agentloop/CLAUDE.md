# CLAUDE.md — 维护 agentloop 插件的规则

在 `.claude/plugins/agentloop/` 下工作时自动加载。这里只放**改动本插件必须遵守的规则**，
教程和字段说明住在 [`README.md`](./README.md)（引擎 / 发布 / 消费方式）和
[`fleet/README.md`](./fleet/README.md)（driver / 配置字段 / 权限姿态）。

## 第一原则：这是分发出去的可复用插件，不是 arc 私有脚本

`arc/.claude/plugins/agentloop/` 是**唯一真相源**；`ArcBlock/agent-skills` 是单向发布镜像，
cron/fleet 从**镜像 clone**（`~/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop`）
加载。由此推出三条铁律：

1. **只改真相源，绝不手改镜像 clone。** `git pull` 镜像 ≠ 更新插件——用 `claude plugin update`。
2. **任何内容改动必须 bump version**（`.claude-plugin/plugin.json`）。同版本号改动镜像/缓存不可靠拾取。
   发布链路（bump→sync→push agent-skills→update→验证）见 [README 的 Publishing 章](./README.md#publishing--release-how-a-change-here-reaches-the-fleet)，
   一步跑完是 `bash scripts/publish-agentloop.sh --bump patch|minor|major`。
3. **面向多仓库、多部署写**。别假设 arc 的目录、工具链、label 存在——它们来自消费仓库的 profile（下条）。

## 核心：Generic（住这里）vs Per-repo（住消费仓库）

判定一行代码/文案该放哪，问一句：**「换一个不是 arc 的仓库，这行会不会错？」** 会错 = per-repo。

| Generic —— 属于本插件 | Per-repo —— 属于**消费仓库** |
|---|---|
| 机制：report kernel、comment 投递、merge gate、sweep/review 的判断流程、fleet driver | 工具链命令（`pnpm` vs `bun`）、构建/测试/lint 命令 |
| 跨仓库不变的纪律（round-awareness、dry-run 契约、升级前硬前置） | 仓库路径、face-paths、label 集合、verification check 清单 |
| 配置 **schema**（`driver.ts` 的 `DeploymentConfig`/`RepoEntry`） | deploy 细节、DID Space / 部署目标 |

- 消费仓库的具体值住 **`.claude/repo-profile.md`** + **`.claude/verify/config.ts`**（check 列表）。
  skill 从 profile 读工具链/label/verification_entry，不硬编码。
- **新引用一个 `<profile_key>` 要同步三处**（否则漂移）：① 引用它的 skill；② arc
  `.claude/repo-profile.md`（reference 实现，给真实值）；③ `bootstrap/init-profile.sh`（scaffold
  的 `<FILL>` 占位）——第③处最易漏：漏了，新采用者 repo-setup 出来的 profile 就缺这个键，
  de-arc 化的 skill 在 face/companion-gated 步骤里撞 dangling `<占位符>`。**skill 引用的键集 ≡
  init-profile.sh scaffold 的键集**，两者不能分叉（本条正是补一次这种分叉后立的规矩）。
- **通用脚本 ship 进插件 `scripts/`，repos 引用不拷贝**：`agent-identity.sh`、`agent-capabilities.sh`、
  `gh-upload-media.sh`（单个媒体:图片/视频）、`gh-upload-dir.sh`（整目录媒体 → `filename\turl` map，内部循环调
  gh-upload-media）都是 UNIVERSAL（任何仓库同样跑，如 gh-upload 自动从 git remote 探 source repo）。
  canonical 住 `<plugin_root>/scripts/`，消费仓库的同名 `scripts/x.sh`（若有）是薄 delegator。判据同上：
  「换个仓库这脚本会不会错」——不会 = 进插件 `scripts/`。别让每个仓库各拷一份（会漂移，正是 #1037 修的）。
  **反例教训**：目录循环上传之前只有 arc 有（旧 `img-upload/upload.sh`），于是 arcblock-site 的
  ui-verify 把同一段 `for f in *.png; do gh-upload-media "$f"; done` 又抄了一遍（还带细微不一致）——
  did 建 ui-verify 就是第三份。目录循环够通用 = 必须进插件,消费方零复制。
- **现状**：skills 里仍残留 arc 专属 case-law（issue 号、路径）。去 arc 化是 #1037 的持续目标。
  **动到某个 skill 时，倾向把 arc 专属项挪进 repo-profile，而不是再加一条**。新写的判断逻辑
  用「能被 profile 参数化」的形式，别写死 arc。
- 例外方向反了要停：如果你发现自己在往 skill 里加「arc 的 #XXX 里…」这类硬编码，先问这是不是
  该进 repo-profile。

## 部署特定偏好走本地，不进默认 prompt

`driver.ts` 的 `renderPrompt` 是**全量替换**（读整个 prompt 文件 + `{{RUNNER}}` 替换），没有
append/addendum 机制；部署用 `promptDir` 覆盖**整份** prompt。所以：

- **某台机/某个部署独有的偏好**（例：「这台机器有 native 工具链 → 优先驱动 native issue」）属于
  **本地 prompt / 本地配置**，绝不塞进 `fleet/prompts/*.md` 默认 prompt——那会强加给所有部署。
- 默认 prompt 只放对**任何**部署都成立的通用回路。

## 配置字段：`driver.ts` 是唯一真相，改字段要同步四处

`DeploymentConfig` / `RepoEntry`（带 doc 注释）是权威 schema。**新增/改字段时同步更新**：
1. `driver.ts` 的接口 + doc 注释（为什么存在、默认值、坑）；
2. `fleet/README.md` 的字段参考表；
3. `fleet/deployment.example.json`（若是常用字段，进模板，别让同事照抄就撞坑——如 daemon repo 的 `skillEnv`）；
4. `fleet/setup.ts` 的 `buildDeployment`（installer 生成 config——新字段要么进 defaults，要么进 `SetupInput` + CLI flag，否则 `/agentloop:fleet-setup` 生成的 config 缺这个字段）。

## Setup / 调度是生成的，不是手写的

`/agentloop:fleet-setup`（+ `fleet/setup.ts` installer）是 fleet 的**一条命令调度入口**——生成/对账
`deployment.json`+`repos.json` 并装 crontab（本地）/ RemoteTrigger routine（云端）。它是 `repo-setup`
（把单个 repo 变成可消费：profile+labels+verify）的**调度对侧**——repo-setup 故意不碰调度。规矩：

- **config 是生成的**，别手写；installer reconcile 时**保留**手加的 `skillEnv`/`env`/`cloneUrl`，
  结构字段以显式答案为准。改 installer 逻辑（`renderCronBlock`/`reconcileCrontab` 等）先看 `fleet/setup.test.ts` golden。
- **crontab 用 marker 块**（`# agentloop-fleet:begin/end`），`reconcileCrontab` 只删自己的块、绝不 `crontab -r`。
- **调度无 cron 级锁**：cron 行不再包 `shlock`/`flock`。并发由 driver 的 **per-(repo,skill) 锁**（`fleet/runlock.ts`，PID+存活判定，`wx` 原子创建、死锁自愈）承担——重叠 invocation 各自跳过"正被 live pid 跑着"的 repo，一个慢 repo 只拖自己不拖全队。共享文件（`.fleet-state.json`/`fleet.jsonl`）写走 `withFileLock`。**改 renderCronRow 别把锁加回去**，锁的职责在 driver 不在 cron。
- **本地走 driver 代码，云端走 skill 指挥 RemoteTrigger**（MCP 工具是 Claude 的、不是脚本的）；两端共享同一
  catalog + `fleet/prompts`，只是调度基底不同。`setup.ts --emit-cloud-plan` 把 catalog→routine 规格
  确定性地吐成 JSON，skill 照 plan 执行，减少 LLM 出错。

## 自测纪律：本插件自带的测试必须绿

- `lib/*.test.ts`（report / comment / gate 引擎）+ `skills/issue-sweep/test/sweep-golden/`
  （marker / round-awareness 金测）+ `fleet/*.test.ts`（driver 规划、setup 生成/对账、runlock
  锁语义）。改引擎或 marker 逻辑**先看 golden**；改 fleet 锁/调度**先看 `runlock.test.ts` +
  `setup.test.ts`**。
- **round-awareness 的 marker 检测很微妙**（`MACHINE_MARKER` 正则、行锚定的 `GENERATED_FOOTER`——
  人类引用 AI 评论时不能被误判成机器，#1831）。别在不动 golden 的情况下改 marker 判定。
- 跑法：`cd .claude/plugins/agentloop && bun test lib/ skills/<skill>/test/`。

## Skill 交叉引用：slash command 必带 `agentloop:` 前缀

插件 skill 的调用形态是 `/agentloop:<skill>`（plugin 命名空间），**不是**裸 `/<skill>`。
因此本插件文件里任何指向**另一个插件 skill** 的 slash-command 引用都必须带前缀。判据只有一句：
**这个 skill 装在哪？** 插件里 → 带 `agentloop:`；消费仓库的 `.claude/skills/` → 裸名（project
skill 无命名空间，别硬加前缀）。

| 引用对象 | slash command | markdown 相对链接（从插件 skill 出发） |
|---|---|---|
| **本插件 skill**（issue-sweep / pr-review / design-review / build-phases / verification / issue-graph / impact-check / media-upload …） | `/agentloop:build-phases` ✅　裸 `/build-phases` ❌ | `../<skill>/SKILL.md` |
| **消费仓库 project skill**（住 `.claude/skills/`，如 ui-verify / e2e-verify / e2e-gate / deploy / plan-status） | 裸 `/ui-verify` ✅ | `../../../../skills/<skill>/SKILL.md` |

- 反向同理：`.claude/skills/` 下的 project skill 引用**插件 skill** 时，slash command 要 `/agentloop:<skill>`，
  链接要 `../../plugins/agentloop/skills/<skill>/SKILL.md`。
- 改完用**定向检查**证明每个链接可解析（`test -f` 会自然解析 `../`；**别用 macOS 不支持的
  `realpath -m`**，会把全部链接误报成 broken）。

### 沉淀一个 skill 进插件时（#1037 的迁移动作）：全仓 sweep 它的每处引用

把一个 skill 从消费仓库 `.claude/skills/` 挪进插件 `skills/` 后，它的调用形态从裸 `/<skill>`
变成 `/agentloop:<skill>`。**必须全仓 sweep 对这个被沉淀 skill 的每一处 slash-command 引用**，
两个方向都要改：

1. **插件内**：其它插件 skill 里引用它的地方（companion 引用）。
2. **消费仓库**：`.claude/skills/` 里的 project skill、`.claude/verify/`、`planning/`、CLAUDE.md
   里引用它的地方。

漏一处的后果是实测过的、不是假设：那处裸 `/<skill>` 会 resolve 到消费仓库残留的**同名 stale
fork**（arc main 就还带着若干同名旧副本），或直接 `Unknown skill` 挂掉无人值守 routine（且模型
不自纠）。判据仍是那一句——**这个 skill 现在装在哪**：插件里 = 带前缀。

**这条已经自动化，不再靠人记得跑**：

- **canonical 守卫** = `scripts/lint-skill-namespace.sh`（Rule A：pinned-literal `name: 'x'` 调用；
  Rule B：任何 SKILL.md 里裸 `/<plugin-skill>` 引用——**同时扫插件 skill 树 + 消费仓库 `.claude/skills/`
  两棵树**）。自带负向自检（探针匹配不到就 exit 2，绝不用「静默 ✓」骗你）。
- **已接进 gate**：`.claude/verify/checks/check-skills.ts` shell out 调它，随 `pre-pr` 每次跑
  （目前 warn-only，和该 check 的既有姿态一致；误报率调稳后翻 blocking）。**别在 check-skills 里
  重抄一份正则**——单一真相源在 bash 守卫里。
- **新增一个插件 skill 名**（如将来再沉淀一个）→ 记得把名字加进守卫的 `SKILLS` 列表，否则对它的裸引用抓不到。

## 合并 main / 迁移窗口期的合并纪律

skills 已从旧 `.claude/skills/**` 迁到本插件，但 main 仍可能改**旧路径**。合并时 git 的 rename
检测**不可靠**（相似度不够就不映射）：

- 逐一核实 main 对旧 `.claude/skills/**` 的每处改动，是否被带进了本插件对应文件——auto-merge 进来的
  **测试**常常是这条改动的存在性证据（测在、实现不在 = 必须手工 port）。
- 冲突解决取「结构用插件版、内容并入 main 的改进」，并适配 plugin 的去 arc 化文案（如 footer）。
- **main 改的旧路径 skill 里 slash command 是裸 `/skill`（无命名空间），并入后必须逐一改成
  `/agentloop:<skill>`**——见上节「Skill 交叉引用」。合并后 grep 全仓库扫裸 slash command 和失效
  markdown 链接（正反两个方向都要），两者都修，别放过 auto-merge 悄悄带进来的裸引用。
- 提交前用**定向测试**证明一致（lib + golden + 受影响脚本的类型检查），别只靠「无冲突标记」。

## AFS-Only I/O 不约束本目录

仓库根 CLAUDE.md 的「所有 I/O 走 AFS」是给**运行时 / provider 代码**的。本插件是**开发期工具**
（shell 出 `gh`/`git`/`bun`、读写本地 checkout），不是 AFS provider，直接用 `Bun.spawn` / `node:fs`
是对的，别硬套 AFS 抽象。
