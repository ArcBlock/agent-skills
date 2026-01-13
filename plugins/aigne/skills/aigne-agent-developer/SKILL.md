---
name: aigne-agent-developer
description: Guide for developing AI agents using AIGNE Framework CLI. Use when users want to create AIGNE agents, define agent YAML files, write JavaScript/MCP skills, configure aigne.yaml project files, or understand how to run/test/deploy agents with the aigne CLI. Triggers on requests like "create an agent", "write a skill", "configure aigne.yaml", "help me build an AIGNE project", or mentions of AIGNE Framework development.
---

# AIGNE Agent Developer

Build AI agents using the AIGNE Framework CLI.

## Quick Start

```bash
aigne create my-project && cd my-project
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

## Agent Types

| Type | YAML `type` | Purpose |
|------|-------------|---------|
| AI Agent | `ai` | LLM interaction |
| Team Agent | `team` | Orchestrate agents |
| Function Agent | `.js` | Custom JS logic |
| Transform Agent | `transform` | JSONata transformation |
| MCP Agent | `mcp` | MCP servers |
| Image Agent | `image` | Image generation |

See [references/agent-types.md](references/agent-types.md) for details.

## Basic Agent

```yaml
name: assistant
instructions: |
  You are a helpful assistant.
  Topic: {{topic}}
input_schema:
  type: object
  properties:
    topic: { type: string }
  required: [topic]
```

**Critical**: `input_schema` required for CLI `--param` flags.

See [references/agent-definition.md](references/agent-definition.md) for details.

## Skills

**JavaScript:**
```javascript
export default async function calc({ expr }) {
  return { result: eval(expr) };
}
calc.description = "Evaluate expression";
calc.input_schema = { type: "object", properties: { expr: { type: "string" } } };
calc.output_schema = { type: "object", properties: { result: { type: "number" } } };
```

**MCP:**
```yaml
type: mcp
command: npx
args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

See [references/skill-definition.md](references/skill-definition.md) for details.

## Workflows

```yaml
# Sequential
type: team
mode: sequential
skills: [researcher.yaml, writer.yaml]

# Parallel
type: team
mode: parallel
skills: [analyzer-a.yaml, analyzer-b.yaml]

# Reflection
type: team
skills: [generator.yaml]
reflection:
  reviewer: reviewer.yaml
  is_approved: approved
  max_iterations: 3
```

See [references/workflow-patterns.md](references/workflow-patterns.md) for details.

## aigne.yaml

```yaml
name: my-project
chat_model:
  model: openai:gpt-4o-mini

image_model:
  model: google/gemini-3-pro-image-preview  # Note: slash not colon

agents:
  - chat.yaml
  - save-output.js  # Function Agents under 'agents'
```

See [references/aigne-yaml-config.md](references/aigne-yaml-config.md) for details.

## CLI Commands

| Command | Purpose |
|---------|---------|
| `aigne create [path]` | Create project |
| `aigne run . <agent>` | Run agent (by `name` field) |
| `aigne run . chat --interactive` | Interactive mode |
| `aigne run . agent -i @input.json` | Run with input file |
| `aigne test` | Run tests |
| `aigne serve-mcp` | Start MCP server |

## References

- [agent-types.md](references/agent-types.md) - AI, Team, Function, Transform, MCP, Image
- [agent-definition.md](references/agent-definition.md) - Agent YAML properties
- [skill-definition.md](references/skill-definition.md) - JavaScript and MCP skills
- [workflow-patterns.md](references/workflow-patterns.md) - Router, Sequential, Parallel, Reflection
- [aigne-yaml-config.md](references/aigne-yaml-config.md) - Project configuration
