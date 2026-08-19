# Using ArcBlock Agent Skills with Kimi Code CLI

This repository contains two kinds of content:

- **Agent Skills** in `.claude/skills/` — portable, open-format skills that Kimi Code CLI can use directly.
- **Claude Code Plugins** in `plugins/` — Claude-specific packages that rely on the `/plugin` marketplace, hooks, slash commands, and manifest files.

This guide explains how to use the project with [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli), what works out of the box, what can be ported with minimal effort, and what is not compatible.

> **Note:** This project is primarily designed for Claude Code. Kimi support is provided on a best-effort basis.

## Quick start

The fastest way to get the Kimi-ready skills is to copy the `.claude/skills/` directory from this repository into your user skills directory:

```bash
git clone https://github.com/ArcBlock/agent-skills.git
mkdir -p ~/.claude/skills
cp -R agent-skills/.claude/skills/* ~/.claude/skills/
```

Restart Kimi Code CLI, then run:

```
/skill:commit
```

or ask:

```
What skills are available?
```

## What works out of the box

Kimi Code CLI discovers skills from `.claude/skills/` directories (project-level and user-level). The following skills in this repository are ready to use without any changes:

| Skill | Description |
|-------|-------------|
| **commit** | Generate standardized commit messages following Conventional Commits. |
| **pull-request** | Generate standardized Pull Requests from branch diffs; submit via `gh` or save as `PR.md`. |
| **simple-skills-manager** | Install, update, or remove skill groups from local paths or git repositories. |

These skills are pure `SKILL.md` files. They use standard Markdown instructions and do not depend on Claude plugin infrastructure.

## What can be ported to Kimi

Many Claude plugins bundle standard Agent Skills under `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`. These bundled skills are also plain `SKILL.md` files and can be copied into a Kimi-accessible skills directory with minor adaptations.

The following plugin-bundled skills are good candidates for porting:

| Plugin | Bundled Skills | Porting Notes |
|--------|---------------|---------------|
| **arcblock-context** | `arcblock-context` | Loads company knowledge (products, technical architecture, strategy). Remove `/arcblock-context` slash-command references; use `/skill:arcblock-context` or natural-language prompts. |
| **thinking-framework** | `what-robert-thinks` | Proposal review framework. Works as a standalone skill; no plugin dependencies. |
| **content-creation** | `interview-writer` | Interview-based writing system. Uses `~/.claude/content-profile/` for user profiles, which Kimi can access because it reads `.claude/` directories. |
| **plugin-development** | `plugin-authoring` | Guidance for creating Claude plugins. Useful for cross-tool skill authoring; some examples are Claude-specific. |
| **agentloop** | `verification`, `issue-sweep`, `issue-review`, `pr-sweep`, `pr-review`, `design-review`, `build-phases`, `issue-graph`, `impact-check`, etc. | Most are workflow instructions. Some depend on `agentloop` scripts, repo profiles, or fleet infrastructure; those require more adaptation. |
| **blocklet** | `blocklet-getting-started`, `blocklet-dev-setup`, `blocklet-server-dev-setup`, `blocklet-branch`, `blocklet-pr`, `blocklet-converter`, `blocklet-updater`, `blocklet-url-analyzer` | Useful if you work with Blocklet. Many instructions reference Blocklet CLI and tmux, which are tool-agnostic, but some workflow steps assume Claude plugin paths. |

### How to port a plugin-bundled skill

1. Locate the skill:

   ```bash
   ls plugins/<plugin-name>/skills/
   ```

2. Copy the skill directory into a Kimi skills directory:

   ```bash
   mkdir -p ~/.claude/skills/
   cp -R plugins/<plugin-name>/skills/<skill-name> ~/.claude/skills/<plugin-name>-<skill-name>
   ```

   > Use a prefixed name (e.g., `arcblock-context`, `thinking-what-robert-thinks`) to avoid collisions with other skills.

3. Edit the copied `SKILL.md` and make these adjustments:
   - Replace Claude-specific slash commands like `/arcblock-context` with `/skill:<name>` or natural-language invocation.
   - Remove or rewrite references to Claude plugin paths (e.g., plugin install locations).
   - Remove the `allowed-tools` frontmatter field, or leave it; Kimi ignores it safely.
   - If the skill loads reference files from the plugin directory, update relative paths or copy the referenced files alongside the skill.

4. Restart Kimi Code CLI and test:

   ```
   /skill:<name>
   ```

## What does **not** work in Kimi

The following Claude Code features have no Kimi equivalent and cannot be used:

- **Plugin marketplace** (`/plugin marketplace add ...`, `/plugin install ...`)
- **Plugin manifests** (`.claude-plugin/plugin.json`)
- **Hooks** (`hooks/hooks.json`)
- **Slash-command files** (`commands/*.md`)
- **Agent definition files** (`agents/*.md`)
- **Plugin packaging and validation workflows**

The following plugins rely on the above infrastructure and are therefore unavailable in Kimi without porting:

- `arcblock-context` (the plugin wrapper; the knowledge-base skill can be ported)
- `agentloop` (the engine; individual instructional skills can be ported)
- `blocklet` (the plugin wrapper; individual skills can be ported)
- `content-creation` (the plugin wrapper; the `interview-writer` skill can be ported)
- `thinking-framework` (the plugin wrapper; the `what-robert-thinks` skill can be ported)
- `plugin-development` (the plugin wrapper; the `plugin-authoring` skill can be ported)

