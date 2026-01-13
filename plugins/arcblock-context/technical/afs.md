# AFS (Agentic File System)

## 第一性原理

- AFS 不是 feature、工具、SDK
- AFS 是 **AI-Native 的系统抽象层**
- AI 时代的最小可组合单元不是 API，而是"可被模型理解、推理、操作的状态载体"

## 四句话本体论

```
Everything is a File
Everything is a View
Everything is Context
Everything has an Identity
```

## AFS 是什么

- 虚拟文件系统（Virtual FS），不是 POSIX 延伸
- Agent-First / LLM-First 的系统接口
- 语义文件系统，不是物理文件系统
- 文件 = "模型可消费的上下文单元"

## AFS 文件可以代表

- 文档、数据、计划、意图
- 中间态、UI 输入/输出
- Tool invocation state
- Agent memory / scratchpad
- Contract / Spec / Prompt / DSL

## 为什么是 File System

### 对 API/JSON/YAML 的否定

- JSON/YAML 是糟糕的 DSL
- Parser、schema validation 在 AI 时代性价比极低
- API 是人类时代的接口设计
- AI 擅长浏览、对比、diff、回溯、组合，而非"精确调用"

### FS 的优势

- 天然支持：层级、部分可见、diff/history/snapshot、lazy load、mount/overlay/namespace
- **FS 是人类和 AI 的最大公约数**

## View 是灵魂

- AFS 文件 ≠ 原始数据
- AFS 文件 = 某个视角下的数据投影
- AFS 是 **View-First** 的系统
- 真正的能力不在 CRUD，而在 View

### View 例子

- `/intent/` = system state 的视图
- `/ui/input/` = UI 所需数据的视图
- `/agent/memory/` = agent 当前可见世界

## Path 是协议

```
$afs:/did:xxx/intent/plan.md
```

- path = context selector = query = view address = capability boundary
- **绝非** bash path / docker volume path / hard-coded path

## AFS-UI 思想

- UI 不应该直接依赖 backend
- **UI 应该只依赖 AFS**
- AFS 是 UI 与 Agent 的中介层（Buffer / Contract / Boundary / Replayable State）

---

## 从 Page 到 View：TMUX 式视角模型

### 传统模型的问题

传统 Web 理解：
- 站点由多个**页面（pages）**组成
- 用户通过**跳转（navigation）**在页面间移动
- 页面有加载、卸载、生命周期

> "页面"是浏览器和 HTTP 条件下的历史产物，不是 UI 的本体结构

### 更贴近现实的模型

```
城市不会因为你没去就不存在
房间不会因为你转身就被销毁
世界在持续演化，你只是某一刻观察其中一部分
```

**AFS-UI 模型**：
- 系统状态（世界/Document）持续存在并演化
- UI 只是对这个世界的一个**视角（projection）**
- 用户"访问"页面 = 把注意力对齐到已存在的视角

### TMUX 的启示

TMUX 核心不是终端，而是**视角管理**：
- 没有"页面"
- pane（显示区域）长期存在
- layout 与 focus 是独立概念
- 切换 pane ≠ 启动新程序
- session 可以 detach/attach

> TMUX 把"内容"和"组合/关注方式"彻底分离

### View：一等语义对象

**View = 对世界某一部分的语义观察视角**

View 的本质：
- 观察什么（数据/状态/流）
- 时间语义（stream / snapshot / interactive）
- 是否可聚焦、隐藏、组合

**View 不是**：
- ❌ DOM 区域
- ❌ 布局、尺寸、像素
- ❌ 知道自己"显示在哪里"

> View 只是一个被观察的语义切片

### View Manager

职责：
- 哪些 view 当前可见
- 哪些 view 被组合在一起
- 当前 focus 在哪个 view
- 分组、切换、叠加关系

**不负责**：view 内部语义、业务逻辑、渲染细节

### Display/Renderer 层

Web、Terminal、Native GUI 都是 **Display/Renderer**，不是语义层。

