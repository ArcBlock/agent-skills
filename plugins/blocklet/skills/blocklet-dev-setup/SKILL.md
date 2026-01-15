---
name: blocklet-dev-setup
description: 配置 blocklet 类型仓库的开发环境。支持解析 GitHub Issue URL、Blocklet URL 或问题描述，自动定位仓库、检查权限、克隆代码、安装依赖、启动开发服务器。使用 `/blocklet-dev-setup` 或说"帮我修复 xxx blocklet 的问题"、"我要开发 xxx blocklet"、"我想修改这个 URL 相关的代码"触发。
---

# Blocklet Dev Setup

帮助开发者快速定位、克隆并配置任意 blocklet 仓库的开发环境，进入 live 开发状态。

**关键**: blocklet dev 需要本地有 Blocklet Server 在运行。

## 约定目录

| 目录 | 用途 |
|------|------|
| `~/arcblock-repos/` | 所有 ArcBlock 项目仓库 |
| `~/arcblock-repos/agent-skills/` | AI Agent 技能集（查询 skill 定义时使用） |
| `~/blocklet-server-data/` | Blocklet Server 数据目录 |
| `~/blocklet-server-dev-data/` | Blocklet Server 源码开发数据目录 |

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

**原因**: Skill 运行时无法读取当前 repo 的其他上下文，必须从约定路径读取。

## PM2 进程管理

查看 PM2 进程时需要设置正确的 `PM2_HOME`：

| 环境 | PM2_HOME |
|------|----------|
| 生产环境 | `~/.arcblock/abtnode` |
| 开发环境 | `~/.arcblock/abtnode-dev` |
| e2e 测试 | `~/.arcblock/abtnode-test` |

```bash
PM2_HOME=~/.arcblock/abtnode pm2 list
PM2_HOME=~/.arcblock/abtnode pm2 logs abt-node-daemon --lines 100
```
## Active Loading Policy
下面文件只要需要时, 才去读取, 文件在 arcblock 的 agent-skill repo 里:
| 涉及产品 | 加载文件 |
|---------|---------|
| Blocklet 开发通用 | `arcblock-context/products/blocklet-developer.md` |
| Blocklet Server | `arcblock-context/products/blocklet-server.md` |
| DID Connect | `arcblock-context/products/did-connect.md` |
| Discuss Kit | `arcblock-context/products/discuss-kit.md` |
| PaymentKit | `arcblock-context/products/paymentkit.md` |
| AIGNE CLI | `arcblock-context/products/aigne.md` |

## 仓库搜索

使用 GitHub API 动态搜索仓库，按最近更新排序：

### 搜索 ArcBlock 和 blocklet 组织的仓库

```bash
# 搜索 ArcBlock 组织的仓库（按最近更新排序）
gh repo list ArcBlock --limit 20 --json name,description,updatedAt --jq 'sort_by(.updatedAt) | reverse | .[] | "\(.name)\t\(.description // "N/A")"'

# 搜索 blocklet 组织的仓库（按最近更新排序）
gh repo list blocklet --limit 20 --json name,description,updatedAt --jq 'sort_by(.updatedAt) | reverse | .[] | "\(.name)\t\(.description // "N/A")"'
```

### 按关键词搜索仓库

```bash
# 在两个组织中搜索包含关键词的仓库
gh search repos "$KEYWORD" --owner ArcBlock --owner blocklet --sort updated --json fullName,description --jq '.[] | "\(.fullName)\t\(.description // "N/A")"'
```

### 检查仓库是否存在

```bash
# 检查仓库是否存在并获取详情
gh repo view "$ORG/$REPO" --json name,description,updatedAt,defaultBranchRef 2>/dev/null && echo "存在" || echo "不存在"
```

### GitHub Organizations

- **ArcBlock**: https://github.com/ArcBlock（主仓库，包含 blocklet-server 等核心项目）
- **blocklet**: https://github.com/blocklet（Blocklet 应用仓库）

---

## Workflow

按顺序执行以下阶段。

### Phase 1: Issue/Repo Resolution

识别用户意图，确定要开发的仓库。

