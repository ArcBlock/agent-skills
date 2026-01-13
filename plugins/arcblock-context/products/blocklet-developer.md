# Blocklet Developer 101

> Mental models are cognitive structures that help us organize, interpret, and make sense of information and experiences. They are like mental maps or schemas that guide decision-making and problem-solving.

---

## What are Blocklets?

Blocklets 是具有 Identity、Capability、Runtime Context 的最小可部署计算单元。

## What is the Blocklet Platform?

### View from 3000 feet

整个平台提供：
- 应用开发、构建、打包、分发工作流
- 可组合的运行时环境
- 基于 DID 的身份和权限系统

### View from a developer

开发者看到的是：
- Blocklet SDK 提供的运行时 API
- Blocklet Service 提供的开箱即用能力
- 组件化的开发和组合模式

---

## Rules to keep in mind for a Blocklet Developer

### Rule #0: Everything is identified by DID

| Underlying Entity | Controller | KeyPair Storage | Use Cases |
|-------------------|------------|-----------------|-----------|
| Blocklet | Developer | DID Wallet | Prove ownership of software, Receive platform incentive tokens |
| App | Site Master | DID Wallet | Receive user payments, Prove app identity to wallet, Prove app ownership |
| NFT | Owner | DID Wallet | Prove NFT ownership |
| Server | Server Owner | Server Storage | Prove server identity to wallet |
| User | User | DID Wallet | Prove account ownership to app, Receive tokens, NFTs, VCs |
| Data | Application | App Storage | It depends on the developer's design |

---

### Rule #1: Composition over Complexity

**Composition support is everywhere:**

- **Path prefix based routing**: 如 https://www.aistro.io/en
- **Navigation**: 如 https://team.arcblock.io
- **Blocklet dashboard features**: 如 `/.well-known/service/admin/components`
- **Blocklet embeds**: 如 https://www.robertmao.com/

**Each component should do one thing and do it well:**

| Component | Purpose |
|-----------|---------|
| Pages Kit | Make it easy to craft web pages |
| Media Kit | Make it easy to manage multi-media files |
| Discuss Kit | Make it easy to create and organize content |

**Each component can be enhanced with composition:**

- Discuss Kit + meilisearch → 搜索能力增强
- Discuss Kit + ai-studio → AI 能力增强

---

### Rule #2: Sharing vs Isolation

**App components share the same blocklet runtime:**

- Frontend: `window.blocklet` ([文档](https://www.arcblock.io/docs/blocklet-developer/en/blockletjs))
- Backend: `@blocklet/sdk/lib/config` ([文档](https://www.arcblock.io/docs/blocklet-developer/en/blocklet-sdk#config))

**App components are isolated by default using different processes (WIP):**

- ❌ Should not access each other's data store directly
- ✓ Should communicate with each other with `component.call`

---

### Rule #3: Decentralize by default

> Self-hosting vs centralized service

- Each component should support **self-hosting first**, then consider a centralized service without user lock-in
- Each component should **not have any centralized dependencies**
- Each component can have many instances on different servers by different users
- Each component state is **not identical** to each other

---

### Rule #4: Self-contain by default

> Easy to setup and port

- Each component should be able to start **without any extra configuration** (WIP)
- All configurations should go into **blocklet preferences**
- Each component can start from its **data backup**, which makes it easy to migrate back and forth
- **Local first**, use as few external dependencies as possible
- Add an abstract data layer when your component needs to r/w data from both local and remote (like aistro)

---

### Rule #5: Fast by default

> Slow software will die

**Users will not wait for slow pages or APIs:**

| Layer | Target |
|-------|--------|
| Frontend | Page should load within **2000ms**, leverage PWA when possible |
| Backend | API should respond within **500ms** |

**Master the improvement loop:**

```
Measure → Tune → Feedback
   ↑                 ↓
   ←←←←←←←←←←←←←←←←←←
```

- **Measure**: If you can not measure, you can not improve
- **Tune**: Do things that have max ROI
- **Feedback**: Verify and learn from the results

---

### Rule #6: Release strategy

> Think in native apps

- All users may be using **different versions** of your blocklet
- **Backward compatibility** is important, migration script should be considered

**2 release pipelines used by most official blocklets:**

| Pipeline | Store | Accessibility |
|----------|-------|---------------|
| Beta | test.store.blocklet.dev | Inaccessible from launcher service |
| Production | store.blocklet.dev | Public |

---

## Blocklet Service that works out of the box

### Authentication Service

- RBAC model
- **Caveat**: The same user in the physical world will always generate **different user DID** when visiting different apps
- Invite users, issue passports
- Built on top of DID Connect, Verifiable Credential

### Notification Service

- Send notification to DID Wallet
- Send notification to email

### Domain and SSL Certificate Service

- Automatically manage domain and SSL certificates
- Built on top of DID Domain, DID DNS and DID Registry

### Image Service

- Image resize, crop, compress
- Built on top of Sharp
- 使用方法见 [如何使用图片处理服务？](https://www.arcblock.io/docs)

### SEO Service

- **Sitemap**: [如何为应用生成 Sitemap？](https://www.arcblock.io/docs)
- **Opengraph**: [如何使用 Open Graph 服务？](https://www.arcblock.io/docs)
- **Content SEO**: [如何自定义页面 SEO 内容？](https://www.arcblock.io/docs)

### Storage Service

- Built on top of DID Space
- Backup and restore
- Per user data storage (WIP)

### Analytics Service

- Built on top of goaccess
- Traffic: requests, error, users
- Runtime: CPU/memory

---

## Agent 摘要

```
Blocklet Developer Mental Models:

Rule #0: Everything is identified by DID
Rule #1: Composition over Complexity - do one thing well, combine for power
Rule #2: Sharing vs Isolation - share runtime, isolate data, use component.call
Rule #3: Decentralize by default - self-hosting first, no centralized dependencies
Rule #4: Self-contain by default - local first, easy setup and migration
Rule #5: Fast by default - 2000ms page load, 500ms API, measure→tune→feedback
Rule #6: Release strategy - backward compatibility, beta then production

Key services: Auth (RBAC + DID), Notification, Domain/SSL, Image, SEO, Storage, Analytics
Critical caveat: Same physical user → different User DID per app
```
