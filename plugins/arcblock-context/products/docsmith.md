# DocSmith

## 一句话定位

**AI-native 文档与网站工具，DocOps 范式的试验场**

> WebSmith 已合并入 DocSmith，PagesKit 已 sunset

## 战略地位

- 本身不是核心产品
- 但它是 AFS / DocOps 的试验场
- 验证"结构优先、样式最小化"的 AI-native UI 理念

## PagesKit 替代方案

> PagesKit 已取消，新方案：AFS-UI + AI 生成

| 旧方案 | 新方案 |
|--------|--------|
| PagesKit（手工组件） | AFS-UI + AI 生成 |
| WebSmith（独立产品） | 合并到 DocSmith |

**新 web 页面能力方向**：
- 基于 AFS-UI 思想
- AI 根据结构自动生成 UI
- 结构即内容，样式由 Theme + AI 处理

## DocOps 新范式

文档不是"写出来的"，而是**工程状态的副产物**：

- 文档是可 replay 的
- 文档有 provenance
- 文档和代码同源
- 文档是 agent 的 memory

## 与 AFS 的关系

DocSmith 验证：
- 文档作为 AFS 文件
- 文档的 View 投影
- 文档的版本/diff/history

---

## AI-Native UI 设计理念

> 状态：产品思路阶段

### 核心转变

Web 设计进入"**结构优先、样式最小化**"的 AI-native 时代：
- 专注内容与语义
- 把视觉设计交给 Theme + AI 自然生长
- 保持结构纯粹，定义好审美基线
- 不再把精力消耗在手工样式与组件变体上

### PagesKit 的教训

过去试图让结构和样式在一个体系里统一，导致：
- 系统越来越复杂
- 维护成本越来越高
- 结构不再纯粹
- 样式难以保持一致

**问题示例**：

```json
// 本来有意义的是：
{
  "type": "HeroBanner",
  "title": "...",
  "subtitle": "...",
  "action": "..."
}

// 但因为需要控制 layout, animation, padding, bgColor 等，
// 被迫把一堆 properties 混合到内容里，直接把语义结构毁掉了
```

### 根本性转变

| 过去 | AI-Native |
|------|-----------|
| 结构 + 样式统一 | 结构是唯一的源 |
| 人工设计组件变体 | AI 自动生成视觉 |
| props 控制样式 | 纯语义结构，不要 props |
| 像素级手工设计 | 审美基线 + AI 自然生长 |

### 花园隐喻

> 我们只需要决定哪里是草地、哪里种树、哪里留一条小路；而每一片树叶、每朵花的细节，不应该由我们一个个去安排，而是让"自然"自己决定。AI 在未来的 UI 中，就是那个"自然"。

### DocSmith 验证

DocSmith 之所以显得更容易质量更高（内容而言 DocSmith 应该比 WebSmith 难得多）：
- 只关注文档的结构和内容
- 视觉完全交给主题本身
- AI 只补内容，不碰样式

### 设计原则

1. **不做 UI 组件库**：不手工做 10 个卡片 variant
2. **AI 自动生成视觉**：默认情况下视觉由 AI 自动生成
3. **保留意图级微调**（escape hatch）：极特殊情况下可通过结构化方式调整，而不是写 CSS
4. **结构是最重要的设计资产**：结构要定义得精确、语义化、毫不含糊
5. **Garbage In, Garbage Out**：垃圾结构会导致垃圾 UI

### 团队能力重心转移

从"如何实现这个 UI" → "如何精准表达业务语义"

### Theme 的升级

视觉不是"完全交给 AI 全自由发挥"，而是在**主题（Theme）**的审美基线上生成：
- Theme 从仅定义字体、颜色 → 包含让 AI 可以设计的方向
- 设计师负责制定审美基线与主题系统，而不是画十几个组件 variant

### 行业趋势

Cursor、Anthropic 等网站都在向更"结构化、简单、干净"的方向发展：
- 没有复杂的 UI 部件堆叠
- 清晰的结构 + 极简样式

> 这不是巧合，而是 AI 时代的必然趋势：把精力放在内容结构和产品逻辑上，而不是样式细节上

---

## 页面即 AFS

### 核心理念

页面本质上应该就是 AFS：
- 页面的"源"是 AFS 结构，不是 HTML、组件、props
- AI 理解页面时不需要 parse
- 不会被 layout、样式、DOM 这些非语义信息干扰
- 看到的是纯净的语义结构

### Web 形态

页面最终仍然会渲染成 HTML，但：
- HTML 不再是"源"，只是"输出产物"
- 源是 AFS 中定义的结构

### AFS 层的能力

配置页面、输入表单、动态内容区在 AFS 层都会变成：
- AI 能自动读懂
- 能自动扩展
- 能自动组合

> 对未来开发效率是巨大的提升

### Blocklet 的高阶方向

每个 Blocklet 都能够"挂载"到 AFS 上：
- 挂载的不只是数据模型（model）
- 也包括 UI 表现形式（view）
- Blocklet 可以同时在 AFS 中暴露数据结构和 UI 语义
- Blocklet 之间可以在 AFS 层自然拼接和组合
- 不需要在前端手工整合 UI、路由、配置面板

> 让整个生态的扩展性和组合能力大幅提升，也让 AI 可以在 AFS 层对整个系统进行理解、生成和重构

