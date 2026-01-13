# ArcBlock Context

公司产品、技术架构、战略知识库。按需自动加载。

## Loading Priority

文件加载优先级（First match wins）：

1. **Project override**: `./.claude/arcblock-context/{path}`
2. **User override**: `~/.claude/arcblock-context/{path}`
3. **Plugin default**: This plugin's `{path}`

## Active Loading Policy (ALP)

按上下文自动加载相关文件。不确定时先读 README 获取摘要。

### Products

| 触发场景 | 加载文件 |
|---------|---------|
| 涉及产品全局定位 | `products/README.md` |
| 涉及 ArcSphere | `products/arcsphere.md` |
| 涉及 Agent Fleet | `products/agent-fleet.md` |
| 涉及 Blocklet Server | `products/blocklet-server.md` |
| 涉及 Blocklet 开发 | `products/blocklet-developer.md` |
| 涉及 DID Wallet | `products/did-wallet.md` |
| 涉及 DocSmith | `products/docsmith.md` |
| 涉及 ImageSmith | `products/imagesmith.md` |
| 涉及 PaymentKit | `products/paymentkit.md` |
| 涉及 Promotion Kits / 增长活动 | `products/promotion-kits.md` |
| 涉及 DID Spaces / 数据空间 | `products/did-spaces.md` |
| 涉及 DID Connect / 用户认证 | `products/did-connect.md` |
| 涉及 DID Names / 域名 | `products/did-names.md` |
| 涉及 AIGNE / AI 原生框架 | `products/aigne.md` |
| 涉及 AIGNE Hub | `products/aigne-hub.md` |
| 涉及 AIStro | `products/aistro.md` |
| 涉及 Discuss Kit | `products/discuss-kit.md` |
| 涉及 Live Document | `products/live-document.md` |
| 涉及产品矩阵规划 | `products/product-matrix-2025.md` |

### Technical

| 触发场景 | 加载文件 |
|---------|---------|
| 涉及技术全局架构 | `technical/README.md` |
| 涉及 AFS | `technical/afs.md` |
| 涉及 AINE | `technical/aine.md` |
| 涉及 DID / Capability | `technical/did-capability.md` |
| 涉及 Blocklet 技术 | `technical/blocklet.md` |
| 涉及 ABT Staking | `technical/abt-staking.md` |
| 涉及 NFT / VC 设计 | `technical/nft-vc-design.md` |
| 涉及 CreditToken | `technical/credittoken-design.md` |
| 涉及链架构 | `technical/chain-architecture.md` |

### Strategy

| 触发场景 | 加载文件 |
|---------|---------|
| 涉及公司战略方向 | `strategy/README.md` |

## Override 使用场景

### 项目级 Override（`./.claude/arcblock-context/`）
- 项目对某产品有特殊理解或扩展
- 项目特定的技术决策记录
- 临时覆盖测试

### 用户级 Override（`~/.claude/arcblock-context/`）
- 个人补充的见解
- 还没 merge 到主库的更新
- 个人视角的理解

## 核心原则

### 公司定位
**ArcBlock 是一个 AI-Native Engineering Company**

- ❌ 不是区块链开发平台
- ❌ 不是 dApp infra
- ❌ 不是 DID / Web3 工具链

> Web3 本来就只是 AI-Native infra 的早期形态之一

### 技术核心
**AFS + AINE 是"母体"，其他产品都是自然衍生**

### 不妥协原则
- 一切皆 Blocklet
- 一切皆可 Self-Host
- 一切 ID 皆 DID
