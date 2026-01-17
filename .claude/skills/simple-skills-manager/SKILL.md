---
name: simple-skills-manager
description: Manage skills from local paths or git repositories - add, update, or remove skill tips in ~/.claude/skills with group prefix
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# Simple Skills Manager

Manage skill tips in `~/.claude/skills/` that point to skills from local paths or git repositories, enabling dynamic invocation via `/{group}:{skill-name}`.

## Constants

- **Repos directory**: `~/.claude/simple-skills-manager-repos/`
- **Skills directory**: `~/.claude/skills/`
- **Backup directory**: `~/.claude/simple-skills-manager-backup-last-skills/`

## Workflow

### Step 1: Ask Operation Type

**First**, ask the user what operation they want to perform:

```json
{
  "questions": [{
    "question": "What operation would you like to perform?",
    "header": "Operation",
    "options": [
      {"label": "Add (Recommended)", "description": "Add skills from a local path or git repository"},
      {"label": "Update", "description": "Update an existing skill group (re-sync from source)"},
      {"label": "Remove", "description": "Remove an existing skill group"}
    ],
    "multiSelect": false
  }]
}
```

### Step 2: Collect Information Based on Operation

#### For "Add" Operation

Ask user to directly input the source path or git URL:

```json
{
  "questions": [{
    "question": "Please enter the local path or git URL for the skills:",
    "header": "Source",
    "options": [
      {"label": "Example: /path/to/skills", "description": "Local directory containing SKILL.md files"},
      {"label": "Example: https://github.com/user/repo.git", "description": "Git repository URL (will be cloned)"}
    ],
    "multiSelect": false
  }]
}
```

The user will select "Other" and type the actual path or URL. The system will auto-detect the source type:
- **Git URL**: starts with `http://`, `https://`, `git@`, or ends with `.git`
- **Local path**: everything else (treat as filesystem path)

After getting the source, ask for the group name:

```json
{
  "questions": [{
    "question": "What group name should be used as prefix? (e.g., 'mygroup' creates '/mygroup:skill-name')",
    "header": "Group",
    "options": [
      {"label": "Use folder name", "description": "Use the source folder/repo name as group"},
      {"label": "Custom", "description": "Enter a custom group name"}
    ],
    "multiSelect": false
  }]
}
```

**Group name validation**: The group name must:
- Only contain lowercase letters, numbers, and hyphens (`a-z`, `0-9`, `-`)
- Not start or end with a hyphen
- Not be empty
- Not contain spaces, slashes, asterisks, or other special characters

If the group name is invalid, ask the user to provide a valid name.

#### For "Update" or "Remove" Operation

First, list existing groups to show the user what's available:

```bash
# List groups from skills directory
ls -d ~/.claude/skills/*:* 2>/dev/null | xargs -I {} basename {} | cut -d: -f1 | sort -u

# List tracked repos
ls ~/.claude/simple-skills-manager-repos/ 2>/dev/null
```

Display the found groups as reference information, then ask the user to input the group name they want to manage:

```json
{
  "questions": [{
    "question": "Which group do you want to update/remove? (Enter the group name)",
    "header": "Group",
    "options": [
      {"label": "Example: mygroup", "description": "Enter the group name you want to manage"},
      {"label": "Example: arcblock", "description": "The group prefix used in skill names like /arcblock:commit"}
    ],
    "multiSelect": false
  }]
}
```

The user will select "Other" and type the actual group name. Validate that the group exists before proceeding.

### Step 3: Backup Before Operation (Required)

**Before executing any Add, Update, or Remove operation**, you MUST backup the current skills directory:

```bash
# Remove old backup if exists, then create new backup
rm -rf ~/.claude/simple-skills-manager-backup-last-skills
cp -r ~/.claude/skills ~/.claude/simple-skills-manager-backup-last-skills
```

This ensures the user can recover their skills if something goes wrong.

### Step 4: Execute Operation

#### Add Operation

1. **If git URL**: Clone to `~/.claude/simple-skills-manager-repos/{group}/`
   ```bash
   git clone {git-url} ~/.claude/simple-skills-manager-repos/{group}
   ```
   - If clone fails, **stop and report error** - do not proceed

2. **Determine working path**:
   - Local path: use as-is (verify path exists first)
   - Git URL: use `~/.claude/simple-skills-manager-repos/{group}/`

3. **Scan for skills** in the working path:
   ```bash
   find "{working-path}" -name "SKILL.md" -type f 2>/dev/null
   ```
   - If no SKILL.md found, **stop and report error** - do not proceed

4. **Clean existing tips** for this group (only after steps 1-3 succeed):
   ```bash
   rm -rf ~/.claude/skills/{group}:*
   ```

5. **Create skill tips** for each SKILL.md found (see "Creating Skill Tips" section)

6. **Save source metadata** for local path groups:
   ```bash
   echo "{absolute-working-path}" > ~/.claude/simple-skills-manager-repos/{group}.source
   ```
   This allows Update operation to find the original source path later.

7. **Report results**

#### Update Operation

1. **Find the source path and pull latest**:
   - **Git source**: Check if `~/.claude/simple-skills-manager-repos/{group}/` directory exists
     - If yes, run `git pull` first:
       ```bash
       git -C ~/.claude/simple-skills-manager-repos/{group} pull
       ```
     - Working path: `~/.claude/simple-skills-manager-repos/{group}/`
   - **Local path source**: Check if `~/.claude/simple-skills-manager-repos/{group}.source` file exists
     - If yes, read the original path from it:
       ```bash
       cat ~/.claude/simple-skills-manager-repos/{group}.source
       ```
     - If no, ask user to provide the source path
     - Working path: the path from `.source` file or user input

