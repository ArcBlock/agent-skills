# Agent Fleet

> 状态：技术概念阶段，已有技术基础可实现
> 定位：基础设施层，非直接面向用户的产品

## 重要澄清

**Agent Fleet 目前更多是技术概念，而非直接可销售的产品。**

| 维度 | 说明 |
|------|------|
| **产品清晰度** | 较低（对比 DocSmith、MyVibe.so、AIStro） |
| **直接用户** | 开发者、技术团队（非终端用户） |
| **商业化路径** | 通过上层产品成功后被动曝光 |
| **获客方式** | 不直接销售，靠产品引流 |

### 战略定位

> **产品在前，基础设施在后**

不直接卖 Agent Fleet，而是：
1. 上层产品成功（DocSmith、MyVibe.so、AIStro）
2. 产生收入和用户
3. 开发者问"你们用什么做的"
4. Agent Fleet / AIGNE 自然被发现

---

## 一句话定位

**每个用户拥有一支"舰队"——一组长期存在、持续自主工作、带着目标推进任务的 AI Agents**

---

## 产品愿景

Agent Fleet 不是 ChatGPT 式的问答助手，而是：

| 传统 AI 助手 | Agent Fleet |
|-------------|-------------|
| 用户问一句答一句 | 有使命、有上下文、有记忆、有回路 |
| 按需激活 | Always-on, long-life, mission-driven |
| 工具 | 长期 AI 同事 / 队友 |

> 这些 agent 持续推进任务，会监听用户行为线索、自动更新任务数据库、主动请求反馈、生成工作日志

---

## 技术架构定位

### 关键澄清

- Agent Fleet **不是**独立新产品
- Agent Fleet **不是** Blocklet Server 的替代品
- Agent Fleet **是一种新类型的 Blocklet**

### 架构关系

```
Blocklet Server (平台)
├── 传统 Blocklet（Web 组件）
└── Agent Fleet Blocklet（AI-native 组件）= 新类型
```

**战略**：改进 Blocklet Server 以支持这种新类型，而不是另起炉灶。

### Agent Fleet 的本质

Agent Fleet 本质上是以下要素的组合：

| 组成部分 | 说明 |
|---------|------|
| **AIGNE Runtime** | Agent 执行环境 |
| **应用层** | Skills 或 Agents |
| **周边服务** | MCP servers、资源服务、Web、安全 shell 执行容器等 |

> 这充分利用了 Blocklet 架构的可组合性特点。Blocklet Server 已针对 AIGNE 开发的应用、Docker、可组合 Blocklet，以及 vibe coding 生成的页面进行了优化部署。

### 与其他概念的关系

| 概念 | Agent Fleet 中的角色 |
|------|---------------------|
| Skill | 运行在 Agent Fleet 上的能力单元 |
| Chamber | 有边界的执行环境 |
| AFS | Agent Fleet 操作的状态空间 |
| DID | Agent 的身份标识 |

> Agent Fleet = Skills + DID + Capability + Chamber + AFS = 有边界的 Skill 集合

---

## 为什么只有 ArcBlock 能做

Agent Fleet 是 ArcSphere + Blocklet + AIGNE 共同带来的 ArcBlock 独有能力：

### ArcSphere = 驾驶舱（Navigator Cockpit）

用户把 ArcSphere 看成 Agent 总控中心：

- 像 Messenger 联系人一样，每个 agent 都是一个"联系人"
- 随时可启用/停止 agent
- 给 agent 下任务
- 查看它们的日志、状态、进展
- agent 主动发 message 像队友一样

> ArcSphere 是"Agent 的世界窗口"和"用户的驾驶舱"

### Blocklet = 发动机舱（Engine Room）

Agent 真正运行的地方：

- 用户不需要看到部署细节
- Blocklet 提供 agent 的执行 runtime
- 提供持久化、事件、hook、消息发布等功能
- agent 日志自动发布到用户讨论系统

> Blocklet = Agent 的发动机舱

### AIGNE = 大脑与人格定义

AIGNE 提供：

- agent 的结构、记忆、技能、逻辑
- 不同任务的 agent 类型可快速增加

