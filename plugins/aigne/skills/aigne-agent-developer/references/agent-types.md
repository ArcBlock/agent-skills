# Agent Types Reference

## Overview

| Type | YAML `type` | Purpose |
|------|-------------|---------|
| AI Agent | `ai` (default) | LLM interaction, tool usage, structured output |
| Team Agent | `team` | Orchestrate multiple agents |
| Function Agent | `.js` file | Custom JavaScript logic |
| Transform Agent | `transform` | JSONata data transformation |
| MCP Agent | `mcp` | Connect to MCP servers |
| Image Agent | `image` | Image generation |
| Orchestrator | `@aigne/agent-library/orchestrator` | Complex autonomous workflows |

## AI Agent

Primary agent for LLM interaction.

```yaml
type: ai  # Optional, defaults to 'ai'
name: assistant
description: Helpful assistant
instructions: |
  You are a helpful assistant.
  User: {{message}}
input_key: message
output_key: response
memory: true
skills:
  - calculator.js

# Tool choice: auto | none | required | router
tool_choice: auto

# Structured output
output_schema:
  type: object
  properties:
    sentiment: { type: string, enum: [positive, negative, neutral] }
```

Load instructions from file:
```yaml
instructions:
  url: prompts/system.md
```

## Team Agent

Orchestrate multiple agents in workflows.

```yaml
type: team
name: pipeline
mode: sequential  # or parallel
skills:
  - researcher.yaml
  - writer.yaml
include_all_steps_output: true

# Reflection (self-correction)
reflection:
  reviewer: reviewer.yaml
  is_approved: approved
  max_iterations: 3

# Batch processing
iterate_on: items
concurrency: 3
```

See [workflow-patterns.md](workflow-patterns.md) for detailed patterns.

## Function Agent

JavaScript functions for custom logic. Register under `agents` in aigne.yaml.

```javascript
// save-output.js
import fs from "node:fs/promises";

export default async function saveOutput({ content, filename }) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(filename, content);
  return { saved: true, path: filename };
}

saveOutput.description = "Save content to file";
saveOutput.input_schema = {
  type: "object",
  properties: {
    content: { type: "string" },
    filename: { type: "string" }
  },
  required: ["content", "filename"]
};
saveOutput.output_schema = {
  type: "object",
  properties: {
    saved: { type: "boolean" },
    path: { type: "string" }
  }
};
```

```yaml
# aigne.yaml
agents:
  - workflow.yaml
  - save-output.js  # Function Agents go under 'agents'
```

See [skill-definition.md](skill-definition.md) for complete examples.

## Transform Agent

Declarative data transformation using JSONata.

```yaml
type: transform
name: formatter
jsonata: |
  {
    "fullName": first_name & " " & last_name,
    "total": $sum(items.price)
  }
```

Common JSONata patterns:
- Field mapping: `{ "new": old }`
- Array transform: `items.{ "name": product_name }`
- Calculations: `$sum(items.price)`
- Filtering: `users[age >= 18]`

## MCP Agent

Connect to Model Context Protocol servers.

```yaml
# Stdio transport
type: mcp
command: npx
args: ["-y", "@modelcontextprotocol/server-filesystem", "."]

# Network transport
type: mcp
url: http://localhost:3000/mcp
transport: streamableHttp
```

## Image Agent

Generate images using image models. Configure `image_model` in aigne.yaml.

```yaml
# aigne.yaml
image_model:
  model: google/gemini-3-pro-image-preview  # Use slash format
```

```yaml
# cover-generator.yaml
type: image
name: cover-generator
instructions: |
  Create a cover image for:
  {{article}}
output_key: cover_image
```

**Model Format**: Image models use `provider/model` (slash), not `provider:model` (colon):
```yaml
# WRONG
image_model:
  model: gemini:imagen-3.0

# CORRECT
image_model:
  model: google/gemini-3-pro-image-preview
```

Output format:
```json
{
  "images": [{ "path": "/tmp/image.jpg", "filename": "image.jpg" }]
}
```

Use in sequential workflow:
```yaml
type: team
mode: sequential
skills:
  - writer.yaml          # {article: "..."}
  - cover-generator.yaml # Uses {{article}}
include_all_steps_output: true
```

## Orchestrator Agent

Complex autonomous workflows with planning.

```yaml
type: "@aigne/agent-library/orchestrator"
name: analyzer

objective: |
  Analyze codebase and provide recommendations.

state_management:
  max_iterations: 20
  max_tokens: 100000

afs:
  modules:
    - module: local-fs
      options:
        name: workspace
        localPath: .

skills:
  - code-reader.js
```

Components: Planner → Worker → Completer. Override with custom agents if needed.
