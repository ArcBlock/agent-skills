# Execute a phase — layer walkthroughs, requirements, and prompts

> On-demand detail for build-phases Step 2 (and the phase diagram). Layer 1 still runs **scoped per phase** — that rule is in `SKILL.md`. Read this when executing a phase.

## How It Works

For each phase in `tasks.md`:

```
┌─────────────────────────────────────────────────────┐
│  Phase N                                             │
│                                                      │
│  1. IMPLEMENT                                        │
│     Read phase spec from tasks.md                    │
│     Write tests first (TDD)                          │
│     Implement until tests pass                       │
│     Use parallel subagents for independent tasks     │
│                                                      │
│  2. VERIFY (three layers, mandatory, not skippable)  │
│     Layer 1: build + types + affected-pkg tests      │
│     Layer 2: Start service, send real requests        │
│            → write raw afs_exec output to            │
│            planning/<dir>/logs/s{N}-e2e.log          │
│            (HARD REQUIREMENT — phase NOT done without it)   │
│     Layer 3: Adversarial — break it intentionally    │
│     → ALL must pass, or go back to 1                 │
│                                                      │
│  3. COMMIT "phase N: implement"                      │
│                                                      │
│  4. SIMPLIFY (/simplify skill)                       │
│     Clean up code for clarity and maintainability    │
│                                                      │
│  5. RE-VERIFY (Layer 1 only — ensure no regression)  │
│     → FAIL? Revert simplify changes                  │
│                                                      │
│  6. COMMIT "phase N: simplify"                       │
│                                                      │
│  7. DESIGN REVIEW (parent dispatches a clean-context │
│     reviewer — implementer and reviewer are           │
│     DIFFERENT agents)                                 │
│     Score must meet --review-target                   │
│     → NOT APPROVED? respawn executor with findings   │
│                                                      │
│  8. Report phase completion, proceed to Phase N+1    │
└─────────────────────────────────────────────────────┘
```

### Step 0.5: Pre-Code Principle Check (in executor agent)

Before writing ANY code in any phase, verify the design does not violate:

1. **AFS-Only I/O** — Does any part of the design bypass AFS? If you notice the tasks.md describing direct file access, HTTP fetch, or any I/O that doesn't go through AFS → **STOP and escalate to user**
2. **Abstraction reuse** — Does the design reinvent something that already exists in AFS? → **STOP and escalate**
3. **Provider boundary** — Does code outside a provider directly access underlying resources? → **STOP and escalate**

These checks apply at EVERY phase, not just the start. If during implementation you find yourself about to write code that violates these principles: **STOP immediately and ask the user, even if it means the phase is incomplete.**

### Step 1: Parse tasks.md and identify phases

Read `<planning-dir>/tasks.md`. Identify all phases by looking for:
- `## Phase N:` headers
- `## Task N:` headers (some docs use tasks instead of phases)
- Numbered sections with implementation steps

Build a list of phases with their:
- Name / number
- Acceptance criteria
- Test files to create
- Files to modify
- Dependencies on previous phases

**Parallel phase detection:** If two phases have no dependency between them (both listed as "独立" or no cross-references), they CAN run in parallel using separate Agent subagents. Build a dependency graph and identify parallelizable groups.

### Step 1.5: Pre-implementation check — what already exists?

**Before implementing each phase**, check if the work is already done:

```
For each phase:
1. Check if files-to-create already exist (ls/stat)
2. If they exist, check if they have substantial content (not just scaffold)
3. Check if tests already exist and pass
4. If phase is already implemented → SKIP with note "already done"
5. If partially implemented → adjust scope to only the missing parts
```

This prevents re-implementing work that was done outside of /agentloop:build-phases (manual coding, other sessions, etc.).

### Step 2: Execute phases

**If phases are independent (no dependency):** Launch parallel Agent subagents, each implementing one phase. Merge results, then verify all together.

**If phases have dependencies:** Execute sequentially as described below.

For each phase:

#### 2.1 IMPLEMENT

Read the phase spec carefully. Follow TDD strictly:
1. Write test files first (all tests should fail initially)
2. Implement until all tests pass
3. For independent sub-tasks within a phase, use parallel subagents (Agent tool with worktree isolation)

#### 2.2 VERIFY — Three Layers (MANDATORY)

This is the critical step. Do NOT skip any layer.

**Layer 1: Static — scoped per phase**
```bash
<package_manager> build
<package_manager> check-types
<package_manager> --filter <affected-packages> test    # the packages this phase touched
```
- Compare the affected packages' pass count with the previous phase; if it decreased → FAIL
- **Do not run the full test suite (`<package_manager> test`).** The cross-package
  closure is nightly's job on the default branch (arc: the full suite is ~230 test tasks).
  The PR carries the affected packages' exact test command and counts.

