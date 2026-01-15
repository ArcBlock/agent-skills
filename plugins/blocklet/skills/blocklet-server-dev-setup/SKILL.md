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

### Phase 0: GitHub CLI 认证检查

**最优先执行**: 在执行任何 `gh` 命令之前，必须先确保 GitHub CLI 已认证。

```bash
# 检查 gh 是否已认证
if ! gh auth status &>/dev/null; then
    echo "❌ GitHub CLI 未认证，请先执行认证"
    gh auth login
fi
```

| 认证状态 | 处理 |
|----------|------|
| 未安装 gh | 提示安装：`brew install gh` (macOS) 或参考 https://cli.github.com/ |
| 未认证 | 引导执行 `gh auth login` 完成认证, 可以帮用户执行认证, 并且告诉用户怎么做 |
| 已认证 | 继续下一步 |

---

### Phase 1: 输入分析（可选）

当用户提供 URL 时，首先判断是否应该使用本 skill：

#### 1.1 URL 类型判断

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

#### 1.2 非 GitHub URL 处理

使用 `blocklet-url-analyzer` skill 分析 URL：

| 分析结果类型 | 处理 |
|-------------|------|
| `DAEMON` | 继续本 skill（blocklet-server 源码开发） |
| `BLOCKLET_SERVICE` | 继续本 skill（blocklet-server 源码开发） |
| `BLOCKLET` | 提示用户应使用 `blocklet-dev-setup`，并告知对应仓库 |
| `UNKNOWN` | 使用 AskUserQuestion 让用户确认是否继续本 skill |

**blocklet-url-analyzer skill 位置**: `plugins/blocklet/skills/blocklet-url-analyzer/SKILL.md`

#### 1.3 无 URL 输入

如果用户没有提供 URL（如直接说"帮我配置 blocklet-server 环境"），跳过此 Phase，直接进入 Phase 2。

---

### Phase 2: 检查 GitHub 权限

```bash
gh api repos/ArcBlock/blocklet-server --jq '.permissions'
```

| 权限情况 | 处理 |
|----------|------|
| 无访问权限 | 提示联系管理员或检查 GitHub 登录 |
| 只有 read 权限 | 提示可查看但无法推送，建议 fork |
| 有 push 权限 | 正常继续 |

---

### Phase 3: 克隆仓库到约定目录

#### 3.1 检查本地仓库

```bash
REPO_PATH="$HOME/arcblock-repos/blocklet-server"
if [ -d "$REPO_PATH" ]; then
    cd "$REPO_PATH" && git fetch origin
    echo "仓库已存在"
fi
```

#### 3.2 克隆仓库（如不存在）

```bash
mkdir -p ~/arcblock-repos && cd ~/arcblock-repos
git clone git@github.com:ArcBlock/blocklet-server.git || git clone https://github.com/ArcBlock/blocklet-server.git
```

---

### Phase 4: 切换到 dev 分支

#### 4.1 检查当前分支是否有未提交的改动

```bash
cd ~/arcblock-repos/blocklet-server
git status --porcelain
```

**重要**: 如果有未提交的改动，**必须**使用 AskUserQuestion 询问用户如何处理：
- 选项 A: 暂存改动 (`git stash`)
- 选项 B: 提交改动
- 选项 C: 放弃改动 (`git checkout .`)
- 选项 D: 取消操作

#### 4.2 切换分支

```bash
git checkout dev && git pull origin dev
```

**规则**:
- 所有开发者都在 `dev` 分支开始
- 如果当前在 `master` 分支，必须切换到 `dev`

---

### Phase 5: 前置环境检查

#### 5.1 检查 blocklet 开发进程冲突

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

### Phase 6: 执行项目内置的 project-setup skill

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
   - 持续查看 tmux 中 blocklet windows 的 webapp window, 看看日志输出, 要确保成功. 如果出现 [nodemon] app crashed - waiting, 记得停止这个进程,重新执行
   - 输出启动指南

---


## 输出完成信息

```
===== Blocklet Server 开发环境已就绪 =====

仓库位置: ~/arcblock-repos/blocklet-server
当前分支: dev

访问地址: http://127.0.0.1:3000, 而不是 http://127.0.0.1:3030, 3030 只是代理地址

正在启动开发环境：
  cd ~/arcblock-repos/blocklet-server
  bun run start

其他常用命令：
  bun run test        # 运行测试
  bun run turbo:lint  # 运行 lint 检查

使用其他 SKill 完成工作:

/blocklet-pr 修改完代码, 提交一个符合规范的 PR
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

