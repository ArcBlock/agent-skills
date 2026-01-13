# ArcBlock Agent Skills

[English](README.md)

ArcBlock 团队构建的 Claude Code 插件和 Agent 技能集合，用于增强 AI 辅助的工程工作流。

## 理念

我们信奉 **AI 原生工程** - 把 AI 视为软件开发中的一等公民协作者。这些插件编码了团队积累的知识、工作流程和最佳实践，让它们能够按需提供给 Claude。

核心原则：
- **按需加载上下文**：使用 ALP（Active Loading Policy）在相关时加载知识，而不是一次性全部加载
- **共享知识，个人覆盖**：团队知识作为插件默认值，同时支持个人/项目定制
- **采访式创作**：内容创作时 AI 通过提问获取信息，而不是盲目生成

## 快速开始

```bash
# 启动 Claude Code
claude

# 添加 ArcBlock marketplace
/plugin marketplace add git@github.com:ArcBlock/agent-skills.git

# 列出可用插件
/plugin list arcblock-agent-skills

# 安装需要的插件
/plugin install arcblock-context@arcblock-agent-skills
/plugin install content-creation@arcblock-agent-skills
```

## 可用插件

### 核心知识

| 插件 | 描述 |
|-----|------|
| **arcblock-context** | 公司知识库（产品、技术架构、战略）。通过 ALP 按需加载上下文。使用 `/arcblock-context` 探索。|

### 工程工作流

| 插件 | 描述 |
|-----|------|
| **devflow** | 开发者工作流自动化：代码审查、Pull Request、日常工程任务 |
| **blocklet** | 将 Web 项目转换为 ArcBlock Blocklet 并管理发布 |
| **thinking-framework** | 技术思考框架和提案评审方法论（AFS/AINE）|
| **plugin-development** | 创建、验证和分发 Claude Code 插件 |
| **aigne** | 使用 AIGNE Framework CLI 构建 AI Agent 的开发指南。涵盖 Agent 类型、技能、工作流和项目配置。|

### 内容创作

| 插件 | 描述 |
|-----|------|
| **content-creation** | AI 采访式写作系统。通过结构化采访，以你的风格创作博客和社交媒体内容。使用 `/interview-writer`。|

## 团队集成

在项目的 `.claude/settings.json` 中添加以下配置，自动获取访问权限：

```json
{
  "extraKnownMarketplaces": {
    "arcblock-agent-skills": {
      "source": {
        "source": "github",
        "repo": "ArcBlock/agent-skills"
      }
    }
  }
}
```

## 理解 ALP

ALP（Active Loading Policy）是我们设计的上下文管理模式。不是预先加载所有知识，而是定义显式规则，根据对话话题决定 Claude 应该加载什么。

好处：
- 更低的 token 消耗（只加载需要的）
- 更快的响应（更少的上下文需要处理）
- 更聚焦的输出（注意力不被稀释）

详见 [docs/alp-guide.md](plugins/arcblock-context/docs/alp-guide.md) 完整指南。

## 覆盖机制

插件支持三级优先级链：

1. **项目覆盖**: `./.claude/arcblock-context/` - 项目特定定制
2. **用户覆盖**: `~/.claude/arcblock-context/` - 个人定制
3. **插件默认**: 团队共享知识

这让团队可以维护权威文档，同时个人可以根据需要扩展或定制。

## 贡献

1. Fork 仓库
2. 在 `plugins/` 下创建你的插件
3. 使用 `/plugin-development:validate` 检查结构
4. 提交 Pull Request

## 许可证

MIT License - 详见 [LICENSE](LICENSE)。
