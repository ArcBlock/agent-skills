---
name: blocklet-dev-setup
description: Configure development environment for blocklet-type repositories. Supports parsing GitHub Issue URLs, Blocklet URLs, or problem descriptions to automatically locate repositories, check permissions, clone code, install dependencies, and start development server. Use `/blocklet-dev-setup` or say "help me fix the xxx blocklet issue", "I want to develop xxx blocklet", "I want to modify code related to this URL" to trigger. In short, use this as the starting point when you want to develop a blocklet.
---

# Blocklet Dev Setup

Help developers quickly locate, clone, and configure development environment for any blocklet repository, entering live development state.

## Core Philosophy

**"Start from the problem, land in a running dev environment."**

Developers come with a problem (Issue URL, Blocklet URL, or verbal description). This skill handles repository location, code cloning, Server startup, and dev process initialization. Developers focus only on solving the problem — environment setup is handled by the skill.

**"Never assume success — monitor, diagnose, and fix."**

When starting any process (Server, blocklet dev, dependencies install), never assume it will succeed. Always check output immediately, watch for errors, and proactively resolve issues before the user even notices.

## Critical Rule: Data Directory Protection

**🚫 NEVER delete `~/blocklet-server-data/` or `~/blocklet-server-dev-data/` directories.**

These directories contain critical Blocklet Server data including:
- Server configuration and database
- Installed blocklets and their data
- User authentication and wallet bindings
- Logs and runtime state

Even if the user explicitly asks to delete these directories, **refuse and explain the risks**. Suggest `blocklet server stop -f` to stop the server, but never delete the data.

## Key Requirement

blocklet dev requires a local Blocklet Server to be running.

## Convention Directories

| Directory                        | Purpose                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `~/arcblock-repos/`              | All ArcBlock project repositories                         |
| `~/arcblock-repos/agent-skills/` | AI Agent skill set (used when querying skill definitions) |
| `y`        | Blocklet Server data directory                            |
| `~/blocklet-server-dev-data/`    | Blocklet Server source code development data directory    |

## Query Skill Definitions

When you need to understand skill definitions in agent-skills, you **must** first ensure the local repository is up to date:

```bash
REPO_PATH="$HOME/arcblock-repos/agent-skills"
if [ -d "$REPO_PATH" ]; then
    cd "$REPO_PATH" && [ -z "$(git status --porcelain)" ] && git pull origin main
else
    mkdir -p ~/arcblock-repos && cd ~/arcblock-repos && git clone git@github.com:ArcBlock/agent-skills.git
fi
```

**Reason**: Skills cannot read other context from the current repo at runtime; must read from the convention path.

## PM2 Process Management

When viewing PM2 processes, set the correct `PM2_HOME`:

| Environment | PM2_HOME                   |
| ----------- | -------------------------- |
| Production  | `~/.arcblock/abtnode`      |
| Development | `~/.arcblock/abtnode-dev`  |
| e2e Testing | `~/.arcblock/abtnode-test` |

```bash
PM2_HOME=~/.arcblock/abtnode pm2 list
PM2_HOME=~/.arcblock/abtnode pm2 logs abt-node-daemon --lines 100
```

## Active Loading Policy

The following files should only be read when needed. Files are in the ArcBlock agent-skills repo:

| Related Product              | File to Load                                      |
| ---------------------------- | ------------------------------------------------- |
| Blocklet Development General | `arcblock-context/products/blocklet-developer.md` |
| Blocklet Server              | `arcblock-context/products/blocklet-server.md`    |
| DID Connect                  | `arcblock-context/products/did-connect.md`        |
| Discuss Kit                  | `arcblock-context/products/discuss-kit.md`        |
| PaymentKit                   | `arcblock-context/products/paymentkit.md`         |
| AIGNE CLI                    | `arcblock-context/products/aigne.md`              |

## Repository Search

Use local reference files for repository lookup (no GitHub API needed):

### Reference Files Location

Query the `blocklet-url-analyzer` skill's reference files:

- `blocklet-url-analyzer/references/org-arcblock-repos.md` - ArcBlock repos (core infrastructure, SDKs, mobile apps)
- `blocklet-url-analyzer/references/org-blocklet-repos.md` - Blocklet repos (blocklet applications, kits, tools)
- `blocklet-url-analyzer/references/org-aigne-repos.md` - AIGNE repos (AI agent framework, LLM adapters)

These files contain: Name, URL, Main Branch, Branch Prefix, Description, Category for each repository.

### Active Loading Policy (ALP) for Repository Search

> Load reference files on-demand based on context. Do not preload all files.

