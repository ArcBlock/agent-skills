# ArcBlock Agent Skills

A curated collection of agent skills and Claude Code plugins by the ArcBlock Team.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

```bash
# Start Claude Code
claude

# Add the ArcBlock marketplace (preferred method)
/plugin marketplace add git@github.com:ArcBlock/agent-skills.git

# Or use the shorthand format
# /plugin marketplace add ArcBlock/agent-skills

# List available plugins
/plugin list arcblock-agent-skills

# Install a plugin
/plugin install <plugin-name>@arcblock-agent-skills
```

## Team Integration

Add this marketplace to your ArcBlock projects by including `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "arcblock-agent-skills": {
      "source": {
        "source": "github",
        "repo": "ArcBlock/agent-skills"
      }
    }
  }
}
```

## Plugin Development

### 1. Install the Plugin Development Toolkit

```bash
# Start Claude Code
claude

# Add your local marketplace
/plugin marketplace add .

# Install the development toolkit
/plugin install plugin-development@arcblock-agent-skills
```

### 2. Create Your First Plugin

```bash
# Scaffold a new plugin
/plugin-development:init my-awesome-plugin

# Add components
/plugin-development:add-command my-command "Description of what it does"
/plugin-development:add-skill my-skill "Use when working with..."

# Validate before publishing
/plugin-development:validate
```

### Available Commands

| Command | Description |
|---------|-------------|
| `/plugin-development:init [name]` | Scaffold a new plugin |
| `/plugin-development:add-command [name] [desc]` | Add a slash command |
| `/plugin-development:add-skill [name] [desc]` | Add a skill |
| `/plugin-development:add-agent [name] [desc]` | Add a sub-agent |
| `/plugin-development:add-hook [event] [matcher]` | Add a hook |
| `/plugin-development:validate` | Validate plugin structure |
| `/plugin-development:test-local` | Test locally |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add your skill or plugin under `plugins/`
4. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## About ArcBlock

[ArcBlock](https://www.arcblock.io/) is building the decentralized web with blockchain technology. This repository is part of our effort to enhance developer productivity with AI-powered tools.
