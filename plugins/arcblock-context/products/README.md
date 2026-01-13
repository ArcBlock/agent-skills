# ArcBlock 产品索引

## 高密度版本

```
ArcSphere: AI Navigator（仅移动端），Skill Browser + Composer + AFS UI，用户1-10万
Agent Fleet: 新型 Blocklet，AI-native 组件运行时（开发中，2026 Q1 目标）
Blocklet Server: 部署平台，支持传统 + AI-native Blocklet（混合商业模式）
Blocklet Store: Blocklet 市场（主要免费）
Blocklet Launcher: 一键部署服务（付费）
DocSmith: AI-native 文档工具，DocOps 试验场
Discuss Kit: 综合内容可组合 Blocklet，BBS/blog/文档/chat/评论/协作
AIStro: AI 占星应用，面向消费者的垂直 AI 产品
ImageSmith: 移动端图像能力，转型为 Agent Skill
PaymentKit: 抽象支付层，支持多 token/多链（Budget-Based Billing 混合计费模式）
Promotion Kits: 增长驱动营销工具集，Share2Win/抽奖/积分/礼品卡
DID Spaces: 去中心化个人数据空间，混合架构存储（S3兼容/本地文件系统/可插拔）
DID Connect: 应用-钱包交互协议，隐私保护的 DID 派生机制
DID Names: DID 原生域名系统，所有权=NFT，启动即可用
DID Wallet: 多链多资产身份钱包，用户1-10万
AIGNE: AI 原生软件工程框架，开源（Elastic Search License），MCP完全支持
AIGNE Hub: LLM 后端统一管理服务，官方收费（Payment Kit），可自托管
ArcBlock链: 独立 L1（PoS），ABT Token（ERC-20 + 原生），ArcBridge 跨链桥
Live Document: AI Vibe Coding 时代的新出版形态
MyVibe.so: Live Document 的出版平台（开发中）
```

## 根本定位

**ArcBlock 是一个 AI-Native Engineering Company**

- ❌ 不是区块链开发平台
- ❌ 不是 dApp infra
- ❌ 不是 DID / Web3 工具链

> 我们不是"从 Web3 转 AI"，而是：Web3 本来就只是 AI-Native infra 的早期形态之一

## 核心架构原则（不妥协）

| 原则 | 说明 |
|------|------|
| **一切皆 Blocklet** | 任何服务端都是 Blocklet（包括区块链节点、DID Spaces 存储） |
| **一切皆可 Self-Host** | Launcher、Store、Spaces 等任何部件均可去中心化独立部署 |
| **一切 ID 皆 DID** | 所有身份都用 DID（包括链账户），所有验证都用 VC |

**示例**：MyVibe.so 本身是 Blocklet，ArcBlock 部署提供公共服务，用户完全可以自己部署

> **这是 ArcBlock 的核心哲学，始终坚持，从不妥协**

## 产品文件

| 产品 | 文件 | 一句话 |
|------|------|--------|
| ArcSphere | [arcsphere.md](arcsphere.md) | AI-native 浏览器与 Shell（已发布移动应用） |
| Agent Fleet | [agent-fleet.md](agent-fleet.md) | AI-native Blocklet 运行时（2026 Q1） |
| AIStro | [aistro.md](aistro.md) | AI 占星应用（消费级） |
| Blocklet Server | [blocklet-server.md](blocklet-server.md) | 可部署单元的平台（含 50 条常识） |
| Blocklet Developer | [blocklet-developer.md](blocklet-developer.md) | 开发者心智模型与规则 |
| Discuss Kit | [discuss-kit.md](discuss-kit.md) | 综合内容可组合 Blocklet |
| DID Wallet | [did-wallet.md](did-wallet.md) | 多链多资产去中心化身份钱包 |
| DocSmith | [docsmith.md](docsmith.md) | AI-native 文档工具 |
| ImageSmith | [imagesmith.md](imagesmith.md) | 移动端图像能力（转型为 Agent Skill） |
| Live Document | [live-document.md](live-document.md) | AI Vibe Coding 时代的新出版形态 |
| PaymentKit | [paymentkit.md](paymentkit.md) | 抽象支付层（Budget-Based 开发中） |
| Promotion Kits | [promotion-kits.md](promotion-kits.md) | 增长驱动营销工具集 |
| DID Spaces | [did-spaces.md](did-spaces.md) | 去中心化个人数据空间（混合架构） |
| DID Connect | [did-connect.md](did-connect.md) | 应用-钱包交互协议 |
| DID Names | [did-names.md](did-names.md) | DID 原生域名系统 |
| AIGNE | [aigne.md](aigne.md) | AI 原生软件工程框架（内部+开源） |
| AIGNE Hub | [aigne-hub.md](aigne-hub.md) | LLM 后端统一管理服务 |
| 产品矩阵 2025 | [product-matrix-2025.md](product-matrix-2025.md) | 2025年底产品重新梳理 |

## 系统族视角

ArcBlock 不是"单一产品"，而是**长期演进的系统宇宙**。

关心的不是功能是否齐全、市场是否好卖，而是：
- 抽象是否正确
- 能否承载未来 10-20 年的软件范式变化

---

## 技术主干架构

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

**AFS + AINE 才是"母体"，其他都是自然衍生**