| Trigger Condition                                              | Load File                                               |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| Known ArcBlock repo (blocklet-server, ux, did-connect, SDKs)   | `org-arcblock-repos.md`                                 |
| Known Blocklet app (payment-kit, media-kit, discuss-kit, etc.) | `org-blocklet-repos.md`                                 |
| Known AIGNE repo (aigne-framework, aigne-hub, LLM adapters)    | `org-aigne-repos.md`                                    |
| Uncertain which organization                                   | First read `blocklet-url-analyzer/references/README.md` |

**Loading Strategy:**

1. Analyze user input (repo name, keywords, blocklet name) to infer organization
2. Load only the relevant reference file
3. If uncertain, read README.md first for high-density summary to decide

### Search Method

Search by keyword in the reference file loaded based on ALP rules above.

### GitHub Organizations

- **ArcBlock**: https://github.com/ArcBlock (main repositories, including blocklet-server and other core projects)
- **blocklet**: https://github.com/blocklet (Blocklet application repositories)
- **AIGNE-io**: https://github.com/AIGNE-io (AIGNE AI framework and related repositories)

---

## Workflow

Execute the following phases in order.

### Phase 0: Basic Tool Check

**Execute first**: Verify essential tools are installed.

```bash
# Check required tools
git --version || echo "❌ git not installed"
curl --version | head -1 || echo "❌ curl not installed"
```

| Tool     | Purpose                                               | Check Command    | Installation                   |
| -------- | ----------------------------------------------------- | ---------------- | ------------------------------ |
| **git**  | Repository cloning, branch operations, commit history | `git --version`  | Built-in or `brew install git` |
| **curl** | Domain reachability testing                           | `curl --version` | Built-in                       |

---

### Phase 1: Issue/Repo Resolution

Identify user intent and determine which repository to develop.

| Trigger Method                  | Example                                            | Handling                                                   |
| ------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| GitHub Issue URL                | `https://github.com/ArcBlock/media-kit/issues/123` | Extract repo from URL; if gh available, read issue content |
| **Blocklet URL**                | `https://xxx.ip.abtnet.io/image-bin/admin`         | Use `blocklet-url-analyzer` skill to analyze               |
| Repo name + problem description | "Help me fix the media-kit image issue"            | Search in local reference files                            |
| Problem description             | "Discussion comment feature has a bug"             | Keyword search in reference files                          |
| Direct specification            | "I want to develop snap-kit"                       | Search in local reference files to verify                  |

#### 1.0 URL Type Detection

> **⚠️ Critical: When analyzing URLs, NEVER use Chrome browser or any interactive browser tools.**
>
> **ALWAYS use terminal commands (curl, wget, etc.) to make HTTP requests directly.**

When user provides a URL, first determine URL type:

```bash
# Check if it's a GitHub URL
if [[ "$URL" =~ ^https?://github\.com/ ]]; then
    # GitHub URL → proceed to 1.2 Issue handling or directly extract repository
    IS_GITHUB_URL=true
else
    # Non-GitHub URL → use blocklet-url-analyzer skill to analyze
    IS_GITHUB_URL=false
fi
```

**Non-GitHub URL Handling Flow**:

1. Read `blocklet-url-analyzer` skill definition
2. Follow skill flow to analyze URL
3. Based on analysis result:

| Analysis Result Type | Handling                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DAEMON`             | **Redirect** to `blocklet-server-dev-setup` skill                                                                          |
| `BLOCKLET_SERVICE`   | **Redirect** to `blocklet-server-dev-setup` skill                                                                          |
| `BLOCKLET`           | Get corresponding repository; if `blocklet-server`, redirect to `blocklet-server-dev-setup`; otherwise continue to Phase 2 |
| `UNKNOWN`            | Use AskUserQuestion to let user specify manually                                                                           |

**Important**: When the identified repository is `blocklet-server`, always redirect to `blocklet-server-dev-setup` skill instead of continuing with this skill.

**blocklet-url-analyzer skill location**: `blocklet-url-analyzer/SKILL.md`
**blocklet-server-dev-setup skill location**: `blocklet-server-dev-setup/SKILL.md`

#### 1.1 Repository Search and Verification

When user provides repository name or keywords, search in local reference files **following ALP**:

**Load reference file based on context** (see "Repository Search" section above):

- Core infrastructure keywords → `blocklet-url-analyzer/references/org-arcblock-repos.md`
- Blocklet app keywords (kit, store, marketing tools) → `blocklet-url-analyzer/references/org-blocklet-repos.md`
- AI-related keywords (aigne, LLM, agent) → `blocklet-url-analyzer/references/org-aigne-repos.md`
- Uncertain → First read `blocklet-url-analyzer/references/README.md` for summary

**Reference files contain**: Name, URL, Main Branch, Branch Prefix, Description, Category for all active repositories.

**blocklet-server Repository Detection**:

After identifying the repository, check if it is `blocklet-server`:

```bash
if [ "$REPO" = "blocklet-server" ]; then
    echo "⚠️ Detected blocklet-server repository"
    echo "→ Redirecting to blocklet-server-dev-setup skill"
