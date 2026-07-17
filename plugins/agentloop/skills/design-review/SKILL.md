---
name: design-review
description: Iterative clean-context review of a design/plan document or issue — spawn independent-perspective reviewers each round, score, and synthesize findings without carrying prior-round bias. Use to review an implementation plan, architecture doc, or design proposal before building.
---

# Design Review — Iterative Clean-Context Review Loop

> **Repo profile — read `.claude/repo-profile.md` first.** This skill is repo-agnostic; arc is the reference implementation. Where it references repo identity or paths, read the profile (`repo_slug` etc.). Arc's own provenance for any lessons is not inlined here (fuller case narratives, where they exist, are under `.claude/case-law/`).

Automate design document review using clean-context subagents. Each round gets a fresh perspective — no inherited bias from the current conversation.

## Usage

```
/design-review <path> [--target <score>] [--max-rounds <n>]
```

- `<path>` — Path to a design document file, or a directory containing `design.md` + `tasks.md`
- `--target <score>` — Target completeness score (default: 95)
- `--max-rounds <n>` — Maximum review iterations (default: 5)

### Examples

```
/design-review planning/provider-architecture-rethink/
/design-review intent/my-feature/INTENT.md --target 90
/design-review planning/my-plan/ --target 95 --max-rounds 3
```

### Issue-driven plans (no `planning/` file — issue is the source of truth)

When the plan originated in a **GitHub issue** (the human confirmed it in the
comments), do **NOT** commit a `planning/` doc — those
tracker docs rot and become the next audit's deletion. The issue is the source
of truth; the file is throwaway:

1. **Render an ephemeral working copy** of the confirmed plan (a `design.md` /
   `tasks.md`) into a **scratch / gitignored** dir (e.g. the session scratchpad)
   from the issue. Run `/design-review <scratch-dir>` on it. The rounds are
   disposable iterations on a disposable file.
2. When it hits the target score, **post the final optimized plan back to the
   issue as a comment** — that comment is the durable artifact.
3. Add a brief **round summary**: how many rounds, and the key improvement each
   round made. Then discard the scratch file. Nothing lands in `planning/`.

