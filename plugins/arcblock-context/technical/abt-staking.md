# ABT Staking 机制

> 来源：ArcBlock 官方博客 (2022-12-05)
> 这是 ABT 的重要独特 utility

---

## Gas 费设计（与 Ethereum 完全不同）

### Ethereum 的 Gas
- 防止无限循环和复杂代码
- 用于交易排序（矿工优先选择高 gas 交易）
- 矿工从 gas 中获益
- 存在 MEV（Miner Extractable Value）问题

### ArcBlock 的 Gas
| 项目 | 说明 |
|------|------|
| **目的** | 防止系统滥用（spam、bot、应用故障） |
| **节点收益** | 节点运营者**不从** gas 费中获益 |
| **交易排序** | 节点**无法**控制交易顺序，无 MEV |
| **定位** | 区块链作为 Billing and Operation Support System (BOSS) |

**核心区别**：Gas 是保护机制，不是收入来源

---

## "Pay for Another Account" 功能

### Ethereum 的问题
- Gas 必须从执行交易的账户支付
- 转移小额 token 需要先转 ETH 付 gas
- 大量账户残留 dust token

### ArcBlock 的解决方案

| 功能 | 说明 |
|------|------|
| **跨账户支付** | Gas 可从另一个账户支付 |
| **应用代付** | 应用可为用户支付 gas |
| **新用户友好** | 用户无需先购买 token 即可使用 dApp |

**应用场景**：应用开发者用专用私钥为用户签名支付 gas

---

## "Staking for Gas-free" 机制

### 核心设计

```
Stake 1 ABT → Gas 费完全免除
```

| 特性 | 说明 |
|------|------|
| **Stake 数量** | 目前 1 ABT（可通过链上治理调整） |
| **覆盖范围** | 同一钱包的所有账户 |
| **与代付结合** | Stake 后可为他人免 gas |
| **应用场景** | 应用 stake 后，所有用户都免 gas |

### 显示方式
Gas 费仍会计算并显示，但会划线表示已免除

---

## Slashing 机制（关键保护）

### 触发条件

| 行为 | 后果 |
|------|------|
| **Spam 交易** | Stake 被没收 |
| **Bot 滥用** | Stake 被没收 |
| **应用故障大量交易** | Stake 被没收 |

### 设计逻辑

```
正常用户 → Stake 1 ABT → 永久免 gas → 最佳体验
滥用者 → Stake 被 slash → 失去免 gas → 需付 gas → 无余额则交易失败
```

**经济逻辑**：失去 stake 的成本远高于正常支付 gas 的成本

### 电路熔断器效应
- 应用故障发送大量交易 → 快速失去 stake → 停止影响系统
- 保护区块链不被滥用

---

## Unstaking 规则

| 项目 | 说明 |
|------|------|
| **发起** | 随时可以 unstake |
| **等待期** | 365 天（可通过治理调整） |
| **等待期权益** | 仍享有 gas-free 特权 |
| **到期后** | 可领回 token |

---

## 为什么这个设计独特

| 对比 | Ethereum | ArcBlock |
|------|----------|----------|
| Gas 受益者 | 矿工 | 无人（纯保护机制） |
| 用户体验 | 必须付 gas | 可完全免 gas |
| 新用户门槛 | 需先购买 token | 无门槛 |
| 滥用保护 | 经济成本 | Stake + Slash |
| 应用支持 | 复杂 | 原生支持代付 |

---

## ABT 需求来源（Staking 维度）

```
用户/应用想要 gas-free
     ↓
必须持有并 stake ABT
     ↓
ABT 锁定在 staking 中
     ↓
减少流通供应 + 刚性持有需求
```

**这是 ABT 作为 Utility Token 的重要需求来源之一**

---

## 通用 Staking 框架（Staking for X）

### 核心设计理念

> "Staking" 和 "Slashing" 是一对，没有 slashing 的 staking 毫无意义

### 可 Stake 的资产

| 类型 | 支持 |
|------|------|
| 系统原生 Token (ABT) | ✅ |
| 用户发行的 Token | ✅ |
| NFT | ✅ |
| 任意组合 | ✅ |

**应用决定**要求用户 stake 什么资产

### Staking 安全设计

