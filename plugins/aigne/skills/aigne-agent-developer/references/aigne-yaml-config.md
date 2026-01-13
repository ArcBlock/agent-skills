# aigne.yaml Configuration Reference

## Basic Structure

```yaml
name: my-project
description: Project description

chat_model:
  model: openai:gpt-4o-mini
  temperature: 0.7

image_model:
  model: google/gemini-3-pro-image-preview

agents:
  - chat.yaml
  - save-output.js    # Function Agents here too

cli:
  agents:
    - chat.yaml

mcp_server:
  agents:
    - chat.yaml
```

## Chat Model

```yaml
chat_model:
  model: openai:gpt-4o-mini    # provider:model
  temperature: 0.7
  max_tokens: 4096
```

Common providers: `openai:`, `anthropic:`, `gemini:`, `deepseek:`, `ollama:`

## Image Model

```yaml
image_model:
  model: google/gemini-3-pro-image-preview
```

**Important**: Image models use `provider/model` (slash), chat models use `provider:model` (colon).

## Agents vs Skills

| Use `agents` for | Use `skills` for |
|------------------|------------------|
| All agent types (AI, Team, Image, etc.) | Utility tools for AI agents |
| Function Agents (.js workflow steps) | MCP tools AI can call |

```yaml
agents:
  - chat.yaml              # AI Agent
  - article-workflow.yaml  # Team Agent
  - save-output.js         # Function Agent (workflow step)

skills:
  - sandbox.js             # Tool for AI agent to call
```

## CLI Configuration

```yaml
cli:
  agents:
    - chat.yaml
    - name: tools
      description: Tool commands
      alias: [tool]
      agents:
        - url: translate.yaml
          name: translate
```

## MCP Server

```yaml
mcp_server:
  agents:
    - chat.yaml
```

Start: `aigne serve-mcp --port 3000`

## Environment Variables

Create `.env.local`:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
```
