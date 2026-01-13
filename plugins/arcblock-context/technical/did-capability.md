# DID + Capability + Delegation

## 核心区分

- **Identity**（我是谁）→ DID
- **Capability**（我能做什么）→ 分离的授权
- **Delegation**（谁代表谁）→ 安全委托

**Web3 最大问题之一：把 identity 和 capability 混在一起**

---

## DID

### 原始判断（早于行业）

DID ≠ wallet ≠ 登录 ≠ address

而是：**一个可被系统识别、可被授权、可被追责的主体标识**

### DID 在 ArcBlock 中标识

- 人
- 服务
- Blocklet
- Agent
- Tool
- 数据来源

### 反感的用法

- DID 只绑定私钥
- DID 只用于签名交易
- DID 只存在链上

### AI 时代为什么 DID 必须

因为 Agent：
- 不是人、不是函数
- 有行为、影响、成本、风险

> 没有 identity 的 agent，是不可控的

---

## Agent = DID = 链上账户

### 核心设计

```
每个 Agent ID = DID
每个 DID = 可以是链上账户
因此：Agent 可以直接收付款
```

| 实体 | 身份 | 链上能力 |
|------|------|---------|
| 用户 | DID | 可收付款 |
| Agent | DID | 可收付款 |
| Blocklet | DID | 可收付款 |
| 服务 | DID | 可收付款 |

### 为什么重要

- Agent 不再只是"工具"，而是有身份的"主体"
- Agent 可以有自己的预算（Budget-Based Billing）
- Agent 可以代表用户付费
- Agent 的所有行为可追溯、可审计

---

## Delegation（安全委托）

### 专利覆盖

ArcBlock 拥有多项专利，覆盖链上安全委托机制：

| 场景 | 说明 |
|------|------|
| **自动扣费** | 服务可在授权范围内自动扣款 |
| **代付费** | 一个 DID 可代表另一个 DID 付款 |
| **预算限制** | 委托可设置上限和条件 |
| **可撤销** | 用户随时可撤销委托 |

### 解决的问题

```
传统问题：
- 自动扣费需要托管私钥（不安全）
- 或者每次手动签名（体验差）

ArcBlock 方案：
- 链上原生 Delegation 机制
- 无需托管私钥
- 授权可精细控制
- 随时可撤销
```

### 在 Agent 场景的应用

| 场景 | 机制 |
|------|------|
| 用户给 Agent 预算 | 用户 delegate 给 Agent DID 一定额度 |
| Agent 消费预算 | Agent 在授权范围内自动支付 |
| 超出预算 | 自动停止，无法超支 |
| 用户撤销 | 随时可从钱包撤销 delegation |

---

## Capability

### 技术思想

- Capability 是最小授权单元
- Capability 可组合、可撤销、可委托
- Capability 应该：
  - 附着在 DID 上
  - 被系统强制检查
  - 与上下文强相关

### 反对的做法

- role-based 粗权限
- 一次授权、无限能力

---

## DID + AFS 结合

- **DID 决定**：能看到哪个 AFS view、能写哪些路径
- **Capability 决定**：能调用哪些 skill、能操作哪些 tool
- **所有操作**：必须可追溯到 DID

---

## DID 基础设施

### 做过但不沉迷

做过：DID Registry、DID DNS、DID Name、Resolver

但内心清楚：**这些是 plumbing，不是价值本身**

### 对链的态度

不迷信任何链（以太坊、自己的链、任何 L1/L2）

判断标准：**是否稳定、是否可验证、是否足够 boring**

### 技术立场

- 批评 W3C DID 的 JSON-LD 要求
- 更倾向 ArcBlock 的 JSON Schema 方案

---

## Web3 阶段反思

### DID 被用错的地方

Web3 把 DID 用在：钱包、登录、资产

忽略了：系统边界、服务授权、agent identity、tool identity

> 不是 DID 没用，而是时代用错了问题

### 长期判断

不认为"失败了"，认为它：
- 提前了
- 被错误叙事包裹
- 被错误场景消费

在 AI-Native 时代：**它们会自然回到本来就该在的位置**

---

## DID Spaces 存储

### 支持的后端

| 后端 | 说明 |
|------|------|
| **S3 兼容存储** | AWS S3 或任何 S3 兼容存储 |
| **本地文件系统** | 服务器本地存储 |
| **其他** | 可插拔设计，支持扩展 |

> DID Spaces 采用可插拔后端设计，用户可根据需求选择不同存储方案

---

## Token 关系

### ABT Token

| 类型 | 说明 |
|------|------|
| **ERC-20** | 以太坊上的 ERC-20 Token |
| **原生 Token** | ArcBlock 链的原生 Token |
| **桥接** | 通过 ArcBridge 实现双向映射 |

### ArcBridge

- ArcBlock 独立 L1 链与以太坊的跨链桥
- 本身是一个 Blocklet
- 实现 ABT 在两条链之间的转换

### Token ≠ Identity ≠ Capability

但 Token 可以：
- 作为计量单位
- 作为结算手段
- 附着在 DID 上

---

## Agent 摘要

```
DID + Capability + Delegation: Three pillars of identity system

DID: Accountable system actors (users, agents, blocklets, services)
Capability: Minimal, composable, revocable permissions
Delegation: Secure on-chain authorization (patented)

Key insight: Agent ID = DID = Blockchain Account
- Agents can directly receive and make payments
- Enables Budget-Based Billing for agents
- All agent actions traceable and auditable

Delegation solves:
- Auto-deduction without custodying private keys
- Pay-on-behalf with fine-grained control
- Budget limits with auto-stop on exceed
- User can revoke anytime from wallet

Why critical for AI era:
- Agents have behaviors, impacts, costs, risks
- Agents need identity for accountability
- Agents need payment capability for autonomy
- Without identity, agents are uncontrollable
```
