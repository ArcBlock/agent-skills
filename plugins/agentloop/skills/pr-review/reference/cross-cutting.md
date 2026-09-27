# pr-review — Step 2.5 cross-cutting dimensions (full table)

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Step 2.5 — ★ 横切影响核验(diff 之外必查,不分 PR 类型)

Step 2 核验"这个 PR **声称**改的";这一步核验它对**系统其他部分**的影响——diff 内自洽看不出,必须跳出 diff 主动去搜。**这是 agent review 最常漏的一层**:只盯着改动本身,不问"谁依赖它、别处要不要同步改、有没有真接进使用场景、会不会变慢、测了没、**测的能不能失败**、旧的清了没"。逐维度过,每维度**要么给证据、要么显式判"不适用"**——漏查和查过判"不适用"是两回事:

| 维度 | 何时查 | 怎么查 | 命中处置 |
|---|---|---|---|
| **反向引用** | diff 删文件 / 删或 rename export / 改公开签名 | 跑 [`impact-check`](../../impact-check/SKILL.md):按 basename 反向搜全 repo(含多行 import、`readSource`/动态引用),别只搜单行 `import` | 悬空引用 = 确定性 break `check-types`/`test` = 本 PR 真实缺陷 → 归 Step 3 根因 (a),可 `BLOCK`,列每处 `path:line`。**先于 Step 3 跑**,能预判 verification 红在哪、把根因钉在本 PR 而非陈旧 base |
| **跨包 parity(镜像 + 配套)** | ①改 runtime 层(`node`↔`cloudflare`)/双端共享 provider;②给枚举·联合类型·注册表·factory **新增一项**(新 widget/组件/消息类型/provider kind 等) | ①对照另一 runtime 同语义两边是否都改;②grep 消费该枚举的 switch/dispatch/renderer(常在**另一个包**)是否加了对应 `case`/handler | 缺对等 → `BLOCK`(确定性 bug)或 `COMMENT`(单侧有意为之)。**②最隐蔽:消费端有 `default`/兜底分支(渲染 "Unknown"/静默 no-op)时,`check-types`/build 全绿、只在运行时降级——和"反向引用"相反(删东西响亮 break 编译,加东西不 break 却静默坏)** |
| **端到端交付(使用场景闭环)** | diff 新增 export / 函数 / 能力 / provider / API / 抽象层 | ①grep 该 symbol 全 repo 调用点(impact-check 同一趟出);②再往上一层:这条新能力有没有**接进一个真实的用户可见流程 / 实际使用场景**,还是只落了一半 infra | 零 caller 且非对外 API/SDK 导出 → `COMMENT`;**有 caller 但没端到端接进使用场景**(建了能力没建用它的功能、只 wire 了一半)→ `COMMENT`,要作者说明使用场景闭环在哪 / 哪个后续 PR 补齐。**基础能力建设不脱离实际使用场景——没有真实消费场景的底层不该独立落地** |
| **性能回退** | 改**请求处理链**任意一环(路由 / 中间件 / 鉴权 / provider mount / 序列化)、冷启 / init 路径、DB 查询、循环内 I/O、缓存 | 读改动:①是否引入 N+1、全表扫描、丢索引命中或缓存、同步阻塞、大 payload;②**是否把 scale-work(fleet / 租户级 / O(N))压进了每请求 / 冷启 / init 路径**——那里必须 O(1) 或挪后台 | 可疑 → `COMMENT`,要作者给 before/after 实测(性能改动必须有数据,不接受"应该更快");**请求链 / init 上的 per-request·per-tenant 开销不实测不放行** |
| **测试覆盖(有没有测)** | 任何行为变更 / 新功能 / bug fix | 有无对应新增或既有覆盖的自动化测试 | 核心逻辑无测试 → `BLOCK`;边缘无测试 → `COMMENT`(缺测试) |
| **★ 测试质量(测了但会不会骗人)** | diff 命中任何 `*.test.*` | **先跑确定性的一半**:`/agentloop:test-audit` 的 diff 模式(`bun <plugin_root>/skills/test-audit/scripts/audit.ts diff --base <base>`;arc 已把它接进 `pre-pr`(`<verification_entry>`)的 `testQuality` 行,那就直接读 PR 上 verification 报告里的那一行,别重跑)。**再做机器做不了的一半**(逐条读改动过的测试):①这条新测试真的断言了 PR 声称的行为,还是断言了它自己造的 mock?②期望值是不是从被测代码算出来的(同义反复)?③改动过的测试还有没有 accept path,还是只剩 reject?④红了的测试是被**修好**了还是被**改松**了 | 确定性一半报 `block` → 归 Step 3 根因 (a),`BLOCK`。判断一半命中 → `COMMENT` 列 `path:line` + 具体哪条断言不成立;**「测试通过」不是测试有效的证据——一个被掏空的测试比原来更稳定地通过** |
| **清理 / 收尾** | PR 替换 / 迁移 / 重命名了某实现、加了替代路径或临时 flag | diff 有没有**删掉被取代的旧代码 / 旧 code path / 死 feature flag / 过时测试 / 注释掉的代码**;新增文件是否对应一个该删的旧文件;迁移是否留了双份实现 | 只加新不删旧(死代码堆积 / 双实现并存)→ `COMMENT`,列该清理的 `path:line`;**废弃的旧路径仍有 live caller**(留着会被误用)→ `BLOCK` |

> **同名重定义 ≠ 反向引用漏**:符号因新/ported 模块重新定义而被 grep 命中(rename/rewrite 常见)是噪音,只有仍指向已删/改定义的悬空引用才算(判据见 [`impact-check`](../../impact-check/SKILL.md))。