| 触发方式 | 示例 | 处理 |
|----------|------|------|
| GitHub Issue URL | `https://github.com/ArcBlock/media-kit/issues/123` | **必须**读取 issue 内容分析 |
| **Blocklet URL** | `https://xxx.ip.abtnet.io/image-bin/admin` | 使用 `blocklet-url-analyzer` skill 分析 |
| 仓库名 + 问题描述 | "帮我修复 media-kit 的图片问题" | 使用 gh API 搜索仓库 |
| 问题描述 | "讨论区评论功能有 bug" | 关键词搜索仓库 |
| 直接指定 | "我要开发 snap-kit" | 使用 gh API 验证仓库存在 |

#### 1.0 URL 类型判断

当用户提供 URL 时，首先判断 URL 类型：

```bash
# 判断是否为 GitHub URL
if [[ "$URL" =~ ^https?://github\.com/ ]]; then
    # GitHub URL → 走 1.2 Issue 处理或直接提取仓库
    IS_GITHUB_URL=true
else
    # 非 GitHub URL → 使用 blocklet-url-analyzer skill 分析
    IS_GITHUB_URL=false
fi
```

**非 GitHub URL 处理流程**:

1. 读取 `blocklet-url-analyzer` skill 定义
2. 按照 skill 流程分析 URL
3. 根据分析结果判断：

| 分析结果类型 | 处理 |
|-------------|------|
| `DAEMON` | 提示用户应使用 `blocklet-server-dev-setup` |
| `BLOCKLET_SERVICE` | 提示用户应使用 `blocklet-server-dev-setup` |
| `BLOCKLET` | 获取对应仓库，继续 Phase 2 |
| `UNKNOWN` | 使用 AskUserQuestion 让用户手动指定 |

**blocklet-url-analyzer skill 位置**: `plugins/blocklet/skills/blocklet-url-analyzer/SKILL.md`

#### 1.1 仓库搜索与验证

当用户提供仓库名或关键词时，使用 gh API 搜索：

```bash
# 精确匹配仓库名（优先在 ArcBlock 和 blocklet 组织搜索）
REPO_NAME="media-kit"
gh repo view "ArcBlock/$REPO_NAME" --json fullName 2>/dev/null || \
gh repo view "blocklet/$REPO_NAME" --json fullName 2>/dev/null || \
echo "未找到仓库"

# 模糊搜索（按更新时间排序）
gh search repos "$KEYWORD" --owner ArcBlock --owner blocklet --sort updated --limit 5 \
  --json fullName,description,updatedAt \
  --jq '.[] | "\(.fullName) - \(.description // "N/A") (updated: \(.updatedAt[:10]))"'
```

**匹配失败**: 使用 AskUserQuestion 显示搜索结果让用户选择。

#### 1.2 Issue URL 处理（重要）

当用户提供 GitHub Issue URL 时，**不能**只解析 URL 提取仓库，**必须**读取 issue 内容：

```bash
# 解析 URL 提取 org/repo/issue_number
gh issue view $ISSUE_NUMBER --repo $ORG/$REPO --json title,body,labels
```

**分析 issue 内容**:
1. 阅读 issue 标题和正文
2. 识别涉及的产品/组件关键词
3. 判断是否涉及多个仓库

**多仓库场景示例**:

| Issue 位置 | Issue 内容关键词 | 实际涉及仓库 |
|------------|------------------|--------------|
| `media-kit` | "Discuss Kit 上传图片触发 2 次" | `media-kit`（uploader）+ `discuss-kit`（调用方） |
| `discuss-kit` | "图片上传组件 onUploadSuccess 异常" | `discuss-kit` + `media-kit`（组件提供方） |
| `blocklet-server` | "DID Connect 登录失败" | `blocklet-server` + `did-connect` |
| `did-spaces` | "PaymentKit 支付回调问题" | `did-spaces` + `paymentkit` |

**判断逻辑**:
- Issue 所在仓库是**主仓库**（问题报告位置）
- Issue 内容提到的其他产品是**关联仓库**（可能需要同时查看）

#### 1.3 多仓库处理

如果识别到多个仓库：

1. **使用 AskUserQuestion 询问用户**:
   - 选项 A: 只克隆主仓库 `{主仓库名}`
   - 选项 B: 同时克隆主仓库和关联仓库 `{主仓库名}` + `{关联仓库名}`
   - 选项 C: 用户指定其他仓库

2. **记录变量**:
   - `PRIMARY_REPO`: 主仓库（issue 所在位置）
   - `RELATED_REPOS`: 关联仓库列表（可能为空）

3. **后续 Phase 2-6 对每个选中的仓库执行**