**Agent 类型示例**：
- 写日记 agent
- 写 blog agent
- 写文档 agent
- 写白皮书 agent
- 研究行业 agent
- 信息整理 agent
- 产品构思 agent
- 竞争分析 agent
- PR agent
- 技术分析 agent

> AIGNE = Agent 的大脑与人格定义系统

---

## 为什么叫"Fleet"而不是定时任务

**绝不能降级为**：
- ❌ 一个定时任务
- ❌ 一个 event handler
- ❌ 一个 hook

**Agent Fleet 的本质**：长期存在、带着目标持续自主推进任务的智能体系统

它们会：
- 有长期目标（如：收集白皮书素材、构思产品故事）
- 监听用户的一切行为线索
- 自动记录并更新自己的任务数据库
- 主动请求用户反馈
- 生成自己的工作日志
- 不断推进任务直到完成

> 这是"长期自主 agent" + "人类同事般的 AI 队友"的概念

---

## Daily Retention 的答案

### Navigator + Fleet 的组合

| 角色 | 定位 |
|------|------|
| Navigator | 前台，以"探索"为主 |
| Fleet | 后台，以"执行"为主 |

ArcSphere = "星舰迷航"式的宇宙设定

### 用户每天打开 ArcSphere 的理由

用户每天进来会看到：

- 舰队今天做了什么
- Navigator 推荐了什么
- 昨日浏览总结
- 今日可能关心的话题
- 自动生成的 blog / notes / research logs
- agent 自主整理的白皮书材料
- agent 主动提问、反馈、请求确认
- 新发现的信息结构
- 持续推进的任务进度

> 这是天然的每日参与循环

---

## 个人 AI 办公团队

每个人 = 有一个 AI 工作团队
每个团队 = 一支 Agent Fleet
每个 agent = 一个长期的、明确任务的 AI 同事

**团队版示例**：
- 白皮书小组
- 产品研究 agent
- 文档编写 agent
- 市场研究 agent
- 竞争分析 agent
- PR agent
- 技术分析 agent

> ArcBlock 的整个体系（DID / Blocklet / Payment / AIGNE）让这个结构不是 PowerPoint，而是真正可以实现

---

## 实现可行性

> Agent Fleet 我们现在的系统已经可以实现，也许只是不够优化而已。因此这是一个切实可行的概念，而非未来的愿景。

---

## Budget-Based 计费模式

> 状态：产品思路阶段
> 计费机制：混合模式（按预算 + 任务 + Token 综合计费）

### 核心问题

Agent Fleet 是长时间运行、事件驱动的服务，传统计费模式都不适合：

| 模式 | 问题 |
|------|------|
| **Subscription（订阅制）** | 用户付费与真实使用不匹配、无法按需扩展、越用越亏 |
| **Pay-as-you-go（按调用付费）** | 用户对成本无限恐惧、不敢尝试主动 agent、不敢设长生命周期任务 |

传统模式的根本问题：
- 订阅适合"问答式 AI"，不适合持续运行、主动任务型 Fleet
- 按调用付费导致用户只敢把 AI 当"问答工具"，不敢当"劳动力"

### Budget-Based 模式

> **给 Fleet 一个预算，让 Agent 自主在预算内生产价值**

用户不需要买套餐，也不用按调用付费，只需要给 Fleet 一个"每日/每周预算"：

```
每日预算：$1.00

Fleet 会自动在预算上限内运行：
- 调用模型
- 执行任务
- 调整频率
- 合并批量推理
- 使用本地模型降低成本
- 决定哪些任务优先执行

且绝不超支。
```

### 为什么这个模式自然可信

符合真实世界的人类劳动力体系：

> "我有过特别能干的员工，工资不高但非常主动，我会不断加工资，因为我想留住他们。"

| 逻辑 | 说明 |
|------|------|
| 先从小预算开始 | 低风险试用 |
| agent 是否"值得"更多预算 → 看产出 | 价值驱动 |
| 如果 agent 很能干 → 用户自然会增加预算 | 自然增长 |
| AI 不再是工具，而是"劳动力" | 心智模型转变 |

### 为什么只有 ArcBlock 能落地

