# ArcBlock 技术索引

## 高密度版本

```
AFS: AI-Native 系统抽象层，Everything is File/View/Context/Identity（基础已实现，高级功能设计中）
AINE: 为不确定计算主体设计的工程体系
DID: 可追责的主体标识，不是钱包
Capability: 最小授权单元，与 Identity 分离
Chamber: AINE 里的抽象执行环境概念（与 Agent Skill 是不同维度）
Blocklet: 有身份、有能力声明的最小可部署单元
Agent Skill: Agent 的能力声明，可在 Agent Fleet 上运行
```

## 核心架构原则（不妥协）

```
一切皆 Blocklet：任何服务端都是 Blocklet，运行在 Blocklet Server（包括区块链节点、DID Spaces）
一切皆可 Self-Host：Launcher、Store、Spaces 等任何部件均可去中心化独立部署
一切 ID 皆 DID：所有身份都用 DID（包括链账户），所有验证都用 VC
```

> **这是 ArcBlock 的核心哲学，始终坚持，从不妥协**

## 重要概念区分

| 概念 | 所属体系 | 说明 |
|------|---------|------|
| **Chamber** | AINE | 抽象执行环境，用于约束 AI 行为 |
| **Agent Skill** | Agent Fleet | 能力声明，可被 Agent 调用 |

> 两者是**完全不同维度的概念**，没有必然关系

## 核心判断

**AFS + AINE 是"母体"，其他都是衍生**

## 技术文件

| 技术 | 文件 | 一句话 |
|------|------|--------|
| AFS | [afs.md](afs.md) | AI-Native 系统抽象层 |
| AINE | [aine.md](aine.md) | 不确定计算主体的工程体系 |
| DID + Capability | [did-capability.md](did-capability.md) | 身份与能力分离 + Delegation |
| Blocklet 技术 | [blocklet.md](blocklet.md) | 有边界的最小部署单元 |
| ABT Staking | [abt-staking.md](abt-staking.md) | Staking for X 通用框架 |
| NFT + VC | [nft-vc-design.md](nft-vc-design.md) | NFT 作为真实资源的 Digital Twin |
| CreditToken | [credittoken-design.md](credittoken-design.md) | USD 计费合规设计（不可转移） |
| 链架构 | [chain-architecture.md](chain-architecture.md) | BOSS 思维，Rule-Based 设计 |

## 架构全景

```
AI-Native Engineering (AINE)
│
├─ AFS (Agentic File System)          ← 核心系统抽象
│
├─ Agent / Skill / Chamber Runtime    ← 执行与不确定性承载
│
├─ Identity / DID / Capability        ← 权限、边界、信任
│
├─ Blocklet Runtime & Server          ← 可部署、可组合的单元
│
├─ ArcSphere (AI Browser / Shell)     ← 人与 Agent 的入口
│
└─ Tooling / DocOps / UI / Payment    ← 外围系统
```

## 技术栈

| 类别 | 技术 |
|------|------|
| **主要语言** | TypeScript / JavaScript（但 Blocklet 支持任意语言） |
| **区块链** | ArcBlock 链（PoS 共识） |
| **Token** | ABT（Billing、Staking、Payment） |
| **协议** | MCP（Model Context Protocol）完全支持 |

## ArcBlock 链定位

> 链 = Billing and Operation Support System (BOSS)
> Telecom 思维，Rule-Based 设计，不用 EVM，不要智能合约

| 用途 | 说明 |
|------|------|
| **Billing** | 计费和结算 |
| **Staking** | 服务质押（安全保障、防止作恶者） |
| **Payment** | 生态伙伴支付结算 |

| 性能 | 数值 |
|------|------|
| **当前** | 100 TPS（足够 Billing） |
| **单机** | ~500 TPS |
| **分片** | 可达 10,000 TPS |

## 学术认可

- AINE 相关论文已被 **ICSA 2026** 接收
