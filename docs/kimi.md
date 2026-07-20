# Using ArcBlock Agent Skills with Kimi Code CLI

In addition to Claude Code, the **Agent Skills** in this repository can also be used with [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli). This guide explains what works, what doesn't, and how to set things up.

> **Note:** This project is primarily designed for Claude Code. Kimi support is provided on a best-effort basis for the Agent Skills portion only.

## What works in Kimi

Kimi Code CLI supports the open [Agent Skills](https://agentskills.io/) format and automatically discovers `SKILL.md` files from `.claude/skills/` directories. The following skills in this repository are usable in Kimi:

| Skill | Description |
|-------|-------------|
| **commit** | Generate standardized commit messages following Conventional Commits. |
| **pull-request** | Generate standardized Pull Requests from branch diffs and submit via `gh` or save as `PR.md`. |
| **simple-skills-manager** | Manage skills from local paths or git repositories. |

## What does **not** work in Kimi

The **Claude Code plugins** under [`plugins/`](../plugins/) are **not** compatible with Kimi because they rely on Claude-specific mechanisms:

- `.claude-plugin/plugin.json` manifests
- Claude Code `/plugin` marketplace and slash commands
- Hooks (`hooks/hooks.json`)
- Claude-specific command files

The following plugins are therefore unavailable in Kimi:

- `arcblock-context`
- `agentloop`
- `blocklet`
- `content-creation`
- `thinking-framework`
- `plugin-development`

If you need ArcBlock company knowledge or plugin-based workflows in Kimi, you will need to port the relevant `SKILL.md`-style content manually.

## Installing the skills in Kimi

### Option 1: Install to your user skills directory (recommended)

Copy the `.claude/skills/` folder from this repository to your user-level Kimi/Claude skills directory:

```bash
# Clone the repository
git clone https://github.com/ArcBlock/agent-skills.git

# Install skills to your user directory
mkdir -p ~/.claude/skills
cp -R agent-skills/.claude/skills/* ~/.claude/skills/
```

Restart Kimi Code CLI, then ask:

```
What skills are available?
```

### Option 2: Install as project skills

If you want these skills available only within a specific project, copy them into that project:

```bash
mkdir -p /path/to/your/project/.claude/skills
cp -R agent-skills/.claude/skills/* /path/to/your/project/.claude/skills/
```

Project-level skills are loaded automatically when you run `kimi` inside the project.

### Option 3: Point Kimi at the repository with `--skills-dir`

For quick testing, you can launch Kimi with an extra skills directory:

```bash
kimi --skills-dir /path/to/agent-skills/.claude/skills
```

For a persistent extra skills directory, add it to your Kimi config:

```toml
extra_skill_dirs = [
    "/path/to/agent-skills/.claude/skills",
]
```

## Using the skills

Once installed, Kimi will discover the skills automatically. You can invoke them implicitly by describing what you want:

```
Generate a commit message for my staged changes.
```

Or load a skill explicitly with the slash command:

```
/skill:commit
/skill:pull-request
/skill:simple-skills-manager
```

## Known differences and limitations

| Feature | Claude Code | Kimi Code CLI |
|---------|-------------|---------------|
| Skill discovery | `~/.claude/skills/`, `.claude/skills/` | `~/.claude/skills/`, `.claude/skills/` (and others) ✅ |
| `allowed-tools` frontmatter | Honored | Not supported; Kimi will ask for tool permission as usual ⚠️ |
| Shell tool name in instructions | `Bash` | `Shell`; skill instructions still work because the AI adapts ✅ |
| Plugin marketplace (`/plugin`) | Supported | Not supported ❌ |
| Claude branding in outputs | Expected | Cosmetic only; you may see "Generated with Claude Code" or "Co-Authored-By: Claude" ⚠️ |

### About `allowed-tools`

The skills use the Claude-specific `allowed-tools` frontmatter field (for example, `Bash`). Kimi does not recognize this field, so it will not pre-approve tools. The skill instructions remain valid, but Kimi may prompt you for permission before running commands.

### About Claude branding

Some generated outputs (commit messages, PR bodies) include references to Claude Code. These are plain text and do not affect functionality in Kimi. If you prefer, you can edit the generated content before committing or submitting.

## Getting help

For Kimi-specific skill behavior, see the [Kimi Code CLI skills documentation](https://moonshotai.github.io/kimi-cli/en/customization/skills.md).

For questions about the original skills, open an issue in the [ArcBlock/agent-skills](https://github.com/ArcBlock/agent-skills) repository.
