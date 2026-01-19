---
name: blocklet-branch
description: Git branch management tool. Detects main iteration branch and branch naming conventions, handles branch creation and switching. Referenced by blocklet-dev-setup, blocklet-pr, and other skills.
---

# Blocklet Branch

Unified Git branch management tool providing branch detection, creation, and switching capabilities.

## Core Philosophy

**"Detect dynamically, never assume."**

Branch management must not hardcode `main` or `master`. Different ArcBlock repositories follow different branch conventions. By analyzing PR history dynamically, branch operations adapt to each repository automatically.

## Design Principles
- Never assume the main branch is `main` or `master`; detect dynamically through merged PR history
- Learn branch naming conventions from project history
- Must handle uncommitted changes before switching branches

---

## 1. Repository Information Retrieval

### 1.1 Parse Remote Repository

```bash
REMOTE_URL=$(git remote get-url origin)

# Parse org/repo
ORG=$(echo $REMOTE_URL | sed -E 's/.*[:/]([^/]+)\/([^/]+)(\.git)?$/\1/')
REPO=$(echo $REMOTE_URL | sed -E 's/.*[:/]([^/]+)\/([^/]+)(\.git)?$/\2/' | sed 's/\.git$//')

echo "Repository: $ORG/$REPO"
```

### 1.2 Get Current Branch

```bash
CURRENT_BRANCH=$(git branch --show-current)
echo "Current branch: $CURRENT_BRANCH"
```

---

## 2. Main Iteration Branch Detection

**Important**: Must determine the main iteration branch by analyzing the last 10 merged PRs, rather than simply assuming it is `main` or `master`.

### 2.1 Detect Main Iteration Branch

```bash
# Get target branches of the last 10 merged PRs, count occurrences to find the main iteration branch
MAIN_BRANCH=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json baseRefName \
  | jq -r '.[].baseRefName' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')

# Get detection rationale
BRANCH_STATS=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json baseRefName \
  | jq -r '.[].baseRefName' | sort | uniq -c | sort -rn)

echo "Main iteration branch: $MAIN_BRANCH"
echo "Detection rationale (target branch statistics from last 10 merged PRs):"
echo "$BRANCH_STATS"
```

### 2.2 Output Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `MAIN_BRANCH` | Detected main iteration branch | `main`, `develop`, `master` |
| `MAIN_BRANCH_REASON` | Detection rationale | "8 out of 10 recent merged PRs targeted main" |

---

## 3. Branch Naming Convention Detection

**Important**: Determine branch naming prefix conventions by analyzing the last 10 merged PRs.

### 3.1 Analyze Historical Branch Naming

```bash
# Get source branch names from the last 10 merged PRs, analyze naming conventions
BRANCH_NAMES=$(gh pr list --repo $ORG/$REPO --state merged --limit 10 --json headRefName \
  | jq -r '.[].headRefName')

# Extract prefixes (supports both / and - separators)
BRANCH_PREFIXES=$(echo "$BRANCH_NAMES" | sed -E 's/^([a-zA-Z]+)[\/\-].*/\1/' | sort | uniq -c | sort -rn)

echo "Branch naming prefix statistics (from last 10 merged PRs):"
echo "$BRANCH_PREFIXES"

# Detect separator style (/ or -)
if echo "$BRANCH_NAMES" | grep -q '/'; then
    SEPARATOR="/"
else
    SEPARATOR="-"
fi
echo "Separator style: $SEPARATOR"
```

### 3.2 Common Branch Prefixes

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feat` / `feature` | New feature | `feat/add-login`, `feature/user-profile` |
| `fix` / `bugfix` | Bug fix | `fix/login-error`, `bugfix/issue-123` |
| `chore` | Routine maintenance | `chore/update-deps` |
| `refactor` | Code refactoring | `refactor/auth-module` |
| `docs` | Documentation update | `docs/api-guide` |
| `test` | Test-related | `test/add-unit-tests` |
| `style` | Code style | `style/format-code` |
| `perf` | Performance optimization | `perf/optimize-query` |

### 3.3 Output Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `BRANCH_PREFIX_CONVENTION` | Primary prefix convention | `feat`, `fix` |
| `BRANCH_SEPARATOR` | Separator style | `/` or `-` |

---

## 4. Uncommitted Changes Handling

**Important**: Before switching branches, uncommitted changes must be handled first.

### 4.1 Check Change Status

```bash
UNCOMMITTED_CHANGES=$(git status --porcelain)

if [ -n "$UNCOMMITTED_CHANGES" ]; then
    echo "⚠️ Uncommitted changes detected:"
    git status --short
fi
```

### 4.2 Handle Changes

If there are uncommitted changes, use `AskUserQuestion` to ask the user:

```
Uncommitted changes detected. Please choose how to proceed:

Options:
A. Stash changes (git stash) - can be restored later (Recommended)
B. Commit changes - create a temporary commit
C. Discard changes (git checkout .) - ⚠️ cannot be undone
D. Cancel operation
```

**Execute handling**:

```bash
# Option A: Stash
git stash push -m "Auto stash before branch switch"

# Option B: Commit
git add -A && git commit -m "WIP: auto commit before branch switch"

# Option C: Discard
git checkout . && git clean -fd
```

---

## 5. Branch Switching

### 5.1 Switch to Main Iteration Branch

```bash
# Ensure local has latest remote branch info
git fetch origin

# Switch to main iteration branch and update
git checkout $MAIN_BRANCH
git pull origin $MAIN_BRANCH

