---
name: git-hygiene
description: >
  After a merge or when ending multi-branch work: switch the primary checkout
  to the default branch, fast-forward from origin, then remove local worktrees
  and branches that have no unique work left. Use when the user says "切回
  main 清理", "清理 worktree", "prune branches", "git hygiene", "收工清分支",
  or after confirming a PR merged. Safe by default: never delete a branch or
  worktree that still has commits not on origin/<default> unless squash-merge
  parity is verified. Works in any git repo.
---

# git-hygiene

收工 / 合并后的本地 Git 卫生：**回默认分支 → 拉最新 → 只清确认无独特工作的 worktree 与本地分支**。

与现有 skill 的分工：

| Skill | 做什么 |
| --- | --- |
| **git-hygiene（本 skill）** | 回 `main`、ff-only pull、按「相对 origin/main 是否还有独有提交」清 worktree/分支 |
| `git-worktree`（compound-engineering） | 创建 / 切换 / 交互式清理 **`.worktrees/` 约定** 下的并行 worktree |
| `blocklet-branch` | 按 blocklet 仓库约定**开**迭代分支 |

本 skill **不**替你 merge PR、不 force-push、不 `git clean -fdx`、不丢 dirty 改动。

## 触发

- 「切到 main / 拉最新 / 清理没用的 worktree 和 branch」
- 「确认没有未合并工作再删」
- PR 已 merge 后的本地收尾
- 多 agent 并行结束后的主工作区复位

## 默认假设

- 远程名：`origin`
- 默认分支：优先 `origin/HEAD` → 否则 `main` → 否则 `master`
- **删除闸门 = 内容已在 `origin/<default>` 上**，不是「我记得 merge 了」

## 硬规则

1. **主工作区 dirty → 停。** 有 uncommitted 改动时不 `checkout`、不删分支。先让用户 commit / stash / 明确丢弃。
2. **只 `git pull --ff-only`。** 拒绝非快进；有分叉就报告，不 rebase/merge 擅自修。
3. **不删仍有独有提交的分支。**  
   `git merge-base --is-ancestor <branch> origin/<default>` 为假 → **KEEP**，除非走 squash 校验（见下）。
4. **不删 dirty / locked worktree。**
5. **不删当前检出分支**（先切到 default）。
6. **主 worktree 永不 `worktree remove`。**
7. **远程 `origin/<branch>` 已 gone ≠ 本地可删。** gone 只说明远端没了；本地 tip 仍可能有未合入提交。
8. **一次审批只管这一次。** 用户说「继续清」时仍对 KEEP 列表逐类处理，不默认 `branch -D` 全部 unmerged。

## 流程

### 0. 范围

- 默认：当前 repo（`git rev-parse --show-toplevel`）
- 用户点名多个 repo（如 site + arc）：**每个 repo 单独跑完整流程**，报告分开写

优先跑确定性脚本（inventory；可选 apply）。脚本在 skill 旁：

```bash
# From agentloop plugin install (team):
ROOT="${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}"
# Or when developing in arc SoT:
# ROOT="$(git rev-parse --show-toplevel)/.claude/plugins/agentloop"

bash "$ROOT/skills/git-hygiene/scripts/git-hygiene.sh" inventory
# 审查报告后：
bash "$ROOT/skills/git-hygiene/scripts/git-hygiene.sh" apply --yes
# 多 repo：
bash "$ROOT/skills/git-hygiene/scripts/git-hygiene.sh" inventory /path/to/other-repo
```

Agent 必须读脚本输出再决策；**apply 只处理 SAFE 类**。SQUASH_CANDIDATE / KEEP 由 agent 按下面规则处理。

### 1. 库存（只读）

收集并展示：

| 项 | 命令要点 |
| --- | --- |
| 当前分支 / dirty | `status -sb` |
| 默认分支 | `origin/HEAD` 或 main/master |
| fetch | `git fetch origin --prune` |
| worktree 表 | path · branch · dirty 行数 · locked? |
| merged 本地分支 | `git branch --merged origin/<default>` |
| unmerged 本地分支 | `git branch --no-merged origin/<default>` |
| 当前 feature 相对 default | `git log --oneline origin/<default>..<branch>` |

