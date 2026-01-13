# PaymentKit

## 一句话定位

**抽象支付层，支持多 token/多链**

## 核心能力

- 抽象支付
- 支持多 token / 多链
- 给 AI / Agent 提供"可计量的成本模型"

## 支持的支付方式

| 类型 | 支持内容 |
|------|----------|
| **加密货币** | ABT、ETH、USDT、USDC |
| **法币** | 信用卡（通过 Stripe 集成） |
| **链支持** | 任何 EVM 兼容链 |

## 战略定位

- boring，但长期不可或缺
- AI 平台最终一定需要内生结算系统

---

## 定价双轨制

> 详见 [定价与结算原则](../strategy/pricing-settlement.md)

| 轨道 | 适用场景 | 原则 |
|------|---------|------|
| **USD 本位** | 有第三方成本的服务（AIGNE Hub、Server Instance） | 必须锚定法币，覆盖成本 |
| **ABT 本位** | 零边际成本的纯软件层（Protocol 费、授权费） | 强制 B 端购买 ABT 支付 |

### 核心逻辑

```
USD —— 支撑业务（覆盖外部硬成本）
             ↘
                 → ArcBlock 生态增长 → ABT 需求上升
             ↗
ABT —— 捕获价值（资产增值）
```

---

## BYOK 模式

| 项目 | 说明 |
|------|------|
| **Bring Your Own Key** | 伙伴填入自己的 Stripe Key 收取法币 |
| **合规隔离** | 只提供技术工具，不触碰伙伴资金流 |
| **不做 Exchange** | 不提供 Fiat ↔ Crypto 兑换 |

---

## 税收引擎

- 集成 Stripe Tax / Avalara
- ABT 支付也按法币跑 Tax Engine
- 原则："Tax follows Service, not Money"

---

## SubGuard（透支保护）

> 独特设计：用 Staking 机制实现业务连续性保护

### 工作机制

```
用户 Stake 一定 Token 作为 SubGuard
     ↓
业务正常运行
     ↓
发生支付失败（如余额不足）
     ↓
SubGuard 启动，服务不中断
     ├─ 扣减可用 stake 数量
     └─ 收取 Overdraft Protect Fee
     ↓
用户在 SubGuard 期间补齐欠款
     ↓
全部退还，用户无损失
```

### 如果未能补齐

```
Stake 耗尽
     ↓
全部 Slash（覆盖欠费 + Overdraft Fee）
     ↓
服务终止
```

### 设计优势

| 对比 | 传统方案 | SubGuard |
|------|---------|----------|
| 支付失败 | 立即服务中断 | 有缓冲期 |
| 用户体验 | 差（业务停顿） | 好（连续性） |
| 风险保护 | 依赖信用评估 | 链上 Stake 担保 |
| 恶意用户 | 可能欠费跑路 | Stake 被 Slash |

### 适用场景

- B2B 业务的付款周期差异
- 临时余额不足
- 跨时区/跨境支付延迟
- 信用卡扣款偶发失败

---

## 对 Token 的态度

Token 是基础设施，不是 narrative，不是 hype。

### ABT 定位

ABT 是 infra、boring layer、enable layer。

从未认为 ABT 本身是 narrative，Token 不能替代产品。

## Agent 摘要

```
PaymentKit is an abstraction layer for payments.
Supports multi-token, multi-chain.
Provides measurable cost models for AI/agents.
Boring but essential for AI platforms.
ABT is infrastructure, not narrative.
```
