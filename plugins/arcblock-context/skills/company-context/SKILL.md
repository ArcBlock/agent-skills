---
name: company-context
description: Load ArcBlock company context (products, technical architecture, strategy) on demand
---

# Company Context

This skill provides access to ArcBlock's company knowledge base.

## Usage

Invoke `/company-context` to explicitly load relevant company context for your current task.

## Automatic Loading

This plugin also provides automatic context loading via `claude.md` ALP (Active Loading Policy).
When discussing specific products or technologies, relevant context will be loaded automatically.

## Resources

- `products/` - Product documentation
- `technical/` - Technical architecture
- `strategy/` - Company strategy
