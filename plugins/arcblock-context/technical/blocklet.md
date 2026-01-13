# Blocklet 技术

## 总前提

> Identity 不是 feature，是系统的前提条件

Block / DID 从一开始就是"系统级抽象"，不是应用能力。
早期 Web3 用错了地方，叙事把技术价值掩盖了。

---

## 核心架构原则（不妥协）

ArcBlock 在以下原则上始终坚持，从不妥协：

### 一切皆 Blocklet

| 原则 | 说明 |
|------|------|
| **服务端全是 Blocklet** | 任何服务端组件都是 Blocklet |
| **运行在 Blocklet Server** | 一切都运行在 Blocklet Server 里 |
| **包括基础设施** | 区块链节点、DID Spaces 存储等都是 Blocklet |

### 一切皆可 Self-Host

| 原则 | 说明 |
|------|------|
| **完全去中心化部署** | 任何部件均可独立部署 |
| **包括核心服务** | Launcher、Blocklet Store、DID Spaces 都可自托管 |
| **用户完全自主** | 用户可以部署自己的完整生态 |

### 一切 ID 皆 DID

| 原则 | 说明 |
|------|------|
| **统一身份标准** | 所有 ID 都采用 DID |
| **包括链账户** | ArcBlock 链的账户本身就是 DID |
| **验证用 VC** | 任何需要验证的都采用可验证凭证 |

### 自包含示例：MyVibe.so

```
MyVibe.so 本身是一个 Blocklet
├── ArcBlock 部署：提供广泛公共服务
└── 用户自托管：完全可以独立部署自己的 MyVibe
```

> **这种去中心化、自我包含的原则是 ArcBlock 的核心哲学，一直不妥协**

---

## Block 的原始定位

Block ≠ 区块 ≠ 合约 ≠ 插件

Block 本质是：
**一个具备 Identity、Capability、Runtime Context 的最小可部署计算单元**

从一开始就在避免：纯函数、纯服务、纯容器

---

## Blocklet 技术本体

Blocklet 包含：
- 明确的 Identity（DID）
- 明确的运行边界
- 可声明的能力（capability）
- 明确的输入/输出
- 可组合、可卸载、可替换

**Blocklet 比 Docker container 多的不是算力，而是：语义边界 + 权限边界**

---

## Blocklet ↔ AINE 同构关系

| Blocklet 体系 | AINE 体系 | 本质 |
|--------------|-----------|------|
| Blocklet | Chamber | 有边界、有身份、有能力声明的最小执行单元 |
| Blocklet Server | Scaffold | 为特定领域预定义的 Chamber 组合框架 |
| Blocklet Service | 内置 Chamber | 每个应用都需要的基础能力 |
| DID + 权限系统 | Capability | 谁能操作什么、边界在哪 |

### 关键判断

- Blocklet 当时解决的问题是"人类程序员会越界、会乱来"
- AINE 现在解决的问题是"AI Agent 更会越界、乱来速度更快"
- 约束机制从"代码隔离 + 权限"升级到"语义边界 + Capability + AFS View"
- Blocklet Server 不是遗产，是原型——是 AINE Scaffold 在 Web 领域的早期实现

---

## Blocklet 的真实抽象

### 不是 Web 技术问题

Blocklet 解决的不是：
- Node / Java / PHP 选型
- React / Vue 框架
- MySQL / Mongo 数据库

**而是：软件系统的结构性失控问题**

传统 Web 应用的根本问题：所有东西在一个逻辑平面里"混在一起"
- OS 权限 & 业务逻辑混
- Billing & 页面逻辑混
- Auth & Feature 混
- 运维能力 & 产品能力混

> Web 提供了"进程级、URL 级"的隔离，但工程师在代码层面把它们全部重新揉在一起

### 真实抽象：应用级组件边界

Blocklet 不是"把网站拆成小模块"

**而是**：把"一个完整应用"拆解为一组"职责边界清晰、权限受限、可替换"的能力单元

