# DID Wallet

## 一句话定位

**多链、多资产、支持去中心化身份管理的数字钱包**

## 获取方式

- 官网: https://www.didwallet.io/
- iOS App Store / Google Play

---

## 核心功能

### 1. 资产管理

#### 链的管理
- 支持多链

#### 链上资产管理

**Token:**
- 创新：同一种 Token 的数量进行汇总
- 例：10000 个 ABT，用户看总数时不需要关注 ArcBlock 链有多少、EVM 链有多少

**NFT:**
- 跨链 NFT 管理

#### 链下资产管理
- 可验证凭证 VC（如 Server 的 Passport）

#### 其他资产操作
- 链上授权管理
- 链上质押管理
- 换币管理
  - ArcBlock 链的 Bridge
  - Base 链的 Bridge

#### 钱包管理
- 多钱包支持
- 基于 DID Spaces 的自动备份
- 基于备份文件的手动备份

---

### 2. Connect 协议支持

#### 2.1 DID Connect

**ArcBlock 自己的 Connect 协议，基于去中心化身份。**

文档: https://www.arcblock.io/docs/did-connect/

**核心特点：**

- **隐私保护**: 用户用同一个钱包和不同应用 Connect 时，会基于 DID Connect 协议派生和应用一一对应的账户
- **签名能力**:
  - 签消息
  - 签交易
- **Profile 提供**: 可以提供 Profile 给应用
- **Passport 提供**: 可以提供 Passport 给应用
- **私钥派生**: 可用于私钥派生和管理

#### 2.2 Wallet Connect

- EVM 系的 Connect 协议
- 目前支持到 V2

#### 2.3 内置浏览器 web3j connect

- 基于 trust wallet js 实现
- 可以在钱包内置浏览器完成账户的 connect
- 一般用于 EVM 系的应用

---

### 3. 个人 Profile 管理

- Profile 的增删改查

---

### 4. 联系人管理

- 好友的增删改查

---

### 5. 应用管理

#### 我 owner 的应用管理（第 4 个 Tab）
- 我 owner 的应用的资产情况

#### 我访问过的应用管理（第 2 个 Tab）
- 我的钱包和我访问过的应用产生的账户的管理

---

### 6. 应用 Feed 流查看（第 2 个 Tab）

- Marketplace 推的热门 NFT Feed 流
- Token Data 推的币价 Feed 流
- Blocklet Server 推的 Server Status Feed 流

---

### 7. 应用消息查看（第 3 个 Tab）

- 支持多种消息类型
- 参见 Wallet Message Protocol

---

## 与其他产品的关系

| 产品 | 关系 |
|------|------|
| **Blocklet Server** | 用户 DID 由 Wallet 派生；Server 可推送消息到 Wallet |
| **DID Spaces** | 钱包自动备份存储 |
| **DID Connect** | Wallet 是 DID Connect 的客户端 |
| **ArcSphere** | 共享 DID 登录 |

## 支持的区块链

| 类型 | 支持内容 |
|------|----------|
| **ArcBlock 链** | 原生支持 |
| **EVM 兼容链** | 多条 EVM 链支持 |

---

## 关键技术点

**User DID 派生机制（关键常识）：**
- User DID = 派生自 `Wallet DID + App DID`
- 同一个钱包访问不同应用 → 不同的 User DID
- 保护用户隐私，防止跨应用追踪

---

## Agent 摘要

```
DID Wallet is a multi-chain, multi-asset digital wallet with decentralized identity management.

Core features:
- Asset management: tokens (aggregated view), NFTs, VCs, staking, bridges
- Multi-wallet support with DID Spaces backup
- Three connect protocols: DID Connect, Wallet Connect V2, web3j
- DID Connect: privacy-preserving (different User DID per app), signing, profile/passport provision
- Profile, contacts, app management
- Feed streams and message notifications

Key insight: Same wallet + different apps = different User DIDs (privacy protection)
```
