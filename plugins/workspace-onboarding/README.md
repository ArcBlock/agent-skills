# Workspace Onboarding

An entry-point plugin for an agent that arrives in an unfamiliar but compatible web workspace.
It maps the workspace's own instructions, fact sources, local skills, content conventions, and
validation gates before routing a voice- or text-originated task to the appropriate project skill.

## Included Skill

### web-workspace-onboarding

Use when an agent receives a workspace through a local path, MCP resource, AFS mount, or a fresh
checkout and must establish how to work safely before drafting, editing, or publishing web content.

The skill is deliberately a router. It does not replace a project's product context, writing skill,
review process, storage convention, or approval authority.

## Installation

```text
/plugin install workspace-onboarding@arcblock-agent-skills
```