| Blocklet 类型 | 实际语义 |
|--------------|----------|
| Auth / DID / Blockchain | 身份与信任域 |
| PagesKit / MediaKit | 内容与展示域 |
| SearchKit | 索引与知识域 |
| DiscussKit | 协作与交互域 |
| Dashboard / Admin | 控制与治理域 |

> 这些不是 feature，它们是 **Chamber —— 能力腔室**

### Blocklet Server = 为 Web 定制的 Scaffold

**Scaffold 三个核心特征（Blocklet Server 已全部实现）**：

1. **能力的合法组合方式是"被设计过的"**
   - 不能随意把 Auth 改成 Billing
   - 不能因为加页面就碰数据库
   - Scaffold = 合法路径集合

2. **负责"运行期治理"，而不是写代码**
   - 域名 / DNS / WAF / 网络边界
   - 配置、部署、升级、生命周期管理
   - Scaffold ≠ 帮你写代码，Scaffold = 限制你能做什么

3. **天然是"低信任开发者模型"**
   - 设计前提：开发者是不可靠的，需要被结构性约束
   - 这与今天对 LLM 的判断完全一致

### 为什么当年"没意识到"，现在才意识到？

> 当年缺的不是架构，而是合适的执行主体

| 执行主体 | 特征 |
|---------|------|
| 人类工程师 | 不会持续遵守约束、会绕规则、"图快省事" |
| **AI Agent** | 天生需要 Scaffold、没结构就会发疯、有结构就极度高效 |

当年 Blocklet 被理解为：
- ❌ 工程规范
- ❌ DevOps 工具
- ❌ 模块化平台

**实际上是**：对不可靠执行者的系统性约束方法

### 核心洞察

> **Blocklet 不是 Web 产品，Blocklet 是 AINE 在"人类时代"的早期形态**

不是"重新发明"，而是：把同一套思想从「约束人类工程师」升级为「约束 AI Agent」

### 概念统一

| 人类时代 | AI 时代 | 统一解释 |
|---------|---------|----------|
| Blocklet | Chamber | 能力边界清晰的执行空间 |
| Blocklet (Web) | Static Chamber | 确定性、预定义的 chamber |
| AINE Chamber | Dynamic Chamber | 意图驱动的 chamber |

### 对团队沟通的建议

> **AINE 不是否定 Blocklet，AINE 是 Blocklet 理念的完成态**

这能消除：
- "老板又换方向了"
- "以前是不是都白做了"

---

## Chamber 的理解

### 新判断

- 如果所有东西都是 Skill，天然就不会碰到别人（通过 AFS 隔离）
- Chamber 是为"跳出 AFS 边界"的操作设计的，不是为 Skill 设计的
- 未来软件天然自限，不需要那么严格的 Chamber

| 场景 | 需要显式 Chamber？ |
|------|-------------------|
| Skill 运行在 Agent Fleet 上 | 不需要，架构天然隔离 |
| Agent 直接操作外部系统（bash、API） | 需要，因为跳出了 AFS 边界 |

---

## Scaffold 设计策略

### 原来的想法（有问题）

- 建一个通用 Scaffold，能适配任何老代码
- Chamber 要严格到能约束任意 AI 行为
- AI 自动把老代码插入 Scaffold

### 新的判断

- Scaffold 是未来软件的架构模式，不是适配器
- 未来软件天然自限，不需要那么严格的 Chamber
- 不追求"AI 自动适配老代码"——这个问题本身是老问题

### 实际策略

1. 定义 Scaffold 作为"未来 AI-native 软件的标准架构"
2. 人工把现有系统适配到这个 Scaffold（手工重构）
3. 在重构过程中永久删除不需要的部分
4. 剩下的核心部分才让 AI 参与重写
5. **Scaffold 应该为未来会写的软件设计，不是为过去写的软件设计**

---

## Agent 摘要

```
Blocklets are identity-bound, capability-scoped deployable units.
Not plugins, not mini-programs, not app store.
Blocklet = Chamber in AINE terms.
Blocklet Server = Scaffold - the early Web implementation.
Chamber is for operations that jump out of AFS boundary.
Scaffold is for future software, not adapting legacy.
```
