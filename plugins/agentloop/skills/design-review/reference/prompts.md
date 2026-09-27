# Review-round prompts

> Clean-context subagent prompts by document type, plus how to parse the reply. When to stop or fix stays in `SKILL.md`. Read this when running a review round.

### Step 4: Run Review Loop

For each round (1 to maxRounds):

**4a. Launch a clean-context subagent** using the Agent tool.

The subagent prompt varies by document type. Include the classification in the prompt so the subagent knows which strategy to apply.

**For Implementation Plans (has `tasks.md`, hard gate ON):**

```
你是一个独立的架构审查者，对这个项目没有任何先验知识。这是第 {round} 轮 review{previousScore}。目标 ≥{target}%。
文档类型：实施计划（Implementation Plan）。Test coverage hard gate 启用。

1. 读取以下设计文档：
{list of doc file paths}

2. **事实 + 数字 grounding 审计（HARD GATE）** — 文档里关于**现状**的每条断言都要坐实，别凭记忆或旧 planning 草稿：
   - **定性事实**：用 Grep/Read 把每条现状断言坐实到 `path:line` —— 接口/类型存在性、文件路径、方法签名、**存储后端、文件布局、现有行为**是否真的如文档所述。**代码是唯一权威**：引用的 planning/docs 与代码冲突时**以代码为准**，并标出"该文档已过时"。
   - **定量数字**：每个数字（延迟/吞吐/大小/数量/上限/成本）必须**实测**（附确切命令 + 输出）或**显式标注为未验证估计**（含依据），否则删掉。**凭空给出却当作分析/事实呈现的数字（尤其延迟/性能）= must-fix**；与 human 在 issue 里给的实测经验冲突时以实测为准。
   - **任一未坐实 / 与代码矛盾的现状断言，或任一凭空数字 = CRITICAL → NOT APPROVED**（错的地基会让后续 phase 全盘皆错）。

3. **测试覆盖审计（HARD GATE）** — 对每个 phase/task，检查测试 spec 是否覆盖以下 6 类：
   - ✅ Happy path（正常流程）
   - ✅ Bad input（非法输入、边界条件）
   - ✅ Security（path traversal, injection, prototype pollution, resource exhaustion）
   - ✅ Data loss prevention（crash 期间不丢数据、并发写不覆盖）
   - ✅ Data damage prevention（roundtrip 一致性、binary 安全、unicode 安全）
   - ✅ Data leak prevention（namespace 隔离、权限边界、清理后无残留）

   对每个 phase 标注：6/6, 5/6, ... 缺哪一类就列出来。
   **如果任何 phase 缺少 2 类以上 → 测试覆盖不足 → 自动 NOT APPROVED（不管总分多高）。**

   3b. **E2E Verification 审计（HARD GATE）** — 对每个 phase，检查是否有 `### E2E Verification (mandatory)` section：
   - 必须包含具体的 AFS MCP tool call 路径（`afs_read /dev/ui/web/sessions/e2e-xxx/...`）
   - 必须使用 named session（`?session=e2e-{name}`）实现确定性访问，不依赖 session discovery
   - 必须描述预期返回结构（JSON 字段、类型），不能只写"验证成功"
   - 必须包含至少一个 negative case（无效 session、错误 path）
   - 对于 UI/AUP 变更，必须使用 AFS inspect 能力（design-audit, overflow-scan, dom 等）
   **缺少 E2E Verification section → 自动 NOT APPROVED。**
   **E2E section 只写"通过测试"没有具体 tool call → 同样 NOT APPROVED。**

4. **AFS 原则合规检查** — 检查设计是否违反以下核心原则：
   - **AFS-Only I/O**：任何 I/O 是否都通过 AFS API？有没有绕过 AFS 直接访问底层资源的设计？
   - **抽象复用**：有没有设计要新建的东西其实已有现成的 provider/utility？有没有重复发明轮子？
   - **Provider 边界**：provider 之外的代码是否都通过 AFS 接口？
   违反任何一条 = 必须标注为 CRITICAL issue。

5. 做 Dry Run — 按文档的实施阶段顺序，在脑中模拟实现过程。检查：
   - 每个 phase 开始时前置依赖是否满足
   - 代码改动点是否都被识别
   - 有没有文档描述但代码中不存在的概念

6. 输出格式（严格遵守）：
   a. **测试覆盖审计表**（每 phase 的 6 类覆盖情况，HARD GATE）
   a2. **E2E Verification 审计表**（每 phase 是否有 E2E section + 具体 tool call，HARD GATE）
   b. 文档 vs 代码 Gap 列表（带信心百分比）
   c. Dry Run 发现的问题列表（按 phase）
   d. 测试遗漏列表（按严重程度）
   e. 总体评估：实现信息完整度百分比（0-100%）
   f. 如果 ≥{target}% 且测试覆盖 + E2E + 事实/数字 grounding HARD GATE 均通过（无未坐实/与代码矛盾的现状断言、无凭空数字）：输出 "APPROVED"；否则输出 "NOT APPROVED"

