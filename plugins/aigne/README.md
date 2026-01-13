# AIGNE Plugin

Development tools and guides for building AI agents using the AIGNE Framework CLI.

## Skills

### aigne-agent-developer

Guide for developing AI agents using AIGNE Framework CLI.

**Trigger phrases:**
- "create an agent"
- "write a skill"
- "configure aigne.yaml"
- "help me build an AIGNE project"
- mentions of AIGNE Framework development

**What it does:**
1. Guides through project creation with `aigne create`
2. Helps define agent YAML files (AI, Team, Transform, MCP, Image agents)
3. Assists with JavaScript skill development
4. Configures `aigne.yaml` project files
5. Explains CLI commands for running, testing, and deploying agents

## Quick Start

```bash
# Create a new AIGNE project
aigne create my-project && cd my-project

# Run in interactive mode
aigne run . chat --interactive
```

## Project Structure

```
my-project/
├── aigne.yaml          # Project config
├── .env.local          # API keys
├── chat.yaml           # Agent definition
└── sandbox.js          # JavaScript skill
```

## References

The skill includes detailed reference documentation:

- **agent-types.md** - AI, Team, Function, Transform, MCP, Image agents
- **agent-definition.md** - Agent YAML properties and configuration
- **skill-definition.md** - JavaScript and MCP skill development
- **workflow-patterns.md** - Router, Sequential, Parallel, Reflection patterns
- **aigne-yaml-config.md** - Project configuration options
