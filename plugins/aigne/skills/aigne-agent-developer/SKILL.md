---
name: aigne-agent-developer
description: Guide for developing AI agents using AIGNE Framework CLI. Use when users want to create AIGNE agents, define agent YAML files, write JavaScript/MCP skills, configure aigne.yaml project files, or understand how to run/test/deploy agents with the aigne CLI. Triggers on requests like "create an agent", "write a skill", "configure aigne.yaml", "help me build an AIGNE project", or mentions of AIGNE Framework development.
---

# AIGNE Agent Developer

## Project Structure

```
my-project/
├── aigne.yaml          # Project config
├── .env.example        # API keys template (copy to .env.local)
├── chat.yaml           # Agent definition
└── utils.mjs           # JavaScript skill (.mjs extension required)
```

## Agent Types

| Type | YAML `type` | File Extension |
|------|-------------|----------------|
| AI Agent | `ai` (default) | `.yaml` |
| Team Agent | `team` | `.yaml` |
| Function Agent | - | `.mjs` |
| Image Agent | `image` | `.yaml` |
| MCP Agent | `mcp` | `.yaml` |

## aigne.yaml

```yaml
name: my-project

chat_model:
  model: google/gemini-3-pro-preview

image_model:
  model: google/gemini-3-pro-image-preview  # slash not colon

agents:
  - chat.yaml
  - save-output.mjs
```

## Agent Definition

**All agents require `input_schema` and `output_schema`:**

```yaml
name: writer
instructions: |
  Write an article about {{topic}}.
input_schema:
  type: object
  properties:
    topic: { type: string, description: Article topic }
  required: [topic]
output_schema:
  type: object
  properties:
    article: { type: string }
    title: { type: string }
  required: [article, title]
```

## Team Agent (Workflows)

**Use Team Agent for fixed workflows, not AI Agent with skills:**

```yaml
# Correct: Fixed sequential workflow (predictable)
name: main
type: team
mode: sequential  # or: parallel
input_schema:
  type: object
  properties:
    topic: { type: string }
  required: [topic]
skills:
  - writer.yaml
  - reviewer.yaml
  - save-output.mjs

# Reflection pattern
reflection:
  reviewer: reviewer.yaml
  is_approved: approved
  max_iterations: 3
```

### Reflection Mechanism Details

**Important:** Reflection triggers AFTER all skills complete. The reviewer receives the OUTPUT of the LAST skill.

```yaml
# ❌ WRONG: reviewer needs {title, article} but gets {success, path} from save-output
skills:
  - writer.yaml        # outputs: {title, article}
  - save-output.mjs    # outputs: {success, path}
reflection:
  reviewer: reviewer.yaml  # expects: {title, article} - FAILS!

# ✅ CORRECT: Use nested Team Agent for mid-workflow reflection
# Step 1: Create writing-with-review.yaml
name: writing-with-review
type: team
mode: sequential
skills:
  - writer.yaml        # outputs: {title, article}
reflection:
  reviewer: reviewer.yaml  # receives: {title, article} - WORKS!

# Step 2: Use nested team in main pipeline
name: article-pipeline
type: team
mode: sequential
skills:
  - writing-with-review.yaml  # outputs reviewed {title, article}
  - cover-generator.yaml
  - save-output.mjs
```

Key rules:
- Reflection reviewer receives output from the **last skill** in the team
- If reviewer needs specific fields, ensure the last skill outputs them
- For mid-workflow review, wrap earlier skills in a nested Team Agent

## Function Agent (.mjs)

```javascript
// save-output.mjs
import fs from "fs/promises";

export default async function saveOutput({ title, article }) {
  await fs.writeFile("output.md", `# ${title}\n\n${article}`);
  return { success: true, path: "output.md" };
}

saveOutput.description = "Save article to file";
saveOutput.input_schema = {
  type: "object",
  properties: {
    title: { type: "string" },
    article: { type: "string" }
  },
  required: ["title", "article"]
};
saveOutput.output_schema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    path: { type: "string" }
  },
  required: ["success", "path"]
};
```

**Calling other agents from Function Agent:**

Function Agent can invoke other agents using `options.context`:

```javascript
// batch-processor.mjs
export default async function batchProcessor({ topics }, options) {
  const results = [];

  // Get agent reference by name
  const pipeline = options.context?.agents?.["article-pipeline"];

  for (const topic of topics) {
    // Invoke agent with input
    const result = await options.context.invoke(pipeline, { topic });
    results.push(result);
  }

  return { results, total: results.length };
}
```

Key points:
- Use `options.context.agents["agent-name"]` to get agent reference
- Use `options.context.invoke(agent, input)` to call the agent
- Do NOT import `@anthropic-ai/aigne` package directly

## Image Agent

**Output is local file path, not base64:**

```yaml
name: cover-generator
type: image
instructions: Generate cover image for {{title}}
input_schema:
  type: object
  properties:
    title: { type: string }
  required: [title]
output_schema:
  type: object
  properties:
    images:
      type: array
      items:
        type: object
        properties:
          path: { type: string }      # Local temp file path
          mimeType: { type: string }
  required: [images]
```

**Handle image output in Function Agent:**
```javascript
// Copy from temp path, don't decode base64
await fs.copyFile(images[0].path, "cover.jpg");
```

## CLI

```bash
aigne run . <agent-name> --<param> "value"  # Run agent
aigne run . main --topic "AI Future"        # Example
aigne run . chat --interactive              # Interactive mode
```

## Key Rules

1. **Function Agents use `.mjs`** - Not `.js`
2. **Use `.env.example`** - Not `.env.local` with placeholders
3. **All agents need schemas** - Both `input_schema` and `output_schema`
4. **Team Agent for fixed workflows** - Don't let AI decide execution order
5. **Image output is file path** - Copy file, don't decode base64
6. **Nullable fields** - Use `type: ["string", "null"]`

## References

See [references/](references/) for detailed documentation on agent types, workflows, and configurations.
