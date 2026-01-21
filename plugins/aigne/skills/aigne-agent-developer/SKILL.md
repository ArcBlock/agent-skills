---
name: aigne-agent-developer
description: Guide for developing AI agents using AIGNE Framework CLI. Use when users want to create AIGNE agents, define agent YAML files, write JavaScript/MCP skills, configure aigne.yaml project files, or understand how to run/test/deploy agents with the aigne CLI. Triggers on requests like "create an agent", "write a skill", "configure aigne.yaml", "help me build an AIGNE project", or mentions of AIGNE Framework development.
---

# AIGNE Agent Developer

## Quick Start

```
my-project/
├── aigne.yaml          # Project config
├── .env.example        # API keys template (copy to .env.local)
├── chat.yaml           # Agent definition
└── utils.mjs           # JavaScript skill (.mjs extension required)
```

```yaml
# aigne.yaml
name: my-project
chat_model:
  model: google/gemini-3-pro-preview
image_model:
  model: google/gemini-3-pro-image-preview
agents:
  - chat.yaml
  - utils.mjs
```

```bash
aigne run . <agent-name> --<param> "value"
aigne run . chat --interactive
```

## Reference Guide

Read the appropriate reference file based on your task:

| Task | Reference File |
|------|----------------|
| Creating any agent (AI, Team, Image, MCP, etc.) | [references/agent-types.md](references/agent-types.md) |
| Configuring agent input/output, instructions, memory | [references/agent-definition.md](references/agent-definition.md) |
| Writing JavaScript Function Agents (.mjs) | [references/skill-definition.md](references/skill-definition.md) |
| Building workflows (sequential, parallel, batch, reflection) | [references/workflow-patterns.md](references/workflow-patterns.md) |
| Configuring aigne.yaml project file | [references/aigne-yaml-config.md](references/aigne-yaml-config.md) |

## Critical Rules

1. **Function Agents use `.mjs`** - Not `.js`
2. **All agents need schemas** - Both `input_schema` and `output_schema`
3. **Image model uses slash** - `google/gemini-3-pro-image-preview` not colon
4. **Nullable fields** - Use `type: ["string", "null"]`

## Common Pitfalls

### Function Agent Calling Other Agents

Use `options.context` to invoke other agents. Do NOT import `@anthropic-ai/aigne` directly:

```javascript
export default async function batch({ items }, options) {
  const pipeline = options.context?.agents?.["my-pipeline"];
  const results = [];
  for (const item of items) {
    results.push(await options.context.invoke(pipeline, item));
  }
  return { results };
}
```

### Reflection Data Flow

Reflection triggers AFTER all skills complete. Reviewer receives output from the LAST skill:

```yaml
# ❌ WRONG: reviewer needs {article} but gets {path} from save-output
skills: [writer, save-output]
reflection:
  reviewer: reviewer  # FAILS - no article field

# ✅ CORRECT: Nest Team Agent for mid-workflow review
# writing-with-review.yaml
skills: [writer]
reflection:
  reviewer: reviewer  # Gets {article} from writer

# main-pipeline.yaml
skills: [writing-with-review, save-output]
```

### Batch Processing Array Format

Array elements MUST be objects, not primitives:

```json
// ❌ WRONG
{ "items": ["AI", "Blockchain"] }

// ✅ CORRECT
{ "items": [{"topic": "AI"}, {"topic": "Blockchain"}] }
```
