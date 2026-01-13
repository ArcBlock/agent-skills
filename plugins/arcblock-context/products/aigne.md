# AIGNE

> **状态**：产品思路阶段，以下为设计思考，非既定事实

## 名称与含义

**发音**：[ ˈei dʒən ] — 像 "agent" 去掉 "t"

**来源**：
- Aigne 是法国南部的一个中世纪小村庄
- 在古爱尔兰语中，aigne 意为 "spirit"（灵魂）— 完美隐喻能思考和行动的 agent

**缩写**：
> **AIGNE** = **A**I **G**enesis **N**ative **E**ngineering
>
> 一种开放的工程范式，用于构建从诞生起就遵循 AI-native 规则、由自主 agent 赋予生命的系统

---

## 一句话定位

**让相当多的任务完全交给 AI 实现的软件工程框架**

---

## AIGNE Framework

AIGNE Framework 是一个函数式 AI 应用开发框架，旨在简化和加速现代应用的构建过程。结合函数式编程特性、强大的 AI 能力和模块化设计原则。与 Blocklet 生态深度集成。

### 核心特性

| 特性 | 说明 |
|------|------|
| **模块化设计** | 清晰的模块结构，易于组织代码、提高效率、简化维护 |
| **TypeScript 支持** | 完整的类型定义，类型安全 |
| **多 AI 模型支持** | 内置 OpenAI、Gemini、Claude、Nova 等，可扩展 |
| **灵活工作流模式** | 支持 sequential、concurrent、routing、handoff 等 |
| **AFS 集成** | 虚拟文件系统抽象，统一访问本地文件、对话历史、用户 profile |
| **MCP 协议集成** | 通过 Model Context Protocol 与外部系统无缝集成 |
| **代码执行能力** | 在安全沙箱中执行动态生成的代码 |
| **Blocklet 生态集成** | 一站式开发部署方案 |

### 工作流模式

| 模式 | 用途 |
|------|------|
| **Sequential** | 多步骤任务，需按特定顺序执行（内容生成管线、多阶段数据处理） |
| **Concurrency** | 并行处理多个独立任务（并行数据分析、多维内容评估） |
| **Router** | 根据输入内容类型路由到不同处理器（智能客服、多功能助手） |
| **Handoff** | 不同专业 agent 之间的控制转移（专家协作系统） |
| **Reflection** | 自我评估和迭代改进输出质量（代码审查、内容质量控制） |
| **Orchestration** | 协调多个 agent 在复杂管线中协作 |
| **Code Execution** | 在沙箱中安全执行动态生成的代码（自动化数据分析） |
| **Group Chat** | 多 agent 群聊环境中的消息共享和交互 |

### AFS (Agentic File System)

为 AI agent 提供统一接口访问各种存储后端的虚拟文件系统抽象。

**特性**：
- Virtual File System：基于路径访问多种数据源
- Pluggable Modules：可扩展自定义存储后端
- Automatic Tool Registration：AI agent 自动获得文件系统能力
- Persistent Storage：基于 SQLite 的存储和自动迁移
- Conversation Memory：内置历史跟踪和用户 profile 管理

**模块**：
- `afs/core` - 核心实现 + history 模块
- `afs/local-fs` - 本地文件系统模块
- `afs/user-profile-memory` - 用户 profile 记忆模块

### MCP 支持

内置 MCP 支持，可以：
- 运行自己的 MCP Server
- 无缝集成外部 MCP Server（Puppeteer、SQLite、GitHub 等）

### 支持的模型

OpenAI、Anthropic (Claude)、Gemini、Nova (Bedrock)、DeepSeek、Ollama、OpenRouter、XAI

### 包结构

| 包 | 说明 |
|---|------|
| `@aigne/core` | 核心包，构建 AIGNE 应用的基础 |
| `@aigne/agent-library` | Agent 库，提供各种专业化 agent |
| `@aigne/cli` | CLI 工具，项目管理和部署 |
| `@aigne/afs` | Agentic File System |
| `@aigne/models/*` | 各模型实现 |

---

## 设计思路（思考阶段）

### 1. 函数隔离的软件框架和运行时

**语言**：TypeScript

**设计原则**：
- 按函数隔离 → 可按函数加载和运行，不干扰其他部分
- 非常容易实现 unit test
- **目标**：让 LLM 聚焦于足够明确简单的任务，不触碰函数外的东西

### 2. AI 原生的 Scaffold 工具

**类比**：类似各种支持 scaffold 的框架，但这是给 AI 用的，不是人用的

**特点**：
- Scaffold 的产生 = 软件 high-level 的实现（全自动的 mock）
- 始终能持续集成
- 整个软件是 functional 的，对 AI 友好

### 3. 采用 AFS 来组合

- Scaffold 结构 = AFS 结构
- 一个 package/函数 = 一个 folder（受 Java 设计启发）
- 函数的组合由 scaffold 根据 folder 结构和 metadata 全自动实现

---

## 设计洞察（待验证）

```
传统 Scaffold：人类用来生成代码骨架
AI Scaffold：AI 用来理解和填充代码

传统软件：模块隔离
AI-native 软件：函数隔离（更细粒度，对 LLM 更友好）
```

---

## 开源状态

| 项目 | 状态 |
|------|------|
| **开源** | 已开源 |
| **仓库** | https://github.com/AIGNE-io/aigne-framework |
| **许可证** | Elastic Search License（类似 Elastic，防止云厂商直接托管服务） |
| **定位** | 内部使用 + 开源 |

## 与 Blocklet 的关系

**双向集成**：
- AIGNE 应用可以打包成 Blocklet 部署
- Blocklet 可以内嵌 AIGNE Framework

## aigne-cli

| 项目 | 状态 |
|------|------|
| **发布状态** | 已发布（npm 可安装） |
| **功能** | 开发 + 运行一体的 CLI 工具 |

**核心功能**：
- 创建、测试、部署 Agent
- 本地运行 Agent
- 项目管理

## aigne-studio Sunset

> 2025年初决定 sunset

**原因**：
- 原定位为 nocode AI Agent 开发工具
- 发现在这个时代不适合：AI agent 如何开发还很早期
- 80% 精力花在界面上，没精力做核心框架
- 用户不是早期硬核用户，需求无意义
- 决定全力投入 CLI + Framework 本身

---

## Agent 摘要

```
AIGNE [ ˈei dʒən ]: AI Genesis Native Engineering
Open source: https://github.com/AIGNE-io/aigne-framework
Positioning: Internal use + open source

Framework (实现):
- Functional AI app development framework (TypeScript)
- Multi-model: OpenAI, Gemini, Claude, Nova, etc.
- Workflow patterns: sequential, concurrent, routing, handoff
- AFS + MCP + sandbox code execution
- Blocklet ecosystem integration (bidirectional)

aigne-cli: Development + runtime CLI tool
aigne-studio: Sunset (nocode wrong fit for AI Agent era)

Design thinking (思路阶段):
- Function-isolated runtime: each function loadable independently
- AI-native Scaffold: for AI to use, not humans
- AFS-based composition: one package/function = one folder

Goal: Let LLM focus on simple, clear tasks without touching anything outside the function.
```
