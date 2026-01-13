# ALP (Active Loading Policy) 使用指南

## 什么是 ALP

ALP 是我们自己设计的一套上下文管理模式，用于解决 AI 助手在工作时"该加载什么知识"的问题。

传统方式是把所有文档一股脑塞给 AI，导致 token 浪费、响应变慢、重点模糊。ALP 的思路不同：**不预加载，按需触发**。我们在 `claude.md` 中定义一张规则表，告诉 Claude "当讨论 X 话题时，去加载 Y 文件"。Claude 在对话过程中自动判断当前话题，匹配规则，只加载真正需要的上下文。

这不是 Claude Code 的官方功能，而是我们利用 Claude 的指令遵循能力设计的工程模式。核心很简单：一张触发规则表 + 每个目录一个高密度 README。设置一次，长期受益。

目前 ALP 已经集成到 `arcblock-context` 插件中。公司的产品知识、技术架构、战略方向都通过这套机制按需加载。团队成员安装插件后自动生效，不需要自己配置公司知识的加载规则。如果有个人知识需要管理，可以参考本文档在自己的 `~/.claude/CLAUDE.md` 中添加规则。

## ALP 工作原理

1. Claude 读取 `claude.md` 中的 ALP 规则表
2. 在对话过程中，Claude 判断当前话题
3. 如果话题匹配某个触发条件，Claude 加载对应文件
4. 加载后的内容成为对话上下文

## 如何设置 ALP

### Step 1: 确定你的知识文件结构

```
~/.claude/
├── profile/           # 个人画像
├── products/          # 产品知识（如果不用插件）
├── technical/         # 技术知识（如果不用插件）
└── your-domain/       # 你自己的领域知识
```

### Step 2: 在 claude.md 中添加 ALP 规则

在 `~/.claude/CLAUDE.md` 或项目的 `CLAUDE.md` 中添加：

```markdown
## Active Loading Policy (ALP)

> 控制何时加载文件。默认不加载，按需触发。

| 触发场景 | 加载文件 |
|---------|---------|
| 讨论 X 产品 | `products/x.md` |
| 讨论 Y 技术 | `technical/y.md` |
| 需要个人背景 | `profile/background.md` |
| 写博客/文章 | `content-profile/writing-style.md` |

**不主动加载（除非明确要求）：**
- `profile/private-notes.md`
- 其他敏感或不常用文件

**不确定时的策略：**
1. 先读 README 获取摘要
2. 根据摘要判断是否需要加载具体文件
```

### Step 3: 为每个目录创建 README

README 是 ALP 的关键 - 提供高密度摘要，帮助 Claude 快速判断。

```markdown
# Products README

## 高密度版本

ProductA: 一句话描述
ProductB: 一句话描述
ProductC: 一句话描述

## 文件索引

| 产品 | 文件 | 说明 |
|------|------|------|
| ProductA | productA.md | 详细描述 |
| ProductB | productB.md | 详细描述 |
```

## ALP 规则表模板

### 个人知识库

```markdown
## Active Loading Policy (ALP)

| 触发场景 | 加载文件 |
|---------|---------|
| **Profile** | |
| 工程/架构决策 | `profile/engineering-insights.md` |
| 评估提案、方法论 | `profile/worldview.md` |
| 个人背景相关 | `profile/background.md` |
| **Content Creation** | |
| 写博客、文章 | `content-profile/writing-style.md` |
| 发表观点 | `content-profile/opinions.md` |
```

### 项目知识库

```markdown
## Active Loading Policy (ALP)

| 触发场景 | 加载文件 |
|---------|---------|
| **Architecture** | |
| 系统架构讨论 | `docs/architecture.md` |
| API 设计 | `docs/api-design.md` |
| **Development** | |
| 代码规范问题 | `docs/code-style.md` |
| 测试相关 | `docs/testing.md` |
| **Deployment** | |
| 部署问题 | `docs/deployment.md` |
| 环境配置 | `docs/environments.md` |
```

### 团队知识库

```markdown
## Active Loading Policy (ALP)

| 触发场景 | 加载文件 |
|---------|---------|
| **Products** | |
| 涉及产品全局 | `products/README.md` |
| 涉及具体产品 X | `products/x.md` |
| **Technical** | |
| 涉及技术全局 | `technical/README.md` |
| 涉及具体技术 Y | `technical/y.md` |
| **Process** | |
| 开发流程问题 | `process/development.md` |
| 发布流程问题 | `process/release.md` |
```

## 最佳实践

### 1. README 是核心

```
好的 README = Claude 能快速判断 = ALP 高效工作
差的 README = Claude 需要猜测 = 加载错误或遗漏
```

### 2. 触发条件要具体

```markdown
# 好
| 涉及 AFS 文件系统 | `technical/afs.md` |

# 差
| 涉及技术 | `technical/*.md` |
```

### 3. 分层加载

```markdown
# 不确定时的策略
1. 先读 README 获取高密度摘要
2. 根据摘要判断是否需要加载具体文件
3. 不确定时先给通用回答，再询问是否需要详细上下文
```

### 4. 明确排除敏感文件

```markdown
**不主动加载（除非明确要求）：**
- `profile/salary.md`
- `private/credentials.md`
- 任何包含敏感信息的文件
```

### 5. 使用插件处理公共知识

```
个人知识 → ~/.claude/CLAUDE.md 中的 ALP
公司知识 → arcblock-context 插件（已配置好 ALP）
项目知识 → 项目 CLAUDE.md 中的 ALP
```

## 与 arcblock-context 插件的关系

`arcblock-context` 插件已经内置了公司知识的 ALP 配置：

```
插件的 .claude-plugin/claude.md → 定义公司产品/技术的 ALP
你的 ~/.claude/CLAUDE.md → 定义个人知识的 ALP
项目的 CLAUDE.md → 定义项目特定知识的 ALP
```

三者互不冲突，各司其职。

## 常见问题

### Q: ALP 规则没生效？

检查：
1. `claude.md` 文件位置是否正确
2. 规则表格式是否正确（Markdown 表格）
3. 文件路径是否正确

### Q: Claude 加载了错误的文件？

优化触发条件，让它更具体：
```markdown
# 改进前
| 涉及身份 | `technical/did.md` |

# 改进后
| 涉及 DID 身份验证、VC 凭证 | `technical/did-capability.md` |
```

### Q: 如何验证 ALP 是否工作？

问 Claude："你现在加载了哪些上下文文件？"

### Q: 文件太多怎么办？

1. 合并相关文件
2. 创建更好的 README 摘要
3. 使用分层结构（先 README，再具体文件）

## 总结

```
ALP = claude.md 中的规则表 + 每个目录的 README

设置一次，长期受益。
```