---

## Smith 工作流程设计

> 状态：产品思路阶段

### 核心思想

> **AI Agent 是我们的同事（Peer/Co-worker），而不是工具。因此工作流程应该思考如何和同事工作，而不是如何使用工具。**

| 与同事工作的方式 | 不是工具使用方式 |
|----------------|----------------|
| 工作要求和建议是一批批提出的 | 不是想到什么就要什么 |
| 按优先级、批次、阶段来报告结果 | 不是立刻执行命令 |
| 书面化、异步、有结构的沟通 | 不是随时聊天、临时指令 |
| 交付后一次性给一批建议 | 不是随时提出意见等立刻修改 |

### 版本化工作流程

```
V0 原始版本
 ↓ (用户输入、配置、DataSource)
V1 DocSmith 产生的版本
 ↓
V1.5 人类批量 feedback
 ↓
V2 DocSmith 根据 feedback 产生新版本
 ↓
V2.5 人类看到 diff/批注形式的修改信息
 ↓
... 循环往复直到阶段性完成
```

### 版本详解

| 版本 | 内容 |
|------|------|
| **V0** | 人类输入、配置、DataSource 指定 |
| **V1** | DocSmith 完成产生的版本 |
| **V1.5** | 人类对 V1 的批量 feedback |
| **V2** | DocSmith 接受 feedback 产生新版本（上下文包括：原输入/配置/datasource、刚产生的版本、用户批量建议、额外资料） |
| **V2.5** | 用户看到 diff/批注形式，只需关心：最新改了哪些地方、各个反馈点的修改细节 |

### 基本原则

1. **AI 永远不直接修改用户原始输入**
2. **每一个 feedback 都是批量化 patch**
3. **每一次版本生成都是"独立、原子、可 diff 的提交"**
4. **Smith 的版本生成不是 replace 行为，而是 patch + merge + diff 行为**
5. **每个版本都是完整产物，可独立导出**

> AI 的每次改动都是原子且可审计的

### 三类 Feedback 类型

| 类型 | 说明 | 示例 |
|------|------|------|
| **全局语义修改** | 需要 revise 全部内容 | "Blocklet 应该保持 B 大写" |
| **局部结构性 rewrite** | 对部分内容要求整体重写 | "开头不够详细，没有整体介绍产品"、"参考这些额外资料..." |
| **直接内容改写（patch）** | 没给意见，直接改了 | 类似共享文档的修订模式 |

> 这三类本质是三种不同粒度的 edit op，未来可映射为 AFS-level edit operation

### Feedback 格式

**局部 change**：直接插入原文档，用特殊分割符标记

```markdown
::: change
# My rewrite of this paragraph
这里是我希望改成的内容……
:::
```

**全局语义、额外材料**：写入 `changeset.md` 文件

> 人类的 change request 是一个 git commit，非常清晰

### 工作目录设计

DocSmith 不应该把自己建立在别人的工作目录下，应该是独立目录：

```
/user-repo (只读 — reference data)
/docsmith-workspace (读写 — versioned)
/docsmith-cache (可选 — 中间格式)
```

**原则**：
- DocSmith 在自己的工作目录下，不污染别人的 repo
- 如果 doc 是项目的一部分，用 mono repo 形式，限制在自己的工作目录
- 避免 AI 不可控地影响原代码/原文档
- 如果 data source 是 repo，AI 自动 pull，用户只需给 git url
- 中间分析成本高、input 稳定 → 应进 repo
- input 经常变化 → 仅缓存，不纳入版本

### 与 Agent Fleet 的关系

这个版本流程本质上就是 Agent Fleet 里一个独立"生产型 Agent"的生命周期，与 AIGNE 中的 chamber / task / patch 流程完全一致。

> 将来任何一个 Smith 都可以加入某个 Agent Fleet 成为其中一个 crew member

### 与 Discuss Kit 的解耦

- 设计完全解耦了与 Discuss Kit 的关系
- 没有 Discuss Kit 介入时，通过自然语言方式定义 change set
- 未来 Discuss Kit 集成后，只是在 web 上产生 change set 而已
- 不依赖 Discuss Kit 的版本能力（目前远达不到 Git 的能力和灵活性）

---

## Agent 摘要

```
DocSmith is an AI-native document and website tool.
WebSmith merged into DocSmith. PagesKit sunset.

DocOps paradigm: docs are engineering state byproducts.
Docs are replayable, have provenance, and are agent memory.

AI-Native UI philosophy:
- Structure-first, style-minimal
- Semantic structure only, no props for styling
- AI generates visuals within Theme aesthetic baseline
- Garden metaphor: we define where trees go, nature handles leaves

Page = AFS structure, HTML is just output product.
Blocklets mount to AFS with both model and view.
Team focus shifts from "how to implement UI" to "how to express business semantics".

Smith Workflow (AI as Peer/Co-worker):
- Version-controlled: V0 → V1 → V1.5 feedback → V2 → ...
- Batch feedback, not real-time commands
- Three feedback types: global semantic, local rewrite, direct patch
- Each version is atomic, diffable, auditable
- AI never modifies user's original input
- Workspace isolation: DocSmith has its own directory
- Each Smith can join Agent Fleet as crew member
```
