# CreditToken 设计与合规策略

> USD 计费的合规实现方案
> 核心：不可转移 = 不是证券/稳定币

---

## 双 Token 机制

```
ArcBlock 网络
     │
     ├─ ABT（标准加密货币代币）
     │    └─ 可转移、可交易
     │
     └─ CreditToken（网络专用代币）
          └─ 不可转移、仅消费
```

---

## ArcBlock 三种 FungibleToken 类型

| 类型 | 特性 | 用途 |
|------|------|------|
| **普通 FungibleToken** | 标准可转移代币 | 一般用途 |
| **CurveToken** | 全自动 Bonding Curve | 自动定价/流动性 |
| **CreditToken** | 不可转移 | USD 计费合规 |

---

## CreditToken 合规架构

### 核心设计

| 特征 | 说明 |
|------|------|
| **不可转移** | 用户之间无法转移 |
| **USD 定价** | 1 CreditToken = 1 USD |
| **仅消费** | 只能用于购买服务，不能交易 |
| **链上实现** | 比传统数据库更安全可靠 |

### 合规定位

```
CreditToken ≠ 稳定币
CreditToken ≠ 证券
CreditToken = 内部信用机制（Internal Credit）
```

| 对比 | 稳定币 | CreditToken |
|------|--------|-------------|
| 可转移 | ✅ | ❌ |
| 可交易 | ✅ | ❌ |
| 监管定位 | 金融工具 | 内部积分/信用 |
| 美国合规 | 复杂 | 简单 |

### 为什么合规

1. **不可转移** → 不构成"货币"
2. **仅消费** → 不构成"投资"
3. **USD 定价** → 无汇率风险
4. **内部使用** → 封闭生态

---

## 链上实现的优势

| 优势 | 说明 |
|------|------|
| **安全性** | 比传统数据库更可靠 |
| **去中心化** | 保持区块链特性 |
| **生态集成** | 与 ABT/NFT/Staking 统一 |
| **可审计** | 所有操作链上可查 |

---

## USDCredit 通用支付

### 支持的服务

| 服务 | 说明 |
|------|------|
| **Blocklet Server** | 服务费用 |
| **Blocklet Store** | Blocklet 购买 |
| **AI 模型订阅** | AIGNE Hub 等 |
| **其他生态服务** | 任何 USD 计价服务 |

### 链上功能

| 功能 | 支持 |
|------|------|
| Staking | ✅ |
| NFT 购买 | ✅ |
| 服务支付 | ✅ |
| 用户间转移 | ❌ |

---

## PaymentKit 集成

### 多元化支付入口

```
用户支付
     │
     ├─ 信用卡 ──→ 转换为 CreditToken
     ├─ ABT ────→ 直接使用或转换
     └─ ETH ────→ 直接使用或转换
```

### 支付流程

```
信用卡支付 $100
     ↓
Stripe 处理
     ↓
用户获得 100 CreditToken
     ↓
CreditToken 用于购买服务
     ↓
服务方收到 CreditToken（或结算为 ABT）
```

---

## 与 ABT 的关系

| 维度 | ABT | CreditToken |
|------|-----|-------------|
| **性质** | 加密货币 | 内部信用 |
| **可转移** | ✅ | ❌ |
| **定价** | 市场浮动 | 锚定 USD |
| **用途** | 协议费、生态结算 | USD 服务支付 |
| **合规** | 作为 Token 处理 | 作为积分处理 |

### 互补关系

```
USD 服务（有成本）→ CreditToken 支付
零边际成本服务 → ABT 支付

CreditToken = 用户友好的法币入口
ABT = 生态价值捕获工具
```

---

## 设计哲学

```
问题：如何让用户用 USD 付费，又保持链上操作？

传统方案：
├─ 稳定币（合规复杂）
└─ 中心化数据库（失去链上优势）

ArcBlock 方案：
└─ CreditToken
    ├─ 链上实现（保持优势）
    ├─ 不可转移（合规简单）
    └─ USD 定价（用户友好）
```

---

## Agent 摘要

```
CreditToken: USD-denominated internal credit for ArcBlock

Key Design:
- Non-transferable between users
- USD-pegged (1 CreditToken = 1 USD)
- Consumption only, no trading
- On-chain implementation

Compliance:
- NOT a stablecoin (non-transferable)
- NOT a security (no investment expectation)
- Defined as internal credit mechanism
- Compliant with US regulations

Three FungibleToken types on ArcBlock:
1. Regular FungibleToken: Standard transferable
2. CurveToken: Automatic bonding curve
3. CreditToken: Non-transferable for USD billing

PaymentKit Integration:
- Credit card → CreditToken conversion
- ABT/ETH direct payment
- Unified on-chain operations (staking, NFT purchase, etc.)

Relationship with ABT:
- CreditToken: User-friendly fiat entry
- ABT: Ecosystem value capture
- Complementary, not competing
```
