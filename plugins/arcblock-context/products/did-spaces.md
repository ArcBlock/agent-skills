# DID Spaces

## 一句话定位

**去中心化的个人数据空间，数据主权归用户**

## 产品形态

| 项目 | 说明 |
|------|------|
| **技术形态** | 是一个 Blocklet |
| **部署模式** | 可完全自托管 |
| **存储后端** | S3 兼容、本地文件系统、可插拔设计 |

> 遵循 ArcBlock "一切皆 Blocklet" 和 "一切皆可 Self-Host" 原则

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 数据权限设置 | 用户控制谁能访问什么 |
| 隐私保护 | 数据加密，用户持有密钥 |
| 可定制空间 | 个人数字空间，自由组织 |
| 多应用支持 | 不同应用可接入同一空间 |
| 随用随插 | 像 U 盘一样，插入即用 |
| 安全备份 | 数据持久化，可恢复 |
| 数据自管理 | 用户自己管理，无中心托管 |

---

## 核心隐喻

**DID Spaces = 个人数据 U 盘**

```
传统模式：
App A 存数据 → A 的服务器
App B 存数据 → B 的服务器
（数据分散，用户无控制权）

DID Spaces 模式：
App A 存数据 → 用户的 DID Space
App B 存数据 → 用户的 DID Space
（数据集中在用户控制的空间）
```

---

## 与其他产品的关系

| 产品 | 集成方式 |
|------|----------|
| DID Wallet | 钱包数据自动备份到 DID Spaces |
| Blocklet Server | Storage Service 基于 DID Spaces 实现 |
| 任意 Blocklet | 可接入用户的 DID Space 存取数据 |

---

## 设计原则

1. **用户主权**：数据归属用户，不是平台
2. **可携带性**：换应用不丢数据
3. **透明访问**：用户清楚谁访问了什么

---

## Agent 摘要

```
DID Spaces: Decentralized personal data storage with user sovereignty.

Core features:
- Permission control: user decides who accesses what
- Privacy: encrypted, user holds keys
- Multi-app: one space serves multiple apps
- Plug-and-play: like a personal USB drive
- Backup: secure, recoverable

Mental model: Your data lives in YOUR space, apps just connect to it.
Integrates with: DID Wallet (auto-backup), Blocklet Server (Storage Service)
```
