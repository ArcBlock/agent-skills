# ArcSphere

## 一句话定位

**AI-Native 的交互 Shell / Operating Surface**

## 不是什么

- ❌ Chrome
- ❌ Chat UI
- ❌ Copilot

## 是什么

**Skill Browser + Skill Composer + AFS UI**

## 核心角色

- 人类的入口
- Agent 的观测窗口
- AFS 的可视化界面
- 多 Agent 协作的舞台

## 核心能力

- 发现 Skill
- 安装 Skill
- 运行 Skill
- **组合多个 Skill 成为工作流**
- 渲染 Skill 的输入/输出

## HUD 设计理念

AI 界面应该像飞行员的 HUD（Head-Up Display）：

| Copilot (Wrong) | HUD (Right) |
|-----------------|-------------|
| 你召唤它 | 它已经在那里 |
| 对话隐喻 | 感知增强 |
| 需要注意力 | 安静存在 |
| 响应提示 | 主动呈现上下文 |
| 打断流程 | 增强流程 |

**设计原则：**
- Transparency & Lightness: 覆盖层，不是竞争层
- Semantic Awareness: 上下文相关，不是静态 widget
- Restraint: 最好的 HUD 大部分时间是隐形的
- Dismissibility: 用户始终可控，淡出无痕

> 不是更聪明的 AI，而是更安静的界面

## 长期价值

> ArcSphere 的价值会在"Agent 数量 > 人类数量"时显现

---

## AFS 核心支持（下一版重点）

> 状态：产品思路阶段

### 现状问题

ArcSphere 里的上下文工程还是 hardcode 的，用 AFS 会改善很多地方，不仅仅是 memory。

### AFS 应该 Mount 的内容

| 类别 | 内容 |
|------|------|
| **Tools** | 各种 ArcSphere 提供的 tools |
| **App 状态** | 多少 app、每个 app 的状态、app 扩展的 tools 等 |
| **浏览器侧数据** | IndexedDB 等 |
| **Memory** | 用户记忆、对话历史 |

> 需要系统梳理 ArcSphere 下 AFS 应该 mount 哪些东西，以便更好计划具体支持、review AFS 的合理性

### 长期形态：AFS Browser

> **ArcSphere 的长期形态不是一个传统 Web Browser，而是一个 AFS Browser**

| 传统 Web Browser | AFS Browser |
|-----------------|-------------|
| 浏览 URL | 浏览上下文、状态和文件 |
| 网页为中心 | AFS 为中心 |
| HTML 渲染 | AFS-UI 渲染 |

**Web 浏览能力**：
- 继续存在
- 更多作为数据源和兼容层

> AFS-UI 是这种新浏览范式的第一个具体实现，它会带来远超传统 Web 的用户体验

### 对 DID Spaces 的影响

从这个角度重新思考 DID Spaces 支持：
- **不需要** DID Spaces 给我们一个完美的 file manager UI
- **而是**：直接暴露为 AFS
- ArcSphere native 来呈现 AFS，自然就渲染出非常完善的效果

> DID Spaces → AFS → ArcSphere 原生渲染

---

## ArcPrompt → Agent Skills 升级

> 状态：产品思路阶段

### 现状问题

**目前的 ArcPrompt**：简单的 Prompt 模版 + built-in 模版 + built-in tools（location, tab 数量等）

| 优点 | 缺点 |
|------|------|
| 实现简单 | 能力有限（写的文章千篇一律） |
| | 应用难以给出最相关的 prompt，靠 hardcode 匹配 |
| | 依赖 web 页面 inject JS 代码（尤其输入增强类型） |
| | 自定义 prompt 无法测试，大多数人不会用 |

**为什么重度用户反而用竞品**：
- OpenAI Atlas、Chrome Gemini 能使用高性能 model
- 能和主 app 共享数据（AI 有 memory）

### 升级思路：ArcPrompt → Agent Skills

参考 Dia 浏览器也称类似功能为 Skills。

**核心改变**：
- 大部分 Skills 由 App 自己提供
- App builder 可以把 skills 提供得非常完整
- App 定义的 Skills 可以规定作用范围（只能作用于自己的对象 vs 外部对象）
- 用户也可以定义 skills，但主要作用于当前 app

### 关于用户自定义

**重新思考**：大部分用户不可能定义自己的 skills

- 过去需要用户自定义是因为无法扩展
- 现在 app 可以扩展（包括 ArcSphere 自己）
- 用户定义的价值不大了
- 可以考虑不允许用户自定义

### 能运行 Agent Skills

现在 Agent Skills 流行，有大量生态：
- 直接把这个作为 agent skills 来运行
- 一下子有丰富的生态
- AIGNE Framework 能支持运行 agent skills = 天然支持

**运行位置**：

| 位置 | 说明 |
|------|------|
| **ArcSphere 侧** | 满足运行条件时；可以模拟虚拟 bash 等命令给 agent skills |
| **服务端 Blocklet** | 长时间运行 agent 的 blocklet = **Agent Fleet** |

### Agent Fleet 的形态

| 类型 | 示例 |
|------|------|
| **多用户共享** | Aistro、财务金融信息服务、team 的 agent |
| **个人/群体 launch** | 个人专属 fleet |
| **共享但个性化** | Aistro 提供个性化解读；金融服务每个用户有自己的 portfolio |