只有这一层才允许：window / pane / tab / overlay / split

> window/pane 是 View 在特定 display 上的呈现形态，不是系统核心概念

**结果**：Terminal、Web、Native UI 只是三种渲染方式，不是三套体系

### Streaming vs Snapshot

| 类型 | 时间语义 | Terminal | Web | Native |
|------|----------|----------|-----|--------|
| stream | 时间优先 | append 输出 | auto-scroll panel | list view |
| snapshot | 状态优先 | 屏幕控制式 | 静态渲染 | table view |

> 语义不变，renderer 不同

### 重新理解"页面"

```
Page 不是基本单位
Page 是某一时刻 View 组合状态的投影结果
```

| 页面 | 实际是 |
|------|--------|
| Dashboard | Agent List View + Log Stream View |
| Agent Detail | Detail View + Log View + Control View |
| Settings | Settings View 独占前景 |

> View 始终存在，页面只是"我此刻看的是哪些 View"

### 对 AI-native 的重要性

AI/Agent 的工作方式天然是：
- 并行关注多个事态
- 后台持续推演
- 前台只暴露当前关注点

View/View Manager 模型允许 AI：
- 打开/关闭 view
- 切换 focus
- 重组视角
- **无需模拟"页面跳转流程"**

### 架构分层

```
┌─────────────────────────────────────────┐
│              AINE (Agent)               │
│  Intent reasoning, UI planning,         │
│  Attention & focus decisions            │
│  NO rendering / NO layout               │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│        AFS-UI Semantic Layer            │
│  Semantic UI Tree (View A, B, C...)     │
│  NO layout, NO DOM, NO pixels           │
└────────────────┬────────────────────────┘
                 ▼
┌─────────────────────────────────────────┐
│        AFS-UI Window Manager            │
│  Create/destroy, Group/split/tab,       │
│  Focus management, Visibility           │
└────────────────┬────────────────────────┘
                 ▼
    ┌────────────┴────────────┐
    ▼                         ▼
┌──────────────┐      ┌──────────────┐
│ Web Renderer │      │ Terminal     │
│ HTML/HTMX    │      │ Renderer     │
└──────────────┘      └──────────────┘
```

### 核心结论

> **在 AFS-UI 中，Web 不是由页面组成的，而是一个由多个 View 组成的可观察空间。用户不是在跳转页面，而是在切换视角。**

这是 **Document–View 模式在 AI-native 时代的回归**：
- Document：AFS 中持续存在的世界模型
- View：语义视角（projection）
- Controller：AINE（视角与注意力调度）

---

## AFS 作为"最终确定层"

### 核心问题

AI-Native 时代最大的系统性问题不是 UI 技术选型，而是：

> **系统的"最终确定层"到底在哪里？**

传统软件中，确定层隐含且分散：
- 有时在数据库
- 有时在 API
- 有时在前端 state
- 有时在 HTML
- 有时在组件与 hooks 的组合逻辑中

**AI 成为一等工程参与者后的问题**：
- 不可逆的表示（UI → 数据困难）
- 不可 replay、不可 diff、不可演化
- AI 在 UI/代码/状态碎片之间高频 hallucination

> 如果没有一个被强制、显式定义的"最终确定层"，AI-Native 系统将不可持续

### AFS 的核心定义

**AFS = 系统中唯一被强制要求的"中间确定表示层（Canonical Intermediate Representation）"**

**基本原则**：
- 所有**可呈现（renderable）**的信息
- 所有**可交互（interactive）**的输入
- 所有**可被 AI 理解/修改/组合**的对象

→ **必须先被表达为 AFS**

无论后端是什么形态（DB、Service、Workflow、Agent），只要要进入 UI 或交互域，就必须先映射为 AFS。

### AFS-UI 的角色

AFS-UI ≠ 生成式 UI

**AFS-UI 的唯一职责**：只操作 AFS，不直接依赖任何具体 backend