**Autonomous escalation — ask via an issue comment, never block in-session.**
In the issue-native flow nobody is babysitting the session, so an escalation
that would normally call `AskUserQuestion` and wait **must instead be posted as
a comment on the source issue** and the run paused there. If the review loop hits
an unrecoverable point — a genuine design fork, an `AskUserQuestion`-worthy
ambiguity, a needed architecture change, or an AFS-principle conflict (see the
ESCALATION list under "Step 5: Fix Issues") — do **not** sit waiting for an
inline answer. Post a clear, self-contained question comment on the issue (state
the options, your recommendation, and what's blocked), then stop that work item.
The human answers asynchronously on the issue; the next sweep picks it up. Only
fall back to inline `AskUserQuestion` when a human is demonstrably present and
interacting in this session.

**Carve-out:** this issue-native path is only for *transient* feature /
implementation plans. *Durable* specs that already live as files —
`docs/architecture/*`, protocol specs, behaviour-contract `intent/*/INTENT.md`,
conformance targets — are reviewed in place as a normal `/design-review <path>`
run; don't issue-ify those.

(`issue-sweep`'s feature/design work-type drives this handoff automatically.)

## How It Works

### Document Type Detection

Before reviewing, classify the document to apply the right review strategy:

| Type | Signal | Test Coverage Hard Gate? | Needs `tasks.md`? |
|------|--------|-------------------------|-------------------|
| **Implementation Plan** | Has phases/tasks with concrete code changes, file paths, API specs | **YES** | **YES** — should have or generate |
| **Design / Architecture** | Describes problem, alternatives, decisions, trade-offs; may have "待做" sections | No — test coverage as recommendation | **YES if has "待做/Phase N" sections** with concrete implementation work |
| **INTENT.md** | Has API spec, behavior definitions, boundary conditions | No — completeness check instead | Depends on scope |
| **Post-mortem / Record** | Past tense, commit refs, "已完成" markers, performance data | No — fact accuracy check | **NO** |

**Key signals for "should have tasks.md":**
- Document describes future implementation work (phases, steps, "待做")
- Document has concrete code changes that haven't been done yet
- Document has enough detail to decompose into actionable tasks

**Key signals for "should NOT have tasks.md":**
- All work is already completed (commit refs, "已完成", past tense throughout)
- Document is purely analytical (EDoS analysis, architecture comparison)
- Document is a decision record or post-mortem

### The Review Loop

```
┌──────────────────────────────────────────────────────┐
│  Step 0: Classify document type                       │
│  → Determines review strategy + tasks.md requirement  │
│                                                       │
│  Step 0.5: Check tasks.md existence                   │
│  → If should have but missing → ask user to generate  │
│                                                       │
│  Round N                                              │
│                                                       │
│  1. Launch CLEAN-CONTEXT subagent (Agent tool)        │
│     - No parent conversation history                  │
│     - Only sees the files it reads                    │
│     - Read-only: cannot modify files                  │
│                                                       │
│  2. Subagent performs review:                          │
│     a. Read design/task documents                     │
│     b. Verify claims against actual code              │
│     c. Dry-run implementation simulation              │
│     d. Check internal consistency                     │
│     e. Identify test coverage gaps                    │
│     f. Score: 0-100% completeness                     │
│                                                       │
│  3. If score >= target → APPROVED, stop               │
│     If score < target → fix issues, next round        │
└──────────────────────────────────────────────────────┘
```

### Review Dimensions by Document Type

#### Implementation Plan (has `tasks.md`)

| Dimension | What's checked | Hard Gate? |
|-----------|---------------|------------|
| **Test Coverage** | Every phase has tests for: happy path, bad input, security, data loss, data damage, data leak. Missing any category = must-fix. | **YES — < 90% = auto NOT APPROVED** |
| **E2E Verification** | Every phase must have `### E2E Verification (mandatory)` section with concrete AFS MCP tool calls using named sessions (`?session=e2e-{phase}`). Missing = must-fix. | **YES — missing E2E section = auto NOT APPROVED** |
| **Factual grounding（现状 claims vs code）** | 每个关于*现状*的断言（接口/文件存在/签名、存储后端、文件布局、现有行为）是否 `path:line` 坐实?**代码是唯一权威**——与引用的 planning/docs 冲突时**以代码为准并标出该文档过时**。 | **YES — 未坐实 / 与代码矛盾的现状断言 = CRITICAL** |
| **Quantitative / performance claims（数字）** | 每个数字（延迟/吞吐/大小/数量/上限）是否**实测**（附命令+输出）或**显式标注为未验证估计**（含依据）?有实测经验的（含 human 在 issue 里给的）以实测为准。 | **YES — 凭空/未标注的数字当事实 = must-fix** |
| **Internal Consistency** | Do sections reference each other correctly? Naming, numbering, no contradictions? | No |
| **Dry Run** | Can an implementer follow the plan step-by-step? Are dependencies satisfied at each phase? | No |
| **Dependency Chain** | Are phase dependencies explicit? Are there hidden circular dependencies? | No |
| **API Specification** | Are new interfaces, methods, protocol messages fully defined? | No |
| **Migration Path** | Is backward compatibility addressed? Is there a clear transition strategy? | No |

**Test Coverage is a central hard gate for implementation plans** (alongside E2E Verification + 事实/数字 grounding). Its primary purpose is to ensure that `tasks.md` contains sufficient test specifications for `/build-phases` to produce well-tested code.

#### Design / Architecture (no `tasks.md`)

| Dimension | What's checked | Hard Gate? |
|-----------|---------------|------------|
| **Factual grounding（现状 claims vs code）** | 每个关于*现状*的断言（架构、存储后端、API、文件布局、现有行为）是否 `path:line` 坐实?**代码是唯一权威**——与引用的 planning/docs 冲突时**以代码为准并标出该文档过时**。 | **YES — 未坐实 / 与代码矛盾的现状断言 = CRITICAL** |
| **Quantitative / performance claims（数字）** | 每个数字（延迟/吞吐/大小/数量/上限）是否**实测**（附命令+输出）或**显式标注为未验证估计**（含依据）?有实测经验的（含 human 在 issue 里给的）以实测为准。 | **YES — 凭空/未标注的数字当事实 = must-fix** |
| **AFS Principle Compliance** | AFS-Only I/O, abstraction reuse, provider boundaries | **YES — violation = CRITICAL** |
| **Internal Consistency** | Cross-references, naming, no contradictions | No |
| **Feasibility** | Can the proposed design actually be implemented? Are there hidden blockers? | No |
| **Test Coverage** | Are test requirements identified for future implementation? | No (recommendation only) |

#### Post-mortem / Record

| Dimension | What's checked | Hard Gate? |
|-----------|---------------|------------|
| **Factual Accuracy** | File paths, commit hashes, method signatures, behavioral claims vs actual code | **YES — factual errors = must-fix** |
| **Completeness** | Are all changes documented? Are known issues / remaining work tracked? | No |
| **AFS Principle Compliance** | Does the completed work follow AFS principles? | No (informational) |

### Subagent Output Format

Each round's subagent returns:
1. **Gap List** — Document claims vs code reality, with confidence %
2. **Dry Run Issues** — Problems found simulating implementation, by phase
3. **Test Omissions** — Missing test scenarios, by severity (implementation plans only)
4. **Overall Score** — Implementation information completeness (0-100%)
5. **APPROVED / NOT APPROVED**

## Implementation Instructions

When this skill is invoked:

### Step 1: Parse Arguments and Discover Files

```
args = parse arguments from user input
path = args.path (required)
target = args.target or 95
maxRounds = args.maxRounds or 5
```

Resolve the path. If it's a directory, look for `design.md`, `tasks.md`, `plan.md`, `INTENT.md`, `README.md`, or similar planning files inside it. Collect all doc files to review.

### Step 2: Classify Document Type

Read the main design document and classify it based on content signals:

**Classification rules (check in order):**

1. **Post-mortem / Record** if ALL of:
   - Majority of content uses past tense or has "已完成" markers
   - Contains commit references or "Commit: xxx" entries
   - No "待做" sections describe concrete unfinished implementation work

2. **Implementation Plan** if ANY of:
   - Has a `tasks.md` file alongside
   - Has numbered phases with concrete code changes (file paths, function names, test specs)
   - Contains task-level detail: "Add X to Y", "Modify Z to support W"

3. **Design / Architecture** if:
   - Describes problem space, alternatives, trade-offs, decisions
   - May have "待做" or "Phase N" sections but at design level (not task level)
   - Focus is on "what and why", not "how step by step"

4. **INTENT.md** if:
   - File is named INTENT.md
   - Has API specifications, behavior definitions, boundary conditions

**Output the classification to the user** before proceeding:
```
文档类型: {type}
Review 策略: {strategy summary}
Test coverage hard gate: {yes/no}
```

### Step 3: Check for `tasks.md` and Offer Generation

**Determine if this document should have a `tasks.md`:**

A document should have `tasks.md` if it contains future implementation work that can be decomposed into actionable phases — specifically:

- "待做" / "Phase N 待做" sections with concrete changes
- Described but unimplemented features with enough design detail
- Identified issues (test gaps, architecture debt) with proposed fixes

**If should have `tasks.md` but it doesn't exist:**

Ask the user using AskUserQuestion:

```
这个设计文档包含可执行的实施工作（{brief description of what}），但没有对应的 tasks.md。

是否需要我从设计文档中提取并生成 tasks.md？这会：
- 将待做工作分解为有序的 phases
- 每个 phase 包含具体 tasks + 测试 spec（6 类覆盖）
- 生成的 tasks.md 可直接用于 /build-phases

选项：
1. 是，生成 tasks.md 后再做 review
2. 不需要，按当前文档直接 review（不启用 test coverage hard gate）
3. 跳过 review，只生成 tasks.md
```

**If user chooses option 1 (generate then review):**
- Generate `tasks.md` in the same directory as the design document
- Extraction rules:
  - Each "待做" item or unfinished phase → one or more tasks
  - Group tasks into phases by dependency order
  - Each phase must include test specs covering 6 categories (happy path, bad input, security, data loss, data damage, data leak)
  - Reference the design document for context, don't duplicate design rationale
  - Mark tasks that need user design decisions with `⚠️ NEEDS DECISION`
- After generation, proceed to review loop with both design doc + tasks.md
- Review uses Implementation Plan strategy (test coverage hard gate ON)

**If user chooses option 2 (review without tasks):**
- Proceed with Design/Architecture or Post-mortem review strategy
- Test coverage is recommendation only, not hard gate

**If user chooses option 3 (generate only):**
- Generate `tasks.md`, output summary of what was generated, stop

**If document should NOT have `tasks.md`** (e.g., pure post-mortem):
- Skip this step entirely, proceed to review

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

### Step 5: Fix Issues (between rounds)

Read the subagent's feedback carefully. For each issue:

- **Document vs Code gaps**: Fix inaccurate claims, update stale references
- **Internal consistency**: Fix numbering, naming, cross-references
- **Dry Run issues**: Add missing dependency declarations, clarify implementation details
- **Test omissions** (implementation plans only): Add missing test scenarios to the appropriate phase in tasks.md
- **Do NOT change architecture decisions** — only fix documentation accuracy and completeness
- **AFS-Only I/O violations**: If reviewer finds a design that bypasses AFS → this is a design error, must fix
- **Abstraction reuse violations**: If reviewer finds a design that reimplements existing AFS capability → must fix

**ESCALATION — 停下来问用户的情况：**

在 fix 过程中，如果遇到：
- **真正的设计不确定** — reviewer 指出一个问题，你不确定正确的设计方向 → **停下来问用户**
- **两种设计都合理** — reviewer 的建议和原设计都有道理，不知道选哪个 → **停下来问用户**
- **需要大改架构** — fix 不是小修，而是要重写某个 section 的设计 → **停下来问用户**
- **AFS 原则冲突** — 某个设计似乎必须绕过 AFS 才能实现 → **一定要问用户**，几乎肯定有更好的方式

**不要自己做设计决策。** Design review 只修文档一致性和测试覆盖，不改架构方向。架构方向的改变必须由用户确认。

**怎么"问用户"取决于模式**：在交互 session（用户在场）用 `AskUserQuestion`。
在 **issue-native 模式（无人 babysitting）** —— 即计划来自 GitHub issue 的那条路径 ——
**不要 inline 阻塞等答复**，而是把问题**作为 issue 评论**发出（列清选项、你的推荐、被卡住的是什么），
然后**停在该工作项**。人类异步在 issue 上回答，下一轮 sweep 接力。见本文件顶部
"Autonomous escalation" 段。

After fixing, commit the changes (so the next round's subagent sees the updated files).

### Step 6: Report

After the loop ends, output a summary:

```
## Design Review Complete

**Document:** {path}
**Type:** {document type}
**Rounds:** {roundsUsed} / {maxRounds}
**Score progression:** {round1}% → {round2}% → ... → {final}%
**Status:** APPROVED ✓ / NOT APPROVED (best: {score}%)

{if approved}
Remaining minor issues (non-blocking):
- {list any issues noted in the final approved review}
{/if}
```

## Key Principles

1. **Each subagent is completely fresh** — it does not inherit any context from previous rounds or the parent conversation. This ensures unbiased review.

2. **The reviewer never modifies files** — separation of concerns. The reviewer finds problems, you (the main agent) fix them.

3. **Score is based on implementability** — "Could a developer with no project background complete the implementation using only these documents?"

4. **Document type determines review strategy** — don't apply implementation plan criteria to a post-mortem, and don't skip test coverage checks on a real implementation plan.

5. **Tasks.md generation is opt-in** — if a design should have tasks but doesn't, ask the user. Never auto-generate without confirmation.

6. **Security and data integrity are non-negotiable** — for implementation plans, every phase involving I/O must have tests for path traversal, prototype pollution, injection, resource exhaustion, namespace isolation, data roundtrip, binary safety, unicode safety, concurrency, and failure atomicity.

7. **Zero regression is enforced** — the review checks that each phase maintains backward compatibility with existing tests and functionality.

8. **方案设计必须 grounded：客观、精确、实事求是。** 任何关于*现状*的断言（架构、存储后端、API、文件布局、现有行为）都要 `path:line` 坐实——**代码是唯一权威**，与引用的 planning/docs 冲突时以代码为准并指出文档过时（典型幻觉：把存储后端说成 "KV" 而代码其实是 R2+D1，整套后续 phase 就建在错地基上）。任何数字（延迟/吞吐/大小/数量/上限）要么**实测**（附命令+输出）、要么**显式标注为未验证估计**、否则删掉——**凭空数字当事实是最高发的幻觉**（如随手写 "0ms/1-2ms"，实测却是 200ms+）。事实 grounding + 数字纪律对设计文档是 **HARD GATE**，不是软维度——一份地基错的设计不该拿到 APPROVED。