**Layer 2: Dynamic — Actually run the feature (E2E, not just unit tests)**

**MANDATORY:** Follow the `### E2E Verification (mandatory)` table from tasks.md for this phase. If the table doesn't exist, STOP and escalate — every phase must have one.

#### HARD REQUIREMENT: E2E log file

**Phase cannot be marked `done` unless `<planning-dir>/logs/s{N}-e2e.log` exists AND contains the raw afs_exec output.**

Before running the E2E section:

```bash
mkdir -p <planning-dir>/logs
LOG_FILE="<planning-dir>/logs/s${PHASE}-e2e.log"
# Truncate at start of Layer 2 so each run is fresh
: > "$LOG_FILE"
```

For every `afs_exec` / `afs_read` / `afs_list` call specified in the phase's E2E Verification table:

1. Run the call via the MCP tool (or `<cli_binary>` CLI / curl equivalent).
2. Append a header line with the command + a JSON-serialised response to `$LOG_FILE`, e.g.:
   ```
   === S6.1 afs_exec /blocklets/demo-team-seq/.actions/run ===
   input: {"message": "hello"}
   output: {"success": true, "data": {"reply": "..."}, "_meta": {...}}
   ```
3. Do NOT paraphrase ("verified via AFS", "tests passed"). Paste the raw JSON.
4. Include at least one negative case (invalid session / bad path / missing field).

**Phase-done check (spawned executor MUST run before flipping `executor_status` to `"done"`):**

```bash
test -s "<planning-dir>/logs/s${PHASE}-e2e.log" || {
  # Log missing or empty — write error and exit
  jq '.executor_status = "error" | .executor_error = {reason: "E2E_LOG_MISSING", detail: "<planning-dir>/logs/s'${PHASE}'-e2e.log missing or empty"}' \
    <planning-dir>/.build-progress.json > /tmp/bp.json && mv /tmp/bp.json <planning-dir>/.build-progress.json
  exit 1
}
```

Also the log must contain at least one JSON object response (not just prose). A quick sanity check:

```bash
grep -E '^\s*[{\[]|"success"\s*:' "<planning-dir>/logs/s${PHASE}-e2e.log" > /dev/null || {
  # No JSON detected — treat as missing
  ...E2E_LOG_NO_JSON error...
}
```

On success, record the log path in `.build-progress.json`:

```json
{
  "e2e_logs": { "phase_N": "<planning-dir>/logs/s{N}-e2e.log" }
}
```

**Named sessions for deterministic access:**
```bash
# 1. Restart daemon with latest build
afs service restart

# 2. Open target page with named session (Playwright or browser)
playwright → http://target.localhost:4900/?session=e2e-{phase-name}

# 3. Call AFS MCP paths directly — ZERO session discovery
afs_read /dev/ui/web/sessions/e2e-{phase-name}/inspect/viewport
afs_list /dev/ui/web/sessions/e2e-{phase-name}/dom/main
```

Choose additional verification based on change type:

| Change Type | Strategy |
|-------------|----------|
| **Provider** | Mount provider → list/read/write/exec through AFS MCP tools |
| **Session/Protocol** | `afs service restart` → open page with `?session=e2e-test` → call AFS paths |
| **AUP/UI** | Use inspect capabilities: `design-audit`, `overflow-scan`, `dom/@styles`, `accessibility` |
| **Inspect feature** | Test the new inspect path on a real page via named session |
| **Pure utility/library** | Call functions directly via a REPL/one-off script — verify output |
| **CLI** | Run CLI commands, verify stdout/exit code |
| **Refactoring** | Layer 1 sufficient — Layer 2 = verify one happy path via AFS MCP |

**OUTPUT THE ACTUAL TOOL CALL RESULTS.** Paste the `afs_read` / `afs_list` / `afs_exec` responses. Do not just say "verified via AFS". Show the JSON. These same outputs must also land in `<planning-dir>/logs/s{N}-e2e.log` (see HARD REQUIREMENT above).

**Layer 3: Adversarial — Try to break it**
Try at least ONE of:
- Send empty/null/undefined where values are expected
- Send oversized payload (>16MB for WS)
- Path traversal attack (../, %2e%2e, null bytes)
- Kill process mid-operation, check for data corruption
- Concurrent operations, check for race conditions
- Prototype pollution (__proto__, constructor)

**OUTPUT THE RESULTS.** Paste actual terminal output showing what you ran and what happened. Do not just say "tests passed."

If any layer fails → fix → re-run all three layers.

#### 2.3 COMMIT

**Always format before committing** to avoid pre-commit hook failures:
```bash
<formatter> <changed-files>
git add <specific-files>
git commit -m "phase N: implement <description>"
```