AFS-UI 是：
- renderer
- adapter
- compiler
- runtime

**而不是系统真相的来源**

### AFS-UI 三种工作模式

| 模式 | 说明 | 特点 |
|------|------|------|
| **确定性 Adapter**（首选） | 结构明确的 AFS → 预构建 UI 确定性映射 | 快、可预测、可测试、可审计 |
| **Build-time Generated** | AI+人协作构建 UI，产物固化为静态资产 | 本质是 UI 编译/codegen |
| **Run-time Generated**（探索型） | 未知结构/临时需求，AI 运行期生成 UI | 接受不确定性与性能成本 |

三种模式可共存、组合

### 与传统 Web 架构的本质差异

| 层面 | 传统 Web | AFS 架构 |
|------|----------|----------|
| 最终确定层 | HTML | **AFS** |
| Renderer | Browser（固定） | 多形态（Web/TUI/App） |
| UI 表示 | 不可逆、不可组合 | 可 replay、diff、测试 |
| 跨形态复用 | 不可能 | 同一 AFS 多种渲染 |

> 这不是 UI 升级，而是**系统抽象层级的迁移**

### 为什么必须"强制提炼 AFS"

| 时代 | 提炼统一中间表示 |
|------|-----------------|
| 无 AI | 成本高、回报低 |
| **AI-Native** | AI 必须依赖稳定、可读、可逆的表示，否则只能在碎片中猜测 |

> AFS 不是设计偏好，而是 AI 成为系统参与者后的**必然结果**

### Hard Rules

1. 任何进入 UI/交互域的能力，必须先映射为 AFS
2. AFS-UI 不允许直接绑定业务 backend
3. UI 框架（React/htmx/Astro/Web/TUI）只是 AFS-UI 的实现细节
4. 复杂性如果无法在 AFS 层被表达与解释，则默认是不可接受的复杂性

### 一句话总结

> **我们不是在设计一个 UI 框架，而是在重新定义"软件系统的最终确定层"。AFS 是真相，UI 只是它的视图。**

---

## Agent 操作原则

**核心立场：Agent 不应该直接操作系统，只应该操作 AFS**

### Skill 本质

- Skill ≠ 确定性函数
- Skill = 对 AFS 的 transformation（读、写、改变 view、挂载新 namespace）
- AFS 把不确定性锁在 View 层，而不是逻辑层

## 关键矛盾：AFS vs Real FS

- LLM 看到的是 AFS
- Bash/Tool 看到的是 Real FS
- Path 不一致会导致灾难
- **路径错一次，agent 就彻底崩信任**

### 解决方向

- 尽量让 AFS path ≈ container path
- 或有 deterministic mapping layer
- 绝不能让 LLM "猜真实路径"

## 长期判断

### 时间尺度

- AFS 是 **decade-scale abstraction**
- 不可能一次做完，但要从 day one 就对

### 担心的误解

团队可能把 AFS 当成：
- ❌ feature
- ❌ storage
- ❌ prompt trick
- ❌ 又一个架构重构

实际上：**AFS 是世界观，不是模块**

## 试金石

- Blocklet Server 核心部分能 AFS 化 = 真正证明 AINE 成功
- AFS 如果不能落在复杂 legacy 系统上，就是纸上谈兵

## 极端判断

> 如果一个模块不能 AFS 化，它就不值得长期存在

---

## AFS 核心架构设计

> 来源：AFS 架构设计讨论 2025-12-10

### 1. 异步 I/O 作为基础

**设计原则**：
- 所有 AFS 文件访问都必须是异步 I/O
- 不能假设文件读取会立即返回
- Agent 在等待 I/O 时应该被挂起，数据就绪后被唤醒

**为什么需要异步**：
- 格式转换需要时间（PDF → Markdown 可能需要 10 秒以上）
- Human-in-the-loop 的反馈时间不可预知
- 某些操作本身就是异步行为（AI 处理、远程资源获取等）