**匹配失败**: 使用 AskUserQuestion 让用户选择或输入完整 GitHub 路径。

---

### Phase 2: Repo Clone & Permission Check

#### 2.1 检查本地仓库

```bash
REPO_PATH="$HOME/arcblock-repos/$REPO"
[ -d "$REPO_PATH" ] && cd "$REPO_PATH" && git fetch origin
```

#### 2.2 检查 GitHub 权限

```bash
gh api repos/$ORG/$REPO --jq '.permissions'
# 返回: {"admin":true,"push":true,"pull":true}
```

| 权限情况 | 处理 |
|----------|------|
| 无访问权限 | 提示联系管理员或检查 GitHub 登录 |
| 只有 read 权限 | 提示可查看但无法推送，建议 fork |
| 有 push 权限 | 正常继续 |

#### 2.3 克隆仓库

克隆到 `~/arcblock-repos/$REPO`（优先 SSH，失败则 HTTPS）。

#### 2.4 查找 Blocklet 项目

```bash
find . -name "blocklet.yml" -o -name "blocklet.yaml" | grep -v node_modules
```

| 情况 | 处理 |
|------|------|
| 未找到 | 提示不是 blocklet 项目 |
| 找到 1 个 | 自动使用 |
| 找到多个 | AskUserQuestion 让用户选择 |

**记录变量**:
- `REPO_ROOT`: 仓库根目录（依赖安装在这里）
- `BLOCKLET_DIR`: blocklet.yml 所在目录（启动在这里）

#### 2.5 检测开发分支

**重要**: 切换分支前，先检查当前分支是否有未提交的改动：

```bash
git status --porcelain
```

如果有未提交的改动，**必须**使用 AskUserQuestion 询问用户如何处理：
- 选项 A: 暂存改动 (`git stash`)
- 选项 B: 提交改动
- 选项 C: 放弃改动 (`git checkout .`)
- 选项 D: 取消操作

确认无改动或已处理后，再切换分支：

```bash
# 获取最近合并的 PR 的目标分支，统计出现最多的作为开发分支
DEV_BRANCH=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json baseRefName | jq -r '.[].baseRefName' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
git checkout $DEV_BRANCH && git pull origin $DEV_BRANCH
```

**记录变量**:
- `DEV_BRANCH`: 检测到的开发分支名称
- `DEV_BRANCH_REASON`: 分支判断原因（如 "最近 10 个合并 PR 中有 8 个以 main 为目标"）

---

### Phase 3: Prerequisites Check

#### 3.1 Node.js (Required: 22+)

未安装或版本过低时，使用 nvm 安装 Node.js 22。

#### 3.2 pnpm

```bash
corepack enable && corepack prepare pnpm@latest --activate
```

#### 3.3 nginx

必须安装但**不能自启动运行**（Blocklet Server 自己管理）。

#### 3.4 tmux

如果没有 tmux, 帮助用户去安装 tmux, 方便管理终端进程

**macOS**:
```bash
brew install nginx
```

**Ubuntu/Debian**:
```bash
# 必须安装 nginx-extras，包含 ngx_stream_module 等必需模块
sudo apt install -y nginx-extras
sudo systemctl stop nginx
sudo systemctl disable nginx
```

**验证 nginx 模块**:
```bash
nginx -V 2>&1 | grep -o 'with-stream\|http_v2_module\|http_ssl_module'
# 应显示: with-stream, http_v2_module, http_ssl_module
```

**注意**: 普通 `nginx` 包可能缺少 `ngx_stream_module`，会导致 Blocklet Server 启动失败。

#### 3.4 @blocklet/cli

```bash
npm install -g @blocklet/cli@beta
```

版本日期比当前早 1 周以上时更新。

#### 3.5 ulimit Check

**重要**: 必须在启动 Blocklet Server **之前**检查，否则会导致 `worker_connections NaN` 错误。

```bash
ulimit -n  # 不能是 unlimited，建议 >= 10240
ulimit -n 65536  # 临时设置
```

---

### Phase 4: Blocklet Server Setup

Blocklet Server 有两种运行方式，**不能同时运行**：

| 运行方式 | 启动命令 | 检测方法 | 数据目录 |
|----------|----------|----------|----------|
| 生产版本 | `blocklet server start` | `blocklet server status` | `~/blocklet-server-data/` |
| 源码开发 | `bun run start` (在 blocklet-server 仓库) | tmux 会话 `blocklet` | `~/blocklet-server-dev-data/` |

