# 在 Kimi Code CLI 中使用 ArcBlock Agent Skills

本仓库包含两类内容：

- `.claude/skills/` 中的 **Agent Skills** —— 采用开放格式，Kimi Code CLI 可以直接使用。
- `plugins/` 中的 **Claude Code 插件** —— 依赖 `/plugin` 市场、Hooks、斜杠命令和插件清单文件，是 Claude 专用功能。

本文档说明如何配合 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli) 使用本项目：哪些功能开箱即用、哪些可以低成本迁移、哪些不兼容。

> **注意：** 本项目主要为 Claude Code 设计。对 Kimi 的支持为尽力而为。

## 快速开始

最快的使用方式是将本仓库的 `.claude/skills/` 目录复制到用户技能目录：

```bash
git clone https://github.com/ArcBlock/agent-skills.git
mkdir -p ~/.claude/skills
cp -R agent-skills/.claude/skills/* ~/.claude/skills/
```

重启 Kimi Code CLI，然后运行：

```
/skill:commit
```

或询问：

```
What skills are available?
```

## 开箱即用的技能

Kimi Code CLI 会从 `.claude/skills/` 目录（项目级和用户级）自动发现技能。本仓库中以下技能无需修改即可使用：

| 技能 | 描述 |
|------|------|
| **commit** | 按照 Conventional Commits 规范生成标准化的提交信息。 |
| **pull-request** | 根据分支差异生成标准化的 Pull Request，可通过 `gh` 提交或保存为 `PR.md`。 |
| **simple-skills-manager** | 从本地路径或 Git 仓库安装、更新、移除技能组。 |

这些技能都是纯 `SKILL.md` 文件，使用标准 Markdown 指令，不依赖 Claude 插件基础设施。

## 可以迁移到 Kimi 的技能

许多 Claude 插件在 `plugins/<插件名>/skills/<技能名>/SKILL.md` 下也打包了标准 Agent Skills。这些技能同样是普通 `SKILL.md` 文件，经过少量调整即可复制到 Kimi 可识别的技能目录中使用。

以下插件内嵌技能是较好的迁移候选：

| 插件 | 内嵌技能 | 迁移说明 |
|------|---------|---------|
| **arcblock-context** | `arcblock-context` | 加载公司知识库（产品、技术架构、战略）。去掉 `/arcblock-context` 斜杠命令用法，改用 `/skill:arcblock-context` 或自然语言调用。 |
| **thinking-framework** | `what-robert-thinks` | 提案评审框架。可作为独立技能使用，无插件依赖。 |
| **content-creation** | `interview-writer` | 采访式写作系统。使用 `~/.claude/content-profile/` 保存用户画像，该路径在 Kimi 中可用，因为 Kimi 会读取 `.claude/` 目录。 |
| **plugin-development** | `plugin-authoring` | 创建 Claude 插件的指南。对跨工具的技能编写也有参考价值，部分示例为 Claude 专用。 |
| **agentloop** | `verification`、`issue-sweep`、`issue-review`、`pr-sweep`、`pr-review`、`design-review`、`build-phases`、`issue-graph`、`impact-check` 等 | 多数为流程指令类技能，迁移较容易；依赖 agentloop 引擎、仓库配置或 fleet 基础设施的技能需要更多调整。 |
| **blocklet** | `blocklet-getting-started`、`blocklet-dev-setup`、`blocklet-server-dev-setup`、`blocklet-branch`、`blocklet-pr`、`blocklet-converter`、`blocklet-updater`、`blocklet-url-analyzer` | 如果你使用 Blocklet，这些技能很有用。许多指令调用 Blocklet CLI 和 tmux，是工具无关的，但部分流程步骤假设了插件路径。 |

### 如何迁移插件内嵌技能

1. 定位技能：

   ```bash
   ls plugins/<插件名>/skills/
   ```

