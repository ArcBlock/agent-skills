---
name: blocklet-pr
description: Create standardized Pull Requests for blocklet projects. Performs lint checks, unit tests, version updates, and creates PRs following PR templates. Use `/blocklet-pr` or say "help me submit a PR", "create pull request" to trigger.
---

# Blocklet PR

Help developers create standardized Pull Requests for blocklet projects, ensuring code quality and following project PR templates.

## Core Philosophy

**"Quality gates + standardized workflow."**

PRs are not submitted casually. Before submission, code must pass lint and tests, must be on a working branch (never directly on main branch), and PR content must follow project templates. Enforced standardization reduces human oversight errors.

## Prerequisites

- Current directory is a blocklet project (contains `blocklet.yml`)
- Has code changes to commit

## Reference Files

Branch conventions and repository info are read from local reference files (in `blocklet-url-analyzer` skill directory):

- `blocklet-url-analyzer/references/org-arcblock-repos.md` - ArcBlock organization repos with branch info
- `blocklet-url-analyzer/references/org-blocklet-repos.md` - blocklet organization repos with branch info

## Workflow

Execute the following phases in order.

### Phase 1: Workspace Check

**Refer to `blocklet-branch` skill for branch operations**.
Skill location: `blocklet-branch/SKILL.md`

#### 1.1 Confirm Remote Repository

Refer to blocklet-branch section 1.1:

```bash
REMOTE_URL=$(git remote get-url origin)
ORG=$(echo $REMOTE_URL | sed -E 's/.*[:/]([^/]+)\/([^/]+)(\.git)?$/\1/')
REPO=$(echo $REMOTE_URL | sed -E 's/.*[:/]([^/]+)\/([^/]+)(\.git)?$/\2/' | sed 's/\.git$//')
```

#### 1.2 Detect Main Iteration Branch

Read from local reference files to get branch conventions for the repository.

Search for repo-specific branch info in reference files:
- `blocklet-url-analyzer/references/org-arcblock-repos.md`
- `blocklet-url-analyzer/references/org-blocklet-repos.md`
- `blocklet-url-analyzer/references/org-aigne-repos.md`

**Default branch conventions** (if no specific info found in references):

| Organization | Default Main Branch |
|--------------|---------------------|
| ArcBlock | `dev` |
| blocklet | `main` |
| AIGNE-io | `main` |

**Output variables**: `MAIN_BRANCH`, `MAIN_BRANCH_REASON`

#### 1.3 Detect Branch Naming Conventions

Read from local reference files to get branch prefix conventions for the repository.

**Default prefix conventions** (if no specific info found in references):

| Prefix | Usage |
|--------|-------|
| `feat/` or `feature/` | New features |
| `fix/` | Bug fixes |
| `chore/` | Maintenance tasks |
| `docs/` | Documentation |

**Output variables**: `BRANCH_PREFIX_CONVENTION`, `BRANCH_SEPARATOR`

#### 1.4 Branch Check and Creation (Mandatory)

Refer to blocklet-branch sections 6, 7.

**Important**: Before submitting a PR, you **must** ensure you are on a working branch; cannot commit directly on the main iteration branch.

```bash
CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" = "$MAIN_BRANCH" ]; then
    echo "⚠️ Currently on main iteration branch $MAIN_BRANCH, must create new branch!"
fi
```

| Situation | Handling |
|-----------|----------|
| On main iteration branch | **Must** create new branch (refer to blocklet-branch section 6) |
| On working branch | Check if branch naming follows convention (refer to blocklet-branch section 7.2) |

**If on main iteration branch**, use `AskUserQuestion`:

```
⚠️ Currently on main iteration branch {MAIN_BRANCH}, cannot submit PR directly.

Please select new branch name (will be created based on {MAIN_BRANCH}):

Options:
A. {suggested branch name, generated based on change type and BRANCH_PREFIX_CONVENTION} (Recommended)
B. Enter custom branch name
C. Cancel operation
```

**Create working branch** (refer to blocklet-branch section 6.2):

```bash
git fetch origin $MAIN_BRANCH
git checkout $MAIN_BRANCH
git pull origin $MAIN_BRANCH
git checkout -b $NEW_BRANCH_NAME
```

#### 1.5 Check Uncommitted Changes

```bash
git status --porcelain
```

| Situation | Handling |
|-----------|----------|
| Has unstaged changes | Continue flow, will handle later |
| No changes at all | Prompt no changes to commit, ask user intent |

---

### Phase 2: Code Quality Checks

#### 2.1 Lint Check

**Find lint command**:

```bash
# Check scripts in package.json
cat package.json | jq -r '.scripts | keys[]' | grep -iE '^lint$|^eslint$|^check$'
```

**Common lint command priority**:

| Priority | Script Name | Description |
|----------|-------------|-------------|
| 1 | `lint` | Standard lint command |
| 2 | `lint:fix` | Lint with auto-fix |
| 3 | `check` | General check command |
| 4 | `eslint` | Direct ESLint call |

**Execute lint**:

```bash
pnpm run lint
```

| Result | Handling |
|--------|----------|
| Pass | Continue to next step |
| Fail (auto-fixable) | Try `pnpm run lint:fix`, then recheck |
| Fail (cannot auto-fix) | **Stop flow**, output error info, let user fix |
| No lint command | Skip, continue to next step |

#### 2.2 Unit Tests

**Find test command**:

```bash
cat package.json | jq -r '.scripts | keys[]' | grep -iE '^test$|^test:unit$|^jest$|^vitest$'
```

**Common test command priority**:

| Priority | Script Name | Description |
|----------|-------------|-------------|
| 1 | `test` | Standard test command |
| 2 | `test:unit` | Unit tests |
| 3 | `test:ci` | CI environment tests |

**Execute tests**:

```bash
pnpm run test
```

| Result | Handling |
|--------|----------|
| Pass | Continue to next step |
| Fail | **Stop flow**, output failed test cases, let user fix |
| No test command | Skip, continue to next step (suggest adding tests) |

---

### Phase 3: Version Update (Optional)

#### 3.1 Ask If Version Update Needed

Use `AskUserQuestion` to ask:

```
Do you need to update version and create release?

Options:
A. Yes, update patch version (x.x.X) (Recommended for bug fixes)
B. Yes, update minor version (x.X.0)
C. Yes, update major version (X.0.0)
D. No, skip version update
```

#### 3.2 Execute Version Update

If user chooses to update version, **call blocklet-updater skill**:

**blocklet-updater skill location**: `blocklet-updater/SKILL.md`

---

### Phase 4: Git Commit

#### 4.1 Stage Changes

```bash
git add -A
git status
```

Display list of files to be committed, use `AskUserQuestion` to confirm:

```
The following files will be committed:
{file list}

Continue?
A. Yes, commit all changes (Recommended)
B. No, let me select files to commit
C. Cancel
```

#### 4.2 Generate Commit Message

**Generate standardized commit message based on change type**:

Note: Refer to the last 20 commits for the specific prefix, follow historical conventions.

| Change Type | Commit Prefix | Example |
|-------------|---------------|---------|
| New feature | `feat:` | `feat: add video preview support` |
| Bug fix | `fix:` | `fix: resolve duplicate upload issue` |
| Documentation | `docs:` | `docs: update API documentation` |
| Refactoring | `refactor:` | `refactor: simplify auth logic` |
| Testing | `test:` | `test: add unit tests for utils` |
| Build/Chore | `chore:` | `chore: bump dependencies` |

**Analyze changes to automatically infer type**, then use `AskUserQuestion` to confirm:

```
Suggested commit message:

{generated commit message}

Options:
A. Use this message (Recommended)
B. Modify message
C. Cancel
```

#### 4.3 Execute Commit

```bash
git commit -m "$(cat <<'EOF'
{commit_message}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Phase 5: Push Branch

#### 5.1 Check Remote Branch

```bash
git ls-remote --heads origin $CURRENT_BRANCH
```

| Situation | Handling |
|-----------|----------|
| Remote branch doesn't exist | Use `-u` to push and set upstream |
| Remote branch exists | Normal push |

#### 5.2 Push

```bash
git push -u origin $CURRENT_BRANCH
```

---

### Phase 6: Create Pull Request

#### 6.1 Check PR Template

```bash
# Find PR template
PR_TEMPLATE=""
if [ -f ".github/PULL_REQUEST_TEMPLATE.md" ]; then
    PR_TEMPLATE=".github/PULL_REQUEST_TEMPLATE.md"
elif [ -f ".github/pull_request_template.md" ]; then
    PR_TEMPLATE=".github/pull_request_template.md"
elif [ -f "docs/PULL_REQUEST_TEMPLATE.md" ]; then
    PR_TEMPLATE="docs/PULL_REQUEST_TEMPLATE.md"
fi
```

**If template found**: Read and parse template structure, fill PR content according to template format.

**If template not found**: Use default PR format.

#### 6.2 Get Target Branch

Use the `MAIN_BRANCH` detected in Phase 1.2 (from reference files).

Use `AskUserQuestion` to confirm target branch:

```
PR target branch:

