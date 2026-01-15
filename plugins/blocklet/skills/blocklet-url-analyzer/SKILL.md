---
name: blocklet-url-analyzer
description: Analyze Blocklet Server related URLs, identify their type (daemon/service/blocklet), and locate the corresponding development repository. Supports analysis of IP DNS domains and regular domains.
---

# Blocklet URL Analyzer

Analyze URLs in the Blocklet Server ecosystem, identify request types, and locate corresponding development repositories.

## Use Cases

- User provides a Blocklet Server related URL and wants to know which repository to develop in
- During debugging, need to know which component a URL corresponds to
- Reverse lookup development repository from production environment URL

## Important Note

**When analyzing URLs, must use terminal commands (curl, wget, etc.) to make requests directly. Do not use Chrome browser for interactive operations.**

## URL Type Classification

### 1. Blocklet Server Daemon (Core Management Interface)

**Characteristics**:
- Main domain (not IP DNS domain)
- Path starts with `/admin`

**Examples**:
```
https://node-dev-1.arcblock.io/admin/blocklets
https://node-dev-1.arcblock.io/admin/blocklets/zNKWm5HBgaTLptTZBzjHo6PPFAp8X3n8pabY/components
https://example.com/admin/settings
```

**Corresponding repository**: `ArcBlock/blocklet-server`

---

### 2. Blocklet Service (Blocklet Built-in Service Interface)

**Characteristics**:
- IP DNS domain (format: `{did}-{ip}.ip.abtnet.io`)
- Path starts with `/.well-known/service/admin`

**Examples**:
```
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/.well-known/service/admin/overview
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/.well-known/service/admin/operations
```

**Corresponding repository**: `ArcBlock/blocklet-server` (service module)

---

### 3. Specific Blocklet (Third-party Blocklet Applications)

**Characteristics**:
- IP DNS domain
- Path starts with blocklet's mount path (not `/.well-known`)
- Or IP DNS domain root path

**Examples**:
```
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/image-bin/admin/images
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/payment-kit/admin
https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io
```

**Corresponding repository**: Need to request URL to analyze which specific blocklet

---

## Workflow

### Phase 1: URL Parsing

```javascript
// Parse URL to get key information
const url = new URL(inputUrl);
const host = url.hostname;
const path = url.pathname;
```

### Phase 2: Domain Type Detection

#### 2.1 Detect IP DNS Domain

```javascript
// IP DNS domain regex
const IP_DNS_PATTERN = /^[a-z0-9]+-(\d{1,3}-){3}\d{1,3}\.ip\.abtnet\.io$/;
const DID_DNS_PATTERN = /^[a-z0-9]+\.did\.abtnet\.io$/;

const isIpDnsDomain = IP_DNS_PATTERN.test(host) || DID_DNS_PATTERN.test(host);
```

| Domain Type | Detection Result |
|-------------|------------------|
| `*.ip.abtnet.io` | IP DNS domain → Possibly Blocklet |
| `*.did.abtnet.io` | DID DNS domain → Possibly Blocklet |
| Other domains | Regular domain → Check path |

### Phase 3: Path Type Detection

```javascript
const DAEMON_ADMIN_PATH = '/admin';
const WELLKNOWN_SERVICE_PATH = '/.well-known/service';
const WELLKNOWN_PATH = '/.well-known';
```

#### 3.1 Detection Flow

```
IF not IP DNS domain AND path.startsWith('/admin')
  → Type: DAEMON
  → Repository: ArcBlock/blocklet-server

ELSE IF IP DNS domain AND path.startsWith('/.well-known/service/admin')
  → Type: BLOCKLET_SERVICE
  → Repository: ArcBlock/blocklet-server

ELSE IF IP DNS domain AND (path === '/' OR !path.startsWith('/.well-known'))
  → Type: BLOCKLET
  → Need further identification of specific blocklet

ELSE IF path.startsWith('/.well-known') AND !path.startsWith('/.well-known/service')
  → Type: WELLKNOWN
  → Repository: ArcBlock/blocklet-server

ELSE
  → Type: UNKNOWN
  → Need user to provide more information
```

### Phase 4: Blocklet Identification (BLOCKLET Type Only)

When URL type is BLOCKLET, need to request API to get specific blocklet information.

#### 4.1 Extract Mount Path

```javascript
// Extract mount path (first path segment) from path
const pathParts = path.split('/').filter(Boolean);
const mountPath = pathParts.length > 0 ? `/${pathParts[0]}` : '/';
```

#### 4.2 Request Blocklet Information

**Method A: Request DID API**

```bash
# Construct API URL
API_URL="${ORIGIN}/.well-known/service/api/did/blocklet"
curl -sS "$API_URL" | jq '.name, .did, .title'
```

**Method B: Request Page to Analyze Meta Tags**

```bash
# Request page to get HTML
curl -sS "$URL" | grep -oP '(?<=<meta name="blocklet-did" content=")[^"]*'
```

**Method C: Request blocklet.json**

```bash
# Try to get blocklet metadata
curl -sS "${ORIGIN}${MOUNT_PATH}/__blocklet__.json" 2>/dev/null | jq '.name, .did'
```

#### 4.3 Blocklet to Repository Mapping

