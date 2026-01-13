# AIGNE Hub

## 一句话定位

**LLM 后端统一管理服务，简化 AIGNE Framework 的模型接入**

---

## 产品形态

| 项目 | 说明 |
|------|------|
| **所属** | AIGNE 旗下 |
| **技术形态** | 是一个 Blocklet |
| **官方服务** | 收费（使用 Payment Kit 计费） |
| **用户自托管** | 可以，用户可运行自己的 Hub 管理自己的 API key |

> 遵循 ArcBlock "一切皆 Blocklet" 和 "一切皆可 Self-Host" 原则

---

## 核心功能

| 功能 | 说明 |
|------|------|
| **LLM 后端管理** | 统一管理不同的 LLM 提供商（OpenAI、Anthropic、等） |
| **API Key 管理** | 集中管理多个模型的 API key |
| **简化框架设计** | AIGNE Framework 不需要直接处理多后端复杂性 |
| **计费集成** | 通过 Payment Kit 实现使用计费 |

---

## 架构角色

```
AIGNE Framework
     │
     │ 调用
     ▼
AIGNE Hub（LLM 网关）
     │
     ├─ OpenAI
     ├─ Anthropic
     ├─ Google
     └─ 其他 LLM 后端
```

---

## 商业定位

| 维度 | 说明 |
|------|------|
| **收入贡献** | 基本不赚钱 |
| **战略价值** | 简化 AIGNE Framework 设计 |
| **定位** | 基础设施服务，非利润中心 |

---

## 部署模式

| 模式 | 说明 |
|------|------|
| **官方托管** | ArcBlock 提供的公共服务，付费使用 |
| **用户自托管** | 用户部署自己的 AIGNE Hub Blocklet，管理自己的 API key |

---

## 与其他产品的关系

| 产品 | 关系 |
|------|------|
| **AIGNE Framework** | Hub 是 Framework 的 LLM 接入层 |
| **Payment Kit** | 官方 Hub 使用 Payment Kit 计费 |
| **Blocklet Server** | Hub 作为 Blocklet 运行在 Server 上 |

---

## Agent 摘要

```
AIGNE Hub: LLM backend management service under AIGNE.

Core function: Unified gateway for different LLM providers (OpenAI, Anthropic, etc.)
Simplifies AIGNE Framework design by abstracting LLM backend complexity.

Technical: Is a Blocklet (follows "Everything is Blocklet" principle)
Official service: Paid via Payment Kit
Self-host: Users can run their own Hub to manage their own API keys

Business: Doesn't make much money, but strategic value in simplifying framework.
```
