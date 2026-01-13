# 2025年底产品重新梳理

> 状态：战略规划，2025年底产品矩阵

## 产品矩阵总览

| 类别 | 产品 | 维护成本 | AINE复杂度 | 自用 | 外部发布 | 营收 | 调整计划 |
|------|------|----------|------------|------|----------|------|----------|
| **Blockchain** | ABT Node | 👨 | 🧶 | ✓ | ✓ | | 保持 |
| | Blockchain Explorer | 👨 | 🧶 | ✓ | ✓ | | 保持 |
| **DID** | DID Wallet | 👨👨👨 | 🧶🧶🧶 | ✓ | ✓ | | 保持 |
| | DID Connect | 👨 | 🧶 | ✓ | ✓ | | 保持 |
| | DID Spaces | 👨👨 | 🧶🧶 | ✓ | ✓ | | 保持 |
| **Blocklet Infra** | Blocklet Server | 👨👨👨 | 🧶🧶🧶 | ✓ | ✓ | ✓ | 保持 |
| | Blocklet Store | 👨👨 | 🧶🧶 | ✓ | ✓ | | 保持 |
| | Blocklet Launcher | 👨 | 🧶 | ✓ | ✓ | ✓ | 保持 |
| **Blocklets** | PagesKit | 👨👨 | 🧶🧶🧶 | ✓ | ✓ | | 需要用 DocSmith 新思路 |
| | Discuss Kit | 👨👨 | 🧶🧶 | ✓ | ✓ | | 保持 |
| | NFT Market | 👨 | 🧶 | | ✓ | | 考虑 Sunset |
| | Payment Kit | 👨👨 | 🧶🧶 | ✓ | | | 保持 |
| **AIGNE** | AIGNE Framework | 👨👨👨 | 🧶🧶🧶 | ✓ | ✓ | | 保持 |
| | aigne-cli | 👨 | 🧶 | ✓ | ✓ | | 保持 |
| | aigne-studio | 👨👨 | 🧶🧶 | | | | 考虑 Sunset |
| **ArcSphere** | ArcSphere | 👨👨👨 | 🧶🧶🧶 | ✓ | ✓ | | 保持 |
| **AIStro** | AIStro | 👨👨 | 🧶🧶 | ✓ | ✓ | | 保持 |
| **Smiths** | DocSmith | 👨👨 | 🧶🧶 | ✓ | | | 保持 |
| | WebSmith | - | - | - | - | | 合并到 DocSmith |
| | Image-smith | 👨 | 🧶 | ✓ | | | 改为 Agent Skill |

## 图例说明

- **维护成本** (👨): 人力投入程度，越多越高
- **AINE 复杂度** (🧶): AI 原生工程复杂度，越多越复杂
- **自用**: 内部使用
- **外部发布**: 对外提供
- **营收**: 产生收入

## 关键战略决策

### Sunset 考虑

| 产品 | 原因 |
|------|------|
| **NFT Market** | 外部使用为主，无内部需求 |
| **aigne-studio** | 需重新评估价值 |

### 合并/重组

| 产品 | 调整 |
|------|------|
| **WebSmith** | 合并到 DocSmith |
| **PagesKit** | 用 DocSmith 新思路重新定义 |
| **Image-smith** | 从独立产品改为 Agent Skill |

### 核心保持

高维护成本但战略重要的产品：
- DID Wallet (👨👨👨)
- Blocklet Server (👨👨👨)
- AIGNE Framework (👨👨👨)
- ArcSphere (👨👨👨)

## AI 可自动开发的产品

部分产品可以通过 AI Vibe Coding 方式自动开发/维护：

| 产品 | 可行性 |
|------|--------|
| Blockchain Explorer | 适合 AI 自动开发 |
| DID Connect | 适合 AI 自动开发 |
| Blocklet Launcher | 适合 AI 自动开发 |

## 产品架构关系

```
ArcSphere (用户入口)
    ├── Agent Fleet (长期运行)
    │   ├── AIGNE Framework (Agent 定义)
    │   └── Blocklet Server (运行时)
    │
    ├── Smiths (内容生产)
    │   ├── DocSmith (文档/网站)
    │   └── Agent Skills (Image-smith等)
    │
    └── AIStro (垂直应用)

DID 体系
    ├── DID Wallet (身份管理)
    ├── DID Connect (认证)
    └── DID Spaces (存储)

Blocklet 生态
    ├── Blocklet Server (平台)
    ├── Blocklet Store (分发)
    └── Payment Kit (支付)
```

---

## Agent 摘要

```
2025 Product Reorganization Matrix.

Key decisions:
- Sunset consideration: NFT Market, aigne-studio
- Merge: WebSmith → DocSmith, PagesKit needs DocSmith new approach
- Transform: Image-smith → Agent Skill

High maintenance but strategic: DID Wallet, Blocklet Server, AIGNE Framework, ArcSphere.
AI auto-developable: Blockchain Explorer, DID Connect, Blocklet Launcher.

Core architecture: ArcSphere as entry, Agent Fleet for long-running,
Smiths for content production, DID system for identity, Blocklet ecosystem for platform.
```
