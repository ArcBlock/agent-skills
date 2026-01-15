---
name: blocklet-branch
description: Git 分支管理工具。检测主迭代分支、分支命名规范，处理分支创建和切换。被 blocklet-dev-setup 和 blocklet-pr 等 skill 引用。
---

# Blocklet Branch

统一的 Git 分支管理工具，提供分支检测、创建、切换等功能。

**设计原则**：
- 不假设主分支是 `main` 或 `master`，通过历史 PR 动态检测
- 分支命名规范从项目历史中学习
- 切换分支前必须处理未提交改动

---

## 1. 仓库信息获取

### 1.1 解析远程仓库

```bash
REMOTE_URL=$(git remote get-url origin)

# 解析 org/repo
ORG=$(echo $REMOTE_URL | sed -E 's/.*[:/]([^/]+)\/([^/]+)(\.git)?$/\1/')
REPO=$(echo $REMOTE_URL | sed -E 's/.*[:/]([^/]+)\/([^/]+)(\.git)?$/\2/' | sed 's/\.git$//')

echo "仓库: $ORG/$REPO"
```

### 1.2 获取当前分支

```bash
CURRENT_BRANCH=$(git branch --show-current)
echo "当前分支: $CURRENT_BRANCH"
```

---

## 2. 主迭代分支检测

**重要**：必须通过最近 10 个合并的 PR 来确定主迭代分支，而不是简单地假设是 `main` 或 `master`。

### 2.1 检测主迭代分支

```bash
# 获取最近 10 个合并 PR 的目标分支，统计出现最多的作为主迭代分支
MAIN_BRANCH=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json baseRefName \
  | jq -r '.[].baseRefName' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')

# 获取判断依据
BRANCH_STATS=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json baseRefName \
  | jq -r '.[].baseRefName' | sort | uniq -c | sort -rn)

echo "主迭代分支: $MAIN_BRANCH"
echo "判断依据（最近 10 个合并 PR 的目标分支统计）:"
echo "$BRANCH_STATS"
```

### 2.2 输出变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `MAIN_BRANCH` | 检测到的主迭代分支 | `main`, `develop`, `master` |
| `MAIN_BRANCH_REASON` | 判断原因 | "最近 10 个合并 PR 中有 8 个以 main 为目标" |

---

## 3. 分支命名规范检测

**重要**：通过最近 10 个合并的 PR 来确定分支命名前缀规范。

### 3.1 分析历史分支命名

```bash
# 获取最近 10 个合并 PR 的源分支名，分析命名规范
BRANCH_NAMES=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json headRefName \
  | jq -r '.[].headRefName')

# 提取前缀（支持 / 和 - 分隔符）
BRANCH_PREFIXES=$(echo "$BRANCH_NAMES" | sed -E 's/^([a-zA-Z]+)[\/\-].*/\1/' | sort | uniq -c | sort -rn)

echo "分支命名前缀统计（最近 10 个合并 PR）:"
echo "$BRANCH_PREFIXES"

# 检测分隔符风格（/ 或 -）
if echo "$BRANCH_NAMES" | grep -q '/'; then
    SEPARATOR="/"
else
    SEPARATOR="-"
fi
echo "分隔符风格: $SEPARATOR"
```

### 3.2 常见分支前缀

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat` / `feature` | 新功能 | `feat/add-login`, `feature/user-profile` |
| `fix` / `bugfix` | Bug 修复 | `fix/login-error`, `bugfix/issue-123` |
| `chore` | 日常维护 | `chore/update-deps` |
| `refactor` | 代码重构 | `refactor/auth-module` |
| `docs` | 文档更新 | `docs/api-guide` |
| `test` | 测试相关 | `test/add-unit-tests` |
| `style` | 代码风格 | `style/format-code` |
| `perf` | 性能优化 | `perf/optimize-query` |

### 3.3 输出变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `BRANCH_PREFIX_CONVENTION` | 主要前缀规范 | `feat`, `fix` |
| `BRANCH_SEPARATOR` | 分隔符风格 | `/` 或 `-` |

---

## 4. 未提交改动处理

**重要**：切换分支前，必须先处理未提交的改动。

### 4.1 检查改动状态

```bash
UNCOMMITTED_CHANGES=$(git status --porcelain)

if [ -n "$UNCOMMITTED_CHANGES" ]; then
    echo "⚠️ 检测到未提交的改动:"
    git status --short
fi
```

### 4.2 处理改动

如果有未提交的改动，使用 `AskUserQuestion` 询问用户：

```
检测到未提交的改动，请选择处理方式：

选项：
A. 暂存改动 (git stash) - 稍后可恢复 (Recommended)
B. 提交改动 - 创建一个临时提交
C. 放弃改动 (git checkout .) - ⚠️ 不可恢复
D. 取消操作
```

**执行处理**：

```bash
# 选项 A: 暂存
git stash push -m "Auto stash before branch switch"

# 选项 B: 提交
git add -A && git commit -m "WIP: auto commit before branch switch"

# 选项 C: 放弃
git checkout . && git clean -fd
```

---

## 5. 分支切换

### 5.1 切换到主迭代分支

```bash
# 确保本地有最新的远程分支信息
git fetch origin

# 切换到主迭代分支并更新
git checkout $MAIN_BRANCH
git pull origin $MAIN_BRANCH

echo "✅ 已切换到主迭代分支: $MAIN_BRANCH"
```

### 5.2 切换到指定分支

```bash
TARGET_BRANCH="feat/my-feature"

