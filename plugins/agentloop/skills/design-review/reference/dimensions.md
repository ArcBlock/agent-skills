# Review dimensions by document type

> Dimension catalogs and document-type signals. Classification order and the approve/stop decision stay in `SKILL.md`. Read this when classifying or scoring.

### Document Type Detection

Before reviewing, classify the document to apply the right review strategy:

| Type | Signal | Test Coverage Hard Requirement? | Needs `tasks.md`? |
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

### Review Dimensions by Document Type

#### Implementation Plan (has `tasks.md`)

| Dimension | What's checked | Hard Requirement? |
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

**Test Coverage is a central hard requirement for implementation plans** (alongside E2E Verification + 事实/数字 grounding). Its primary purpose is to ensure that `tasks.md` contains sufficient test specifications for `/agentloop:build-phases` to produce well-tested code.

#### Design / Architecture (no `tasks.md`)

| Dimension | What's checked | Hard Requirement? |
|-----------|---------------|------------|
| **Factual grounding（现状 claims vs code）** | 每个关于*现状*的断言（架构、存储后端、API、文件布局、现有行为）是否 `path:line` 坐实?**代码是唯一权威**——与引用的 planning/docs 冲突时**以代码为准并标出该文档过时**。 | **YES — 未坐实 / 与代码矛盾的现状断言 = CRITICAL** |
| **Quantitative / performance claims（数字）** | 每个数字（延迟/吞吐/大小/数量/上限）是否**实测**（附命令+输出）或**显式标注为未验证估计**（含依据）?有实测经验的（含 human 在 issue 里给的）以实测为准。 | **YES — 凭空/未标注的数字当事实 = must-fix** |
| **AFS Principle Compliance** | AFS-Only I/O, abstraction reuse, provider boundaries | **YES — violation = CRITICAL** |
| **Internal Consistency** | Cross-references, naming, no contradictions | No |
| **Feasibility** | Can the proposed design actually be implemented? Are there hidden blockers? | No |
| **Test Coverage** | Are test requirements identified for future implementation? | No (recommendation only) |

#### Post-mortem / Record

| Dimension | What's checked | Hard Requirement? |
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