**实现方式**：
- 使用 Promise 或类似异步机制
- Agent 读取文件时如果数据未就绪则挂起
- 底层系统负责在数据就绪后唤醒 Agent

> "你的每一个 IO 全部都是异步 IO，我要读，如果读不到就得把我挂起，就像操作系统一样"

### 2. 语义化的文件系统

#### 2.1 格式转换由 Driver 层处理

Agent 声明想要什么格式，Driver 自动处理转换：

```python
# Agent 视角
content = afs.read("document.pdf", format="markdown")
# Driver 自动处理 PDF → Markdown 转换
```

> 类似 Web 图片服务：请求不同尺寸的图片，服务器自动转换

#### 2.2 国际化/翻译在文件系统层实现

一个文件天生就是多语言版本的：

```
/docs/guide.md       # 中文版
/docs/guide.md/en    # 英文版（自动触发翻译）
/docs/guide.md/ja    # 日文版（自动触发翻译）
```

**好处**：
- 文档生成 Agent 完全不需要考虑翻译问题
- 翻译由专门的 Agent 在 AFS 层面自动处理
- 翻译机制是 universal 的，适用于所有内容

#### 2.3 利用 Metadata 优化性能

**不要让 AI 搜索**：
- 不应该让 Agent 通过关键词搜索找文件
- 应该利用 AFS metadata（文件修改时间、状态等）

> 通过时间戳直接定位被修改的文件，无需扫描所有文件

### 3. AIGNE Framework 提供 Agent 调度（类似 OS Scheduler）

**Agent 不是 Function Call，而是进程/线程**

#### 3.1 Agent 状态管理

三种状态：
- **Running** - 运行中
- **Suspended** - 挂起（等待 I/O 或资源）
- **Waiting** - 等待特定条件

调度行为：
- Agent 可以被挂起
- 条件满足后被唤醒
- 恢复时保持完整的上下文状态

#### 3.2 Framework 层职责

**这是 Framework 的工作，不是应用层**：
- 进程式的 Agent 调度
- 上下文管理和清理
- 防止上下文无限累积

**解决当前问题**：
- 当前 function call 堆积导致 message 列表越来越长
- Framework 应该知道何时需要注入上下文，何时清理

#### 3.3 避免 TODO List 的模拟方式

| 其他系统做法 | 我们的做法 |
|-------------|-----------|
| 用"纸上"的 TODO list 模拟状态 | Framework 原生支持状态管理 |
| 让 LLM 去理解和 check TODO list | 状态由调度器管理 |
| 没有状态管理能力的无奈之举 | Agent 不需要自己维护 TODO list |

### 4. Agent 挂载在 AFS 上

```
/agents/
  ├── agent-1/
  │   ├── memory
  │   ├── prompt
  │   ├── state         # running/suspended/waiting
  │   └── waiting_for   # 等待的资源
  ├── agent-2/
  │   └── ...
  └── ...
```

**好处**：
- 通过 `ls /agents` 可以看到所有 Agent
- 查看每个 Agent 的状态和等待条件
- 便于调试和监控
- Supervisor Agent 可以通过 AFS 检查所有 Agent

#### 上下文通过 AFS 共享

| 方案 | 说明 |
|------|------|
| **Selector** | 为不同 Agent 创建不同的 AFS 视图，每个 Agent 只看到 tree 的一个 branch |
| **Namespace + Mount** | 为 Agent 创建新的 AFS namespace，将需要的内容 mount 到特定位置 |

> 用 AFS 来解决上下文问题本身是最适合的

### 5. Supervisor Agent 提供三大能力

| 能力 | 说明 |
|------|------|
| **Crash 恢复** | 监控 Agent 运行状态，崩溃时能够恢复，保持状态一致性 |
| **死锁检测** | 检测多个 Agent 相互等待、资源竞争和循环等待；读取 `/agents/*/state` 和 `/agents/*/waiting_for` 分析资源依赖图 |
| **安全 Guardrail** | 文件级别（AFS 层面控制读写权限）+ 行为级别（检测异常行为模式如死循环） |