#### 4.0 检查 Blocklet Server 运行状态

**必须同时检查两种运行方式**：

```bash
# 检查方式 1: 生产版本是否在运行
PRODUCTION_RUNNING=false
if blocklet server status 2>/dev/null | grep -q "Running"; then
    PRODUCTION_RUNNING=true
    echo "✅ 检测到 Blocklet Server 生产版本正在运行"
fi

# 检查方式 2: 源码开发版本是否在运行（tmux 会话名为 "blocklet"）
DEV_RUNNING=false
if tmux has-session -t "blocklet" 2>/dev/null; then
    DEV_RUNNING=true
    echo "✅ 检测到 blocklet-server 源码开发版本正在运行 (tmux session: blocklet)"
fi
```

#### 4.1 根据检测结果处理

| 生产版本 | 源码开发 | 处理 |
|----------|----------|------|
| 运行中 | 未运行 | ✅ 直接使用，跳到 Phase 5 |
| 未运行 | 运行中 | ⚠️ 询问用户：停止源码开发并启动生产版本，或直接使用源码开发版本 |
| 未运行 | 未运行 | 需要启动生产版本，继续 4.2 |
| 运行中 | 运行中 | ❌ 异常状态，询问用户停止哪个 |

**源码开发版本运行时的处理**：

使用 `AskUserQuestion` 询问用户：

```
检测到 blocklet-server 源码开发版本正在运行 (tmux session: blocklet)。
源码开发和生产版本不能同时运行。

选项：
A. 停止源码开发，启动生产版本 (Recommended for blocklet dev)
   - 执行: tmux kill-session -t blocklet && blocklet server start
B. 继续使用源码开发版本
   - 需要使用 bn-dev 命令（而非 blocklet dev）
   - 如未配置 bn-dev，将自动创建符号链接
C. 取消操作
```

**停止源码开发版本**：

```bash
tmux kill-session -t "blocklet" 2>/dev/null
# 等待端口释放
sleep 3
```

#### 4.1.1 配置 bn-dev（选择源码开发版本时）

如果用户选择继续使用源码开发版本，需要确保 bn-dev 命令可用：

**检查 bn-dev 是否存在**:
```bash
which bn-dev || echo "bn-dev 未配置"
```

**如果未配置，创建符号链接**:
```bash
# bn-dev 指向 blocklet-server 源码中的 dev.js
BLOCKLET_SERVER_REPO="$HOME/arcblock-repos/blocklet-server"
if [ -f "$BLOCKLET_SERVER_REPO/core/cli/tools/dev.js" ]; then
    sudo ln -sf "$BLOCKLET_SERVER_REPO/core/cli/tools/dev.js" /usr/local/bin/bn-dev
    echo "✅ bn-dev 已配置"
else
    echo "❌ 未找到 blocklet-server 源码，请先使用 blocklet-server-dev-setup skill 克隆仓库"
fi
```

**记录变量**:
- `USE_DEV_SERVER`: 是否使用源码开发版本（true/false）
- `DEV_CMD`: 启动命令（bn-dev 或 blocklet dev）

#### 4.2 初始化（如果需要）

检查 `~/blocklet-server-data/.blocklet-server/config.yml` 是否存在。

```bash
mkdir -p ~/blocklet-server-data && cd ~/blocklet-server-data
blocklet server init --yes --http-port 8080 --https-port 8443
```

#### 4.3 检查端口配置

如果端口不是 8080/8443，修改配置后启动时**必须**使用 `--update-db`。

#### 4.4 启动

```bash
cd ~/blocklet-server-data
ulimit -n 65536 && blocklet server start --update-db
```

**启动失败检查**:
1. `ulimit -n` 不能是 `unlimited`
2. 端口是否为 8080/8443
3. 修改端口后是否用了 `--update-db`
4. 查看日志: `PM2_HOME=~/.arcblock/abtnode pm2 logs abt-node-daemon --lines 50`

---

### Phase 5: Project Dependencies Install

**注意**: 在**仓库根目录**执行。

检测包管理器（按 lock 文件优先级）和项目类型（Makefile > pnpm-workspace > 普通项目）。