fi
```

| Repository         | Handling                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `blocklet-server`  | **Stop current skill**, redirect to `blocklet-server-dev-setup` skill |
| Other repositories | Continue to Phase 2                                                   |

**Redirect message**:

```
The repository you want to develop is blocklet-server (Blocklet Server core).
This requires a different development environment setup.

→ Switching to blocklet-server-dev-setup skill...
```

**blocklet-server-dev-setup skill location**: `blocklet-server-dev-setup/SKILL.md`

**Match failure**: Use AskUserQuestion to display search results for user selection.

#### 1.2 Issue URL Handling

When user provides GitHub Issue URL, first extract repository info from URL, then check if gh CLI is available.

**Step 1: Parse URL to extract repository**

```bash
# Extract org/repo/issue_number from URL
# Example: https://github.com/ArcBlock/media-kit/issues/123
# → ORG=ArcBlock, REPO=media-kit, ISSUE_NUMBER=123
```

**Step 1.5: Check if blocklet-server repository**

```bash
if [ "$REPO" = "blocklet-server" ]; then
    # Redirect to blocklet-server-dev-setup skill
    echo "→ Detected blocklet-server repository, switching to blocklet-server-dev-setup skill"
fi
```

| Repository         | Handling                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `blocklet-server`  | **Stop current skill**, redirect to `blocklet-server-dev-setup` skill |
| Other repositories | Continue to Step 2                                                    |

**Step 2: Check gh CLI availability and permissions**

```bash
# Check if gh is installed and authenticated
if command -v gh &> /dev/null && gh auth status &> /dev/null; then
    GH_AVAILABLE=true
else
    GH_AVAILABLE=false
