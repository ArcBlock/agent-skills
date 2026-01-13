# Blocklet Server

## 一句话定位

**可部署、可组合计算单元的运行平台**

## 为什么重要

因为它是：
- 非 demo、非 greenfield
- 多年演化
- 多权限、多状态、多租户

> 如果一个抽象不能在 Blocklet Server 这种系统中成立，那它不算工程级抽象

## 真实复杂度

- 用户 / Developer / Admin / App 多角色
- 安装、升级、卸载
- 权限继承
- 配置分层
- 数据持久化
- 网络与服务发现

从来不认为它"好维护"，但正因为如此：**它是 AINE / AFS 的试金石**

## 战略意义

- 真实世界的复杂系统
- Legacy code + 多状态 + 多权限
- 人类工程师维护成本高

> 如果 Blocklet Server 能被 AINE / AFS 改造，那才是"工程级别的成功"

## 与 Agent Fleet 的关系

```
Blocklet Server (平台)
├── 传统 Blocklet（Web 组件）
└── Agent Fleet Blocklet（AI-native 组件）
```

不是替换关系，是扩展关系。

---

## ArcBlocker 应熟知的 50 个 Blocklet 常识

### 平台基本常识

1. Blocklet Server 是整个平台的基座，结合 Blocklet Store 提供完整的应用开发、构建、打包、分发工作流。产品早期叫 ABT Node，后来品牌统一时改为 Blocklet Server

2. Blocklet Server 的核心能力是**可组合**，提供路由、导航、控制台等多角度、全方位的可组合能力。所有官方服务都是不同的应用组合，所有功能模块都是 Blocklet，所有 Blocklet 都应该支持组合使用

3. Blocklet Server 运行时产生的主要实体都有 DID，包括 Server、Blocklet、App、User。绝大部分 DID 都是在 DID Wallet 中产生并保管，Server DID 除外。生态的 DID 默认使用 base58 编码

4. Blocklet Server 中可安装的 Blocklet 都有 DID（类似于软件 DID），是在 Blocklet Studio 或 Create Blocklet 中由开发者生成的，Blocklet DID 是全宇宙唯一的

5. Blocklet Server 中的 App DID 可以变化（基于链的 Migration 机制），但仅在必要时这么做

6. **【关键常识】** User DID 是以 `Wallet DID + App DID` 为参数派生出来的，其中 Wallet DID 由钱包的助记词唯一确定。这意味着：
   - 不同钱包在相同应用下派生出来的 User DID 不同
   - 相同钱包在不同应用下派生出来的 User DID 也不同

7. Blocklet Server 和 App 运行时都有自己的 DID Domain，默认提供两个 DID Domain。DID Domain 是根据 DID 派生出来的域名，是对 DID 做了 base32 转码

8. Blocklet Server 和 App 都可以添加任意多个自定义域名。绑定到相同服务的不同域名都可以获取相同的内容，但因为跨域原因，这些域名之间的登录会话不是共享的

### Server 基本常识

9. Blocklet Server 的配置文件和运行过程中产生的所有数据都保存在本地的 `.blocklet-server` 目录下，产生这个目录是靠 `blocklet server init`

10. Blocklet Server 在任何机器上都可以存在很多个实例（本质就是多个 `.blocklet-server` 目录），但同时运行中的只能有一个

11. Blocklet Server 目录是可以挪动、复制的，挪动后需要重启 Server：`blocklet server start --update-blocklet-env`

12. Blocklet Server 启动时会自动从当前目录逐级往上查找 `.blocklet-server` 目录，如果发现，就以其作为目标节点启动

13. Blocklet Server 中的应用数量取决于所在机器的硬件配置，配置越高，可同时运行的数量越多。最低硬件要求是 1C、1G

14. Blocklet Server 中的应用可以包含任意多个组件，能够通过 WEB 访问的组件通常有挂载点。**【需要谨慎】** 组件的挂载点可以修改，修改之后原挂载点会失效

15. Blocklet Server 中的应用中不同组件都可以独立管理：启动、停止、重启、升级

16. Blocklet Server 中不同组件都可以有自己的偏好配置，这些偏好配置默认情况下是相互隔离的，见 Blocklet Preferences

17. Blocklet Server 默认使用 SQLite 作为数据库，Server 自身的数据库和每个 Blocklet 的数据库是隔离的（独立的文件）。SQLite 支持多进程读写

18. Blocklet Server 中的应用以及应用的组件都有各自的数据目录，各个组件对这些数据目录有读写限制（基于 Node.js 的 File Permission 实现）

### Server 运行常识

19. Blocklet Server 默认情况下会先尝试使用 80/443 端口和 Nginx，如果不可用，会尝试使用 8080/8443 端口

20. Blocklet Server 默认把控制台挂载到 `/.well-known/server/admin` 路径下，可通过 `.blocklet-server/config.yml` 修改，通常不需要这么做

21. **【常见问题】** 如果所处网络环境发生变化（尤其是 IP 变化），需要重启 Server，否则 DID Domain 解析会出问题

22. Blocklet Server 默认先尝试使用 Nginx 作为路由引擎，如果不可用，会用内置的 Node.js 引擎（用 Node.js 写反向代理是可行的，性能还不错）

23. Blocklet Server 默认占用 40406、40407 两个端口，目前无法指定

24. 随着安装的 Blocklet 变多，会逐步占用 8089 及以上的系统端口，起始端口可在配置文件指定，启动后修改也可以