请非常彻底和严格。不要做任何修改，只做 review 和分析。
```

**For Design / Architecture (no `tasks.md`, hard gate OFF):**

```
你是一个独立的架构审查者，对这个项目没有任何先验知识。这是第 {round} 轮 review{previousScore}。目标 ≥{target}%。
文档类型：设计/架构文档。Test coverage hard gate 不启用（测试覆盖作为建议）。

1. 读取以下设计文档：
{list of doc file paths}

2. **事实 + 数字 grounding 审计（HARD GATE）** — 文档里关于**现状**的每条断言都要坐实，别凭记忆或旧 planning 草稿：
   - **定性事实**：用 Grep/Read 把每条现状断言坐实到 `path:line` —— 接口/类型存在性、文件路径、方法签名、**存储后端、文件布局、现有行为**是否真的如文档所述。**代码是唯一权威**：引用的 planning/docs 与代码冲突时**以代码为准**，并标出"该文档已过时"。
   - **定量数字**：每个数字（延迟/吞吐/大小/数量/上限/成本）必须**实测**（附确切命令 + 输出）或**显式标注为未验证估计**（含依据），否则删掉。**凭空给出却当作分析/事实呈现的数字（尤其延迟/性能）= must-fix**；与 human 在 issue 里给的实测经验冲突时以实测为准。
   - **任一未坐实 / 与代码矛盾的现状断言，或任一凭空数字 = CRITICAL → NOT APPROVED**（错的地基会让后续 phase 全盘皆错）。

3. **AFS 原则合规检查（HARD GATE）** — 检查设计是否违反以下核心原则：
   - **AFS-Only I/O**：任何 I/O 是否都通过 AFS API？有没有绕过 AFS 直接访问底层资源的设计？
   - **抽象复用**：有没有设计要新建的东西其实已有现成的 provider/utility？有没有重复发明轮子？
   - **Provider 边界**：provider 之外的代码是否都通过 AFS 接口？
   违反任何一条 = 必须标注为 CRITICAL issue。

4. 内部一致性检查：
   - 各 section 之间交叉引用是否正确
   - 命名、编号是否一致
   - 有没有自相矛盾的描述

5. 可行性检查 — 设计能否被实现？
   - 所依赖的接口/能力是否存在或可创建
   - 有没有隐藏的阻塞依赖
   - 性能假设是否合理

6. 如果文档包含已完成的工作（commit refs、"已完成"标记），验证事实准确性：
   - commit hash 是否存在且描述匹配
   - 声称修改的文件是否确实被修改
   - 性能数据是否有可信来源

7. 测试覆盖建议（非 hard gate）：
   - 已完成工作的已有测试和缺失测试
   - 待做工作的测试需求
   - 区分"已有"和"缺失"，缺失项是否被 tracked

8. 输出格式（严格遵守）：
   a. 文档 vs 代码 Gap 列表（带信心百分比）
   b. AFS 原则合规结果
   c. 内部一致性问题
   d. 可行性问题
   e. 测试覆盖建议（已有 vs 缺失 vs tracked）
   f. 总体评估：文档质量百分比（0-100%）
   g. 如果 ≥{target}% 且无 CRITICAL issue（含未坐实/与代码矛盾的现状断言、凭空数字、AFS 原则违规）：输出 "APPROVED"；否则输出 "NOT APPROVED"

请非常彻底和严格。不要做任何修改，只做 review 和分析。
```

**For Post-mortem / Record:**

```
你是一个独立的架构审查者，对这个项目没有任何先验知识。这是第 {round} 轮 review{previousScore}。目标 ≥{target}%。
文档类型：Post-mortem / 已完成工作记录。审查重点是事实准确性和完整性。

1. 读取以下文档：
{list of doc file paths}

2. **事实准确性验证（HARD GATE）** — 使用 Grep 和 Read 工具验证：
   - 每个 commit hash 是否存在且 message 匹配（用 git log 验证）
   - 每个文件路径是否正确
   - 每个方法签名/接口声明是否与实际代码匹配
   - 每个行为描述是否与代码实际行为一致
   - 性能数据的来源是否可信

3. 完整性检查：
   - 所有改动是否都被记录
   - 已知问题/遗留项是否被 tracked
   - 相关文件引用是否完整

4. AFS 原则合规（信息性，非 hard gate）：
   - 记录中的已完成工作是否遵守 AFS 原则
   - 如有违反，标注为建议而非阻塞

5. 输出格式（严格遵守）：
   a. 事实准确性审计表（每条声明 vs 实际，信心百分比）
   b. 完整性 Gap 列表
   c. AFS 合规性备注
   d. 总体评估：文档准确度百分比（0-100%）
   e. 如果 ≥{target}% 且无事实错误：输出 "APPROVED"；否则输出 "NOT APPROVED"

请非常彻底和严格。不要做任何修改，只做 review 和分析。
```

Where `{previousScore}` is empty for round 1, or ` — 上一轮 {score}%` for subsequent rounds.

**4b. Parse the subagent's response:**
- Extract the overall score (look for the percentage number)
- Extract the issue list

**4c. Decision:**
- If score >= target or response contains "APPROVED" → **stop, report success**
- If round == maxRounds → **stop, report current score and remaining issues**
- Otherwise → **fix the identified issues**, then continue to next round
