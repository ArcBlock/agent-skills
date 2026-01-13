# ArcBlock 链架构

> 链是 Billing and Operation Support System，不是 Magic
> Telecom 思维，不是 Crypto 叙事

---

## 核心设计哲学

### 链不是魔法

```
链 = Billing and Operation Support System (BOSS)
     │
     ├─ 电信思维：清晰、可靠、可计量
     │
     └─ 不是 Crypto 叙事：不追求"世界计算机"
```

### 反 EVM 设计

| 维度 | EVM 链 | ArcBlock 链 |
|------|--------|-------------|
| **执行模型** | 虚拟机 + 智能合约 | Rule/Script Based |
| **设计哲学** | 可编程性优先 | 协议清晰优先 |
| **复杂度** | 高（图灵完备） | 低（明确规则） |
| **性能** | 受限于 VM | 更高 |
| **安全性** | 合约漏洞风险 | 协议级安全 |
| **类比** | 以太坊 | 更接近 Bitcoin |

### 为什么不要智能合约

```
智能合约 = 复杂性 + 攻击面 + 不确定性

ArcBlock 选择：
├─ 明确的协议规则
├─ 可预测的行为
└─ 更小的攻击面
```

---

## 性能设计

### 当前状态

| 指标 | 数值 |
|------|------|
| **线上 Mean TPS** | 100 TPS |
| **定位** | 足够支撑 Billing 场景 |

### 扩展能力

```
水平扩展设计（Sharding Ready）
     │
     ├─ 单机优化：~500 TPS
     │
     └─ 多机分片：可达 10,000 TPS
```

### 设计原则

> Billing 不需要极致 TPS，需要的是：可靠、可审计、可扩展

---

## 作为 BOSS 的功能

| 功能 | 说明 |
|------|------|
| **Billing** | 计费记录、结算 |
| **Staking** | 质押、Slash、解锁 |
| **Payment** | 支付、转账 |
| **Registry** | NFT、DID、资产登记 |
| **Delegation** | 授权委托（专利） |

---

## 与 Telecom BOSS 的类比

```
电信 BOSS                    ArcBlock 链
    │                              │
    ├─ 计费系统      ←→          Billing
    ├─ 账户管理      ←→          DID + Account
    ├─ 服务开通      ←→          Staking Activation
    ├─ 资源计量      ←→          Token Operations
    └─ 结算清算      ←→          Settlement
```

---

## 节点运营

| 模式 | 说明 |
|------|------|
| **混合模式** | 多种运营方式并存 |

> PoS 共识采用混合节点运营模式

---

## Token 供应

| 特性 | 说明 |
|------|------|
| **固定供应** | 总量固定 |
| **无通胀** | 无节点奖励增发 |
| **无销毁** | 无通缩机制 |

> ABT 是固定供应的 Token，不增发不销毁

---

## Token 分配现实

### 原始设计

| 池子 | 比例 | 原始用途 |
|------|------|---------|
| **社区池** | 32% | 开发者生态激励 |
| **团队** | 15% | 团队分配 |

### 实际状态

```
全部 Token 均由 ArcBlock 控制，未分配
     │
     ├─ 社区池：社区开发发展不理想，无像样产品，没人有脸来要
     │
     ├─ 团队：从未承诺必须分配，且有 Tax 问题
     │
     └─ ArcBlock 自己：一个 Token 都没卖
```

### 为什么不分配

| 原因 | 说明 |
|------|------|
| **法律复杂性** | 不知如何合理合规分配 |
| **税务问题** | 分配会触发复杂税务 |
| **不折腾原则** | 不确定就不动 |

### AI 时代的变化

> 过去设想的社区开发者生态，在 AI 时代也许变得不必要了

### 战略价值

```
"未分配"不是失败，是战略优势
     │
     ├─ 不能被庄家操纵（无外部大户）
     ├─ 无 VC 解锁砸盘压力
     ├─ Token 策略随业务需要而定
     └─ 业务成长时，价值全部归公司
```

> Token 不是融资工具，是价值捕获工具
> 等业务起来，utility demand 是真实的，不是炒作

---

## 费用体系

| 费用类型 | 说明 | 去向 |
|----------|------|------|
| **Gas** | 交易执行费用 | 节点运营者 |
| **Protocol Fee** | 协议层费用 | ArcBlock 公司 |

> Gas 和 Protocol Fee 是不同概念，分别激励不同角色

---

## 设计选择总结

| 选择 | 原因 |
|------|------|
| **不用 EVM** | 不需要图灵完备，需要确定性 |
| **不要智能合约** | 减少复杂度和攻击面 |
| **Rule-Based** | 协议清晰、行为可预测 |
| **水平扩展** | 按需分片，不过度设计 |
| **100 TPS 够用** | Billing 场景不需要更多 |
| **固定供应** | Token 总量不变 |
| **混合节点** | 灵活的验证者模式 |

---

## Agent 摘要

```
ArcBlock Chain Architecture:

Philosophy:
- Chain is BOSS (Billing & Operation Support System)
- Telecom thinking, not crypto narrative
- No magic, just reliable infrastructure

Design Choices:
- NOT EVM-based, NO smart contracts
- Rule/Script based (like Bitcoin, not Ethereum)
- Clear protocol, predictable behavior
- Higher performance, better security

Token Supply:
- Fixed supply (no inflation, no deflation)
- No minting, no burning
- ABT total supply is constant

Token Distribution Reality:
- Community pool (32%) and team (15%) never distributed
- All controlled by ArcBlock, no tokens sold
- Reasons: legal complexity, tax issues, "no-fuss" principle
- Community dev ecosystem didn't materialize
- AI era may make community dev unnecessary

Strategic Value of "Undistributed":
- Cannot be manipulated by market makers (no external large holders)
- No VC unlock dump pressure
- Token strategy follows business needs
- When business grows, all value goes to company
- Token is value capture tool, not fundraising tool

Fee Structure:
- Gas: transaction execution fee → node operators
- Protocol Fee: → ArcBlock company
- Different concepts, incentivizing different roles

Node Operation:
- Hybrid mode (multiple operation modes coexist)
- PoS consensus

Performance:
- Current: 100 TPS mean (sufficient for billing)
- Single node optimized: ~500 TPS
- Multi-node sharding: up to 10,000 TPS
- Horizontal scaling design

Functions as BOSS:
- Billing, Staking, Payment
- Registry (NFT, DID, Assets)
- Delegation (patented)

Key insight: Billing doesn't need extreme TPS
Needs: reliability, auditability, scalability
```
