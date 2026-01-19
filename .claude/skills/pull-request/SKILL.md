---
name: pull-request
description: PR Generator - Generate standardized Pull Request based on branch diff and submit via gh or save as PR.md
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# Pull Request Skill

Generate standardized Pull Requests by analyzing the diff between current branch and main branch.

## PR Template

Based on analysis of high-quality PRs, use this template:

### Title Format

```
<type>(<scope>): <description>
```

**Types** (same as Conventional Commits):
| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style changes |
| `refactor` | Code refactoring |
| `perf` | Performance improvement |
| `test` | Add or modify tests |
| `chore` | Build process or tools |
| `ci` | CI/CD configuration |
| `build` | Build system changes |

**Scope**: Optional, indicates affected module (e.g., `devflow`, `blocklet`, `auth`)

**Description**:
- Imperative mood ("add" not "added")
- Lowercase first letter
- No period at end
- Under 72 characters

### Body Format

```markdown
## Summary

<1-5 bullet points describing key changes>

## Motivation / Context

<Why this change is needed - the problem being solved>

## Changes

<Detailed list of what was changed, organized by area>

## Test Plan

<How to verify the changes work correctly>
- [ ] Step 1
- [ ] Step 2

---

Generated with [Claude Code](https://claude.com/claude-code)
```

## Workflow

### Step 1: Gather Branch Information

```bash
# Get current branch name
git branch --show-current

# Get main branch (usually 'main' or 'master')
git remote show origin | grep 'HEAD branch' | cut -d' ' -f5

# Check if branch is pushed to remote
git status -sb
```

### Step 2: Analyze All Commits and Changes

**IMPORTANT**: Analyze ALL commits from branch divergence point, not just the latest commit.

```bash
# Get the merge base (where current branch diverged from main)
git merge-base main HEAD

# View all commits since diverging from main
git log main..HEAD --oneline

# Get comprehensive diff statistics
git diff main...HEAD --stat

# Get full diff for content analysis
git diff main...HEAD
```

### Step 3: Generate PR Content

Based on the diff analysis:

1. **Determine type**: Look at the nature of changes
   - New files/features → `feat`
   - Bug fixes → `fix`
   - Only .md files → `docs`
   - Only test files → `test`
   - Configuration/tooling → `chore`

2. **Identify scope**: Look at which module/area is most affected

3. **Write summary**: Capture the essence of ALL commits, not just one

4. **Document motivation**: Explain why these changes are needed

5. **List changes**: Organize by logical groupings

6. **Create test plan**: Practical verification steps

### Step 4: Present PR Draft and Ask User

Display the generated PR title and body to the user, then use **AskUserQuestion** to determine next action:

```json
{
  "questions": [{
    "question": "How would you like to proceed with this PR?",
    "header": "PR Action",
    "options": [
      {"label": "Save as PR.md (Recommended)", "description": "Save PR content to PR.md file in project root (will overwrite if exists)"},
      {"label": "Submit via gh", "description": "Create PR directly using GitHub CLI"}
    ],
    "multiSelect": false
  }]
}
```

### Step 5A: If "Save as PR.md"

Write the PR content to `./PR.md` in the project root:

```markdown
# PR Title

<type>(<scope>): <description>

---

## Summary

...

## Motivation / Context

...

## Changes

...

## Test Plan

...

---

Generated with [Claude Code](https://claude.com/claude-code)
```

Inform user that PR.md has been created (or overwritten if it existed).

### Step 5B: If "Submit via gh"

#### 5B.1: Check gh CLI availability

```bash
which gh
```

If `gh` is not found:
```
GitHub CLI (gh) is not installed. Please install it:

- macOS: brew install gh
- Linux: See https://github.com/cli/cli/blob/trunk/docs/install_linux.md
- Windows: winget install --id GitHub.cli

After installation, run: gh auth login
```

#### 5B.2: Check gh authentication

```bash
gh auth status
```

If not authenticated or token lacks permissions:
```
GitHub CLI is not authenticated or lacks permissions. Please run:

gh auth login

Select:
- GitHub.com
- HTTPS
- Authenticate with browser (recommended)

Ensure you grant 'repo' scope for creating PRs.
```

#### 5B.3: Check if branch is pushed

```bash
git status -sb
```

If branch is not pushed to remote:
```bash
# Push current branch to origin
git push -u origin $(git branch --show-current)
```

#### 5B.4: Create the PR

```bash
gh pr create --base main --title "<title>" --body "$(cat <<'EOF'
<body content>
EOF
)"
```

#### 5B.5: Report Success

Display the PR URL and summary to the user.

## Example Output

### Title
```
feat(devflow): add PR generation skill
```

### Body
```markdown
## Summary

- Add new `pull-request` skill for generating standardized Pull Requests
- Analyze diff between current branch and main branch
- Support both gh CLI submission and PR.md file generation
- Include comprehensive PR template based on best practices

## Motivation / Context

Creating consistent, well-documented PRs is important for code review efficiency.
This skill automates PR generation by analyzing git diff and following established patterns.

## Changes

### New Files
- `.claude/skills/pull-request/SKILL.md` - Pull Request generation skill definition

### Workflow
- Step 1: Gather branch and diff information
- Step 2: Analyze all commits since branch divergence
- Step 3: Generate PR content following template
- Step 4: Ask user for submission method
- Step 5: Execute chosen action (gh submit or save to file)

## Test Plan

- [ ] Run `/pull-request` on a feature branch with changes
- [ ] Verify PR title follows conventional commit format
- [ ] Verify summary captures all changes
- [ ] Test gh submission flow
- [ ] Test PR.md generation flow

```

## Rules

1. **Always analyze ALL commits** from branch divergence point, not just HEAD
2. **Use English** for PR title and body
3. **Follow Conventional Commits** format for title
4. **Keep title under 72 characters**
5. **Include test plan** with actionable verification steps
6. **Base PR on main branch** (or project's default branch)
7. **Check gh auth** before attempting to create PR
8. **Push branch first** if not already pushed to remote
9. **Preserve user's intent** - ask before overwriting existing PR.md
