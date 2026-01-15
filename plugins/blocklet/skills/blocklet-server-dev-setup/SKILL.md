---
name: blocklet-server-dev-setup
description: 克隆 blocklet-server 仓库并引导执行项目内的 project-setup skill。使用 `/blocklet-server-dev-setup` 或说"帮我配置 blocklet-server 环境"、"setup blocklet-server"触发。
---

# Blocklet Server Dev Setup

帮助开发者克隆 blocklet-server 仓库到约定目录，切换到开发分支，然后引导执行项目内置的 `project-setup` skill 完成环境配置。

**注意**: 此 skill 用于 blocklet-server **源码开发**，与 `blocklet-dev-setup`（使用 `blocklet dev` 开发 blocklet）不同。

## 约定目录

| 目录 | 用途 |
|------|------|
| `~/arcblock-repos/` | 所有 ArcBlock 项目仓库 |
| `~/arcblock-repos/blocklet-server/` | Blocklet Server 源码 |
| `~/arcblock-repos/agent-skills/` | AI Agent 技能集（查询 skill 定义时使用） |
| `~/blocklet-server-dev-data/` | Blocklet Server 源码开发, 数据目录 |

## 查询 Skill 定义

当需要了解 agent-skills 中的 skill 定义时，**必须**先确保本地仓库是最新的：

```bash
REPO_PATH="$HOME/arcblock-repos/agent-skills"
if [ -d "$REPO_PATH" ]; then
    cd "$REPO_PATH" && [ -z "$(git status --porcelain)" ] && git pull origin main
else
    mkdir -p ~/arcblock-repos && cd ~/arcblock-repos && git clone git@github.com:ArcBlock/agent-skills.git
fi
```

---

## Workflow

### Phase 0: 输入分析（可选）

当用户提供 URL 时，首先判断是否应该使用本 skill：

#### 0.1 URL 类型判断

```bash
# 判断 URL 类型
if [[ "$URL" =~ ^https?://github\.com/ ]]; then
    # GitHub Issue URL → 检查是否为 blocklet-server 仓库
    if [[ "$URL" =~ github\.com/ArcBlock/blocklet-server ]]; then
        # 是 blocklet-server 的 issue → 继续本 skill
        IS_TARGET_REPO=true
    else
        # 其他仓库的 issue → 提示使用 blocklet-dev-setup
        IS_TARGET_REPO=false
    fi
else
    # 非 GitHub URL → 使用 blocklet-url-analyzer skill 分析
    # 读取 plugins/blocklet/skills/blocklet-url-analyzer/SKILL.md
fi
```

#### 0.2 非 GitHub URL 处理

使用 `blocklet-url-analyzer` skill 分析 URL：

| 分析结果类型 | 处理 |
|-------------|------|
| `DAEMON` | 继续本 skill（blocklet-server 源码开发） |
| `BLOCKLET_SERVICE` | 继续本 skill（blocklet-server 源码开发） |
| `BLOCKLET` | 提示用户应使用 `blocklet-dev-setup`，并告知对应仓库 |
| `UNKNOWN` | 使用 AskUserQuestion 让用户确认是否继续本 skill |

**blocklet-url-analyzer skill 位置**: `plugins/blocklet/skills/blocklet-url-analyzer/SKILL.md`

#### 0.3 无 URL 输入

如果用户没有提供 URL（如直接说"帮我配置 blocklet-server 环境"），跳过此 Phase，直接进入 Phase 1。

---

### Phase 1: 检查 GitHub 权限

```bash
gh api repos/ArcBlock/blocklet-server --jq '.permissions'
```

| 权限情况 | 处理 |
|----------|------|
| 无访问权限 | 提示联系管理员或检查 GitHub 登录 |
| 只有 read 权限 | 提示可查看但无法推送，建议 fork |
| 有 push 权限 | 正常继续 |

---

### Phase 2: 克隆仓库到约定目录

#### 2.1 检查本地仓库

```bash
REPO_PATH="$HOME/arcblock-repos/blocklet-server"
if [ -d "$REPO_PATH" ]; then
    cd "$REPO_PATH" && git fetch origin
    echo "仓库已存在"
fi
```

#### 2.2 克隆仓库（如不存在）

```bash
mkdir -p ~/arcblock-repos && cd ~/arcblock-repos
git clone git@github.com:ArcBlock/blocklet-server.git || git clone https://github.com/ArcBlock/blocklet-server.git
```

---

### Phase 3: 切换到 dev 分支

#### 3.1 检查当前分支是否有未提交的改动

```bash
cd ~/arcblock-repos/blocklet-server
git status --porcelain
```

**重要**: 如果有未提交的改动，**必须**使用 AskUserQuestion 询问用户如何处理：
- 选项 A: 暂存改动 (`git stash`)
- 选项 B: 提交改动
- 选项 C: 放弃改动 (`git checkout .`)
- 选项 D: 取消操作

#### 3.2 切换分支

```bash
git checkout dev && git pull origin dev
```

**规则**:
- 所有开发者都在 `dev` 分支开始
- 如果当前在 `master` 分支，必须切换到 `dev`

