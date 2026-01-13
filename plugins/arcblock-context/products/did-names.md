# DID Names

> **命名说明**：正式名称是 DID Names，内部也常被称为 DID Domain / DID DNS / DID NS / DID Names Service

## 一句话定位

**基于 DID 的域名系统，所有权 = NFT**

服务入口: https://domain.didlabs.org/app

---

## 相关模块关系

```
DID Names (产品层)
    ↓ 依赖
DID Registry (DID 注册表，基础服务)
    ↓ 被调用
did-dns (DNS 协议实现模块)
```

- **DID Names**：面向用户的域名服务产品
- **DID Registry**：DID 视角的注册服务，是 DID Names 的基础
- **did-dns**：实现 DNS 协议的技术模块

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 域名解析 | DID → 域名的映射 |
| 域名配置 | 管理域名指向 |
| 域名校验 | 验证所有权 |
| 外部域名管理 | 托管非 DID 域名 |
| 二级域名托管 | 支持子域名分配 |

---

## 多重含义（关键理解）

### 1. DID 原生域名

```
Server/Blocklet 启动 → 自动获得 DID Domain
DID Domain = base32(DID)
```

- 每个 Server、Blocklet 都有 DID
- DID 自动派生出可用域名
- **启动即可用，零配置**

### 2. 域名购买与托管服务

```
用户购买域名 → 链上 NFT 代表所有权
拥有 NFT → 托管、绑定只需出示 NFT
```

- 域名所有权 = 链上 NFT
- 转移域名 = 转移 NFT
- **所有权证明极简化**

---

## 与其他产品的关系

| 产品 | 关系 |
|------|------|
| Blocklet Server | Server/App 自动获得 DID Domain |
| DID Wallet | 域名 NFT 存储在钱包 |
| Blocklet Service | Domain/SSL Certificate Service 基于此 |

---

## 设计洞察

1. **零配置可用**：DID 存在 → 域名自动存在
2. **所有权链上化**：NFT 即证明，无需中心托管
3. **分层架构**：Registry（存储）+ DNS（解析）分离

---

## Agent 摘要

```
DID Names (aka DID Domain/DID DNS/DID NS): DID-based domain system, ownership = NFT.

Module hierarchy:
- DID Names: user-facing product
- DID Registry: foundational DID registry service
- did-dns: DNS protocol implementation

Two meanings:
1. Native DID Domain: Server/Blocklet auto-gets domain from DID (base32 encoded)
2. Domain service: Buy domains, ownership = on-chain NFT

Key insight: DID exists → domain exists (zero config)
```
