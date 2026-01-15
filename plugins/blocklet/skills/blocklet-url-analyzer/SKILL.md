---
name: blocklet-url-analyzer
description: 分析 Blocklet Server 相关 URL，识别其类型（daemon/service/blocklet），并定位对应的开发仓库。支持 IP DNS 域名和常规域名的分析。
---

# Blocklet URL Analyzer

分析 Blocklet Server 生态系统中的 URL，识别请求类型并定位对应的开发仓库。

## 使用场景

- 用户提供一个 Blocklet Server 相关的 URL，想知道应该去哪个仓库开发
- 调试时需要知道某个 URL 对应的是哪个组件
- 从生产环境 URL 反向查找开发仓库

## 重要说明

**分析 URL 时必须使用终端命令（curl、wget 等）直接请求，不要使用 Chrome 浏览器进行交互式操作。**

## URL 类型分类

### 1. Blocklet Server Daemon（核心管理界面）

**特征**:
- 主域名（非 IP DNS 域名）
- 路径以 `/admin` 开头

**示例**:
```
https://node-dev-1.arcblock.io/admin/blocklets
https://node-dev-1.arcblock.io/admin/blocklets/zNKWm5HBgaTLptTZBzjHo6PPFAp8X3n8pabY/components
https://example.com/admin/settings
```

**对应仓库**: `ArcBlock/blocklet-server`

---

### 2. Blocklet Service（Blocklet 内置服务接口）

**特征**:
- IP DNS 域名（格式: `{did}-{ip}.ip.abtnet.io`）
- 路径以 `/.well-known/service/admin` 开头

**示例**:
```
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/.well-known/service/admin/overview
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/.well-known/service/admin/operations
```

**对应仓库**: `ArcBlock/blocklet-server`（service 模块）

---

### 3. 具体 Blocklet（第三方 Blocklet 应用）

**特征**:
- IP DNS 域名
- 路径以 blocklet 的 mount path 开头（非 `/.well-known`）
- 或 IP DNS 域名根路径

**示例**:
```
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/image-bin/admin/images
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/payment-kit/admin
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io
```

**对应仓库**: 需要请求 URL 分析具体是哪个 blocklet

---

## Workflow

### Phase 1: URL 解析

```javascript
// 解析 URL 获取关键信息
const url = new URL(inputUrl);
const host = url.hostname;
const path = url.pathname;
```

### Phase 2: 域名类型判断

#### 2.1 检测 IP DNS 域名

```javascript
// IP DNS 域名正则
const IP_DNS_PATTERN = /^[a-z0-9]+-(\d{1,3}-){3}\d{1,3}\.ip\.abtnet\.io$/;
const DID_DNS_PATTERN = /^[a-z0-9]+\.did\.abtnet\.io$/;

const isIpDnsDomain = IP_DNS_PATTERN.test(host) || DID_DNS_PATTERN.test(host);
```

| 域名类型 | 判断结果 |
|----------|----------|
| `*.ip.abtnet.io` | IP DNS 域名 → 可能是 Blocklet |
| `*.did.abtnet.io` | DID DNS 域名 → 可能是 Blocklet |
| 其他域名 | 常规域名 → 检查路径 |

### Phase 3: 路径类型判断

```javascript
const DAEMON_ADMIN_PATH = '/admin';
const WELLKNOWN_SERVICE_PATH = '/.well-known/service';
const WELLKNOWN_PATH = '/.well-known';
```

#### 3.1 判断流程

```
IF 非 IP DNS 域名 AND path.startsWith('/admin')
  → 类型: DAEMON
  → 仓库: ArcBlock/blocklet-server

ELSE IF IP DNS 域名 AND path.startsWith('/.well-known/service/admin')
  → 类型: BLOCKLET_SERVICE
  → 仓库: ArcBlock/blocklet-server

ELSE IF IP DNS 域名 AND (path === '/' OR !path.startsWith('/.well-known'))
  → 类型: BLOCKLET
  → 需要进一步识别具体 blocklet

ELSE IF path.startsWith('/.well-known') AND !path.startsWith('/.well-known/service')
  → 类型: WELLKNOWN
  → 仓库: ArcBlock/blocklet-server

ELSE
  → 类型: UNKNOWN
  → 需要用户提供更多信息
```

### Phase 4: Blocklet 识别（仅 BLOCKLET 类型）

当 URL 类型为 BLOCKLET 时，需要请求 API 获取具体 blocklet 信息。

#### 4.1 提取 Mount Path

```javascript
// 从路径中提取 mount path（第一段路径）
const pathParts = path.split('/').filter(Boolean);
const mountPath = pathParts.length > 0 ? `/${pathParts[0]}` : '/';
```

#### 4.2 请求 Blocklet 信息

**方法 A: 请求 DID API**

```bash
# 构造 API URL
API_URL="${ORIGIN}/.well-known/service/api/did/blocklet"
curl -sS "$API_URL" | jq '.name, .did, .title'
```

**方法 B: 请求页面分析 Meta 标签**

```bash
# 请求页面获取 HTML
curl -sS "$URL" | grep -oP '(?<=<meta name="blocklet-did" content=")[^"]*'
```

**方法 C: 请求 blocklet.json**

```bash
# 尝试获取 blocklet 元数据
curl -sS "${ORIGIN}${MOUNT_PATH}/__blocklet__.json" 2>/dev/null | jq '.name, .did'
```