fi
```

**Step 3: Handle based on gh availability**

| gh Status               | Handling                                                      |
| ----------------------- | ------------------------------------------------------------- |
| Available with auth     | Read issue content for deeper analysis (multi-repo detection) |
| Not available / No auth | Use repository from URL directly, skip issue content analysis |

**If gh available - Read issue content**:

```bash
gh issue view $ISSUE_NUMBER --repo $ORG/$REPO --json title,body,labels
```

Then analyze issue content:

1. Read issue title and body
2. Identify product/component keywords mentioned
3. Determine if multiple repositories are involved

**If gh not available - Use URL only**:

Simply use the repository extracted from the Issue URL (`$ORG/$REPO`) and proceed to Phase 2. Skip multi-repository detection.

**Multi-repository scenario examples**:

| Issue Location    | Issue Content Keywords                             | Actual Repositories Involved                     |
| ----------------- | -------------------------------------------------- | ------------------------------------------------ |
| `media-kit`       | "Discuss Kit image upload triggers twice"          | `media-kit` (uploader) + `discuss-kit` (caller)  |
| `discuss-kit`     | "Image upload component onUploadSuccess exception" | `discuss-kit` + `media-kit` (component provider) |
| `blocklet-server` | "DID Connect login failed"                         | `blocklet-server` + `did-connect`                |
| `did-spaces`      | "PaymentKit payment callback issue"                | `did-spaces` + `paymentkit`                      |

**Decision logic**:

- Repository where Issue is located is the **primary repository** (issue report location)
- Other products mentioned in Issue content are **related repositories** (may need to view simultaneously)

#### 1.3 Multi-Repository Handling

If multiple repositories are identified:

1. **Use AskUserQuestion to ask user**:
   - Option A: Clone only primary repository `{primary repository name}`
   - Option B: Clone both primary and related repositories `{primary repository name}` + `{related repository name}`
   - Option C: User specifies other repository

2. **Record variables**:
   - `PRIMARY_REPO`: Primary repository (where issue is located)
   - `RELATED_REPOS`: Related repository list (may be empty)

3. **Execute subsequent Phases 2-6 for each selected repository**

**Match failure**: Use AskUserQuestion to let user select or input complete GitHub path.

---

### Phase 2: Repo Clone & Permission Check

#### 2.1 Check Local Repository

```bash
REPO_PATH="$HOME/arcblock-repos/$REPO"
[ -d "$REPO_PATH" ] && cd "$REPO_PATH" && git fetch origin
```

#### 2.2 Clone Repository

Clone to `~/arcblock-repos/$REPO` (prefer SSH, fallback to HTTPS on failure).

#### 2.3 Find Blocklet Project

```bash
find . -name "blocklet.yml" -o -name "blocklet.yaml" | grep -v node_modules
```

| Situation      | Handling                               |
| -------------- | -------------------------------------- |
| Not found      | Prompt this is not a blocklet project  |
| Found 1        | Auto-select                            |
| Found multiple | Use AskUserQuestion for user selection |

**Record variables**:

- `REPO_ROOT`: Repository root directory (dependencies installed here)
- `BLOCKLET_DIR`: Directory containing blocklet.yml (start here)

#### 2.4 Detect Development Branch and Switch

**Switch to main working branch according to `blocklet-branch` skill**.
Skill location: `blocklet-branch/SKILL.md`

---

### Phase 3: Prerequisites Check

#### 3.1 Node.js (Required: 22+)

If not installed or version too low, use nvm to install Node.js 22.

#### 3.2 pnpm

```bash
corepack enable && corepack prepare pnpm@latest --activate
```

#### 3.3 nginx

Must be installed but **must not auto-start** (Blocklet Server manages it).

**macOS**:

```bash
brew install nginx
```

**Ubuntu/Debian**:

```bash
# Must install nginx-extras, which includes ngx_stream_module and other required modules
sudo apt install -y nginx-extras
sudo systemctl stop nginx
sudo systemctl disable nginx
```

**Verify nginx modules**:

```bash
nginx -V 2>&1 | grep -o 'with-stream\|http_v2_module\|http_ssl_module'
# Should show: with-stream, http_v2_module, http_ssl_module
```

**Note**: Regular `nginx` package may lack `ngx_stream_module`, causing Blocklet Server startup failure.

#### 3.4 tmux

If tmux is not available, help user install it for easier terminal process management.

**macOS**:

```bash
brew install tmux
```

**Ubuntu/Debian**:

```bash
sudo apt install -y tmux
```

#### 3.5 @blocklet/cli

```bash
npm install -g @blocklet/cli@beta
```

Update if version date is more than 1 week old.

#### 3.6 ulimit Check

**Important**: Must check **before** starting Blocklet Server, otherwise will cause `worker_connections NaN` error.

```bash
ulimit -n  # Cannot be unlimited, recommend >= 10240
ulimit -n 65536  # Temporary setting
```

---

### Phase 4: Blocklet Server Setup

Blocklet Server has two modes of operation that **cannot run simultaneously**:

| Mode               | Start Command                             | Detection Method                                                              | Data Directory                |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| Production version | `blocklet server start`                   | `blocklet server status`                                                      | `~/blocklet-server-data/`     |
| Source development | `bun run start` (in blocklet-server repo) | tmux session exactly named `blocklet` with sub-windows `webapp` and `event-hub` | `~/blocklet-server-dev-data/` |

#### 4.0 Check Blocklet Server Running Status

**Must check both modes**:

```bash
# Check method 1: Is production version running
PRODUCTION_RUNNING=false
CORRECT_DATA_DIR=false
EXPECTED_DATA_DIR="$HOME/blocklet-server-data"

if blocklet server status 2>/dev/null | grep -q "Running"; then
    PRODUCTION_RUNNING=true
    echo "✅ Detected Blocklet Server production version running"

    # Check if it's using the expected data directory
    CURRENT_DATA_DIR=$(blocklet server status 2>/dev/null | grep "Data Directory:" | sed 's/.*Data Directory: //' | tr -d '[:space:]')

    if [ "$CURRENT_DATA_DIR" = "$EXPECTED_DATA_DIR" ]; then
        CORRECT_DATA_DIR=true
        echo "✅ Data directory matches: $CURRENT_DATA_DIR"
    else
        CORRECT_DATA_DIR=false
        echo "⚠️ Data directory mismatch: $CURRENT_DATA_DIR (expected: $EXPECTED_DATA_DIR)"
    fi
fi

# Check method 2: Is source development version running
# IMPORTANT: Must check BOTH conditions:
#   1. tmux session exactly named "blocklet" exists (not prefix match)
#   2. Session has "webapp" and "event-hub" windows (blocklet-server source dev structure)
# Note: `tmux has-session -t "blocklet"` uses prefix matching and will incorrectly
# match sessions like "blocklet-dev-payment-kit", so we must check exact session name
DEV_RUNNING=false
if tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -qx "blocklet"; then
    # Session exactly named "blocklet" exists, now check for webapp/event-hub windows
    WINDOWS=$(tmux list-windows -t blocklet -F '#{window_name}' 2>/dev/null)
    if echo "$WINDOWS" | grep -q "webapp" && echo "$WINDOWS" | grep -q "event-hub"; then
        DEV_RUNNING=true
        echo "✅ Detected blocklet-server source development version running (tmux session: blocklet)"
    else
        echo "ℹ️ Found tmux session 'blocklet' but missing webapp/event-hub windows - not source dev"
    fi