# 检查分支是否存在
if git show-ref --verify --quiet refs/heads/$TARGET_BRANCH; then
    # 本地分支存在
    git checkout $TARGET_BRANCH
elif git show-ref --verify --quiet refs/remotes/origin/$TARGET_BRANCH; then
    # 远程分支存在，创建本地跟踪分支
    git checkout -b $TARGET_BRANCH origin/$TARGET_BRANCH
else
    echo "❌ 分支 $TARGET_BRANCH 不存在"
fi
```

---

## 6. 工作分支创建

### 6.1 生成分支名建议

根据任务类型和仓库命名规范生成建议的分支名：

```bash
# 输入参数
TASK_TYPE="fix"           # feat, fix, chore, refactor, docs, test
TASK_DESCRIPTION="login"  # 简短描述
ISSUE_NUMBER=""           # 可选的 Issue 编号

# 生成分支名
if [ -n "$ISSUE_NUMBER" ]; then
    SUGGESTED_BRANCH="${TASK_TYPE}${BRANCH_SEPARATOR}issue-${ISSUE_NUMBER}-${TASK_DESCRIPTION}"
else
    SUGGESTED_BRANCH="${TASK_TYPE}${BRANCH_SEPARATOR}${TASK_DESCRIPTION}"
fi

echo "建议的分支名: $SUGGESTED_BRANCH"
```

### 6.2 创建工作分支

**前提**：必须基于最新的主迭代分支创建。

```bash
# 1. 确保主迭代分支是最新的
git fetch origin $MAIN_BRANCH
git checkout $MAIN_BRANCH
git pull origin $MAIN_BRANCH

# 2. 创建并切换到新分支
NEW_BRANCH="feat/my-new-feature"
git checkout -b $NEW_BRANCH

echo "✅ 已创建并切换到分支: $NEW_BRANCH (基于 $MAIN_BRANCH)"
```

### 6.3 用户确认流程

使用 `AskUserQuestion` 确认分支名：

```
将基于 {MAIN_BRANCH} 创建新分支。

请选择分支名：

选项：
A. {SUGGESTED_BRANCH} (Recommended)
B. 输入自定义分支名
C. 取消操作
```

---

## 7. 分支状态检查

### 7.1 检查是否在主迭代分支

```bash
if [ "$CURRENT_BRANCH" = "$MAIN_BRANCH" ]; then
    echo "⚠️ 当前在主迭代分支上"
    ON_MAIN_BRANCH=true
else
    ON_MAIN_BRANCH=false
fi
```

### 7.2 检查分支命名是否规范

```bash
# 检查分支名是否符合常见前缀规范
if echo "$CURRENT_BRANCH" | grep -qE "^(feat|fix|chore|refactor|docs|test|style|perf|hotfix|release)[/\-]"; then
    echo "✅ 分支命名符合规范"
    BRANCH_NAME_VALID=true
else
    echo "⚠️ 分支命名不符合常见规范: $CURRENT_BRANCH"
    BRANCH_NAME_VALID=false
fi
```

### 7.3 检查分支与远程的同步状态

```bash
# 获取本地和远程的差异
git fetch origin

LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse origin/$CURRENT_BRANCH 2>/dev/null || echo "")

if [ -z "$REMOTE_COMMIT" ]; then
    echo "📤 分支尚未推送到远程"
    SYNC_STATUS="not_pushed"
elif [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
    echo "✅ 分支与远程同步"
    SYNC_STATUS="synced"
else
    AHEAD=$(git rev-list origin/$CURRENT_BRANCH..HEAD --count)
    BEHIND=$(git rev-list HEAD..origin/$CURRENT_BRANCH --count)
    echo "📊 本地领先 $AHEAD 个提交，落后 $BEHIND 个提交"
    SYNC_STATUS="diverged"
fi
```

---

## 8. 使用场景

### 场景 A: 开发环境准备（blocklet-dev-setup）

1. 检测主迭代分支
2. 处理未提交改动
3. 切换到主迭代分支并更新
4. （可选）创建工作分支

### 场景 B: 提交 PR（blocklet-pr）

1. 检测主迭代分支
2. 检测分支命名规范
3. 检查当前分支
   - 如果在主迭代分支上 → **必须**创建工作分支
   - 如果在工作分支上 → 检查命名规范

### 场景 C: 切换任务

1. 处理未提交改动（stash/commit/discard）
2. 切换到目标分支
3. 恢复之前的改动（如果需要）

---

## 9. 被其他 Skill 引用

本 skill 被以下 skill 引用：

| Skill | 使用的功能 |
|-------|-----------|
| `blocklet-dev-setup` | 检测主迭代分支、处理未提交改动、切换分支、创建工作分支 |
| `blocklet-pr` | 检测主迭代分支、分支命名规范、强制创建工作分支 |

**引用方式**：

```
参考 blocklet-branch skill 执行分支操作。
skill 位置: plugins/blocklet/skills/blocklet-branch/SKILL.md
```

---

## 10. 错误处理

| 错误 | 原因 | 处理 |
|------|------|------|
| 无法获取 PR 历史 | gh 未认证或网络问题 | 运行 `gh auth status` 检查认证 |
| 分支切换失败 | 有未提交的改动冲突 | 先处理未提交改动 |
| 分支创建失败 | 分支名已存在 | 使用其他分支名或切换到现有分支 |
| 无法检测主迭代分支 | 仓库无合并的 PR | 回退到默认分支 `gh repo view --json defaultBranchRef` |