25. Blocklet Server 运行时的常驻进程有三个：EventHub、Daemon、Service。还有两个动态按需启动、用完即关的进程：Updater、Rotator

26. Blocklet Server 可以通过路由前缀的方式挂载其他应用，即直接通过 Server 访问应用

27. Blocklet Server 可以通过编程方式访问，参见 `@abtnode/client`。Server 内置但隐藏了 GraphQL 试验台：`/.well-known/server/admin/console`

### Blocklet 运行常识

28. Blocklet 后端获取运行时配置、偏好需要通过 `@blocklet/sdk/lib/config` 来获取

29. Blocklet 前端获取运行时配置、偏好需要通过 `__blocklet__.js` 来获取，已内置在 Create Blocklet 模板中，可通过 `window.blocklet` 获取

30. Blocklet 前端请求 `__blocklet__.js` 可以在任意 URL 前缀下，内部这个请求的内容是按应用/组件维度缓存的，有自动失效机制

31. Blocklet 后端组件间的调用应该被保护，通过 `@blocklet/sdk/lib/component` 实现

32. Blocklet 有全局的多租户开关，默认关闭。前端和后端都可以拿到：`Config.env.tenantMode` 和 `window.blocklet.tenantMode`

33. Blocklet 前端请求静态资源的标准路径是 `/.blocklet/proxy/{blockletDid}/{resourcePath}`，这些静态资源默认应该被缓存

34. Blocklet 前端请求的所有可缓存资源，都可以通过 URL 携带 `nocache=1` 跳过缓存，另一种方法是 `t={timestamp}`

35. Blocklet 组件被请求时，如果组件不在运行状态，会收到 503 状态码

### Blocklet Service 常识

36. **【重要知识】** Blocklet Service 被设计成始终可以访问的，即使应用出问题。就好比应用可以崩溃、出错，但操作系统始终会兜底（重启、删除、升级应用）

37. **Routing Service**：基于挂载点（前缀匹配）的路由组合能力。请求处理链条：`Browser --> Server Router --> Blocklet Service --> Blocklet`（部分请求会转发到 Server Daemon，部分反向代理会去掉前缀）

38. **Team Service**：
   - 基于 DID Connect 的用户认证能力
   - 基于 OAuth 的用户认证能力
   - 基于角色的、可扩展的权限控制能力
   - 用户管理 + 会话管理
   - 权限控制默认粒度是组件，开发者可以细到 API 级别

39. **Notification Service**：可横向扩展的通知能力，支持的渠道包括邮件、推送、钱包内、Server 内

40. **Image Service**：基于 Sharp 的图片转换、裁剪、缩放能力，仅需通过 Query 参数就可以自由控制，开发多媒体应用时需要考虑使用以提高性能

41. **Navigation Service**：基于 `blocklet.yml#navigation` 字段的自动导航组合能力，可以组合顶部、底部、控制台、右上角的导航条目

42. **Analytics Service**：提供实时运行时 CPU、内存消耗统计，以及按天的访问量统计（需要 goaccess 可执行文件，如果没有则该功能不可用）

43. **Logging Service**：应用运行时打印的日志可以实时在应用控制台查看，不同组件的日志也是隔离的

44. **Cache Service**：Router 和 Blocklet Service 中对于静态资源、Image Service 处理过的资源会有二级缓存，可以从 Blocklet 和 Server 两个层面去清理缓存

45. **Storage Service**：支持和 DID Spaces 无缝集成，可以把 DID Spaces 想象成 U 盘，Server 中的应用可以自动或手动备份到 U 盘中，之后只要有应用的控制权，可以完整还原

46. **SEO Service**：Blocklet Server 提供默认但可扩展的 Open Graph、Sitemap 服务

### 常见接口一览

47. `/.well-known/server/admin` - 默认的 Server 控制台挂载点，可修改但修改后需重启方能生效

48. `/.well-known/service/admin` - 默认的 Blocklet Service 挂载点，不可修改，通常需要 owner/admin 身份登录

49. `/.well-known/service/health` - 默认的 Blocklet 健康检查接口，可以拿到所有组件的运行状态，常用于监控系统

50. 其他常见接口：
    - `/.well-known/service/blocklet/logo` - Blocklet Logo 接口，有缓存，后台配置修改后生效会有延迟
    - `/.well-known/service/login` - 应用的登录界面，可手动拼接直接访问
    - `/.well-known/service/user/avatar/{userDid}` - 用户头像，可加 imageFilter 参数
    - `/.well-known/did.json` - 返回 Server 或应用的 DID Document

---

## Agent 摘要

```
Blocklet Server is the deployment platform for composable compute units.
It's multi-year evolved, multi-role, multi-tenant - real complexity.
It's the stress test for AINE/AFS abstractions.
If abstractions don't work here, they're not engineering-grade.
Agent Fleet is a new Blocklet type, not a replacement.

Key technical facts:
- Core capability: composability (routing, navigation, console)
- All entities have DID: Server, Blocklet, App, User
- User DID = derived from Wallet DID + App DID (critical knowledge)
- Data stored in .blocklet-server directory
- Default ports: 80/443 or 8080/8443, plus 40406/40407
- Uses SQLite with isolated databases per Blocklet
- 10+ Blocklet Services: Routing, Team, Notification, Image, Navigation, Analytics, Logging, Cache, Storage, SEO
- Blocklet Service is always accessible even when app fails (OS-level guarantee)
```