fi
```

#### 4.0.1 Handle Data Directory Mismatch

If production version is running but using a different data directory (not `~/blocklet-server-data`), **must stop it first**:

```bash
if [ "$PRODUCTION_RUNNING" = "true" ] && [ "$CORRECT_DATA_DIR" = "false" ]; then
    echo "⚠️ Stopping Blocklet Server running at different data directory..."
    blocklet server stop -f
    sleep 3
    PRODUCTION_RUNNING=false
    echo "✅ Stopped. Will start new instance with correct data directory."
fi
```

**Reason**: The skill uses `~/blocklet-server-data` as the convention data directory. If user has a different Blocklet Server running (e.g., from another project or location), it must be stopped to avoid conflicts.

#### 4.1 Handle Based on Detection Results

| Production Version | Data Dir Correct | Source Development | Handling                                                                                                        |
| ------------------ | ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Running            | ✅ Yes           | Not running        | ✅ Use directly, skip to Phase 5                                                                                |
| Running            | ❌ No            | Not running        | Stop it (4.0.1), then start with correct data dir (4.2)                                                         |
| Not running        | N/A              | Running            | ⚠️ Ask user: stop source development and start production version, or continue using source development version |
| Not running        | N/A              | Not running        | Need to start production version, continue to 4.2                                                               |
| Running            | Any              | Running            | ❌ Abnormal state, ask user which to stop                                                                       |

**Handling when source development version is running**:

Use `AskUserQuestion` to ask user:

```
Detected blocklet-server source development version running (tmux session: blocklet).
Source development and production versions cannot run simultaneously.

Options:
A. Stop source development, start production version (Recommended for blocklet dev)
   - Execute: tmux kill-session -t blocklet && blocklet server start
B. Continue using source development version
   - Need to use bn-dev command (instead of blocklet dev)
   - bn-dev runs directly in the blocklet directory WITHOUT arguments (NOT "bn-dev start")
   - If bn-dev not configured, will automatically create symlink
C. Cancel operation
```

**Stop source development version**:

```bash
tmux kill-session -t "blocklet" 2>/dev/null
# Wait for port release
sleep 3
```

#### 4.1.1 Configure bn-dev (When Choosing Source Development Version)

If user chooses to continue using source development version, ensure bn-dev command is available:

**Check if bn-dev exists**:

```bash
which bn-dev || echo "bn-dev not configured"
```

**If not configured, create symlink**:

```bash
# bn-dev points to dev.js in blocklet-server source
BLOCKLET_SERVER_REPO="$HOME/arcblock-repos/blocklet-server"
if [ -f "$BLOCKLET_SERVER_REPO/core/cli/tools/dev.js" ]; then
    sudo ln -sf "$BLOCKLET_SERVER_REPO/core/cli/tools/dev.js" /usr/local/bin/bn-dev
    echo "✅ bn-dev configured"
else
    echo "❌ blocklet-server source not found, please use blocklet-server-dev-setup skill to clone repository first"
fi
```

**Record variables**:

- `USE_DEV_SERVER`: Whether using source development version (true/false)
- `DEV_CMD`: Start command (bn-dev or blocklet dev)

#### 4.2 Initialize (If Needed)

Check if `~/blocklet-server-data/.blocklet-server/config.yml` exists.

```bash
# Check if this is first-time setup
FIRST_TIME_SETUP=false
if [ ! -d "$HOME/blocklet-server-data/.blocklet-server" ]; then
    FIRST_TIME_SETUP=true
fi

mkdir -p ~/blocklet-server-data && cd ~/blocklet-server-data
blocklet server init --yes --http-port 8080 --https-port 8443
```

#### 4.3 Check Port Configuration

If ports are not 8080/8443, **must** use `--update-db` when starting after modifying config.

#### 4.4 Start

```bash
cd ~/blocklet-server-data
ulimit -n 65536 && blocklet server start --update-db
```

**Startup failure checks**:

1. `ulimit -n` cannot be `unlimited`
2. Are ports 8080/8443
3. Used `--update-db` after modifying ports
4. View logs: `PM2_HOME=~/.arcblock/abtnode pm2 logs abt-node-daemon --lines 50`

#### 4.5 First-Time Wallet Binding Check (Critical)

**Important**: If this is the first time starting Blocklet Server (no previous `.blocklet-server` directory), the user **MUST** complete wallet binding before proceeding. Without wallet binding, blocklets created later will have issues.

**Detection methods**:

1. **Check if first-time setup** (from 4.2):

```bash
if [ "$FIRST_TIME_SETUP" = "true" ]; then
    echo "⚠️ First-time Blocklet Server setup detected"