2. 将技能目录复制到 Kimi 技能目录：

   ```bash
   mkdir -p ~/.claude/skills/
   cp -R plugins/<插件名>/skills/<技能名> ~/.claude/skills/<插件名>-<技能名>
   ```

   > 建议使用带前缀的名称（如 `arcblock-context`、`thinking-what-robert-thinks`），避免与其他技能冲突。

3. 编辑复制后的 `SKILL.md`，做以下调整：
   - 将 `/arcblock-context` 等 Claude 斜杠命令替换为 `/skill:<name>` 或自然语言调用。
   - 删除或改写对 Claude 插件路径的引用（如插件安装位置）。
   - `allowed-tools` 前置元数据可以删除或保留；Kimi 会安全地忽略它。
   - 如果技能会从插件目录加载参考文件，请更新相对路径，或将参考文件一并复制到技能旁边。

4. 重启 Kimi Code CLI 并测试：

   ```
   /skill:<name>
   ```

## Kimi 中**不可用**的内容

以下 Claude Code 特性在 Kimi 中没有对应实现，无法使用：

- **插件市场**（`/plugin marketplace add ...`、`/plugin install ...`）
- **插件清单**（`.claude-plugin/plugin.json`）
- **Hooks**（`hooks/hooks.json`）
- **斜杠命令文件**（`commands/*.md`）
- **Agent 定义文件**（`agents/*.md`）
- **插件打包与验证工作流**

以下插件依赖上述基础设施，因此不迁移的话无法在 Kimi 中使用：

- `arcblock-context`（插件外壳；知识库技能可以迁移）
- `agentloop`（引擎；单独的指令类技能可以迁移）
- `blocklet`（插件外壳；单独技能可以迁移）
- `content-creation`（插件外壳；`interview-writer` 技能可以迁移）
- `thinking-framework`（插件外壳；`what-robert-thinks` 技能可以迁移）
- `plugin-development`（插件外壳；`plugin-authoring` 技能可以迁移）

## 技能就绪情况矩阵

| 技能 / 插件 | 位置 | 是否可在 Kimi 使用 | 说明 |
|------------|------|------------------|------|
| `commit` | `.claude/skills/commit/` | ✅ 是 | 功能完整。 |
| `pull-request` | `.claude/skills/pull-request/` | ✅ 是 | `gh` CLI 提交流程可用；PR 正文可能包含 Claude Code 字样。 |
| `simple-skills-manager` | `.claude/skills/simple-skills-manager/` | ✅ 是 | 可用于管理本地或 Git 来源的技能；使用 Kimi 也能读取的 `.claude/` 目录。 |
| `arcblock-context` | `plugins/arcblock-context/skills/arcblock-context/` | ⚠️ 需迁移 | 将技能及知识文件复制到 `.claude/skills/`。 |
| `interview-writer` | `plugins/content-creation/skills/interview-writer/` | ⚠️ 需迁移 | 复制技能及 `references/` 文件；`~/.claude/content-profile/` 在 Kimi 中可用。 |
| `what-robert-thinks` | `plugins/thinking-framework/skills/what-robert-thinks/` | ⚠️ 需迁移 | 复制技能即可，无外部依赖。 |
| `plugin-authoring` | `plugins/plugin-development/skills/plugin-authoring/` | ⚠️ 需迁移 | 部分示例引用 Claude 专用插件特性。 |
| `agentloop` 技能 | `plugins/agentloop/skills/*/` | ⚠️ 部分 | 指令类技能容易迁移；依赖引擎的技能需要脚本/配置。 |
| `blocklet` 技能 | `plugins/blocklet/skills/*/` | ⚠️ 部分 | 使用 Blocklet 时有用；部分步骤假设插件路径。 |
| 插件外壳 / 市场 | `.claude-plugin/`、`plugins/*/.claude-plugin/` | ❌ 否 | Claude 专用基础设施。 |

## 安装方式

### 方式一：用户级技能（推荐）