**Never commit run-generated log/state files.** `<planning-dir>/logs/*.log`、
`<planning-dir>/.build-logs/`、`.build-progress*.json` 都已被 `.gitignore` 覆盖——它们是本地证据/状态，
不是交付物。规则：
- 只 `git add <specific-files>`，绝不 `git add -A` / `git add .`；
- 绝不 `git add -f` 强加被 ignore 的 log——E2E hard requirement 验证的是文件**存在于本地**，不要求入库；
  design review 的 reviewer 直接读本地文件。
- **改了依赖 → lockfile 必须一起 add。** "specific files" **包含**本次连带产生的改动:改了 `package.json` 的依赖后,安装会更新 `<package_manager>` 的 lockfile(如 `pnpm-lock.yaml`/`package-lock.json`/`yarn.lock`);只提 manifest 不提 lockfile → 两者不一致,别处 / 后续 phase / 其他 agent 的 `<package_manager> install --frozen-lockfile` 直接红。**commit 前先 `git status` 扫连带改动:**
  - 本次动了依赖、lockfile 有对应 diff → 一起 `git add <lockfile>`(`git diff` 确认 diff 只含你增删的包,scoped);
  - 本次没碰依赖、lockfile 却有 diff → 是并发/无关改动,**别卷入**——精确 add 的意义正在于此。

#### 2.4 SIMPLIFY (conditional)

**Skip if phase changed < 50 lines of production code** (tests don't count). Small changes rarely benefit from a simplify pass.

If applicable, launch a `code-simplifier:code-simplifier` agent (or use /simplify skill). Focus on:
- Recently modified files only
- Clarity and maintainability
- Remove unnecessary complexity
- Do NOT change behavior

#### 2.5 RE-VERIFY

Run Layer 1 only (build + types + the simplified packages' tests — not the full suite). If simplify broke something:
- Revert the simplify changes
- Commit without simplify
- Note what went wrong

Otherwise:
```bash
git add <simplified-files>
git commit -m "phase N: simplify"
```

#### 2.6 DESIGN REVIEW（parent 负责，不在 executor 内）

收到 executor 完成通知并通过 E2E log check 后，**parent** launch 一个 clean-context review agent（与 /agentloop:design-review 同模式）。审查者与实现者是不同的 agent——独立性是设计要求：NOT APPROVED 时 parent 把 review 发现写进 respawn prompt 重派 executor 修复，而不是 reviewer 自己修。Review prompt:

```
你是一个独立的代码审查者。检查 Phase {N} 的实现是否符合 spec。

1. 读取 {planning-dir}/tasks.md 中 Phase {N} 的 spec
2. 读取实际代码变更（git diff HEAD~2 对比 phase 开始前）
3. 读取 E2E 日志 {planning-dir}/logs/s{N}-e2e.log：
   - 文件必须存在且非空
   - 必须包含 JSON-shaped 响应（至少一个 `{` 或 `"success":` 行）
   - 如果只是散文 ("verified via AFS"、"tests passed") → NOT APPROVED
   - 至少包含 tasks.md 的 E2E Verification 表中列出的每一个 afs_exec 调用
4. 检查：
   - 所有 acceptance criteria 是否满足
   - 测试是否覆盖 spec 中列出的场景
   - 是否有 spec 中描述但未实现的功能
   - 是否有实现了但 spec 中没提到的额外功能（scope creep）
   - E2E 日志中的返回值是否匹配 tasks.md 预期（比如 `success: true`、特定字段）
5. 打分 0-100%。E2E 日志缺失或不合格 = 自动 NOT APPROVED，不管其他维度。
```

If score < target:
- Parent respawns the executor with the reviewer's findings appended to the prompt
- Respawned executor fixes **all** of the reviewer's findings in one batch, re-runs verify (Layer 1, scoped), updates progress JSON
- Parent re-dispatches review on the next notification
- Repeat until approved (counts toward the same respawn_count ≤ 3 budget)

#### 2.7 REPORT（parent 在 review approved 后输出）

Output phase completion summary:
```
## Phase N Complete

**Tests:** X pass (up from Y)
**Verification:** Layer 1 ✓ | Layer 2 ✓ | Layer 3 ✓
**E2E log:** `planning/<dir>/logs/s{N}-e2e.log` ({bytes} bytes, {calls} afs_exec calls)
**Simplify:** Applied / Skipped
**Review:** {score}% — APPROVED
**Commits:** {hash1} (implement), {hash2} (simplify)
```

The E2E log line is **required** — omitting it (or pointing at a missing/empty file) means the phase did not pass the hard requirement.

### Step 3: Final report after all phases

```
## Build Phases Complete

**Planning:** {planning-dir}
**Phases completed:** {N} / {total}
**Total test count:** {before} → {after}
**All phases:** PASSED
**Tests:** `<affected-package test command>` → {pass}/{fail} @ {sha7}
```