2. **Scan for skills** in the working path:
   ```bash
   find "{working-path}" -name "SKILL.md" -type f 2>/dev/null
   ```
   - If no SKILL.md found, **stop and report error** - do not proceed

3. **Clean existing tips** for this group (only after scan succeeds):
   ```bash
   rm -rf ~/.claude/skills/{group}:*
   ```

4. **Re-scan and recreate** all skill tips from the updated source

5. **Report results** (include git pull output if applicable)

#### Remove Operation

1. **Remove skill tips**:
   ```bash
   rm -rf ~/.claude/skills/{group}:*
   ```

2. **Optionally remove cloned repo and source metadata** (ask user):
   ```bash
   # Remove cloned repo if exists
   rm -rf ~/.claude/simple-skills-manager-repos/{group}
   # Remove source metadata file if exists
   rm -f ~/.claude/simple-skills-manager-repos/{group}.source
   ```

3. **Report results**

## Creating Skill Tips

For each SKILL.md found, extract:
1. **Skill name**: From `name:` field in frontmatter, or from parent directory name
2. **Description**: From `description:` field in frontmatter
3. **Allowed tools**: From `allowed-tools:` field in frontmatter

Create directory and SKILL.md in `~/.claude/skills/{group}:{skill-name}/SKILL.md`:

```bash
mkdir -p ~/.claude/skills/{group}:{skill-name}
```

Generated SKILL.md format:

```markdown
---
name: {group}:{skill-name}
description: {original-description}
allowed-tools:
  - Read
  - Glob
  - Grep
  {... copy remaining allowed-tools from original skill, excluding duplicates}
---

# {group}:{skill-name}

This is a tip pointing to a skill from external source.

## Instructions

**IMPORTANT**: Read and execute the skill from the following path:

{absolute-path-to-original-SKILL.md}

Use the Read tool to load the actual skill content, then follow all instructions in that file.
```

**Note**: When copying `allowed-tools`, always include `Read`, `Glob`, `Grep` first (required for tip to work), then add any additional tools from the original skill that are not already listed.

## Example Workflows

### Adding from Git

1. User runs `/simple-skills-manager`
2. Agent asks: "What operation?" -> User selects "Add"
3. Agent asks: "Please enter the local path or git URL" -> User types: `https://github.com/example/my-skills.git`
4. Agent auto-detects it's a git URL
5. Agent asks: "Group name?" -> User selects "Use folder name" (becomes `my-skills`)
6. Agent validates group name format
7. **Agent backs up `~/.claude/skills/` to `~/.claude/simple-skills-manager-backup-last-skills/`**
8. Agent clones repo, scans skills, verifies SKILL.md files found
9. Agent cleans old tips, creates new tips, saves source metadata
10. Agent reports: "Created 3 skill tips: /my-skills:setup, /my-skills:deploy, /my-skills:test"

### Adding from Local Path

1. User runs `/simple-skills-manager`
2. Agent asks: "What operation?" -> User selects "Add"
3. Agent asks: "Please enter the local path or git URL" -> User types: `/home/user/projects/my-plugin`
4. Agent auto-detects it's a local path, verifies path exists
5. Agent asks: "Group name?" -> User types custom name: `myteam`
6. Agent validates group name format
7. **Agent backs up `~/.claude/skills/` to `~/.claude/simple-skills-manager-backup-last-skills/`**
8. Agent scans skills, verifies SKILL.md files found
9. Agent cleans old tips, creates new tips, saves source metadata (`.source` file)
10. Agent reports: "Created 2 skill tips: /myteam:build, /myteam:release"

### Updating a Group

1. User runs `/simple-skills-manager`
2. Agent asks: "What operation?" -> User selects "Update"
3. Agent lists existing groups: `my-skills`, `myteam`
4. User types: `my-skills`
5. Agent validates group exists
6. **Agent backs up `~/.claude/skills/` to `~/.claude/simple-skills-manager-backup-last-skills/`**
7. Agent finds repo at `~/.claude/simple-skills-manager-repos/my-skills/`
8. Agent runs `git pull`, scans skills, verifies SKILL.md files found
9. Agent cleans old tips, recreates tips
10. Agent reports: "Updated 3 skill tips for group 'my-skills'"

### Removing a Group

1. User runs `/simple-skills-manager`
2. Agent asks: "What operation?" -> User selects "Remove"
3. Agent lists existing groups: `my-skills`, `myteam`
4. User types: `my-skills`
5. Agent validates group exists
6. **Agent backs up `~/.claude/skills/` to `~/.claude/simple-skills-manager-backup-last-skills/`**
7. Agent asks: "Also remove cloned repo?" -> User confirms
8. Agent removes tips, repo, and `.source` file if exists
9. Agent reports: "Removed group 'my-skills' and its cloned repository"

## Notes

- **Backup directory**: `~/.claude/simple-skills-manager-backup-last-skills/` - created before each operation
- Git repositories are cached in `~/.claude/simple-skills-manager-repos/{group}/`
- Local path sources are referenced directly, not copied
- Tips dynamically load content, so changes to original skills are reflected immediately
- Each group's tips are managed independently
- The original skill files are never modified
- **Skills are loaded at startup** - restart Claude Code after adding/updating skills
