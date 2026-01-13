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
├── .env.example        # API keys template (copy to .env.local)
├── chat.yaml           # Agent definition
└── utils.mjs           # JavaScript skill (use .mjs extension!)
```

## Agent Types

| Type | YAML `type` | Purpose |
|------|-------------|---------|
| AI Agent | `ai` | LLM interaction |
| Team Agent | `team` | Orchestrate agents |
| Function Agent | `.mjs` | Custom JS logic |
| Transform Agent | `transform` | JSONata transformation |
| MCP Agent | `mcp` | MCP servers |
| Image Agent | `image` | Image generation |

See [references/agent-types.md](references/agent-types.md) for details.

## Basic Agent

**Critical**: ALL agents MUST define both `input_schema` and `output_schema`:

```yaml
name: assistant
instructions: |
  You are a helpful assistant.
  Topic: {{topic}}
input_schema:
  type: object
  properties:
    topic:
      type: string
      description: The topic to discuss
  required:
    - topic
output_schema:
  type: object
  properties:
    message:
      type: string
      description: The response message
  required:
    - message
```

See [references/agent-definition.md](references/agent-definition.md) for details.

## Skills

**JavaScript (use .mjs extension):**
```javascript
// save-output.mjs
export default async function saveOutput({ title, article, image }) {
  // ... implementation
  return { success: true, articlePath, imagePath, message };
}

saveOutput.description = "Save article and cover image to output directory";

saveOutput.input_schema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Article title" },
    article: { type: "string", description: "Article content" },
    image: { type: "string", description: "Cover image base64 data" }
  },
  required: ["title", "article"]  // image is optional
};

saveOutput.output_schema = {
  type: "object",
  properties: {
    success: { type: "boolean", description: "Whether save succeeded" },
    articlePath: { type: "string", description: "Article file path" },
    imagePath: { type: ["string", "null"], description: "Image file path (null if no image)" },
    message: { type: "string", description: "Result message" }
  },
  required: ["success", "articlePath", "message"]  // imagePath can be null
};
```

**MCP:**
```yaml
type: mcp
command: npx
args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

See [references/skill-definition.md](references/skill-definition.md) for details.

## Workflows

**Critical**: Team agents MUST define `input_schema` and `output_schema` to pass parameters:

```yaml
# Sequential with parameter passing
name: article-pipeline
type: team
mode: sequential
input_schema:
  type: object
  properties:
    topic:
      type: string
      description: Article topic
  required:
    - topic
output_schema:
  type: object
  properties:
    article:
      type: string
    title:
      type: string
  required:
    - article
    - title
skills:
  - writer.yaml

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

# Default recommended models
chat_model:
  model: google/gemini-3-pro

image_model:
  model: google/gemini-3-pro-image-preview  # Note: use slash not colon for google models

agents:
  - chat.yaml
  - save-output.mjs  # Function Agents use .mjs extension
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

**CLI Parameter Syntax**:
```bash
# Correct: use --<param-name> directly
aigne run . main --topics "AI Future"

# Wrong: do NOT use --param
aigne run . main --param topics="AI Future"  # WRONG!
```

## Best Practices

### 1. Always use .mjs extension for Function Agents
```
save-output.mjs   # Correct
save-output.js    # Wrong - will cause module warnings
```

### 2. Create .env.example instead of .env.local
```bash
# .env.example - Template file (commit to git)
# Copy to .env.local and fill in your actual API keys
# OPENAI_API_KEY=
# GOOGLE_GENERATIVE_AI_API_KEY=
```

### 3. ALL agents must define input_schema AND output_schema
```yaml
# Every agent needs both schemas
input_schema:
  type: object
  properties:
    topic: { type: string }
  required: [topic]           # Specify required fields
output_schema:
  type: object
  properties:
    result: { type: string }
  required: [result]          # Specify required fields
```

### 4. Use required array for mandatory fields
```yaml
input_schema:
  type: object
  properties:
    title: { type: string }     # required
    subtitle: { type: string }  # optional
  required:
    - title                     # only title is required
```

### 5. Handle nullable output fields properly
```javascript
// For fields that may be null, use type array
output_schema = {
  properties: {
    imagePath: { type: ["string", "null"] }  // Can be string or null
  },
  required: ["imagePath"]  // Still required, but can be null
};
```

## Common Pitfalls

### 1. Using .js instead of .mjs for Function Agents
```
utils.mjs   # Correct - ES module
utils.js    # Wrong - causes module type warnings
```

### 2. Creating .env.local with placeholder values
```bash
# Wrong: creates fake API keys that override real env vars
OPENAI_API_KEY=your-key-here

# Correct: use .env.example as template, leave .env.local out of git
```

### 3. Missing input_schema on Team agents
```yaml
# Wrong: children won't receive parameters
type: team
skills: [writer.yaml]

# Correct: define input_schema for parameter passing
type: team
input_schema:
  type: object
  properties:
    topic: { type: string }
  required: [topic]
skills: [writer.yaml]
```

### 4. Missing output_schema on agents
```yaml
# Wrong: no output validation
name: writer
instructions: Write an article

# Correct: always define output_schema
name: writer
instructions: Write an article
output_schema:
  type: object
  properties:
    article: { type: string }
    title: { type: string }
  required: [article, title]
```

## References

- [agent-types.md](references/agent-types.md) - AI, Team, Function, Transform, MCP, Image
- [agent-definition.md](references/agent-definition.md) - Agent YAML properties
- [skill-definition.md](references/skill-definition.md) - JavaScript and MCP skills
- [workflow-patterns.md](references/workflow-patterns.md) - Router, Sequential, Parallel, Reflection
- [aigne-yaml-config.md](references/aigne-yaml-config.md) - Project configuration
