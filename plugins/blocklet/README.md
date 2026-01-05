# Blocklet

Agent skills for working with ArcBlock blocklets - convert web projects to blocklets and manage releases.

## Installation

```bash
/plugin install blocklet@arcblock-agent-skills
```

## Skills

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
- pnpm or bun for dependency management
