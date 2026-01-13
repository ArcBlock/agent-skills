# ArcBlock Agent Skills

[中文版](README-zh.md)

A collection of Claude Code plugins and agent skills built by the ArcBlock team to enhance AI-assisted engineering workflows.

## Philosophy

We believe in **AI-Native Engineering** - treating AI as a first-class collaborator in software development. These plugins encode our team's accumulated knowledge, workflows, and best practices, making them available to Claude on demand.

Key principles:
- **Context on demand**: Using ALP (Active Loading Policy) to load knowledge when relevant, not all at once
- **Shared knowledge, personal overrides**: Team knowledge as plugin defaults, with personal/project customization
- **Interview over automation**: For content creation, AI asks questions rather than generating blindly

## Quick Start

```bash
# Start Claude Code
claude

# Add the ArcBlock marketplace
/plugin marketplace add git@github.com:ArcBlock/agent-skills.git

# List available plugins
/plugin list arcblock-agent-skills

# Install plugins you need
/plugin install arcblock-context@arcblock-agent-skills
/plugin install content-creation@arcblock-agent-skills
```

## Available Plugins

### Core Knowledge

| Plugin | Description |
|--------|-------------|
| **arcblock-context** | Company knowledge base (products, technical architecture, strategy). Loads context on demand via ALP. Use `/arcblock-context` to explore. |

### Engineering Workflow

| Plugin | Description |
|--------|-------------|
| **devflow** | Developer workflow automation: code review, pull requests, daily engineering tasks |
| **blocklet** | Convert web projects to ArcBlock Blocklets and manage releases |
| **thinking-framework** | Technical thinking framework and proposal review methodology (AFS/AINE) |
| **plugin-development** | Scaffold, validate, and distribute Claude Code plugins |
| **aigne** | Development guide for building AI agents using AIGNE Framework CLI. Covers agent types, skills, workflows, and project configuration. |

### Content Creation

| Plugin | Description |
|--------|-------------|
| **content-creation** | AI interview-based writing system. Creates blogs and social media posts in your style through structured interviews. Use `/interview-writer`. |

## Team Integration

Add this to your project's `.claude/settings.json` for automatic access:

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

## Understanding ALP

ALP (Active Loading Policy) is a context management pattern we designed. Instead of loading all knowledge upfront, we define explicit rules for what Claude should load based on conversation topics.

Benefits:
- Lower token usage (load only what's needed)
- Faster responses (less context to process)
- More focused outputs (attention not diluted)

See [docs/alp-guide.md](plugins/arcblock-context/docs/alp-guide.md) for the full guide.

## Override Mechanism

Plugins support a three-level priority chain:

1. **Project override**: `./.claude/arcblock-context/` - Project-specific customization
2. **User override**: `~/.claude/arcblock-context/` - Personal customization
3. **Plugin default**: Shared team knowledge

This lets the team maintain authoritative documentation while individuals extend or customize for their needs.

## Contributing

1. Fork the repository
2. Create your plugin under `plugins/`
3. Use `/plugin-development:validate` to check structure
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.