```bash
cd $REPO_ROOT
if grep -q "^init:" Makefile 2>/dev/null; then make init
elif grep -q "^dep:" Makefile 2>/dev/null; then make dep
else pnpm install
fi
```

---

### Phase 6: Start Development Server

**注意**: 在 **blocklet.yml 所在目录** 执行。

#### 6.1 检测 tmux 环境并启动

**启动命令选择**（根据 Phase 4 的选择）:

| Server 类型 | 启动命令 | 说明 |
|------------|----------|------|
| 生产版本 | `blocklet dev` | 连接到 `blocklet server start` 启动的 Server |
| 源码开发版本 | `bn-dev` | 连接到源码开发的 Server（tmux session: blocklet） |

**记录变量**:
- `TMUX_SESSION`: 会话名称，格式为 `blocklet-dev-{REPO}`
- `HAS_TMUX`: 是否有 tmux 环境
- `DEV_CMD`: 启动命令（`bn-dev` 或 `blocklet dev`）

| tmux 状态 | 处理 |
|-----------|------|
| 可用 | 在 tmux 会话中启动（先清理同名会话） |
| 不可用 | 直接在当前终端启动 |

```bash
# 根据 Phase 4 的选择确定启动命令
if [ "$USE_DEV_SERVER" = "true" ]; then
    DEV_CMD="bn-dev"
else
    DEV_CMD="blocklet dev"
fi

# 有 tmux 时
TMUX_SESSION="blocklet-dev-$REPO"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -c "$BLOCKLET_DIR" "$DEV_CMD"
```

#### 6.2 测试域名可达性

启动成功后，**必须**测试 DID 域名是否可访问：

```bash
# 测试 IP 域名和 Blocklet DID 域名
curl -sI --connect-timeout 5 "https://{IP_DOMAIN}:8443" 2>/dev/null | head -1
curl -sI --connect-timeout 5 "https://{BLOCKLET_DID_DOMAIN}:8443" 2>/dev/null | head -1
```

| 测试结果 | 输出 |
|----------|------|
| 两个域名都返回 HTTP 状态码 | ✅ 域名访问正常 |
| 任一域名无法访问 | ⚠️ 输出 DNS 修复建议（见 Error Handling） |

#### 6.3 查询最近合并的 PR（如有 GitHub 权限）

如果 Phase 2.2 检测到有 push 权限，查询最近 5 个合并的 PR：

```bash
gh pr list --repo $ORG/$REPO --state merged --limit 5 --json number,title,author,mergedAt,baseRefName \
  --template '{{range .}}#{{.number}} {{.title}} (by @{{.author.login}}, merged to {{.baseRefName}}){{"\n"}}{{end}}'
```

#### 6.4 输出启动信息

```
===== 开发环境已就绪 =====

项目: {项目名称}
仓库: {ORG}/{REPO}
路径: ~/arcblock-repos/{REPO}

===== 工作分支 =====
当前分支: {DEV_BRANCH}
判断原因: {DEV_BRANCH_REASON}
  （例如：最近 10 个合并 PR 中有 8 个以 main 为目标，因此判定 main 为主开发分支）

===== 访问地址 =====
Blocklet Server Admin: https://{IP_DOMAIN}:8443/.well-known/server/admin/
Blocklet URL: https://{BLOCKLET_DID_DOMAIN}:8443

{根据 6.2 测试结果}
✅ 域名访问正常
或
⚠️ DID 域名无法访问，请将 DNS 设置为 8.8.8.8:
   macOS: sudo networksetup -setdnsservers Wi-Fi 8.8.8.8 1.1.1.1

===== 最近合并的 PR =====
{如有 GitHub 权限，列出最近 5 个合并的 PR}
#123 Fix login issue (by @author, merged to main)
#122 Add new feature (by @author, merged to main)
...

===== PR 提交规范 =====
根据上述 PR 风格，请遵循以下规范：
1. 分支命名: feat/xxx, fix/xxx, chore/xxx
2. PR 标题格式: 动词开头，简洁描述变更（如 "Fix login redirect issue"）
3. PR 目标分支: {DEV_BRANCH}
4. 提交前请确保: 代码通过 lint、测试通过、功能自测

===== 常用命令 =====
{如果使用 tmux 启动}
  - 查看 blocklet dev 输出: tmux attach -t {TMUX_SESSION}
  - 在其他终端查看日志: tmux capture-pane -t {TMUX_SESSION} -p | tail -50
  - 停止 blocklet dev: tmux kill-session -t {TMUX_SESSION}
  - 列出所有 tmux 会话: tmux ls

{如果未使用 tmux}
  - 停止 blocklet dev: Ctrl+C

{通用命令}
  - 停止 Blocklet Server: blocklet server stop -f
  - 查看 Server PM2 进程: PM2_HOME=~/.arcblock/abtnode pm2 list
  - 查看 Server PM2 日志: PM2_HOME=~/.arcblock/abtnode pm2 logs abt-node-daemon --lines 100

===== 版本更新指引 =====
完成开发后，使用 blocklet-updater skill 创建新版本：
  1. blocklet version patch  # 升级版本号
  2. pnpm install && pnpm run build  # 安装依赖并构建
  3. blocklet meta  # 验证元数据
  4. blocklet bundle --create-release  # 创建发布包

详细说明请参考: ~/arcblock-repos/agent-skills/plugins/blocklet/skills/blocklet-updater/SKILL.md

===== 接下来 =====
开发环境已处于 live 状态，您可以：
- 描述您要修改的功能
- 粘贴需要修复的 bug 详情
```

