# pr-review — Step 5.5 human-confirm block (full text)

> On-demand reference for [`pr-review`](../SKILL.md) (moved out of SKILL.md in #7105).
> SKILL.md holds the executable steps; this file holds the detail, rationale and incident history.

### Step 5.5 — 需人确认块(human-escalation verdict 必带)

**硬前置(升级前必答,issue #1860):打拍板块之前先问「我能不能说出一个安全默认动作?」——能 → 禁止升级,当场按 ratchet(默认放行,出问题再收紧,见 [`pr-sweep` Step 5](../../pr-sweep/SKILL.md))执行并留 trace;不能,才是真判断题,才配走下面的结构化拍板块。** 这条硬前置在结构化拍板块**之前**过一遍——先问能不能自己拍,答不出才落到需人确认。

当 verdict 要**人介入**——`BLOCK`(escalate 而非 agent 可自修)、`COMMENT`(带阻断关注)、以及 pr-sweep 侧的 🔴 高风险 / `awaiting-direction|judgment|caution` / security——**comment 不能停在"请人工确认"**(#660 就是反例:核验表很全,落到"请人工确认后合并"就断了,没说要人判什么、怎么验)。必带一个结构化「需人确认块」:

```
> 🛑 需人确认 — <一句话: 要你定的那一个决定>
>
> **为什么停在这:** <agent 不能自决的精确原因: 设计 A/B 未定 / 安全边界 / 不可逆 / 缺写权限>
> **agent 已核验(不必重做):** <已坐实的部分, path:line + 测试 pass/fail —— 省去人重复劳动>
> **请你验证(可照跑):**
>   1. `<确切命令>` → 预期 `<X>`;现状 `<Y>`
>   2. 看 `<path:line>` 确认 `<具体属性>`
> **要定的:** <选项 A / 选项 B,各自后果> · **我的推荐:** <X,因为…>
> **定了之后:** A → `<解锁动作/命令>` / B → `<解锁动作>`
```

**两要素硬性检查(缺任一 = 拍板块不合格,不许发)——源自 #1812 复盘:**

1. **问题 + 建议回答**:要人答的问题必须**具体、封闭**(一句话能答"是/否/选A"),且 agent 必须附上自己的建议回答——人只做确认/否决,不做开放式思考。"请人工确认后合并"这种开放句式不合格。
2. **选择 + 区别 + 推荐**:每个选项写清**选它之后会发生什么、和其他选项差在哪**(不是只列名字),并给推荐 + 理由。

**两个都给不出 → 这不是正常输出,是发现了真正的问题**:显式写「⚠️ 无法形成建议」+ 精确缺什么(哪条信息 / 哪个权限 / 哪个未定的前置决策),这本身就是最高优先级 escalation——比任何 BLOCK 都值得人先看。绝不允许用一句笼统的"需人工审阅"把"我没想清楚"伪装成"已完成 review"。

**时效**:拍板块必须钉在**当前 HEAD sha** 上(块首标 `针对 HEAD <sha7>`);PR 再收到 push 即作废,复审时在新 HEAD 上重新给出。

**铁律——能给步骤就给步骤,给不了就给判据,绝不造假命令:**

- **可还原成可照跑步骤**(测试失败需人判 / 代码正确性 / 安全属性 / 去重冲突 / 缺权限的机械操作)→「请你验证」填**确切命令 + 看哪个 `path:line` + 预期 vs 现状**,让人(或人的 agent)照跑就能确认。
- **不可还原**(无先例的设计 A/B、架构方向、taste)→ **绝不编一个假装能验证的命令**;「请你验证」换成**选项 + 判据 + 推荐**,并明说这是判断题。
- **agent 已核验的别让人重做**:把机械正确性(sanitization、测试 pass/fail、失败根因)的结论摆上去,人只聚焦那个真正要他判的点。

**per-type「请你验证」填什么:**

| escalation 类型 | 「请你验证」填 |
|---|---|
| 测试失败需人判 | 失败的测试名 + 输出尾部摘录 + 根因判断 + "复现: 跑 `<package_manager> --filter <pkg> test`, 预期 `<pass/fail>`" |
| 代码/逻辑正确性 | 触发点 `path:line` + 复现测试命令(`<package_manager> --filter <pkg> test` / `<test_runner> <path>`) + 预期 vs 实际行为 |
| **security(必逐条列)** | **每个**安全属性单独一行:`<属性: const-time compare / path-traversal guard / authz / 注入过滤>` @ `path:line` + 验证它的命令或测试 + **失败长相**(怎样算被绕过)。决定仍归人,但给完整 checklist,**绝不**只说"涉及安全请人看" |
| 去重/冲突拿不准 | 两个 PR# + 冲突行 `path:line` + 权威源路径(repo `LICENSE` / canonical doc) + 对比命令(`gh pr diff` / `git show`) |
| 设计 A/B(判断题) | 不造命令:选项 A/B crisp 描述 + 各自 tradeoff + 触发它的 intent/issue 锚点 + 你的推荐 + 什么证据能 settle |

> **范围**:只有上面那几类**要人介入**的 verdict 带此块;`MERGE`(无需人)、agent 自修的机械件**不带**——别给不需要人的 PR 也堆一个空块。