需要底层具备四项能力：

| 能力 | ArcBlock 实现 | 其他平台 |
|------|-------------|---------|
| **DID（身份）** | Fleet/Agent/Project/Team 都是 DID，可拥有预算、付费、接受限额、生成账单 | 做不到 |
| **Payment Kit** | Delegation、Cap、Quota、Auto-settlement、永不超支、透明账本 | 中心化计费无法做到 |
| **Blocklet Runtime** | 事件驱动、按需启动、执行几秒、写入状态、结束运行 → 1000 个 Fleet 成本 ≈ 1 个 Fleet | 无法实现 |
| **DID Spaces + AFS** | agent 全部持久化在 Spaces 中，预算与状态分离，成本极低 | 无法实现 |

### 透明补贴机制

可以在特定场景对用户预算进行"补贴"，并清晰告知：

```
你的每日预算：$1.00
Fleet 实际消耗：$1.50
ArcBlock 补贴：$0.50
```

**作用**：
- 降低新用户心理门槛
- 帮助用户看到 agent 真实价值
- 让用户逐步愿意提高预算
- 构建信任感（透明永远比黑盒好）

> 这套补贴机制在其他 AI 平台无法实现（没有 DID、multi-tenant 支付系统、agent-level billing、ledger、event-driven runtime）

### Agent 根据预算调整工作强度

| 预算级别 | 工作方式 |
|---------|---------|
| **低** | 降低任务频率、使用本地模型、简化研究深度、限制自动推理次数 |
| **中** | 正常 daily tasks、multipass summarization、topic watcher、morning brief |
| **高** | 多 agent 并行、深度行业研究、自主探索、高频抓取、多模型融合推理 |

> 这让 Fleet 变成真正的"AI 劳动力"，而不是工具

### 增长飞轮

```
1. 用户从小预算开始
   ↓
2. agent 产出高价值内容
   ↓
3. 用户看到价值，增加预算
   ↓
4. Fleet 工作强度提升，产出更强
   ↓
5. 用户提高预算上限
   ↓
6. ArcBlock 收入持续增长
   ↓
7. Fleet 变成用户不可替代的"AI 团队成员"
```

### 时代定位

| 时代 | 计费模式 |
|------|---------|
| 工具时代 | Subscription |
| 云计算时代 | Pay-as-you-go |
| **AI Agent 时代** | **Budget-Based** |

> 这是 ArcBlock 完全有能力定义、构建、垄断的新范式

---

## 产品状态

| 项目 | 状态 |
|------|------|
| **开发状态** | 正在开发中 |
| **目标发布** | 2026 Q1 |
| **Budget Billing** | 首先在 Agent Fleet 落地 |
| **AIStro 集成** | AIStro 将运行在 Agent Fleet 上 |

## 第一批用例

多种用例并行推进：
- AIStro 个性化 Agent
- 内容创作 Agent
- 自动化工作流 Agent

---

## Agent 摘要

```
Agent Fleet: Each user owns a "fleet" of long-living, mission-driven AI agents.
Not ChatGPT-style Q&A, but always-on AI teammates with goals, memory, and feedback loops.
Status: In development, Q1 2026 target. Budget-Based Billing lands here first. AIStro will run on Fleet.

Technical: A new type of Blocklet (AI-native component runtime).
Agent Fleet = Skills + DID + Capability + Chamber + AFS.

Three pillars:
- ArcSphere = Navigator cockpit (user's control center)
- Blocklet = Engine room (agent runtime)
- AIGNE = Brain & personality (agent definition)

Why "Fleet" not "hook/cron": These are long-term autonomous agents, not event handlers.
Daily retention answer: Navigator (explore) + Fleet (execute) = natural daily engagement loop.
Each user = personal AI office team. Already achievable with current system.

Budget-Based Billing (AI Agent era model):
- Give Fleet a budget, let agents produce value within budget
- Agents adjust work intensity based on budget level
- Only ArcBlock can do this: DID + Payment Kit + Blocklet Runtime + DID Spaces
- Transparent subsidy mechanism builds trust
- Growth flywheel: small budget → see value → increase budget → stronger output
```
