# 在 Kimi Code CLI 中使用 ArcBlock Agent Skills

除了 Claude Code，本仓库中的 **Agent Skills** 也可以在 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli) 中使用。本文档说明哪些功能可用、哪些不可用，以及如何进行配置。

> **注意：** 本项目主要为 Claude Code 设计。对 Kimi 的支持仅覆盖 Agent Skills 部分，且为尽力而为。

## Kimi 中可用的内容

Kimi Code CLI 支持开放的 [Agent Skills](https://agentskills.io/) 格式，会自动从 `.claude/skills/` 目录中发现 `SKILL.md` 文件。本仓库中以下技能可以在 Kimi 中使用：

| 技能 | 描述 |
|------|------|
| **commit** | 按照 Conventional Commits 规范生成标准化的提交信息。 |
| **pull-request** | 根据分支差异生成标准化的 Pull Request，可通过 `gh` 提交或保存为 `PR.md`。 |
| **simple-skills-manager** | 从本地路径或 Git 仓库管理技能。 |

## Kimi 中**不可用**的内容

[`plugins/`](../plugins/) 目录下的 **Claude Code 插件**与 Kimi **不兼容**，因为它们依赖 Claude 特有的机制：

- `.claude-plugin/plugin.json` 插件清单
- Claude Code 的 `/plugin` 市场和斜杠命令
- Hooks（`hooks/hooks.json`）
- Claude 专用的命令文件

因此，以下插件在 Kimi 中无法使用：

- `arcblock-context`
- `agentloop`
- `blocklet`
- `content-creation`
- `thinking-framework`
- `plugin-development`

如果你需要在 Kimi 中使用 ArcBlock 的公司知识或基于插件的工作流，需要手动将相关的 `SKILL.md` 风格内容迁移过去。

## 在 Kimi 中安装技能

### 方式一：安装到用户级技能目录（推荐）

将本仓库的 `.claude/skills/` 文件夹复制到你的用户级 Kimi/Claude 技能目录：

```bash
# 克隆仓库
git clone https://github.com/ArcBlock/agent-skills.git

# 安装技能到用户目录
mkdir -p ~/.claude/skills
cp -R agent-skills/.claude/skills/* ~/.claude/skills/
```

重启 Kimi Code CLI，然后询问：

```
What skills are available?
```

### 方式二：作为项目级技能安装

如果你只想在特定项目中使用这些技能，可以将它们复制到该项目中：

```bash
mkdir -p /path/to/your/project/.claude/skills
cp -R agent-skills/.claude/skills/* /path/to/your/project/.claude/skills/
```

在该项目内运行 `kimi` 时，项目级技能会自动加载。

### 方式三：使用 `--skills-dir` 指向仓库

快速测试时，可以用额外技能目录启动 Kimi：

```bash
kimi --skills-dir /path/to/agent-skills/.claude/skills
```

如需持久化，可在 Kimi 配置中添加：

```toml
extra_skill_dirs = [
    "/path/to/agent-skills/.claude/skills",
]
```

## 使用技能

安装完成后，Kimi 会自动发现这些技能。你可以通过描述需求来隐式调用：

```
为我已经暂存的改动生成一条提交信息。
```

也可以通过斜杠命令显式加载：

```
/skill:commit
/skill:pull-request
/skill:simple-skills-manager
```

## 已知差异与限制

| 特性 | Claude Code | Kimi Code CLI |
|------|-------------|---------------|
| 技能发现 | `~/.claude/skills/`、`.claude/skills/` | `~/.claude/skills/`、`.claude/skills/` 等 ✅ |
| `allowed-tools` 前置元数据 | 生效 | 不支持；Kimi 会按常规流程请求工具权限 ⚠️ |
| 指令中的 shell 工具名 | `Bash` | `Shell`；指令仍可正常工作，AI 会自行适配 ✅ |
| 插件市场（`/plugin`） | 支持 | 不支持 ❌ |
| 输出中的 Claude 品牌标识 | 正常 | 仅影响文案；可能会看到 "Generated with Claude Code" 或 "Co-Authored-By: Claude" ⚠️ |

### 关于 `allowed-tools`

这些技能使用了 Claude 特有的 `allowed-tools` 前置元数据字段（例如 `Bash`）。Kimi 不识别该字段，因此不会预先授权工具。技能指令本身仍然有效，但 Kimi 在执行命令前可能会向你请求权限。

### 关于 Claude 品牌标识

部分生成内容（提交信息、PR 正文）包含 Claude Code 相关文案。这些只是普通文本，不影响在 Kimi 中的功能。如果你介意，可以在提交或发送前编辑生成的内容。

## 获取帮助

关于 Kimi 的技能行为，请参阅 [Kimi Code CLI 技能文档](https://moonshotai.github.io/kimi-cli/zh/customization/skills.md)。

关于原始技能的问题，请在 [ArcBlock/agent-skills](https://github.com/ArcBlock/agent-skills) 仓库提交 Issue。
