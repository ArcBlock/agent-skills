# tasks.md check and generation

> Ask prompt and extraction rules. The unattended default (generate, do not ask) and the three options stay in `SKILL.md`. Read this when checking or generating `tasks.md`.

### Step 3: Check for `tasks.md` and Offer Generation

**Determine if this document should have a `tasks.md`:**

A document should have `tasks.md` if it contains future implementation work that can be decomposed into actionable phases — specifically:

- "待做" / "Phase N 待做" sections with concrete changes
- Described but unimplemented features with enough design detail
- Identified issues (test gaps, architecture debt) with proposed fixes

**If should have `tasks.md` but it doesn't exist:**

**Unattended / fleet mode (issue-native, no human present — the repo hook hard-denies `AskUserQuestion`): do NOT ask. Default to option 1 — generate `tasks.md` from the design (test-coverage hard requirement ON), then review — and continue. Only fall back to the interactive prompt below when a human is demonstrably present in the session.**

Ask the user using AskUserQuestion (interactive only):

```
这个设计文档包含可执行的实施工作（{brief description of what}），但没有对应的 tasks.md。

是否需要我从设计文档中提取并生成 tasks.md？这会：
- 将待做工作分解为有序的 phases
- 每个 phase 包含具体 tasks + 测试 spec（6 类覆盖）
- 生成的 tasks.md 可直接用于 /agentloop:build-phases

选项：
1. 是，生成 tasks.md 后再做 review
2. 不需要，按当前文档直接 review（不启用 test coverage hard requirement）
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
- Review uses Implementation Plan strategy (test coverage hard requirement ON)

**If user chooses option 2 (review without tasks):**
- Proceed with Design/Architecture or Post-mortem review strategy
- Test coverage is recommendation only, not hard requirement

**If user chooses option 3 (generate only):**
- Generate `tasks.md`, output summary of what was generated, stop

**If document should NOT have `tasks.md`** (e.g., pure post-mortem):
- Skip this step entirely, proceed to review
