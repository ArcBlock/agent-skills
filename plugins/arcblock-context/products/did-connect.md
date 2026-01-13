# DID Connect

## 一句话定位

**基于去中心化身份的应用-钱包交互协议**

文档: https://www.arcblock.io/docs/did-connect/

---

## 产品定位

| 项目 | 说明 |
|------|------|
| **性质** | 免费技术/协议，非独立产品 |
| **定位** | 类似 Auth0，但支持完整 DID/VC |
| **集成** | 融入所有 ArcBlock 产品 |

## 支持的认证方式

| 方式 | 说明 |
|------|------|
| **DID 认证** | 基于去中心化身份 |
| **Passkey** | 无密码生物认证 |
| **Google 登录** | OAuth 集成 |
| **Apple 登录** | OAuth 集成 |
| **Email 登录** | 传统邮箱认证 |

> 完整支持 DID/VC，同时兼容传统登录方式

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 用户登录 | 无密码，基于 DID 认证 |
| 提供个人信息 | 用户授权后提供 Profile |
| VC 验证 | 提供可验证凭证（如 Passport） |
| 执行签名 | 签消息、签数据 |
| 发送交易 | 发起区块链交易 |
| 接收 VC | 应用向用户颁发证书 |

---

## 核心特性

### 隐私保护机制

```
User DID = f(Wallet DID, App DID)
```

- 同一钱包访问不同应用 → 不同 User DID
- 应用之间无法关联同一用户
- 防止跨应用追踪

### 交互模式

```
App ←→ DID Connect Protocol ←→ DID Wallet

1. App 发起请求（登录/签名/交易...）
2. Wallet 展示请求，用户确认
3. Wallet 返回结果给 App
```

---

## 与其他 Connect 协议对比

| 协议 | 生态 | 特点 |
|------|------|------|
| DID Connect | ArcBlock | 隐私保护、DID 派生、VC 支持 |
| Wallet Connect | EVM | 通用 EVM 钱包连接 |
| web3j connect | EVM | 内置浏览器注入 |

---

## 与其他产品的关系

| 产品 | 关系 |
|------|------|
| DID Wallet | Wallet 是 DID Connect 的客户端 |
| Blocklet Server | Team Service 基于 DID Connect 认证 |
| 任意 Blocklet | 可集成 DID Connect 实现用户系统 |

---

## Agent 摘要

```
DID Connect: Protocol for app-wallet interaction based on decentralized identity.

Capabilities: login, profile provision, VC verification, signing, transactions, VC issuance

Key privacy feature: User DID = f(Wallet DID, App DID)
- Same wallet + different apps = different User DIDs
- Prevents cross-app tracking

Flow: App request → Wallet shows → User confirms → Result returned
Comparison: DID Connect (privacy-first) vs WalletConnect (EVM generic)
```