echo "✅ Switched to main iteration branch: $MAIN_BRANCH"
```

### 5.2 Switch to Specified Branch

```bash
TARGET_BRANCH="feat/my-feature"

# Check if branch exists
if git show-ref --verify --quiet refs/heads/$TARGET_BRANCH; then
    # Local branch exists
    git checkout $TARGET_BRANCH
elif git show-ref --verify --quiet refs/remotes/origin/$TARGET_BRANCH; then
    # Remote branch exists, create local tracking branch
    git checkout -b $TARGET_BRANCH origin/$TARGET_BRANCH
else
    echo "❌ Branch $TARGET_BRANCH does not exist"
fi
```

---

## 6. Working Branch Creation

### 6.1 Generate Branch Name Suggestion

Generate suggested branch name based on task type and repository naming conventions:

```bash
# Input parameters
TASK_TYPE="fix"           # feat, fix, chore, refactor, docs, test
TASK_DESCRIPTION="login"  # Brief description
ISSUE_NUMBER=""           # Optional issue number

# Generate branch name
if [ -n "$ISSUE_NUMBER" ]; then
    SUGGESTED_BRANCH="${TASK_TYPE}${BRANCH_SEPARATOR}issue-${ISSUE_NUMBER}-${TASK_DESCRIPTION}"
else
    SUGGESTED_BRANCH="${TASK_TYPE}${BRANCH_SEPARATOR}${TASK_DESCRIPTION}"
fi

echo "Suggested branch name: $SUGGESTED_BRANCH"
```

### 6.2 Create Working Branch

**Prerequisite**: Must be created based on the latest main iteration branch.

```bash
# 1. Ensure main iteration branch is up to date
git fetch origin $MAIN_BRANCH
git checkout $MAIN_BRANCH
git pull origin $MAIN_BRANCH

# 2. Create and switch to new branch
NEW_BRANCH="feat/my-new-feature"
git checkout -b $NEW_BRANCH

echo "✅ Created and switched to branch: $NEW_BRANCH (based on $MAIN_BRANCH)"
```

### 6.3 User Confirmation Flow

Use `AskUserQuestion` to confirm branch name:

```
Will create new branch based on {MAIN_BRANCH}.

Please select branch name:

Options:
A. {SUGGESTED_BRANCH} (Recommended)
B. Enter custom branch name
C. Cancel operation
```

---

## 7. Branch Status Check

### 7.1 Check If on Main Iteration Branch

```bash
if [ "$CURRENT_BRANCH" = "$MAIN_BRANCH" ]; then
    echo "⚠️ Currently on main iteration branch"
    ON_MAIN_BRANCH=true
else
    ON_MAIN_BRANCH=false
fi
```

### 7.2 Check Branch Naming Convention Compliance

```bash
# Check if branch name follows common prefix conventions
if echo "$CURRENT_BRANCH" | grep -qE "^(feat|fix|chore|refactor|docs|test|style|perf|hotfix|release)[/\-]"; then
    echo "✅ Branch naming follows convention"
    BRANCH_NAME_VALID=true
else
    echo "⚠️ Branch naming does not follow common conventions: $CURRENT_BRANCH"
    BRANCH_NAME_VALID=false
fi
```

### 7.3 Check Branch Sync Status with Remote

```bash
# Get local and remote differences
git fetch origin

LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse origin/$CURRENT_BRANCH 2>/dev/null || echo "")

if [ -z "$REMOTE_COMMIT" ]; then
    echo "📤 Branch not yet pushed to remote"
    SYNC_STATUS="not_pushed"
elif [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
    echo "✅ Branch is in sync with remote"
    SYNC_STATUS="synced"
else
    AHEAD=$(git rev-list origin/$CURRENT_BRANCH..HEAD --count)
    BEHIND=$(git rev-list HEAD..origin/$CURRENT_BRANCH --count)
    echo "📊 Local is $AHEAD commits ahead, $BEHIND commits behind"
    SYNC_STATUS="diverged"
fi
```

---

## 8. Usage Scenarios

### Scenario A: Development Environment Setup (blocklet-dev-setup)

1. Detect main iteration branch
2. Handle uncommitted changes
3. Switch to main iteration branch and update
4. (Optional) Create working branch

### Scenario B: Submit PR (blocklet-pr)

1. Detect main iteration branch
2. Detect branch naming conventions
3. Check current branch
   - If on main iteration branch → **Must** create working branch
   - If on working branch → Check naming convention compliance

### Scenario C: Switch Tasks

1. Handle uncommitted changes (stash/commit/discard)
2. Switch to target branch
3. Restore previous changes (if needed)

---

## 9. Referenced by Other Skills

This skill is referenced by the following skills:

| Skill | Features Used |
|-------|---------------|
| `blocklet-dev-setup` | Detect main iteration branch, handle uncommitted changes, switch branches, create working branch |
| `blocklet-pr` | Detect main iteration branch, branch naming conventions, enforce working branch creation |

**How to reference**:

```
Refer to blocklet-branch skill for branch operations.
Skill location: `blocklet-branch/SKILL.md`
```

---

## 10. Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| Cannot get PR history | gh not authenticated or network issue | Run `gh auth status` to check authentication |
| Branch switch failed | Conflicting uncommitted changes | Handle uncommitted changes first |
| Branch creation failed | Branch name already exists | Use different branch name or switch to existing branch |
| Cannot detect main iteration branch | Repository has no merged PRs | Fall back to default branch `gh repo view --json defaultBranchRef` |