### 2. 回默认分支

1. Dirty → **停**，列出改动，问用户  
2. `git checkout <default>`  
3. `git pull --ff-only origin <default>`  
4. 确认 `status -sb` 为 `## <default>...origin/<default>` 且无 ahead/behind（或仅说明已对齐）

### 3. 分类每个本地分支 / worktree

对每个非 default 本地分支（及绑定它的 worktree）：

| 类 | 条件 | 动作 |
| --- | --- | --- |
| **SAFE** | tip 是 `origin/<default>` 的祖先；worktree 非 dirty、非 locked | 可删 worktree → 再 `branch -d` |
| **SQUASH_CANDIDATE** | 非祖先，但关联 PR 已 MERGED（`gh pr view` / 合并提交信息），或用户声称已 merge | **必须做内容校验**（见 §4）通过后才可 `-D` |
| **KEEP** | 有独有 commit；或 dirty；或 locked；或无法证明已在 default 上 | **保留**，报告 commits ahead |
| **DETACHED_TMP** | worktree 为 detached HEAD，且位于 `/tmp`、`/private/tmp`、明确的 review 沙箱路径 | 非 dirty 则可 `worktree remove`；无对应需保留分支 |

### 4. Squash /  rebase 合入的校验（SQUASH_CANDIDATE）

`branch --merged` 对 squash **会漏报**。删除前至少满足其一：

**A. PR 证据（优先）**

```bash
gh pr list --state merged --head "<branch>" --json number,mergeCommit,url
# 或
gh pr view <n> --json state,mergedAt,mergeCommit
```

`state=MERGED` 后仍建议 B。

**B. 路径/树证据（必做当有疑虑）**

1. 列出分支相对 merge-base 改过的路径：  
   `git diff --name-only origin/<default>...<branch>`
2. 对**任务相关**路径（或全部若集合小）：确认 `origin/<default>` 上存在且与分支 tip **无关键内容缺口**  
   - 简单：`git diff origin/<default> <branch> -- <paths>` 为空或仅 default 更新  
   - 或：分支独有路径在 default 上已存在且内容可接受
3. **禁止**仅因「PR 标题像」或「issue 关了」就 `-D`

校验失败 → 标 **KEEP**，写明缺什么证据。

### 5. 执行删除（仅 SAFE + 已校验 SQUASH）

顺序固定：

1. `git worktree remove [--force 仅当用户确认且非 dirty 误报]` `<path>`  
2. `git branch -d <branch>`；squash 已校验可用 `-D`  
3. `git worktree prune`

绝不：

- `git push origin --delete`（除非用户明确要求清远程）
- `git clean -fdx` / 删未跟踪构建产物（除非用户明确要求）
- 删 `main` / default / 当前分支

### 6. 报告模板

```markdown
## git-hygiene · <repo path>

**default**: `<branch>` @ `<shortsha>` (= origin/…)
**working tree**: clean | dirty (… )

### Removed
- worktrees: …
- branches: … (SAFE / SQUASH#<pr>)

### Kept (still have unique work or risk)
| ref | ahead of origin/<default> | reason |
|-----|---------------------------|--------|
| … | N commits / dirty / locked | … |

### Not done
- …
```

多 repo 时每个 repo 一节。

## 可选：远程 gone 的本地分支

`git fetch --prune` 后 tracking 显示 `gone`：

- 仍先按 §3 分类  
- gone + SAFE（已是 default 祖先）→ 可删  
- gone + 有独有 commit → **KEEP**（可能是未推完或 squash 未校验）

不要写「gone 就全删」的脚本逻辑。

## 与 wrap-up 的关系

- **wrap-up**：session 回顾、文档/profile 同步  
- **git-hygiene**：本地 Git 图复位  

可同一会话串联：先 hygiene 再 wrap-up，或相反；互不替代。

## 不做什么

- 不整理 stash 列表（除非用户要求）
- 不关闭 GitHub PR / issue
- 不升级依赖、不跑全量测试门禁（除非用户要求验证 main 可构建）
- 不把「分支名像 agent 临时」当成可删充分条件