| 特性 | 说明 |
|------|------|
| **专用账户** | Staked 资产存入专用区块链账户（基于 DID:ABT 协议） |
| **资产去向限制** | 只能：回到原账户（unstake）或被 slash |
| **防 Rug Pull** | 资产无法被转移到攻击者账户 |
| **用户自主 Unstake** | 用户可随时从 DID Wallet 发起 unstake，无需应用配合 |
| **应用无关** | 即使应用下线，用户仍可 unstake |

### Slasher 设计

| 特性 | 说明 |
|------|------|
| **预先指定** | Slasher 在 staking 交易中签名确定 |
| **无直接收益** | Slashed 资产**不给** slasher |
| **进入社区池** | Slashed 资产成为生态奖励 |
| **防滥用** | 防止 slasher 为私利乱 slash |

### Unstake 两阶段机制

```
阶段 1：发送 Unstake TX 请求
     ↓
     冷却期（Cool Down Period）
     ↓
阶段 2：发送 Claim Stake 取回资产
```

**冷却期目的**：防止作恶者 stake → 作恶 → 立即 unstake 逃避惩罚

---

## Staking for X 应用场景

### 1. Staking for Gas-free
- 已上线运行
- Stake 1 ABT → 全部 gas 免除

### 2. Staking for Cross-Chain Bridges (ArcBridge)

| 角色 | 要求 |
|------|------|
| Bridge 节点 | 必须 stake |
| 验证者 | Stake 数量 = 可验证的跨链 token 数量 |
| 作恶后果 | Slash，可能赔偿给受害用户 |

**运行多年，至今零安全事故**

### 3. Staking for Proposal/Vote (DAO 治理)

| 场景 | 机制 |
|------|------|
| 提案 | 提案者需 stake 资产 |
| 投票 | 投票者可能需 stake |
| Slash 条件 | 恶意提案被投 "No+Veto" → 提案者和 Yes 投票者被 slash |

### 4. Staking for Comments (反垃圾)

| 场景 | 机制 |
|------|------|
| 新用户评论 | 需 stake 资产 |
| 内容违规 | Stake 被 slash |
| 内容通过 | Stake 返还 |
| 建立信任 | 获得 NFT/SBT 后无需再 stake |

### 5. Staking for Marketplace Listing (防诈骗)

| 场景 | 机制 |
|------|------|
| 上架 Blocklet/NFT | 需 stake 资产 |
| 恶意内容（malware、违法 NFT） | Stake 被 slash |

### 6. Staking for X（通用 API）

```
Blocklet Framework 提供 "Staking for X" API
开发者几行代码即可实现 staking 功能
无需担心实现、安全、公平性
```

---

## 设计哲学总结

```
去中心化 = 无中心审查
     ↓
但也带来滥用风险（spam、诈骗、恶意内容）
     ↓
Staking + Slashing = 区块链原生的自治机制
     ↓
好行为者：享受权益
坏行为者：失去 stake
     ↓
无需中心化审查，靠经济激励自动治理
```

---

## Agent 摘要

```
ABT Staking Mechanism: Unique utility design with generic "Staking for X" framework

Gas in ArcBlock:
- NOT for miner revenue (no MEV)
- IS for preventing system misuse (spam, bots)
- Node operators do NOT benefit from gas

Core Features:
1. Pay for Another Account: Apps can pay gas for users
2. Staking for Gas-free: Stake 1 ABT → all gas waived
3. Generic Staking for X: Any token/NFT can be staked for any purpose

Security Design:
- Staked assets in special DID:ABT accounts
- Assets can ONLY go back to original owner OR be slashed
- No rug pull possible
- User can unstake anytime from wallet (no app dependency)
- Slashed assets go to community pool (slasher gets nothing)

Two-phase Unstaking:
1. Send Unstake TX → Cool down period → 2. Claim Stake
- Prevents stake → misbehave → instant unstake escape

Staking for X Applications:
- Gas-free (running)
- Cross-chain bridges (ArcBridge, zero incidents)
- DAO Proposal/Vote
- Comments (anti-spam)
- Marketplace Listing (anti-scam)
- Custom via Blocklet Framework API

Philosophy:
Decentralized = No central censorship
But also = Abuse risk
Staking + Slashing = Blockchain-native self-governance
Good actors: Enjoy benefits
Bad actors: Lose stake
No central authority needed, economic incentives auto-govern
```
