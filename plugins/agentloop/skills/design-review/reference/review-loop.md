# The review loop

> Diagram of one design-review run. Step order and when to stop stay in `SKILL.md`.

### The Review Loop

```
┌──────────────────────────────────────────────────────┐
│  Step 0: Classify document type                       │
│  → Determines review strategy + tasks.md requirement  │
│                                                       │
│  Step 0.5: Check tasks.md existence                   │
│  → If should have but missing → ask user to generate  │
│                                                       │
│  Round N                                              │
│                                                       │
│  1. Launch CLEAN-CONTEXT subagent (Agent tool)        │
│     - No parent conversation history                  │
│     - Only sees the files it reads                    │
│     - Read-only: cannot modify files                  │
│                                                       │
│  2. Subagent performs review:                          │
│     a. Read design/task documents                     │
│     b. Verify claims against actual code              │
│     c. Dry-run implementation simulation              │
│     d. Check internal consistency                     │
│     e. Identify test coverage gaps                    │
│     f. Score: 0-100% completeness                     │
│                                                       │
│  3. If score >= target → APPROVED, stop               │
│     If score < target → fix issues, next round        │
└──────────────────────────────────────────────────────┘
```
