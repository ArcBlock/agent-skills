---
name: blocklet-pr
description: 为 blocklet 项目创建规范的 Pull Request。执行 lint 检查、单元测试、版本更新，并按照 PR 模板创建符合规范的 PR。使用 `/blocklet-pr` 或说"帮我提交 PR"、"创建 pull request"触发。
---

# Blocklet PR

帮助开发者为 blocklet 项目创建规范的 Pull Request，确保代码质量并遵循项目 PR 模板。

## 前置条件

- 当前目录是 blocklet 项目（存在 `blocklet.yml`）
- 已有代码改动需要提交
- 已配置 `gh` CLI 并完成认证

## Workflow

按顺序执行以下阶段。

---

### Phase 1: 工作区检查

**参考 `blocklet-branch` skill 执行分支操作**。
skill 位置: `plugins/blocklet/skills/blocklet-branch/SKILL.md`

#### 1.1 确认远程仓库

参考 blocklet-branch 第 1.1 节：

```bash
REMOTE_URL=$(git remote get-url origin)
ORG=$(echo $REMOTE_URL | sed -E 's/.*[:/]([^/]+)\/([^/]+)(\.git)?$/\1/')
REPO=$(echo $REMOTE_URL | sed -E 's/.*[:/]([^/]+)\/([^/]+)(\.git)?$/\2/' | sed 's/\.git$//')
```

#### 1.2 检测主迭代分支

参考 blocklet-branch 第 2 节：

```bash
MAIN_BRANCH=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json baseRefName \
  | jq -r '.[].baseRefName' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
```

**输出变量**: `MAIN_BRANCH`, `MAIN_BRANCH_REASON`

#### 1.3 检测分支命名规范

参考 blocklet-branch 第 3 节：

```bash
BRANCH_PREFIXES=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json headRefName \
  | jq -r '.[].headRefName' | sed -E 's/^([a-zA-Z]+)[\/\-].*/\1/' | sort | uniq -c | sort -rn)
```

**输出变量**: `BRANCH_PREFIX_CONVENTION`, `BRANCH_SEPARATOR`

#### 1.4 分支检查与创建（强制）

参考 blocklet-branch 第 6、7 节。

**重要**：提交 PR 之前，**必须**确保在工作分支上，不能在主迭代分支上直接提交。

```bash
CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" = "$MAIN_BRANCH" ]; then
    echo "⚠️ 当前在主迭代分支 $MAIN_BRANCH 上，必须创建新分支！"
fi
```

| 情况 | 处理 |
|------|------|
| 在主迭代分支上 | **必须**创建新分支（参考 blocklet-branch 第 6 节） |
| 在工作分支上 | 检查分支命名是否符合规范（参考 blocklet-branch 第 7.2 节） |

**如果在主迭代分支上**，使用 `AskUserQuestion`：

```
⚠️ 当前在主迭代分支 {MAIN_BRANCH} 上，无法直接提交 PR。

请选择新分支名（将基于 {MAIN_BRANCH} 创建）：

选项：
A. {建议的分支名，根据改动类型和 BRANCH_PREFIX_CONVENTION 生成} (Recommended)
B. 输入自定义分支名
C. 取消操作
```

**创建工作分支**（参考 blocklet-branch 第 6.2 节）：

```bash
git fetch origin $MAIN_BRANCH
git checkout $MAIN_BRANCH
git pull origin $MAIN_BRANCH
git checkout -b $NEW_BRANCH_NAME
```

#### 1.5 检查未提交改动

```bash
git status --porcelain
```

| 情况 | 处理 |
|------|------|
| 有未暂存的改动 | 继续流程，后续会处理 |
| 无任何改动 | 提示无改动可提交，询问用户意图 |

---

### Phase 2: 代码质量检查

#### 2.1 Lint 检查

**查找 lint 命令**：

```bash
# 检查 package.json 中的 scripts
cat package.json | jq -r '.scripts | keys[]' | grep -iE '^lint$|^eslint$|^check$'
```

**常见 lint 命令优先级**：

| 优先级 | Script 名称 | 说明 |
|--------|-------------|------|
| 1 | `lint` | 标准 lint 命令 |
| 2 | `lint:fix` | 带自动修复的 lint |
| 3 | `check` | 通用检查命令 |
| 4 | `eslint` | ESLint 直接调用 |

**执行 lint**：

```bash
pnpm run lint
```

| 结果 | 处理 |
|------|------|
| 通过 | 继续下一步 |
| 失败（可自动修复） | 尝试 `pnpm run lint:fix`，然后重新检查 |
| 失败（无法自动修复） | **停止流程**，输出错误信息，让用户修复 |
| 无 lint 命令 | 跳过，继续下一步 |

#### 2.2 单元测试

**查找测试命令**：

```bash
cat package.json | jq -r '.scripts | keys[]' | grep -iE '^test$|^test:unit$|^jest$|^vitest$'
```

**常见测试命令优先级**：

| 优先级 | Script 名称 | 说明 |
|--------|-------------|------|
| 1 | `test` | 标准测试命令 |
| 2 | `test:unit` | 单元测试 |
| 3 | `test:ci` | CI 环境测试 |

**执行测试**：

```bash
pnpm run test
```

| 结果 | 处理 |
|------|------|
| 通过 | 继续下一步 |
| 失败 | **停止流程**，输出失败的测试用例，让用户修复 |
| 无测试命令 | 跳过，继续下一步（提示建议添加测试） |

---

### Phase 3: 版本更新（可选）

#### 3.1 询问是否需要版本更新

使用 `AskUserQuestion` 询问：

```
是否需要更新版本并创建 release？

选项：
A. 是，更新 patch 版本 (x.x.X) (Recommended for bug fixes)
B. 是，更新 minor 版本 (x.X.0)
C. 是，更新 major 版本 (X.0.0)
D. 否，跳过版本更新
```

