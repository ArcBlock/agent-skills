# Reference Files

This directory contains repository reference files for ArcBlock, Blocklet, and AIGNE organizations.

## High-Density Summary

**ArcBlock** (`org-arcblock-repos.md`): Core infrastructure and SDKs
- Core: blocklet-server, ux, did-connect
- SDK: forge-js, ocap-javascript-sdk, arcblock-ios-sdk
- Mobile: arc-wallet-ios, arc-wallet-android, arc-sphere-ios, arc-sphere-android
- DID: did-spaces, did-motif, abt-did-spec
- DevTools: arcli, eslint-config, auto-i18n

**Blocklet** (`org-blocklet-repos.md`): Blocklet applications and tools
- Kit: payment-kit, media-kit, discuss-kit, pages-kit, search-kit, push-kit, snap-kit
- Store: blocklet-store, create-blocklet, toolkit, launcher
- NFT: nft-studio, nft-tools
- Marketing: lucky-draw, waiting-list, point-up, join-to-earn, promotion-tool
- AI: daily-scribe, enamel-pin-maker, old-photo-fix, id-photo-maker, aistro

**AIGNE** (`org-aigne-repos.md`): AI Agent framework and tools
- Framework: aigne-framework, aigne-hub, aigne-studio
- Smiths: aigne-doc-smith, aigne-image-smith, aigne-code-smith, aigne-web-smith
- MCP: cmc-mcp-server, puppeteer-mcp-server, mcp-proxy
- Adapters: claude-llm-adapter, groq-llm-adapter, chat-gpt-llm-adapter

## Files

- `org-arcblock-repos.md` - ArcBlock organization repositories (core infrastructure, SDKs, mobile apps)
- `org-blocklet-repos.md` - Blocklet organization repositories (blocklet applications, kits, tools)
- `org-aigne-repos.md` - AIGNE organization repositories (AI agent framework, LLM adapters)

## How These Files Were Generated

### 1. Fetch Repository List

Use GitHub CLI to list repositories updated within the last 6 months:

```bash
# ArcBlock organization
gh repo list ArcBlock --limit 200 --json name,url,description,pushedAt \
  | jq '[.[] | select(.pushedAt > "2024-07-01")]'

# Blocklet organization
gh repo list blocklet --limit 200 --json name,url,description,pushedAt \
  | jq '[.[] | select(.pushedAt > "2024-07-01")]'
```

### 2. Determine Main Branch

For each repository, query the last 10 merged PRs to find the most common base branch:

```bash
gh pr list --repo ORG/REPO --state merged --limit 10 --json baseRefName \
  | jq -r '[.[] | .baseRefName] | group_by(.) | map({name: .[0], count: length}) | sort_by(-.count) | .[0].name'
```

### 3. Determine Branch Prefix Convention

For each repository, query the last 20-30 merged PRs to analyze branch naming patterns:

```bash
gh pr list --repo ORG/REPO --state merged --limit 30 --json headRefName \
  | jq -r '[.[] | .headRefName] | join("\n")'
```

Then count occurrences of each prefix pattern (e.g., `feat/`, `feat-`, `fix/`, `fix-`) and use the most common format for each prefix type.

**Important**: When analyzing branch prefixes, select the format (using `/` or `-`) that appears most frequently. Avoid mixing formats like `feat/ fix-` unless that's genuinely the convention in that repository.

### 4. Categorize Repositories

Manually categorize each repository based on its description and purpose.

## Table Format

```markdown
| Name | URL | Main Branch | Branch Prefix | Description | Category |
```

- **Name**: Repository name
- **URL**: GitHub repository URL
- **Main Branch**: Primary development branch (e.g., `main`, `master`, `dev`, `develop`)
- **Branch Prefix**: Branch naming convention (e.g., `feat- fix-`, `feat/ fix/`)
- **Description**: Brief description of the repository
- **Category**: Functional category

## Updating These Files

To update the repository lists:

1. Run the repository list command to get newly active repos
2. For each new repo, query PRs to determine main branch and branch prefix
3. Add new entries to the appropriate file
4. Remove repos that haven't been updated in 6+ months

## Default Conventions

If a repository has no merged PRs (cannot determine from PR history):

| Organization | Default Main Branch | Default Branch Prefix |
|--------------|--------------------|-----------------------|
| ArcBlock | `master` or `main` | `feat- fix-` |
| Blocklet | `main` | `feat- fix-` |