---

## Error Handling

| 错误 | 处理 |
|------|------|
| 无法识别仓库 | 显示仓库列表让用户选择 |
| GitHub 权限不足 | 提示联系管理员或 fork |
| 不是 blocklet 项目 | 提示没有 blocklet.yml |
| Blocklet Server 启动失败 | 检查 ulimit、端口、--update-db |
| nginx `worker_connections NaN` | 设置 `ulimit -n 65536` |
| DID 域名无法访问 | DNS 配置为 8.8.8.8（见下方） |

### DID 域名无法访问

**症状**: 浏览器无法访问 `*.did.abtnet.io` 或 `*.ip.abtnet.io`

**诊断**:
```bash
nslookup 192-168-1-80.ip.abtnet.io        # 本地 DNS
nslookup 192-168-1-80.ip.abtnet.io 8.8.8.8  # Google DNS
```

**解决**: 更换 DNS
```bash
# macOS
sudo networksetup -setdnsservers Wi-Fi 8.8.8.8 1.1.1.1
```

---

## 停止 Blocklet Dev 进程

```bash
# 停止单个项目
tmux kill-session -t "blocklet-dev-$REPO"

# 完全清理（停止所有 blocklet-dev 会话 + Server）
tmux ls 2>/dev/null | grep "^blocklet-dev-" | cut -d: -f1 | xargs -I {} tmux kill-session -t {}
blocklet server stop -f
```

---

### Phase 7: 工作分支创建

当用户带着具体任务（Issue URL、问题描述）启动开发环境时，询问是否创建工作分支。

**触发条件**：用户提供了 Issue URL 或具体任务描述
**跳过条件**：用户仅要求创建环境，没有具体任务

#### 7.1 询问是否创建工作分支

使用 `AskUserQuestion`：

```
当前在 {DEV_BRANCH} 分支上。是否需要创建工作分支？

选项：
A. 创建分支: {建议的分支名} (Recommended)
B. 使用其他分支名
C. 不创建，直接在 {DEV_BRANCH} 上开发
```

**分支命名规则**：

| 任务类型 | 分支前缀 | 示例 |
|----------|----------|------|
| Bug 修复 | `fix/` | `fix/issue-123-duplicate-upload` |
| 新功能 | `feat/` | `feat/video-preview` |
| 重构/优化 | `refactor/` | `refactor/image-loading` |

#### 7.2 创建分支（如用户确认）

基于 `$DEV_BRANCH` 创建新分支并切换。
#### 7.3 输出就绪信息

```
===== 开发环境已就绪 =====

仓库: ~/arcblock-repos/{REPO}
分支: {BRANCH_NAME} (基于 {DEV_BRANCH})
服务: blocklet dev 已在 tmux 会话 {TMUX_SESSION} 中运行

访问地址:
- Blocklet Server Admin: https://{IP_DOMAIN}:8443/.well-known/server/admin/
- Blocklet URL: https://{BLOCKLET_DID_DOMAIN}:8443

常用命令:
- 查看日志: tmux attach -t {TMUX_SESSION}
- 停止服务: tmux kill-session -t {TMUX_SESSION}
```

---

## Skill 持续改进

详见 `references/skill-contribution.md`。