Options:
A. {MAIN_BRANCH} (Recommended)
B. Other branch
```

#### 6.3 Link Issue (If Applicable)

Use `AskUserQuestion` to ask:

```
Do you need to link an Issue?

Options:
A. No, don't link Issue
B. Yes, link Issue (please enter Issue number)
```

If linking Issue, add to PR description:
- `Closes #123` - Auto-close Issue when merged
- `Fixes #123` - Fix Issue
- `Relates to #123` - Related but don't auto-close

#### 6.4 Generate PR Content

**PR Title**: Generate based on commit message or branch name, keep format concise and clear.

**PR Description** (according to template or default format):

```markdown
## Summary

{Change overview, 2-3 sentences explaining what this PR does}

## Changes

{Specific change list}
- Change 1
- Change 2
- ...

## Related Issues

{If there are linked Issues}
Closes #{issue_number}

## Test Plan

{Verification methods and test points}
- [ ] Verification point 1
- [ ] Verification point 2
- [ ] Unit tests pass
- [ ] Lint check passes

## Screenshots (if applicable)

{If there are UI changes, add screenshots}
```

#### 6.5 Choose PR Creation Method

After generating PR content, use `AskUserQuestion` to ask user:

```
How would you like to create the PR?

Options:
A. Create PR.md file (for manual submission later)
B. Submit PR directly using gh CLI (Recommended)
```

#### 6.5.1 Option A: Create PR.md File

Create a PR.md file in the repository root with the PR content:

```bash
cat > PR.md << 'EOF'
# {pr_title}

**Target Branch**: {TARGET_BRANCH}
**Source Branch**: {CURRENT_BRANCH}

{pr_body}
EOF

echo "✅ PR.md created. You can manually create PR on GitHub using this content."
```

**Output**:
```
===== PR.md Created =====

File: PR.md
Title: {pr_title}
Target Branch: {target_branch}

Next Steps:
1. Open GitHub repository: https://github.com/{ORG}/{REPO}
2. Click "Pull requests" → "New pull request"
3. Select base: {TARGET_BRANCH}, compare: {CURRENT_BRANCH}
4. Copy content from PR.md
```

#### 6.5.2 Option B: Submit PR using gh CLI

**First check gh CLI availability**:

```bash
# Check if gh is installed
if ! command -v gh &> /dev/null; then
    echo "❌ gh CLI is not installed."
    echo ""
    echo "Install gh CLI:"
    echo "  macOS: brew install gh"
    echo "  Linux: see https://cli.github.com/linux"
    echo "  Windows: winget install GitHub.cli"
    echo ""
    echo "After installation, run: gh auth login"
    exit 1
fi

# Check if gh is authenticated
if ! gh auth status &> /dev/null; then
    echo "❌ gh CLI is not authenticated."
    echo ""
    echo "Run: gh auth login"
    echo "Then retry creating PR."
    exit 1
fi
```

| Status | Handling |
|--------|----------|
| gh not installed | Show installation instructions, fallback to PR.md |
| gh not authenticated | Show `gh auth login` instructions, fallback to PR.md |
| gh ready | Create PR |

**Create PR**:

```bash
gh pr create \
  --title "{pr_title}" \
  --body "$(cat <<'EOF'
{pr_body}
EOF
)" \
  --base $TARGET_BRANCH
```

#### 6.6 Output Result

**If PR created via gh**:
```
===== PR Created Successfully =====

PR URL: {pr_url}
Title: {pr_title}
Target Branch: {target_branch}
Linked Issues: {issue_numbers or "None"}

===== Next Steps =====
Wait for Code Review
```

**If PR.md created**:
```
===== PR.md Created =====

File: PR.md
Please manually create PR on GitHub.
```

---

## Error Handling

| Error | Handling |
|-------|----------|
| Lint failed | Show error details, suggest running `pnpm run lint:fix` |
| Tests failed | Show failed test cases, let user fix |
| Push failed | Check permissions, suggest `git pull --rebase` |
| gh not installed | Show installation instructions, offer to create PR.md instead |
| gh not authenticated | Show `gh auth login` instructions, offer to create PR.md instead |
| PR creation failed | Show gh error message, offer to create PR.md instead |
| Same PR already exists | Show existing PR link, ask whether to update |


---

## Relationship with Other Skills

| Skill | Relationship |
|-------|--------------|
| `blocklet-dev-setup` | Development environment setup, use before PR |
| `blocklet-updater` | Version update, optionally called during PR |
| `blocklet-url-analyzer` | Analyze Blocklet URL, locate repository |