Known Blocklet to repository mapping:

| Blocklet Name | Mount Path Example | Repository |
|---------------|-------------------|------------|
| `image-bin` | `/image-bin` | `ArcBlock/media-kit` |
| `payment-kit` | `/payment-kit` | `ArcBlock/payment-kit` |
| `discuss-kit` | `/discuss-kit` | `blocklet/discuss-kit` |
| `did-connect` | `/did-connect` | `ArcBlock/did-connect` |
| `launcher-kit` | `/` | `ArcBlock/launcher-kit` |
| `did-spaces` | `/` | `blocklet/did-spaces` |

**If no match found**:
1. Search GitHub using blocklet name
2. Use AskUserQuestion to let user confirm repository

```bash
# Search repositories
gh search repos "$BLOCKLET_NAME" --owner ArcBlock --owner blocklet --sort updated --limit 5
```

### Phase 5: Output Analysis Result

```
===== URL Analysis Result =====

Input URL: {INPUT_URL}

Type: {DAEMON | BLOCKLET_SERVICE | BLOCKLET | WELLKNOWN | UNKNOWN}
Domain: {HOST}
Path: {PATH}

{If DAEMON}
Component: Blocklet Server Daemon (Core Management Interface)
Repository: ArcBlock/blocklet-server
Path: core/daemon, core/webapp

{If BLOCKLET_SERVICE}
Component: Blocklet Service (Blocklet Built-in Service Interface)
Repository: ArcBlock/blocklet-server
Path: core/service

{If BLOCKLET}
Component: {BLOCKLET_NAME} ({BLOCKLET_TITLE})
DID: {BLOCKLET_DID}
Mount Path: {MOUNT_PATH}
Repository: {ORG}/{REPO}

{If UNKNOWN}
Cannot identify automatically, please provide more information or manually specify repository.
```

---

## Common URL Pattern Quick Reference

| URL Pattern | Type | Corresponding Repository |
|-------------|------|-------------------------|
| `*/admin/*` (not IP DNS) | DAEMON | `ArcBlock/blocklet-server` |
| `*.ip.abtnet.io/.well-known/service/admin/*` | BLOCKLET_SERVICE | `ArcBlock/blocklet-server` |
| `*.ip.abtnet.io/image-bin/*` | BLOCKLET | `ArcBlock/media-kit` |
| `*.ip.abtnet.io/payment-kit/*` | BLOCKLET | `ArcBlock/payment-kit` |
| `*.ip.abtnet.io/discuss-kit/*` | BLOCKLET | `blocklet/discuss-kit` |
| `*.ip.abtnet.io/` (root path) | BLOCKLET | Request API to identify |
| `*/.well-known/did.json` | WELLKNOWN | `ArcBlock/blocklet-server` |

---

## Integration with dev-setup Skills

When `blocklet-dev-setup` or `blocklet-server-dev-setup` receives a URL that is not a GitHub Issue, call this skill to analyze:

1. Analyze URL type
2. Identify corresponding repository
3. Return repository info to dev-setup skill to continue execution

### Output Protocol

After analysis completes, output structured data for caller to parse:

```
<<<BLOCKLET_URL_ANALYSIS>>>
{
  "type": "DAEMON | BLOCKLET_SERVICE | BLOCKLET | WELLKNOWN | UNKNOWN",
  "url": "original URL",
  "host": "domain",
  "path": "path",
  "repo": "org/repo-name",
  "repoType": "blocklet-server | blocklet",
  "blocklet": {
    "name": "blocklet name (if BLOCKLET type)",
    "did": "blocklet DID",
    "title": "blocklet title",
    "mountPath": "mount path"
  }
}
<<<END_BLOCKLET_URL_ANALYSIS>>>
```

---

## Error Handling

| Error | Handling |
|-------|----------|
| Invalid URL format | Prompt user to check URL format |
| Cannot access URL | Prompt to check network or if URL is correct |
| Cannot identify Blocklet | Use AskUserQuestion to let user manually specify |
| No repository search results | Prompt user to provide complete repository path |

---

## Examples

### Example 1: Daemon URL

**Input**: `https://node-dev-1.arcblock.io/admin/blocklets`

**Output**:
```
Type: DAEMON
Component: Blocklet Server Daemon
Repository: ArcBlock/blocklet-server
Suggestion: Use blocklet-server-dev-setup skill to configure development environment
```

### Example 2: Blocklet URL

**Input**: `https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/image-bin/admin/images`

**Output**:
```
Type: BLOCKLET
Component: Image Bin (Media Kit)
Mount Path: /image-bin
Repository: ArcBlock/media-kit
Suggestion: Use blocklet-dev-setup skill to configure development environment
```

### Example 3: Blocklet Service URL

**Input**: `https://bbqaqc2vvt4mte2n4mta7dlgpsoxakc2gejo3wrrx34-18-180-145-193.ip.abtnet.io/.well-known/service/admin/overview`

**Output**:
```
Type: BLOCKLET_SERVICE
Component: Blocklet Service (Built-in Management Interface)
Repository: ArcBlock/blocklet-server
Path: core/service
Suggestion: Use blocklet-server-dev-setup skill to configure development environment
```