### 6. Human-in-the-Loop 设计

**通过 AFS 作为异步 I/O 实现**：

```python
# Agent 请求反馈
feedback = afs.read("/human/approval/task-123")
# Agent 被挂起，直到人类提供反馈
# 反馈到达后，Agent 被唤醒，继续执行
```

**特点**：
- Agent 请求人类反馈时被挂起
- 人类响应时间不可预知（可能几秒，可能几小时）
- 反馈到达后，AFS 唤醒 Agent

### 7. 设计哲学

#### Everything is Context

- 不要教 AI 如何做事，而是给 AI 充分的上下文让它理解意图
- 像宜家家具：工具、零件、说明书全部齐全
- Changeset 应该是描述性的（我要改什么），不是指令性的（你应该怎么改）

#### 让 AI 的工作尽可能简单

> 目标：张嘴饭来，伸手衣来

- 上下文全部喂给 AI
- 需要的工具都准备好
- AI 不需要感知异步、挂起等底层细节
- 外部系统把一切管理得很好

#### AFS 必须满足所有需求

- AFS 不是一个小工作，是长期核心基础设施
- 如果 AFS 不行，必须改进 AFS 使其能行
- 不允许 workaround 或替代方案

#### Observability 统一化

如果大部分 context 都通过 AFS：
- 只需实现一个统一的 FS renderer
- 所有内容用统一方式展示

---

## 产品战略：AFS as Core

> **所有产品都需要支持 AFS as Core，这样才能全面 AI 支持**

### 战略要求

每个产品都必须考虑：
- 如何将自己的状态、数据、能力暴露为 AFS
- AI 如何通过 AFS 理解和操作该产品
- 与其他产品如何在 AFS 层自然组合

### 各产品 AFS 化方向

| 产品 | AFS 化方向 |
|------|-----------|
| **ArcSphere** | Mount tools、app 状态、浏览器数据、memory；长期形态为 AFS Browser |
| **DID Spaces** | 直接暴露为 AFS，由 ArcSphere 原生渲染 |
| **DocSmith** | 文档结构即 AFS，页面即 AFS |
| **Blocklet** | 同时挂载 model 和 view 到 AFS |
| **Agent Fleet** | 在 AFS 上操作状态空间 |

### 检验标准

- 产品的核心状态是否可以表达为 AFS？
- AI 能否通过 AFS 完全理解该产品的当前状态？
- 产品能否与其他 AFS 化产品自然组合？

> AFS 化程度 = AI 支持程度

---

---

## 学术论文：ICSA 2026

> **"Everything is Context: Agentic File System Abstraction for Context Engineering"**
>
> 作者：Xiwei Xu (CSIRO), Robert Mao, Xuewu Gu, Yechao Li, Quan Bai, Liming Zhu
>
> 发表于 ICSA 2026（International Conference on Software Architecture）

### 论文核心贡献

1. **File-System 抽象作为 Context Engineering 基础设施**
   - 基于 Unix 哲学 "everything is a file"
   - 统一处理异构 context 来源（memory, tools, knowledge, human input）

2. **Context Engineering Pipeline**
   - Context Constructor：选择、压缩、准备 context
   - Context Updater：推理过程中刷新 context
   - Context Evaluator：验证输出、更新 repository

3. **Persistent Context Repository**
   - History（不可变事实源）
   - Memory（结构化索引视图）
   - Scratchpad（临时工作空间）

### 论文定义的 Memory 分类