**组成**：
- 运行 agent 的 blocklet
- 对应的服务组合（如 MCP servers）

### 使用场景示例

**写作 Skills**：
- 为个人 blog 定制个人风格的写作 skill
- 在公司网站下有公司风格的写作 skill
- 在 ArcSphere 里研究一批内容
- 想发表到不同站点时，自动用不同 skills 写作，产生不同风格文章

> 解决了现在发表时还得选择一堆不同的支持 Discuss Kit 的发表对象的问题

---

## 语音输入系统战略

> 状态：产品思路阶段

### 核心思路

将语音输入能力从 Web 实现转移到 Mobile 组件，由 ArcSphere 统一承担语音输入系统。

### 技术方案

| 方向 | 说明 |
|------|------|
| **平台迁移** | 语音输入能力从 Web → Mobile 组件 |
| **能力扩展** | 扩展 ArcSphere 现有 transcript 能力 |
| **API 结合** | 结合实时和离线 transcription API |
| **组件封装** | 包装成 ArcSphere 独特原生语音输入组件 |

### 核心功能集成

- **静默提示和自动整理**（基于 AINE 语音设计思路）
- 翻译词汇禁止列表
- 指令表和错误纠正
- 语音输入能力统一封装成可插入任何输入区的组件（提供给任何 Web App）

### 产品集成策略

**Web 应用简化**：
- 简化为基础输入界面
- 可选择是否支持语音功能
- 主要依赖 ArcSphere 组件提供完整语音能力

**AIGNE CLI 集成**：
- 通过 ArcSphere 提供语音输入界面
- 避免 CLI 内置独立 Webserver（导致 API key 管理问题和提高 AIGNE 复杂度）
- 桌面 CLI 能直接激活 ArcSphere 语音系统（WebSocket 控制和连接）

### Mobile 平台技术优势

| 优势 | 说明 |
|------|------|
| **录音稳定性** | 更好，可保留原始语音 |
| **API 调用** | 支持实时和后处理的语音 API |
| **并行处理** | 更容易并行处理 LLM 请求和录音 |
| **后台能力** | 后台 transcript 和 note 整理 |

### 用户体验提升

- ArcSphere 作为 AI Navigator 的核心能力
- 黑箱式集成，外部应用无需复杂 plugin
- 天然 AI 建议和改进功能

### 实施方向

- 客户端组相对充沛人员资源，已实现基本 transcript 能力
- 让 ArcSphere 具备细节功能优势（超过输入法产品、超过 ChatGPT 等内置能力）
- 将 ArcSphere 打造为真正的 AI 操作系统级工具
- 建立差异化优势，提升 retention 和竞争力

---

## 产品状态

| 项目 | 状态 |
|------|------|
| **平台** | iOS + Android 已发布 |
| **定位** | AI Navigator（新物种） |
| **策略** | 以 AI Browser 木马方式上架，但目标不是做浏览器 |
| **下一版重点** | AFS 核心支持 |
| **用户规模** | 1-10万 |

## Skill 运行模式

| 模式 | 说明 |
|------|------|
| **本地执行** | ArcSphere 侧直接运行，满足条件时使用 |
| **远程执行** | 通过 Agent Fleet 服务端运行 |
| **混合模式** | 根据 Skill 类型和需求自动选择 |

## 与 DID Wallet 的关系

- 两个独立产品
- Wallet 管身份资产
- ArcSphere 管 AI 交互

## 核心差异化

ArcSphere 与普通 AI 浏览器的核心区别：
- **Agent 为中心**：不是网页为中心
- **Skill 组合**：可组合多个 Skill 成为工作流
- **AFS 原生**：基于 AFS 而不是 URL

> 这些综合形成"新物种"，不是传统浏览器的 AI 增强版

## 竞争护城河

ArcBlock 的独特组合形成多重护城河：

| 组件 | 护城河贡献 |
|------|-----------|
| **DID** | 身份与权限的统一抽象 |
| **Blocklet** | 可组合的部署单元 |
| **AIGNE** | AI-native 开发框架 |
| **Agent Fleet** | AI 运行时平台 |
| **链上 Payment** | 原生加密支付能力 |

> 这些都是 ArcBlock 独特的技术积累，综合形成难以复制的差异化优势

---

## Agent 摘要

```
ArcSphere is an AI Navigator (new species), not a browser.
Released on iOS + Android. Wooden horse strategy: listed as AI browser for distribution.
It's Skill Browser + Skill Composer + AFS UI.
HUD philosophy: ambient awareness over reactive assistance.
Core differentiation: Agent-centric + Skill composition + AFS native.

Next version priority: AFS as core.
- Mount: tools, app states, browser-side data (IndexedDB), memory
- Long-term: AFS Browser, not Web Browser
- DID Spaces exposed as AFS, ArcSphere renders natively

ArcPrompt → Agent Skills upgrade:
- Apps provide Skills (not user-defined)
- Run on ArcSphere side or server-side Blocklet (Agent Fleet)
- AIGNE Framework supports agent skills natively
- Example: writing skills adapt to different sites automatically

Voice input strategy: Mobile-first, provides voice capability to all apps.
AIGNE CLI integrates via WebSocket, no embedded webserver.
Value emerges when agents outnumber humans.
```