fi
```

2. **Check Server Admin URL response**:

```bash
# Get Server Admin URL
IP_DOMAIN=$(hostname -I | awk '{print $1}' | tr '.' '-').ip.abtnet.io
SERVER_ADMIN_URL="https://${IP_DOMAIN}:8443/.well-known/server/admin/"

# Check if redirected to setup/authorization page
RESPONSE=$(curl -sI --connect-timeout 5 -L "$SERVER_ADMIN_URL" 2>/dev/null | grep -i "location:")
# If response contains "setup", "auth", or "connect", wallet binding is needed
```

**When first-time setup is detected, MUST use AskUserQuestion**:

```
⚠️ First-Time Blocklet Server Setup Detected

Before continuing, you MUST complete wallet binding in the browser:

1. Open Server Admin: {SERVER_ADMIN_URL}
2. You will see an authorization/setup page
3. Use DID Wallet to scan the QR code and complete binding
4. After binding, the page will redirect to the Server Admin dashboard

⚠️ IMPORTANT: If you skip this step, blocklets created later will have permission issues and may not function correctly.

Options:
A. I have completed wallet binding (Continue)
B. Help me open the URL (will open browser)
C. Cancel setup
```

**Wait for user confirmation before proceeding to Phase 5**.

**Why wallet binding is required**:

- Blocklet Server uses DID-based authentication
- The first bound wallet becomes the Server owner/admin
- Without an owner, blocklets cannot be properly registered
- Permission system will malfunction without initial wallet binding

---

### Phase 5: Project Dependencies Install

**Note**: Execute in **repository root directory**.

Detect package manager (by lock file priority) and project type (Makefile > pnpm-workspace > regular project).

```bash
cd $REPO_ROOT
if grep -q "^init:" Makefile 2>/dev/null; then make init
elif grep -q "^dep:" Makefile 2>/dev/null; then make dep
else pnpm install
fi
```

---

### Phase 6: Start Development Server

**Note**: Execute in **directory containing blocklet.yml**.

#### 6.1 Detect tmux Environment and Start

**Start command selection** (based on Phase 4 choice):

| Server Type                | Start Command  | Description                                                                                       |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| Production version         | `blocklet dev` | Connect to Server started by `blocklet server start`                                              |
| Source development version | `bn-dev`       | Connect to source development Server (tmux session: blocklet). **Run directly without arguments** |

**Record variables**:

- `TMUX_SESSION`: Session name, format `blocklet-dev-{REPO}`
- `HAS_TMUX`: Whether tmux environment available
- `DEV_CMD`: Start command (`bn-dev` or `blocklet dev`)

| tmux Status   | Handling                                                  |
| ------------- | --------------------------------------------------------- |
| Available     | Start in tmux session (clean up same-named session first) |
| Not available | Start directly in current terminal                        |

```bash
# Determine start command based on Phase 4 choice
if [ "$USE_DEV_SERVER" = "true" ]; then
    # bn-dev must be run WITHOUT arguments (e.g., do NOT use "bn-dev start")
    DEV_CMD="bn-dev"
else
    DEV_CMD="blocklet dev"
fi

# When tmux available
TMUX_SESSION="blocklet-dev-$REPO"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -c "$BLOCKLET_DIR" "$DEV_CMD"
```

#### 6.1.1 Startup Monitoring (Important)

**Output logs immediately**: After starting tmux session, **do not wait for startup to complete**, immediately view and output logs to user:

```bash
# View logs immediately after startup (wait 2 seconds for process to start outputting)
sleep 2
tmux capture-pane -t "$TMUX_SESSION" -p | tail -30
```

**Continuous monitoring**: `blocklet dev` startup process **varies greatly** depending on blocklet type, dependencies, and environment configuration; must continuously monitor:

```bash
# Check if process is still running
tmux has-session -t "$TMUX_SESSION" 2>/dev/null && echo "Process running" || echo "❌ Process exited"

