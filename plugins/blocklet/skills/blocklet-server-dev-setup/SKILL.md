---
name: blocklet-server-dev-setup
description: Clone blocklet-server repository and guide execution of the in-project project-setup skill. Use `/blocklet-server-dev-setup` or say "help me configure blocklet-server environment", "setup blocklet-server" to trigger.
---

# Blocklet Server Dev Setup

Help developers clone the blocklet-server repository to the convention directory, switch to the development branch, then guide execution of the built-in `project-setup` skill to complete environment configuration.

**Note**: This skill is for blocklet-server **source code development**, different from `blocklet-dev-setup` (which uses `blocklet dev` to develop blocklets).

## Convention Directories

| Directory | Purpose |
|-----------|---------|
| `~/arcblock-repos/` | All ArcBlock project repositories |
| `~/arcblock-repos/blocklet-server/` | Blocklet Server source code |
| `~/arcblock-repos/agent-skills/` | AI Agent skill set (used when querying skill definitions) |
| `~/blocklet-server-dev-data/` | Blocklet Server source code development, data directory |

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

---

## Workflow

### Phase 0: GitHub CLI Authentication Check

**Execute first**: Before running any `gh` command, must ensure GitHub CLI is authenticated.

**Important**: Must use `--scopes read:org` to request only read-level permissions. Do NOT omit this parameter.

```bash
# Check if gh is authenticated
if ! gh auth status &>/dev/null; then
    echo "❌ GitHub CLI not authenticated, please authenticate first"
    # MUST specify --scopes read:org for read-only permissions
    gh auth login --scopes read:org
fi
```

| Authentication Status | Action |
|-----------------------|--------|
| gh not installed | Prompt to install: `brew install gh` (macOS) or refer to https://cli.github.com/ |
| Not authenticated | **Must** run `gh auth login --scopes read:org` (read-only permissions required) |
| Authenticated | Continue to next step |

---

### Phase 1: Input Analysis (Optional)

**Prerequisite**: Must complete Phase 0 (GitHub CLI Authentication) before analyzing any URL.

When user provides a URL, first determine if this skill should be used:

#### 1.1 URL Type Detection

```bash
# Determine URL type
if [[ "$URL" =~ ^https?://github\.com/ ]]; then
    # GitHub Issue URL → check if it's blocklet-server repository
    if [[ "$URL" =~ github\.com/ArcBlock/blocklet-server ]]; then
        # Is blocklet-server issue → continue with this skill
        IS_TARGET_REPO=true
    else
        # Other repository's issue → suggest using blocklet-dev-setup
        IS_TARGET_REPO=false
    fi
else
    # Non-GitHub URL → use blocklet-url-analyzer skill to analyze
    # Read plugins/blocklet/skills/blocklet-url-analyzer/SKILL.md
fi
```

#### 1.2 Non-GitHub URL Handling

Use `blocklet-url-analyzer` skill to analyze URL:

| Analysis Result Type | Handling |
|---------------------|----------|
| `DAEMON` | Continue with this skill (blocklet-server source code development) |
| `BLOCKLET_SERVICE` | Continue with this skill (blocklet-server source code development) |
| `BLOCKLET` | Inform user they should use `blocklet-dev-setup`, and provide the corresponding repository |
| `UNKNOWN` | Use AskUserQuestion to let user confirm whether to continue with this skill |

**blocklet-url-analyzer skill location**: `plugins/blocklet/skills/blocklet-url-analyzer/SKILL.md`

#### 1.3 No URL Input

If user did not provide URL (e.g., directly said "help me configure blocklet-server environment"), skip this Phase and proceed directly to Phase 2.

---

### Phase 2: Check GitHub Permissions

```bash
gh api repos/ArcBlock/blocklet-server --jq '.permissions.pull'
# Returns: true or false
```

| Permission Status | Handling |
|-------------------|----------|
| No access (`pull: false`) | Prompt to contact administrator or check GitHub login |
| Has read permission (`pull: true`) | Continue normally |

---

### Phase 3: Clone Repository to Convention Directory

#### 3.1 Check Local Repository

```bash
REPO_PATH="$HOME/arcblock-repos/blocklet-server"
if [ -d "$REPO_PATH" ]; then
    cd "$REPO_PATH" && git fetch origin
    echo "Repository already exists"
fi
```

#### 3.2 Clone Repository (If Not Exists)

```bash
mkdir -p ~/arcblock-repos && cd ~/arcblock-repos
git clone git@github.com:ArcBlock/blocklet-server.git || git clone https://github.com/ArcBlock/blocklet-server.git
```

---

### Phase 4: Switch to dev Branch

#### 4.1 Check If Current Branch Has Uncommitted Changes

```bash
cd ~/arcblock-repos/blocklet-server
git status --porcelain
```

**Important**: If there are uncommitted changes, **must** use AskUserQuestion to ask user how to handle:
- Option A: Stash changes (`git stash`)
- Option B: Commit changes
- Option C: Discard changes (`git checkout .`)
- Option D: Cancel operation

#### 4.2 Switch Branch

```bash
git checkout dev && git pull origin dev
```

**Rules**:
- All developers start on the `dev` branch
- If currently on `master` branch, must switch to `dev`

---

### Phase 5: Pre-environment Check

#### 5.1 Check for Blocklet Development Process Conflicts

**Important**: Before starting blocklet-server source development, must check if Blocklet Server production version is running. The two cannot run simultaneously.

```bash
# Check if blocklet server is running
if blocklet server status 2>/dev/null | grep -q "running"; then
    echo "⚠️ Detected Blocklet Server production version running"
    echo "Please stop first: blocklet server stop -f"
    exit 1
fi
```

| Detection Result | Handling |
|------------------|----------|
| blocklet server is running | Use AskUserQuestion to ask user whether to stop that process |
| Not running | Continue to next step |

**Conflict reason**: blocklet-server source development (`bun run start`) and Blocklet Server production version (`blocklet server start`) use the same ports and resources, cannot run simultaneously.

---

### Phase 6: Execute Built-in project-setup Skill

The project repository already has a complete `project-setup` skill located at:

```
~/arcblock-repos/blocklet-server/.claude/skills/project-setup/SKILL.md
```

**Execution method**:

1. Read the skill file content
2. Execute according to the steps in the skill:
   - Prerequisites check (Node.js v22+, bun, nginx)
   - Install dependencies (`bun install`)
   - Compile dependency packages (`bun turbo:dep`)
   - Configure environment variables (`core/webapp/.env.development`)
   - Continuously check the webapp window in the blocklet tmux session to view logs and ensure success. If you see [nodemon] app crashed - waiting, remember to stop that process and re-execute
   - Output startup guide

---


## Output Completion Information

```
===== Blocklet Server Development Environment Ready =====

Repository location: ~/arcblock-repos/blocklet-server
Current branch: dev

Access URL: http://127.0.0.1:3000, not http://127.0.0.1:3030, 3030 is just the proxy address

Starting development environment:
  cd ~/arcblock-repos/blocklet-server
  bun run start

Other common commands:
  bun run test        # Run tests
  bun run turbo:lint  # Run lint checks

Use other skills to complete work:

/blocklet-pr After modifying code, submit a PR that follows conventions
```

## Start Development Environment

Use bun run start to start. If there are issues during the process, please help fix them.

After successful startup, output commands to teach user how to view the tmux processes.

---

## Error Handling

| Error | Handling |
|-------|----------|
| Insufficient GitHub permissions | Prompt to contact administrator or fork |
| Clone failed | Check network, try HTTPS method |
| project-setup skill not found | Prompt may be old version repository, manually execute installation steps |