## Skill readiness matrix

| Skill / Plugin | Location | Works in Kimi | Notes |
|----------------|----------|---------------|-------|
| `commit` | `.claude/skills/commit/` | ✅ Yes | Fully functional. |
| `pull-request` | `.claude/skills/pull-request/` | ✅ Yes | `gh` CLI submission works; PR body may mention Claude Code. |
| `simple-skills-manager` | `.claude/skills/simple-skills-manager/` | ✅ Yes | Can manage skills from git/local paths; uses `.claude/` directories that Kimi reads. |
| `arcblock-context` | `plugins/arcblock-context/skills/arcblock-context/` | ⚠️ Port needed | Copy skill + knowledge files to `.claude/skills/`. |
| `interview-writer` | `plugins/content-creation/skills/interview-writer/` | ⚠️ Port needed | Copy skill + `references/` files; profile path `~/.claude/content-profile/` works in Kimi. |
| `what-robert-thinks` | `plugins/thinking-framework/skills/what-robert-thinks/` | ⚠️ Port needed | Copy skill; no external dependencies. |
| `plugin-authoring` | `plugins/plugin-development/skills/plugin-authoring/` | ⚠️ Port needed | Some examples reference Claude-specific plugin features. |
| `agentloop` skills | `plugins/agentloop/skills/*/` | ⚠️ Partial | Instructional skills port easily; engine-dependent skills need scripts/profiles. |
| `blocklet` skills | `plugins/blocklet/skills/*/` | ⚠️ Partial | Useful if you use Blocklet; some steps assume plugin paths. |
| Plugin wrappers / marketplace | `.claude-plugin/`, `plugins/*/.claude-plugin/` | ❌ No | Claude-specific infrastructure. |

## Installation options

### Option 1: User-level skills (recommended)

Copy the portable skills to `~/.claude/skills/` so they are available in every project:

```bash
mkdir -p ~/.claude/skills
cp -R agent-skills/.claude/skills/* ~/.claude/skills/
```

To also port a plugin-bundled skill:

```bash
cp -R agent-skills/plugins/arcblock-context/skills/arcblock-context \
  ~/.claude/skills/arcblock-context
```

### Option 2: Project-level skills

Copy skills into a specific project:

```bash
mkdir -p /path/to/project/.claude/skills
cp -R agent-skills/.claude/skills/* /path/to/project/.claude/skills/
```

Project-level skills are loaded automatically when you run `kimi` inside the project.

### Option 3: `simple-skills-manager`

Use the bundled `simple-skills-manager` skill to keep skills synchronized from a git repository:

```
/skill:simple-skills-manager
```

Then provide the repository URL and a group name. The manager will create tip files in `~/.claude/skills/` that point back to the source files, making updates easy.

### Option 4: `--skills-dir` flag

For quick testing, point Kimi directly at the skills directory:

```bash
kimi --skills-dir /path/to/agent-skills/.claude/skills
```

For a persistent extra directory, add it to your Kimi config:

```toml
extra_skill_dirs = [
    "/path/to/agent-skills/.claude/skills",
]
```

## Using skills in Kimi

Kimi discovers skills automatically. You can invoke them implicitly:

```
Generate a commit message for my staged changes.
```

Or explicitly:

```
/skill:commit
/skill:pull-request
/skill:simple-skills-manager
```

For ported plugin skills:

```
/skill:arcblock-context
/skill:what-robert-thinks
/skill:interview-writer
```

## Known limitations

| Feature | Claude Code | Kimi Code CLI |
|---------|-------------|---------------|
| Skill discovery | `~/.claude/skills/`, `.claude/skills/` | `~/.claude/skills/`, `.claude/skills/` (and others) ✅ |
| `allowed-tools` frontmatter | Honored | Ignored ⚠️ |
| Shell tool in instructions | `Bash` | `Shell`; the AI adapts ✅ |
| Plugin marketplace | `/plugin ...` | Not supported ❌ |
| Slash commands | `/command` | Use `/skill:<name>` or natural language ⚠️ |
| Profile paths like `~/.claude/content-profile/` | Supported | Supported (Kimi reads `.claude/` dirs) ✅ |
| Claude branding in outputs | Expected | Cosmetic only ⚠️ |

### `allowed-tools`

Skills from this repository use the Claude-specific `allowed-tools` frontmatter field (for example, `Bash`). Kimi does not recognize this field, so it will ask for permission before running commands as usual. The skill instructions still work.

### Claude branding

Some generated outputs (commit messages, PR bodies) include references to Claude Code. These are plain text and do not affect functionality. You can edit the output before committing or submitting if you prefer.

### Slash commands

Skills like `arcblock-context` are documented with Claude slash commands (`/arcblock-context <topic>`). In Kimi, use `/skill:arcblock-context` or simply describe what you want, for example:

```
Load the ArcBlock AFS technical context.
```

## Keeping the Kimi setup in sync

When this repository adds new skills to `.claude/skills/`, update your local copy:

```bash
cd agent-skills
git pull
cp -R .claude/skills/* ~/.claude/skills/
```

If you used `simple-skills-manager`, run the update workflow to re-sync from the repository.

## Getting help

- For Kimi-specific behavior: [Kimi Code CLI skills documentation](https://moonshotai.github.io/kimi-cli/en/customization/skills.md)
- For the original skills and plugins: [ArcBlock/agent-skills issues](https://github.com/ArcBlock/agent-skills/issues)