| Memory 类型 | 时间范围 | 结构单元 | 表示方式 |
|------------|---------|---------|---------|
| **Scratchpad** | 临时、任务范围 | 对话轮次、临时推理状态 | 纯文本或嵌入 |
| **Episodic** | 中期、会话范围 | 会话摘要、案例历史 | 摘要文本或嵌入 |
| **Fact** | 长期、细粒度 | 原子事实陈述 | KV 对或三元组 |
| **Experiential** | 长期、跨任务 | 观察-行动轨迹 | 结构化日志或数据库 |
| **Procedural** | 长期、系统级 | 函数、工具或函数定义 | API 或代码引用 |
| **User** | 长期、个性化 | 用户属性、偏好和历史 | 用户画像、嵌入 |
| **Historical Record** | 不可变、全追踪 | 所有交互的原始日志 | 带元数据的纯文本 |

### 设计约束（Design Constraints）

| 约束 | 说明 |
|------|------|
| **Token Window** | 模型的有限注意力窗口，必须压缩和选择 context |
| **Statelessness** | 模型无状态，需要外部持久化 context repository |
| **Non-Deterministic** | 概率性输出，需要保存 input-output 对和 provenance 以支持审计 |

### SE 原则在 AFS 中的体现

| SE 原则 | AFS 实现 |
|--------|---------|
| **Abstraction** | 统一接口隐藏 context 来源的异构性 |
| **Modularity** | 每个 resource 是独立可管理的 mounted 组件 |
| **Encapsulation** | 隔离内部实现，只暴露最小操作集 |
| **Separation of Concerns** | 区分数据、工具、治理层 |
| **Traceability** | 所有交互记录为事务日志 |
| **Composability** | 一致的 namespace 和可互操作的 metadata schema |

### AIGNE 实现示例

```javascript
// 定义带持久化 memory 的 agent
const afs = new AFS()
  .mount(new AFSHistory({ storage }))      // 消息历史 memory
  .mount(new UserProfileMemory({ storage })); // 用户 memory

const agent = AIAgent.from({
  instructions: "You are a friendly chatbot",
  afs,
});
```

```javascript
// MCP 作为 AFS 模块挂载
const mcpAgent = await MCPAgent.from({ command: "docker", args: [...] });
const afs = new AFS().mount(mcpAgent);  // 挂载到 /modules/github-mcp
```

---

## 实现状态

| 层次 | 状态 |
|------|------|
| **基础实现** | 已完成（history, local-fs, user-profile-memory） |
| **高级功能** | 2026 年主要目标 |

### 高级功能状态

| 功能 | 状态 | 目标 |
|------|------|------|
| Driver 格式转换（PDF→MD） | 设计中 | 2026 |
| 文件系统级 i18n | 设计中 | 2026 |
| Supervisor Agent | 设计中 | 2026 |
| Human-in-the-loop | 设计中 | 2026 |

## 与 DID Spaces 的关系

**互为补充**：
- **AFS**：抽象层，统一的访问接口
- **DID Spaces**：存储层，可插拔的后端之一

> DID Spaces 可以作为 AFS 的存储后端

---

## Agent 摘要

```
AFS is the AI-Native system abstraction layer.
Everything is File, View, Context, Identity.
Implementation status: Basic done (history, local-fs, user-profile-memory), advanced features in design.

AFS files are context units consumable by models.
View is the soul - projection, not raw data.
Path is protocol: context selector, capability boundary.
Agents should only operate AFS, not systems directly.
AFS is a worldview, not a module.

AFS + DID Spaces: Complementary (AFS = abstraction, Spaces = storage backend).

Core Architecture (design):
- All I/O is async (Agent suspends when waiting, wakes when ready)
- Driver handles format conversion (PDF→MD automatic)
- i18n at file system level (/file.md/en triggers translation)
- Agent = process, not function call (Running/Suspended/Waiting states)
- Agents mounted at /agents/* with memory, state, waiting_for
- Supervisor: crash recovery, deadlock detection, guardrails
- Human-in-the-loop via async AFS read

Design philosophy: Everything is Context. Make AI's job simple.
Product strategy: All products must support AFS as Core for full AI support.
AFS化程度 = AI支持程度.
```