# View latest logs
tmux capture-pane -t "$TMUX_SESSION" -p | tail -50
```

**Monitoring points**:

| Check Item    | Command                                    | Exception Handling                           |
| ------------- | ------------------------------------------ | -------------------------------------------- |
| Process alive | `tmux has-session -t "$TMUX_SESSION"`      | If process exits, analyze logs for cause     |
| Error output  | Check logs for `error`, `failed`, `ENOENT` | Try to fix based on error type               |
| Stuck/frozen  | Multiple log checks show no changes        | May be missing dependencies or config issues |
| Port conflict | `EADDRINUSE`                               | Find process using port and handle           |

**Common startup issues and solutions**:

| Log Keyword                              | Possible Cause                             | Solution                                                |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `ENOENT`                                 | Missing file or dependencies not installed | Re-run `pnpm install` or `make init`                    |
| `EADDRINUSE`                             | Port in use                                | `lsof -i :PORT` to find process, decide whether to kill |
| `Cannot find module`                     | Dependencies not installed or path error   | Check node_modules, reinstall dependencies              |
| `Permission denied`                      | Permission issue                           | Check file permissions, may need sudo                   |
| `command not found`                      | Tool not installed                         | Install corresponding tool (e.g., turbo, vite, etc.)    |
| `Blocklet Server is not running`         | Server not started                         | Return to Phase 4 to start Server                       |
| Process exits immediately with no output | Config error or environment issue          | Check blocklet.yml and .env files                       |
| `out of memory`                          | Insufficient memory                        | Close other processes, or increase swap                 |

**Important principles**:

1. **Do not assume startup succeeded** - each blocklet has different startup time and behavior
2. **Proactively view logs** - identify issues early and handle them, don't wait for user feedback
3. **Try automatic fixes** - attempt to resolve common issues first, inform user if unable to resolve
4. **Keep process visible** - always let user know current startup status

#### 6.1.2 Parse Startup Output (Important)

**Important**: The Blocklet URL and Service URL are **dynamically generated** by `blocklet dev`, not constructed from DID. You must parse them from the startup output.

After `blocklet dev` starts successfully, parse the output to extract URLs:

```bash
# Capture blocklet dev output
OUTPUT=$(tmux capture-pane -t "$TMUX_SESSION" -p)

# Look for URL patterns in the output, typical formats:
# "✔ Blocklet xxx is running at https://..."
# "ℹ You can access with the following URL"
# The URL format is usually: https://xxx.did.abtnet.io:8443 or https://xxx-ip.ip.abtnet.io:8443

# Extract the Blocklet access URL from output
BLOCKLET_URL=$(echo "$OUTPUT" | grep -oE 'https://[a-z0-9-]+\.(did|ip)\.abtnet\.io:[0-9]+' | head -1)

# Service Admin URL is based on Blocklet URL
SERVICE_URL="${BLOCKLET_URL}/.well-known/service/admin/"
```

**Record variables** (from blocklet dev output):
| Variable | Description | Source |
|----------|-------------|--------|
| `BLOCKLET_URL` | Blocklet access URL | Parsed from `blocklet dev` output |
| `SERVICE_URL` | Blocklet Service Admin URL | `${BLOCKLET_URL}/.well-known/service/admin/` |

**Note**: Do NOT construct URLs by concatenating DID strings. Always use the URLs output by `blocklet dev`.

---

#### 6.2 Test Domain Reachability

After successful startup, **must** test if the URLs from `blocklet dev` output are accessible:

```bash
# Test using URLs parsed from blocklet dev output (from 6.1.2)
curl -sI --connect-timeout 5 "$BLOCKLET_URL" 2>/dev/null | head -1

# Also test Server Admin URL
curl -sI --connect-timeout 5 "https://{IP_DOMAIN}:8443" 2>/dev/null | head -1
```

| Test Result                       | Output                                             |
| --------------------------------- | -------------------------------------------------- |
| Both URLs return HTTP status code | ✅ Domain access normal                            |
| Either URL inaccessible           | ⚠️ Output DNS fix suggestions (see Error Handling) |

#### 6.3 Query Recent Commits

After cloning, use git to view recent commit history:

```bash
# View last 10 commits with author and date
cd $REPO_PATH
git log --oneline -10 --format="%h %s (by %an, %ar)"
```

#### 6.4 Output Startup Information

**URL Path Notes (Important, do not confuse)**:

| Type                 | Path                         | Purpose                                     |
| -------------------- | ---------------------------- | ------------------------------------------- |
| **Server Admin**     | `/.well-known/server/admin`  | Management panel for entire Blocklet Server |
| **Blocklet Service** | `/.well-known/service/admin` | Management page for individual blocklet     |

⚠️ **Note**: Server Admin uses IP domain (e.g., `192-168-1-80.ip.abtnet.io`), path is `/server/admin`, not `/service/admin`.

```
===== Development Environment Ready =====

Project: {project name}
Repository: {ORG}/{REPO}
Path: ~/arcblock-repos/{REPO}

===== Access URLs (from blocklet dev output) =====
Server Admin: https://{IP_DOMAIN}:8443/.well-known/server/admin/
Blocklet URL: {BLOCKLET_URL}
Blocklet Service: {SERVICE_URL}

Note: Blocklet URL and Service URL are parsed from blocklet dev startup output (see 6.1.2).
      Do NOT construct these URLs manually - always use the URLs output by blocklet dev.

