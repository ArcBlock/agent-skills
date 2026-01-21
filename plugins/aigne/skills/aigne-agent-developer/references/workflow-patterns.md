# Workflow Patterns Reference

## Router Pattern

Route requests to specialized agents based on content.

```yaml
type: ai
name: triage
instructions: Route queries to the appropriate specialist.
skills:
  - product-support.yaml
  - feedback.yaml
  - general.yaml
tool_choice: router  # Force selection of one skill
```

Each skill needs clear `description` for routing decisions.

## Handoff Pattern

Transfer control from one agent to another (JavaScript):

```javascript
function transfer_to_specialist() {
  return specialistAgent;  // Return agent instance
}

const primaryAgent = AIAgent.from({
  name: "primary",
  instructions: "Transfer to specialist when needed.",
  skills: [transfer_to_specialist],
});
```

## Sequential Pipeline

Chain agents in order, output flows to next.

```yaml
type: team
name: content-pipeline
mode: sequential
skills:
  - researcher.yaml    # Step 1: { research: "..." }
  - writer.yaml        # Step 2: { draft: "..." }
  - editor.yaml        # Step 3: { edited: "..." }
include_all_steps_output: true
```

Use `{{ previous_output_key }}` in instructions to access previous step output.

## Parallel Processing

Run multiple agents simultaneously, outputs merged.

```yaml
type: team
name: multi-analysis
mode: parallel
skills:
  - technical-analyzer.yaml   # { technical: "..." }
  - business-analyzer.yaml    # { business: "..." }
```

Each agent should use unique `output_key`.

## Reflection Loop

Self-correction through review iterations.

```yaml
type: team
name: quality-writer
skills:
  - generator.yaml
reflection:
  reviewer: reviewer.yaml
  is_approved: approved
  max_iterations: 3
  return_last_on_max_iterations: true
```

Generator handles feedback:
```yaml
# generator.yaml
instructions: |
  Generate content.
  {% if feedback %}
  Address this feedback: {{ feedback }}
  {% endif %}
output_key: content
```

Reviewer outputs structured approval:
```yaml
# reviewer.yaml
output_schema:
  type: object
  properties:
    approved: { type: boolean }
    feedback: { type: string }
  required: [approved]
```

### Reflection Data Flow (Critical)

**Reflection triggers AFTER all skills complete.** The reviewer receives the output of the LAST skill, not intermediate outputs.

```yaml
# ❌ WRONG: reviewer needs {title, article} but gets {success, path}
type: team
skills:
  - writer.yaml        # outputs: {title, article}
  - save-output.mjs    # outputs: {success, path}
reflection:
  reviewer: reviewer.yaml  # expects: {title, article} - FAILS!
```

**Solution: Use nested Team Agent for mid-workflow reflection:**

```yaml
# Step 1: writing-with-review.yaml (reflection happens here)
type: team
skills:
  - writer.yaml        # outputs: {title, article}
reflection:
  reviewer: reviewer.yaml  # receives: {title, article} - WORKS!

# Step 2: main-pipeline.yaml (uses nested team)
type: team
skills:
  - writing-with-review.yaml  # outputs reviewed {title, article}
  - cover-generator.yaml
  - save-output.mjs
```

## Batch Processing

Process arrays of items with `iterate_on`.

```yaml
type: team
name: batch-processor
iterate_on: items       # Key containing array
concurrency: 3          # Parallel processing
mode: parallel
skills:
  - processor.yaml
```

**Important Limitations:**

1. Array elements must be objects, not strings:
```json
// WRONG
{ "items": ["a", "b"] }
// CORRECT
{ "items": [{"value": "a"}, {"value": "b"}] }
```

2. Use input file for complex arrays:
```bash
aigne run . batch -i @input.json
```

## Orchestration

Autonomous multi-step task execution.

```yaml
type: "@aigne/agent-library/orchestrator"
name: analyzer

objective: |
  Analyze the codebase and provide recommendations.

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
  - code-reader.mjs
```

Custom planner/worker/completer can override defaults.

## Hooks

Lifecycle callbacks for any agent.

```yaml
hooks:
  - on_start: logger.yaml
  - on_success: notifier.yaml
  - on_error: error-handler.yaml
  - on_end: cleanup.yaml
```

| Hook | Trigger |
|------|---------|
| `onStart` | Before processing |
| `onSuccess` | After successful processing |
| `onError` | On error (can retry) |
| `onEnd` | Always, after completion |
