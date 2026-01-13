# Skill Definition Reference

## Overview

Skills provide agents with executable capabilities:
- **JavaScript Skills**: Custom functions in `.js` files
- **MCP Skills**: External services via Model Context Protocol in `.yaml` files

## JavaScript Skills

### Structure

```javascript
export default async function skillName({ param1, param2 }) {
  // Process input
  return { result: "output" };
}

skillName.description = "What this skill does";

skillName.input_schema = {
  type: "object",
  properties: {
    param1: { type: "string", description: "Parameter description" }
  },
  required: ["param1"]
};

skillName.output_schema = {
  type: "object",
  properties: {
    result: { type: "string" }
  }
};
```

### Requirements
- Default export as async function
- `.description` - helps LLM decide when to use
- `.input_schema` - JSON Schema for parameters
- `.output_schema` - JSON Schema for return value

### Example: Save Output

```javascript
import fs from "node:fs/promises";
import path from "node:path";

export default async function saveOutput({ article, images, topic }) {
  const outputDir = path.resolve(process.cwd(), "output");
  await fs.mkdir(outputDir, { recursive: true });

  const filename = `${new Date().toISOString().slice(0, 10)}-${topic}`;
  const result = { outputDir, files: [] };

  if (article) {
    const articlePath = path.join(outputDir, `${filename}.md`);
    await fs.writeFile(articlePath, article, "utf-8");
    result.files.push({ type: "article", path: articlePath });
  }

  if (images?.length) {
    for (const image of images) {
      const ext = path.extname(image.filename || ".jpg");
      const imagePath = path.join(outputDir, `${filename}-cover${ext}`);
      await fs.copyFile(image.path, imagePath);
      result.files.push({ type: "image", path: imagePath });
    }
  }

  return result;
}

saveOutput.description = "Save article and images to output directory";

saveOutput.input_schema = {
  type: "object",
  properties: {
    article: { type: "string", description: "Article content" },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          filename: { type: "string" }
        }
      }
    },
    topic: { type: "string", description: "Topic for filename" }
  },
  required: ["article"]
};

saveOutput.output_schema = {
  type: "object",
  properties: {
    outputDir: { type: "string" },
    files: { type: "array" }
  }
};
```

### Using in Workflow

```yaml
# article-workflow.yaml
type: team
mode: sequential
skills:
  - writer.yaml
  - cover-generator.yaml
  - save-output.js
include_all_steps_output: true
```

```yaml
# aigne.yaml - Register under 'agents', not 'skills'
agents:
  - article-workflow.yaml
  - save-output.js
```

## MCP Skills

### Structure

```yaml
type: mcp
command: npx
args:
  - "-y"
  - "@modelcontextprotocol/server-filesystem"
  - "."
env:
  DEBUG: "true"  # Optional
```

### Common MCP Servers

```yaml
# Filesystem
type: mcp
command: npx
args: ["-y", "@modelcontextprotocol/server-filesystem", "."]

# SQLite
type: mcp
command: npx
args: ["-y", "@anthropic/mcp-server-sqlite", "--db", "./data.sqlite"]

# GitHub
type: mcp
command: npx
args: ["-y", "@anthropic/mcp-server-github"]
env:
  GITHUB_TOKEN: "${GITHUB_TOKEN}"

# Puppeteer
type: mcp
command: npx
args: ["-y", "@anthropic/mcp-server-puppeteer"]
```

### Network MCP

```yaml
type: mcp
url: http://localhost:3000/mcp
transport: streamableHttp  # or sse
timeout: 60000
```

## Testing

```javascript
// skill.test.js
import assert from "node:assert";
import test from "node:test";
import mySkill from "./my-skill.js";

test("skill processes input correctly", async () => {
  const result = await mySkill({ param: "value" });
  assert.ok(result.success);
});
```

```bash
aigne test
```