将可移植技能复制到 `~/.claude/skills/`，使其在所有项目中可用：

```bash
mkdir -p ~/.claude/skills
cp -R agent-skills/.claude/skills/* ~/.claude/skills/
```

如需同时迁移某个插件内嵌技能：

```bash
cp -R agent-skills/plugins/arcblock-context/skills/arcblock-context \
  ~/.claude/skills/arcblock-context
```

### 方式二：项目级技能

将技能复制到特定项目：

```bash
mkdir -p /path/to/project/.claude/skills
cp -R agent-skills/.claude/skills/* /path/to/project/.claude/skills/
```

在该项目内运行 `kimi` 时，项目级技能会自动加载。

### 方式三：使用 simple-skills-manager

使用仓库自带的 `simple-skills-manager` 技能，从 Git 仓库同步技能：

```
/skill:simple-skills-manager
```

然后提供仓库地址和组名。管理器会在 `~/.claude/skills/` 中创建指向源文件的 tip 文件，方便后续更新。

### 方式四：`--skills-dir` 参数

快速测试时，可直接指定技能目录：

```bash
kimi --skills-dir /path/to/agent-skills/.claude/skills
```

如需持久化，在 Kimi 配置中添加：

```toml
extra_skill_dirs = [
    "/path/to/agent-skills/.claude/skills",
]
```

## 在 Kimi 中使用技能

Kimi 会自动发现技能。你可以通过描述需求隐式调用：

```
为我已经暂存的改动生成一条提交信息。
```

也可以显式加载：

```
/skill:commit
/skill:pull-request
/skill:simple-skills-manager
```

对于迁移后的插件技能：

```
/skill:arcblock-context
/skill:what-robert-thinks
/skill:interview-writer
```

## 已知限制

| 特性 | Claude Code | Kimi Code CLI |
|------|-------------|---------------|
| 技能发现 | `~/.claude/skills/`、`.claude/skills/` | `~/.claude/skills/`、`.claude/skills/` 等 ✅ |
| `allowed-tools` 前置元数据 | 生效 | 被忽略 ⚠️ |
| 指令中的 shell 工具名 | `Bash` | `Shell`；AI 会自行适配 ✅ |
| 插件市场 | `/plugin ...` | 不支持 ❌ |
| 斜杠命令 | `/command` | 使用 `/skill:<name>` 或自然语言 ⚠️ |
| `~/.claude/content-profile/` 等画像路径 | 支持 | 支持（Kimi 读取 `.claude/` 目录）✅ |
| 输出中的 Claude 品牌标识 | 正常 | 仅影响文案 ⚠️ |

### `allowed-tools`

本仓库的技能使用了 Claude 特有的 `allowed-tools` 前置元数据字段（例如 `Bash`）。Kimi 不识别该字段，因此会按常规流程请求工具权限。技能指令本身仍然有效。

### Claude 品牌标识

部分生成内容（提交信息、PR 正文）包含 Claude Code 相关文案。这些只是普通文本，不影响功能。你可以在提交或发送前编辑生成的内容。

### 斜杠命令

像 `arcblock-context` 这样的技能文档中使用了 Claude 斜杠命令（`/arcblock-context <topic>`）。在 Kimi 中，请使用 `/skill:arcblock-context` 或直接描述需求，例如：

```
加载 ArcBlock AFS 的技术上下文。
```

## 保持 Kimi 环境同步

当本仓库向 `.claude/skills/` 添加新技能时，更新本地副本：

```bash
cd agent-skills
git pull
cp -R .claude/skills/* ~/.claude/skills/
```

如果你使用了 `simple-skills-manager`，运行更新流程即可从仓库重新同步。

## 获取帮助

- Kimi 相关行为：[Kimi Code CLI 技能文档](https://moonshotai.github.io/kimi-cli/zh/customization/skills.md)
- 原始技能与插件问题：[ArcBlock/agent-skills issues](https://github.com/ArcBlock/agent-skills/issues)