{Based on 6.2 test results}
✅ Domain access normal
or
⚠️ Domain inaccessible, please set DNS to 8.8.8.8:
   macOS: sudo networksetup -setdnsservers Wi-Fi 8.8.8.8 1.1.1.1

===== Common Commands =====
{If started with tmux}
  - View blocklet dev output: tmux attach -t {TMUX_SESSION}
  - View logs in another terminal: tmux capture-pane -t {TMUX_SESSION} -p | tail -50
  - Stop blocklet dev: tmux kill-session -t {TMUX_SESSION}
  - List all tmux sessions: tmux ls

{If not using tmux}
  - Stop blocklet dev: Ctrl+C

{Common commands}
  - Stop Blocklet Server: blocklet server stop -f
  - View Server PM2 processes: PM2_HOME=~/.arcblock/abtnode pm2 list
  - View Server PM2 logs: PM2_HOME=~/.arcblock/abtnode pm2 logs abt-node-daemon --lines 100

===== Version Update Guide =====
After completing development, use blocklet-updater skill to create new version:
  1. blocklet version patch  # Bump version number
  2. pnpm install && pnpm run build  # Install dependencies and build
  3. blocklet meta  # Verify metadata
  4. blocklet bundle --create-release  # Create release bundle

For detailed instructions, refer to: `blocklet-updater/SKILL.md`

===== Next Steps =====
Development environment is now in live state. You can:
- Describe the feature you want to modify
- Paste bug details that need fixing
```

---

### Phase 7: Working Branch Creation

When user starts development environment with a specific task (Issue URL, problem description, or explicitly stated what they want to change), ask whether to create a working branch.

**Trigger condition**: User provided Issue URL or specific task description, or explicitly stated what they want to change
**Skip condition**: User only requested environment creation, no specific task

**Get main working branch {MAIN_BRANCH} and branch prefix patterns according to `blocklet-branch` skill**.
Skill location: `blocklet-branch/SKILL.md`

#### 7.1 Ask Whether to Create Working Branch

Generate a {suggested branch name} based on branch prefix patterns

Use `AskUserQuestion`:

```
Currently on {MAIN_BRANCH} branch. Do you need to create a working branch?

Options:
A. Create branch: {suggested branch name} (Recommended)
B. Use a different branch name
C. Don't create, develop directly on {MAIN_BRANCH}
```

#### 7.2 Create Branch (If User Confirms)

Create new branch based on `$MAIN_BRANCH` and switch to it.

#### 7.3 Output Ready Information

```
===== Development Environment Ready =====

Repository: ~/arcblock-repos/{REPO}
Branch: {BRANCH_NAME} (based on {MAIN_BRANCH})
Service: blocklet dev running in tmux session {TMUX_SESSION}

Access URLs (from blocklet dev output):
- Blocklet Server Admin: https://{IP_DOMAIN}:8443/.well-known/server/admin/
- Blocklet URL: {BLOCKLET_URL}
- Blocklet Service: {SERVICE_URL}

Note: URLs are parsed from blocklet dev output, not manually constructed.

Common commands:
- View logs: tmux attach -t {TMUX_SESSION}
- Stop service: tmux kill-session -t {TMUX_SESSION}
```

Use other skills to complete work:

/blocklet-pr After modifying code, submit a PR that follows conventions

---

## Error Handling

| Error                           | Handling                                   |
| ------------------------------- | ------------------------------------------ |
| Cannot identify repository      | Display repository list for user selection |
| Insufficient GitHub permissions | Prompt to contact administrator or fork    |
| Not a blocklet project          | Prompt no blocklet.yml found               |
| Blocklet Server startup failed  | Check ulimit, ports, --update-db           |
| nginx `worker_connections NaN`  | Set `ulimit -n 65536`                      |
| DID domain inaccessible         | Configure DNS to 8.8.8.8 (see below)       |

### DID Domain Inaccessible

**Symptoms**: Browser cannot access `*.did.abtnet.io` or `*.ip.abtnet.io`

**Diagnosis**:

```bash
nslookup 192-168-1-80.ip.abtnet.io        # Local DNS
nslookup 192-168-1-80.ip.abtnet.io 8.8.8.8  # Google DNS
```

**Solution**: Change DNS

```bash
# macOS
sudo networksetup -setdnsservers Wi-Fi 8.8.8.8 1.1.1.1
```

---

## Stop Blocklet Dev Process

```bash
# Stop single project
tmux kill-session -t "blocklet-dev-$REPO"

# Complete cleanup (stop all blocklet-dev sessions + Server)
tmux ls 2>/dev/null | grep "^blocklet-dev-" | cut -d: -f1 | xargs -I {} tmux kill-session -t {}
blocklet server stop -f
```

---
