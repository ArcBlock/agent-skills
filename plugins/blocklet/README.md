# Blocklet

Agent skills for complete Blocklet development workflow: environment setup, branch management, development, PR submission, and release management.

## Installation

```bash
/plugin install blocklet@arcblock-agent-skills
```

## Skills

### blocklet-getting-started

Interactive guide to help developers choose the right development environment setup.

**Trigger phrases:**
- `/blocklet-getting-started`
- "I want to start blocklet development"
- "How to setup blocklet dev environment"

**What it does:**
1. Asks what you want to develop (blocklet app or Server core)
2. Handles migration from existing development environments
3. Explains convention directories (~/arcblock-repos/, ~/blocklet-server-data/, etc.)
4. Showcases advanced usages of blocklet-dev-setup
5. Guides you to the appropriate setup skill

### blocklet-dev-setup

Configure development environment for blocklet-type repositories.

**Trigger phrases:**
- `/blocklet-dev-setup`
- "Help me fix the xxx blocklet issue"
- "I want to develop xxx blocklet"
- "I want to modify code related to this URL"

**What it does:**
1. Parses GitHub Issue URLs, Blocklet URLs, or problem descriptions
2. Locates the corresponding repository
3. Checks permissions and clones code
4. Installs dependencies and starts development server

### blocklet-server-dev-setup

Clone blocklet-server repository and setup development environment.

**Trigger phrases:**
- `/blocklet-server-dev-setup`
- "Help me configure blocklet-server environment"
- "Setup blocklet-server"

**What it does:**
1. Clones blocklet-server repository
2. Guides execution of the in-project setup skill

### blocklet-branch

Git branch management tool for blocklet projects.

**What it does:**
1. Detects main iteration branch and branch naming conventions
2. Handles branch creation and switching
3. Referenced by blocklet-dev-setup, blocklet-pr, and other skills

### blocklet-url-analyzer

Analyze Blocklet Server related URLs.

**What it does:**
1. Identifies URL type (daemon/service/blocklet)
2. Locates the corresponding development repository
3. Supports analysis of IP DNS domains and regular domains

### blocklet-pr

Create standardized Pull Requests for blocklet projects.

**Trigger phrases:**
- `/blocklet-pr`
- "Help me submit a PR"
- "Create pull request"

**What it does:**
1. Performs lint checks and unit tests
2. Updates version
3. Creates PRs following PR templates

### blocklet-converter

Converts static web or Next.js projects into ArcBlock blocklets.

**Trigger phrases:**
- "Convert this project to a blocklet"
- "Make this a blocklet using DID z8ia..."

**Requirements:**
- Blocklet DID parameter (format: `z8ia...`)
- Static webapp or Next.js project

**What it does:**
1. Analyzes project structure and detects project type
2. Builds the project if needed
3. Generates `blocklet.yml` configuration
4. Creates required assets (logo, README if missing)
5. Validates with `blocklet meta` and `blocklet bundle`

### blocklet-updater

Creates a new release for an existing blocklet project.

**Trigger phrases:**
- "Create a new release"
- "Bump and bundle"
- "Update blocklet version"

**What it does:**
1. Bumps version with `blocklet version patch`
2. Installs dependencies and builds (if build script exists)
3. Verifies entry point and `blocklet.yml` configuration
4. Creates release bundle with `blocklet bundle --create-release`

## Requirements

- [Blocklet CLI](https://www.blocklet.io/docs/cli) installed globally
- [GitHub CLI](https://cli.github.com/) for PR operations
- pnpm or bun for dependency management
