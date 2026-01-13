# NFT 设计原则与 Verifiable Credentials

> ArcBlock 的 NFT 设计与行业主流完全不同
> 核心专利：NFT 作为真实资源的数字孪生

---

## 核心设计原则

### NFT 与 VC 的关系

```
Verifiable Credentials (VC)
         │
         ├─ 可以独立存在（不一定是 NFT）
         │
         └─ 但如果是 NFT：
              └─ NFT payload 必须是 VC
```

| 规则 | 说明 |
|------|------|
| **NFT → VC** | 所有 NFT 的 payload 必须是 Verifiable Credentials |
| **VC → NFT** | VC 不一定需要是 NFT |
| **NFT ID = DID** | NFT ID 本身也是一个 DID |

### 为什么这样设计

| 目的 | 机制 |
|------|------|
| **内容可验证** | 每个 NFT 内容完全可独立验证（不依赖链） |
| **所有权验证** | 链上作为 registry 和所有权验证 |
| **Owner 确定** | 通过 NFT ownership 确定 VC 的 owner |
| **防双花** | VC 可被复制验证，但 NFT 禁止重复花费 |

---

## Digital Twin 数字孪生

### 核心概念

> **ArcBlock 体系中，任何真实资源都有对应的 NFT Digital Twin**

```
真实资源                    NFT Digital Twin
   │                              │
   ├─ Blocklet          ←→       NFT
   ├─ Server            ←→       NFT
   ├─ 账户              ←→       NFT
   ├─ 用户权限          ←→       NFT
   ├─ Agent             ←→       NFT
   └─ Agent Fleet       ←→       NFT
```

### 设计逻辑

```
1. 首先是 Verifiable Credentials
     ↓
2. 如果是线上资源 → 则是 NFT
     ↓
3. 线上资源访问控制完全基于 VC 验证
```

---

## 权限验证机制

### 验证流程

```
用户请求访问资源
     ↓
用户出示 Verifiable Credentials
     ↓
服务器独立加密验证 VC
     ↓
验证通过 → 允许访问
```

### 多层次验证

| 层次 | 验证内容 |
|------|---------|
| **第一层** | VC 本身的可验证性（签名、格式、有效期） |
| **第二层** | 链上归属权验证（NFT ownership） |

### 核心原则

> **服务器允许访问的唯一原因是：用户能出示有效 VC**

---

## 资源转移和交易机制

### 权限转移 = NFT 转移

```
权限转移
   │
   └─ = NFT Transfer
        │
        └─ 接收方获得 NFT = 拥有该资源
```

### 服务器转移

```
转移 Blocklet Server 的控制权
     ↓
只需转移对应的 NFT
     ↓
新 owner 自动获得控制权
```

### 购买资源

```
购买资源 = 购买 NFT / Verifiable Credentials
```

### 系统简化

```
真实资源的：
├─ 交换
├─ 交易
├─ 购买
└─ 转移

全部简化为：
├─ Fungible Token ↔ Non-Fungible Token 的 Exchange
└─ Non-Fungible Token 的 Transfer
```

---

## 与 ABT/Staking 的结合

### 购买流程

```
用户持有 ABT (Fungible Token)
     ↓
Exchange: ABT → 资源 NFT
     ↓
用户获得 NFT = 获得资源访问权
```

### 链上完整闭环

```
所有权: NFT (链上)
     ↓
访问权: VC (NFT payload)
     ↓
验证: 独立加密验证 + 链上归属
     ↓
交易: Token Exchange / Transfer
```

---

## 未来应用

### Agent 作为 NFT

```
Agent 部署后
     ↓
以 NFT 形式呈现
     ↓
Agent 控制权 = NFT ownership
     ↓
Agent 转移 = NFT transfer
```

### Agent Fleet 作为 NFT

```
Agent Fleet 部署后
     ↓
整个 Fleet 以 NFT 形式呈现
     ↓
Fleet 所有权 = NFT ownership
```

---

## 专利价值

| 专利 | 说明 |
|------|------|
| **NFT 作为 Digital Twin** | NFT 代表真实资源的数字孪生 |
| **核心基础设施** | 整个 ArcBlock 体系的控制系统基础 |

---

## 与主流 NFT 的区别

| 维度 | 主流 NFT | ArcBlock NFT |
|------|---------|-------------|
| **内容** | 图片/媒体 URL | Verifiable Credentials |
| **验证** | 链上 ownership 唯一 | VC 独立验证 + 链上 ownership |
| **用途** | 收藏/投机 | 真实资源的访问控制 |
| **ID** | 随机 | DID |
| **转移意义** | 换 owner | 资源控制权转移 |

---

## Agent 摘要

```
ArcBlock NFT Design Principles:

Core Rules:
- All NFT payloads MUST be Verifiable Credentials
- VC doesn't have to be NFT, but NFT content must be VC
- NFT ID itself is a DID

Digital Twin:
- Every real resource has corresponding NFT digital twin
- Blocklets, servers, accounts, permissions, agents, fleets
- Online resource access control based entirely on VC verification

Verification:
- User presents VC for independent cryptographic verification
- Multi-layer: VC verifiability + on-chain ownership
- Server allows access only if user presents valid VC

Resource Transfer:
- Permission transfer = NFT transfer
- Buying resource = buying NFT/VC
- Entire system simplified to token exchange/transfer

Patents:
- NFT as digital twin of real resources
- Foundation of ArcBlock control system
- Agents and agent fleets presented as NFTs after deployment
```