#### 3.2 执行版本更新

如果用户选择更新版本，**调用 blocklet-updater skill**：

**blocklet-updater skill 位置**: `plugins/blocklet/skills/blocklet-updater/SKILL.md`

---

### Phase 4: Git 提交

#### 4.1 暂存改动

```bash
git add -A
git status
```

显示将要提交的文件列表，使用 `AskUserQuestion` 确认：

```
以下文件将被提交：
{文件列表}

是否继续？
A. 是，提交所有改动 (Recommended)
B. 否，让我选择要提交的文件
C. 取消
```

#### 4.2 生成 Commit Message

**根据改动类型生成规范的 commit message**：

注意, 具体前缀请参考最近 20 个 Commit, 根据历史的规范来定.

| 改动类型 | Commit 前缀 | 示例 |
|----------|-------------|------|
| 新功能 | `feat:` | `feat: add video preview support` |
| Bug 修复 | `fix:` | `fix: resolve duplicate upload issue` |
| 文档 | `docs:` | `docs: update API documentation` |
| 重构 | `refactor:` | `refactor: simplify auth logic` |
| 测试 | `test:` | `test: add unit tests for utils` |
| 构建 | `chore:` | `chore: bump dependencies` |

**分析改动自动推断类型**，然后使用 `AskUserQuestion` 确认：

```
建议的 commit message:

{生成的 commit message}

选项：
A. 使用此 message (Recommended)
B. 修改 message
C. 取消
```

#### 4.3 执行提交

```bash
git commit -m "$(cat <<'EOF'
{commit_message}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Phase 5: 推送分支

#### 5.1 检查远程分支

```bash
git ls-remote --heads origin $CURRENT_BRANCH
```

| 情况 | 处理 |
|------|------|
| 远程分支不存在 | 使用 `-u` 推送并设置上游 |
| 远程分支存在 | 正常推送 |

#### 5.2 推送

```bash
git push -u origin $CURRENT_BRANCH
```

---

### Phase 6: 创建 Pull Request

#### 6.1 检查 PR 模板

```bash
# 查找 PR 模板
PR_TEMPLATE=""
if [ -f ".github/PULL_REQUEST_TEMPLATE.md" ]; then
    PR_TEMPLATE=".github/PULL_REQUEST_TEMPLATE.md"
elif [ -f ".github/pull_request_template.md" ]; then
    PR_TEMPLATE=".github/pull_request_template.md"
elif [ -f "docs/PULL_REQUEST_TEMPLATE.md" ]; then
    PR_TEMPLATE="docs/PULL_REQUEST_TEMPLATE.md"
fi
```

**如果找到模板**：读取并解析模板结构，按模板格式填写 PR 内容。

**如果未找到模板**：使用默认 PR 格式。

#### 6.2 获取目标分支

```bash
# 获取默认分支
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')

# 或根据最近 PR 判断
DEV_BRANCH=$(gh pr list --state merged --limit 5 --json baseRefName --jq '.[].baseRefName' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
```

使用 `AskUserQuestion` 确认目标分支：

```
PR 目标分支：

选项：
A. {DEFAULT_BRANCH} (Recommended)
B. 其他分支
```

#### 6.3 关联 Issue（如有）

使用 `AskUserQuestion` 询问：

```
是否需要关联 Issue？

选项：
A. 否，不关联 Issue
B. 是，关联 Issue（请输入 Issue 编号）
```

如果关联 Issue，在 PR 描述中添加：
- `Closes #123` - 合并时自动关闭 Issue
- `Fixes #123` - 修复 Issue
- `Relates to #123` - 相关但不自动关闭

#### 6.4 生成 PR 内容

**PR 标题**：基于 commit message 或分支名生成，格式简洁清晰。

**PR 描述**（按模板或默认格式）：

```markdown
## Summary

{改动概述，2-3 句话说明这个 PR 做了什么}

## Changes

{具体改动列表}
- 改动点 1
- 改动点 2
- ...

## Related Issues

{如有关联的 Issue}
Closes #{issue_number}

## Test Plan

{验证方式和测试点}
- [ ] 验证点 1
- [ ] 验证点 2
- [ ] 单元测试通过
- [ ] Lint 检查通过

## Screenshots (if applicable)

{如有 UI 改动，添加截图说明}
```

#### 6.5 创建 PR

在 PR 输出后, 等待用户确认后再创建 PR, PR 的 base 分支, 请使用近期 10 个 PR,最多合并的那个分支

```bash
gh pr create \
  --title "{pr_title}" \
  --body "$(cat <<'EOF'
{pr_body}
EOF
)" \
  --base $TARGET_BRANCH
```

#### 6.6 输出结果

```
===== PR 创建成功 =====

PR URL: {pr_url}
标题: {pr_title}
目标分支: {target_branch}
关联 Issue: {issue_numbers 或 "无"}

===== 后续步骤 =====
等待 Code Review

```

---

## Error Handling

| 错误 | 处理 |
|------|------|
| Lint 失败 | 显示错误详情，建议运行 `pnpm run lint:fix` |
| 测试失败 | 显示失败的测试用例，让用户修复 |
| 推送失败 | 检查权限，提示 `git pull --rebase` |
| PR 创建失败 | 显示 gh 错误信息，检查认证状态 |
| 已存在相同 PR | 显示现有 PR 链接，询问是否更新 |


---

## 与其他 Skill 的关系

| Skill | 关系 |
|-------|------|
| `blocklet-dev-setup` | 开发环境准备，在 PR 之前使用 |
| `blocklet-updater` | 版本更新，在 PR 中可选调用 |
| `blocklet-url-analyzer` | 分析 Blocklet URL，定位仓库 |