---

### Phase 4: 前置环境检查

#### 4.1 检查 blocklet 开发进程冲突

**重要**: 在启动 blocklet-server 源码开发之前，必须检查是否有 Blocklet Server 生产版本在运行。两者不能同时运行。

```bash
# 检查 blocklet server 是否在运行
if blocklet server status 2>/dev/null | grep -q "running"; then
    echo "⚠️ 检测到 Blocklet Server 生产版本正在运行"
    echo "请先停止: blocklet server stop -f"
    exit 1
fi
```

| 检测结果 | 处理 |
|----------|------|
| blocklet server 正在运行 | 使用 AskUserQuestion 询问用户是否停止该进程 |
| 未运行 | 继续下一步 |

**冲突原因**: blocklet-server 源码开发（`bun run start`）和 Blocklet Server 生产版本（`blocklet server start`）使用相同的端口和资源，不能同时运行。

---

### Phase 5: 执行项目内置的 project-setup skill

项目仓库内已有完整的 `project-setup` skill，位于：

```
~/arcblock-repos/blocklet-server/.claude/skills/project-setup/SKILL.md
```

**执行方式**:

1. 读取该 skill 文件内容
2. 按照 skill 中的步骤执行：
   - 前置条件检查（Node.js v22+, bun, nginx）
   - 安装依赖 (`bun install`)
   - 编译依赖包 (`bun turbo:dep`)
   - 配置环境变量 (`core/webapp/.env.development`)
   - 输出启动指南

---

## 输出完成信息

```
===== Blocklet Server 开发环境已就绪 =====

仓库位置: ~/arcblock-repos/blocklet-server
当前分支: dev

访问地址: http://127.0.0.1:3000

正在启动开发环境：
  cd ~/arcblock-repos/blocklet-server
  bun run start

其他常用命令：
  bun run test        # 运行测试
  bun run turbo:lint  # 运行 lint 检查
```

## 启动开发环境

使用 bun run start 启动, 过程中如果有问题, 请帮忙修复

启动成功后, 输出命令, 教会用户如何查看 tmux 的这些进程

---

## Error Handling

| 错误 | 处理 |
|------|------|
| GitHub 权限不足 | 提示联系管理员或 fork |
| 克隆失败 | 检查网络，尝试 HTTPS 方式 |
| project-setup skill 不存在 | 提示可能是旧版本仓库，手动执行安装步骤 |

---

## Skill 持续改进

当开发过程中遇到 **本 skill 未记录的问题** 并成功解决后，应主动询问用户是否将经验贡献回 skill。

### 触发条件

以下情况应触发改进询问：

| 场景 | 示例 |
|------|------|
| 遇到新的环境问题并解决 | bun 版本问题、nginx 配置、端口冲突等 |
| 发现更好的诊断/修复方法 | 更快的问题定位命令、更可靠的修复步骤 |
| 流程中有遗漏的步骤 | 某个必要的前置检查未包含 |
| 错误处理表缺少某类错误 | 新发现的常见错误模式 |

### 询问流程

使用 `AskUserQuestion`：

```
我刚刚解决了一个问题：{问题简述}

这个问题在当前 skill 文档中没有记录。是否需要我帮你将这个经验贡献到 agent-skills 仓库？

选项：
A. 是，帮我准备 PR（Recommended）
   - 我会拉取 agent-skills 仓库、创建分支、补充相关信息
B. 不需要，这是个特殊情况
C. 稍后再说
```

### PR 准备流程（如用户选择 A）

```bash
# 1. 确保 agent-skills 仓库最新
SKILLS_REPO="$HOME/arcblock-repos/agent-skills"
cd "$SKILLS_REPO" && git checkout main && git pull origin main

# 2. 创建改进分支
BRANCH_NAME="improve/blocklet-server-dev-setup-$(date +%Y%m%d)"
git checkout -b "$BRANCH_NAME"

# 3. 定位 skill 文件
SKILL_FILE="$SKILLS_REPO/plugins/blocklet/skills/blocklet-server-dev-setup/SKILL.md"
```

然后根据问题类型，在 skill 文件的相应位置补充内容：

| 问题类型 | 更新位置 |
|----------|----------|
| 环境问题 | `Phase 4: 前置环境检查` 或 `Error Handling` |
| 流程问题 | 相应的 Phase 章节 |
| 诊断方法 | `Error Handling` 章节 |

### 输出 PR 信息

```
===== Skill 改进 PR 已准备 =====

仓库: ~/arcblock-repos/agent-skills
分支: {BRANCH_NAME}
修改文件: plugins/blocklet/skills/blocklet-server-dev-setup/SKILL.md

已添加内容:
- {简述添加的内容}

下一步:
1. 请检查修改内容: git diff
2. 提交并推送: git add -A && git commit -m "fix(blocklet-server-dev-setup): {改进描述}" && git push -u origin {BRANCH_NAME}
3. 创建 PR: gh pr create --title "fix(blocklet-server-dev-setup): {改进描述}" --body "..."
```
