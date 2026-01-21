# Agent Definition Reference

## Basic Structure

```yaml
name: assistant
description: A helpful AI assistant
instructions: |
  You are a helpful assistant.
input_key: message
output_key: response
memory: true
skills:
  - sandbox.mjs
```

## Input/Output Configuration

Two separate configuration pairs:

| Config | Applies To | Purpose |
|--------|------------|---------|
| `input_key` / `output_key` | AIAgent only | Extract/wrap text in specific field |
| `input_schema` / `output_schema` | All agents | Validate structure, enable CLI params |

### input_key / output_key (AIAgent only)

```yaml
input_key: message      # Extract user text from "message"
output_key: response    # Wrap LLM output in "response"
```

### input_schema (Required for CLI parameters)

Each property becomes a CLI `--flagName` option:

```yaml
input_schema:
  type: object
  properties:
    topic: { type: string, description: Poem topic }
    style: { type: string, enum: [haiku, sonnet] }
  required: [topic]
```

```bash
aigne run . poet --topic "nature" --style "haiku"
```

**Without input_schema**, CLI params won't work—only `--input '{}'` is available.

### output_schema (Structured Output)

Force LLM to return JSON matching schema:

```yaml
output_schema:
  type: object
  properties:
    sentiment: { type: string, enum: [positive, negative, neutral] }
    score: { type: number }
  required: [sentiment, score]
```

### CLI Input Limitations

Simple types work with CLI flags. Complex types (arrays of objects) require input file:

```bash
# Complex input - use file
aigne run . batch -i @input.json
```

## Instructions

### Inline

```yaml
instructions: You are a helpful assistant.
```

### From File

```yaml
instructions:
  url: prompts/system.md
```

### Multi-part

```yaml
instructions:
  - role: system
    url: prompts/system.md
  - role: user
    content: "Example:"
  - role: assistant
    content: "Response example"
```

## Template Variables

Nunjucks/Jinja2 syntax. Input properties available as variables:

```yaml
instructions: |
  Write about {{topic}}.
  {% if style %}Style: {{style}}{% endif %}
input_schema:
  type: object
  properties:
    topic: { type: string }
    style: { type: string }
```

Filters: `{{ data | yaml.stringify }}`, `{{ obj | json.stringify }}`

## Memory

```yaml
memory: true   # Maintain conversation history
memory: false  # Stateless (default)
```

## Skills

```yaml
skills:
  - sandbox.mjs
  - filesystem.yaml
  - url: ./tools/search.yaml
    default_input:
      max_results: 10
```

## Common Mistakes

**Using input_key with non-AI agents** - Has no effect on Team/Transform agents.

**Missing input_schema** - CLI `--param` flags won't be available.

**Expecting structured output without output_schema** - Output will be plain text.