#### 4.3 Blocklet 到仓库映射

已知 Blocklet 与仓库的映射关系：

| Blocklet Name | Mount Path 示例 | 仓库 |
|---------------|-----------------|------|
| `image-bin` | `/image-bin` | `ArcBlock/media-kit` |
| `payment-kit` | `/payment-kit` | `ArcBlock/payment-kit` |
| `discuss-kit` | `/discuss-kit` | `blocklet/discuss-kit` |
| `did-connect` | `/did-connect` | `ArcBlock/did-connect` |
| `launcher-kit` | `/` | `ArcBlock/launcher-kit` |
| `did-spaces` | `/` | `blocklet/did-spaces` |

**如果无法匹配**:
1. 使用 blocklet name 在 GitHub 搜索
2. 使用 AskUserQuestion 让用户确认仓库

```bash
# 搜索仓库
gh search repos "$BLOCKLET_NAME" --owner ArcBlock --owner blocklet --sort updated --limit 5
```

### Phase 5: 输出分析结果

```
===== URL 分析结果 =====

输入 URL: {INPUT_URL}

类型: {DAEMON | BLOCKLET_SERVICE | BLOCKLET | WELLKNOWN | UNKNOWN}
域名: {HOST}
路径: {PATH}

{如果是 DAEMON}
组件: Blocklet Server Daemon（核心管理界面）
仓库: ArcBlock/blocklet-server
路径: core/daemon, core/webapp

{如果是 BLOCKLET_SERVICE}
组件: Blocklet Service（blocklet 内置服务接口）
仓库: ArcBlock/blocklet-server
路径: core/service

{如果是 BLOCKLET}
组件: {BLOCKLET_NAME} ({BLOCKLET_TITLE})
DID: {BLOCKLET_DID}
Mount Path: {MOUNT_PATH}
仓库: {ORG}/{REPO}

{如果是 UNKNOWN}
无法自动识别，请提供更多信息或手动指定仓库。
```

---

## 常见 URL 模式速查

| URL 模式 | 类型 | 对应仓库 |
|----------|------|----------|
| `*/admin/*` (非 IP DNS) | DAEMON | `ArcBlock/blocklet-server` |
| `*.ip.abtnet.io/.well-known/service/admin/*` | BLOCKLET_SERVICE | `ArcBlock/blocklet-server` |
| `*.ip.abtnet.io/image-bin/*` | BLOCKLET | `ArcBlock/media-kit` |
| `*.ip.abtnet.io/payment-kit/*` | BLOCKLET | `ArcBlock/payment-kit` |
| `*.ip.abtnet.io/discuss-kit/*` | BLOCKLET | `blocklet/discuss-kit` |
| `*.ip.abtnet.io/` (根路径) | BLOCKLET | 请求 API 识别 |
| `*/.well-known/did.json` | WELLKNOWN | `ArcBlock/blocklet-server` |

---

## 与 dev-setup Skills 集成

当 `blocklet-dev-setup` 或 `blocklet-server-dev-setup` 接收到非 GitHub Issue 的 URL 时，调用本 skill 进行分析：

1. 分析 URL 类型
2. 识别对应仓库
3. 返回仓库信息给 dev-setup skill 继续执行

### 输出协议

分析完成后，输出结构化数据供调用方解析：

```
<<<BLOCKLET_URL_ANALYSIS>>>
{
  "type": "DAEMON | BLOCKLET_SERVICE | BLOCKLET | WELLKNOWN | UNKNOWN",
  "url": "原始 URL",
  "host": "域名",
  "path": "路径",
  "repo": "org/repo-name",
  "repoType": "blocklet-server | blocklet",
  "blocklet": {
    "name": "blocklet name (如果是 BLOCKLET 类型)",
    "did": "blocklet DID",
    "title": "blocklet title",
    "mountPath": "mount path"
  }
}
<<<END_BLOCKLET_URL_ANALYSIS>>>
```

---

## Error Handling

| 错误 | 处理 |
|------|------|
| URL 格式无效 | 提示用户检查 URL 格式 |
| 无法访问 URL | 提示检查网络或 URL 是否正确 |
| 无法识别 Blocklet | 使用 AskUserQuestion 让用户手动指定 |
| 仓库搜索无结果 | 提示用户提供完整仓库路径 |

---

## 示例

### 示例 1: Daemon URL

**输入**: `https://node-dev-1.arcblock.io/admin/blocklets`

**输出**:
```
类型: DAEMON
组件: Blocklet Server Daemon
仓库: ArcBlock/blocklet-server
建议: 使用 blocklet-server-dev-setup skill 配置开发环境
```

### 示例 2: Blocklet URL

**输入**: `https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/image-bin/admin/images`

**输出**:
```
类型: BLOCKLET
组件: Image Bin (Media Kit)
Mount Path: /image-bin
仓库: ArcBlock/media-kit
建议: 使用 blocklet-dev-setup skill 配置开发环境
```

### 示例 3: Blocklet Service URL

**输入**: `https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/.well-known/service/admin/overview`

**输出**:
```
类型: BLOCKLET_SERVICE
组件: Blocklet Service（内置管理接口）
仓库: ArcBlock/blocklet-server
路径: core/service
建议: 使用 blocklet-server-dev-setup skill 配置开发环境
```
