---
name: codex-review-backlog
description: >
  Scan recently merged (and optionally open) GitHub PRs for unhandled
  chatgpt-codex-connector[bot] review comments, re-validate each finding against
  current main, fix OPEN_EASY items in domain-split PRs, track OPEN_HARD, and
  stop when nothing actionable remains. Designed for a daily cron/routine or
  manual /agentloop:codex-review-backlog. Use when the user asks to "scan Codex
  reviews", "codex backlog", "unhandled codex after merge", or after a merge
  wave where Codex often arrives late.
---

# Codex Review Backlog — post-merge (and open) Codex follow-ups

> **Why this exists.** Codex often posts **after** merge. `pr-sweep` reviews open
> PRs before merge; this skill is the complementary **post-merge lag sweep**:
> find comments that landed too late, triage them on current `main`, and open
> small fix PRs (never one mega-PR).

> **Repo profile first.** Read `.claude/repo-profile.md` for `repo_slug`,
> `default_branch`, `verification_entry` / `pre_merge_entry`, `comment_language`.
> Arc is the reference implementation.

## Usage

```
/agentloop:codex-review-backlog              # last 24h merged PRs (default daily window)
/agentloop:codex-review-backlog --hours 12   # custom lookback
/agentloop:codex-review-backlog --days 7     # week scan (same as manual audits)
/agentloop:codex-review-backlog --open-too   # also scan open PRs for late Codex
/agentloop:codex-review-backlog --dry-run    # matrix only; no branch/PR/comment
```

## Disposition tags

| Tag | Meaning |
|---|---|
| **FIXED_LATER** | Valid when Codex wrote; current main already addresses it |
| **IN_PR** | Being fixed in an open follow-up PR this run opened/updated |
| **OPEN_EASY** | Still valid; small scoped fix — implement this run if capacity |
| **OPEN_HARD** | Still valid; needs design / multi-file / store CAS — track only |
| **REJECT** | False positive or wrong layer (e.g. build script AFS purity) |

## Step 0 — Sync `main` (do not skip)

```bash
git fetch origin <default_branch>
git reset --hard origin/<default_branch>
git log --oneline -1
```

Shared checkouts: stash first if dirty; never blind-wipe human WIP.

## Step 1 — Enumerate merged PRs in the window

```bash
# example: last 24h (default daily)
SINCE=$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)   # macOS; Linux: date -u -d '24 hours ago' …
gh pr list --state merged --limit 100 \
  --json number,title,mergedAt,url \
  --search "merged:>=$(date -u -v-1d +%Y-%m-%d)"   # broaden day then filter client-side
```

Filter client-side: `mergedAt >= SINCE`. With `--open-too`, also list open PRs.

## Step 2 — Collect Codex inline comments

For each PR:

```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate \
  --jq '.[] | select(.user.login=="chatgpt-codex-connector[bot]")'
```

Also pull review summary shells from `pulls/<n>/reviews` if useful. Parse P1/P2
from badge markup (`badge/P1` / `badge/P2`).

## Step 3 — Re-validate against **current main** (not the merge commit alone)

For every comment:

1. Read cited `path` on current tree.
2. Decide disposition (table above). Prefer **FIXED_LATER** when later commits
   already land the fix (common after a follow-up PR wave).
3. Accept-path discipline: if the finding is a gate/check, ensure a fix still
   has an accept-path test.

**Skip already-merged follow-up PRs that only restate addressed threads** once
code matches FIXED_LATER (comment on tracking issue, do not re-open).

## Step 4 — Act (split PRs by domain)

- **OPEN_EASY**: branch from `main`, TDD when possible, conventional commit,
  focused tests, `pre-pr` / push, open PR linking source Codex PR + tracking issue.
  **One domain per PR** (e.g. feeds ≠ security-headers ≠ a11y).
- **OPEN_HARD**: append to a tracking issue (or open one
  `chore: Codex review backlog — <window>`); do not block the daily run.
- **REJECT / FIXED_LATER**: record in the tracking comment only.

Max scope per daily run (bounded): **≤3 OPEN_EASY findings or 2 fix PRs**,
whichever comes first; leave the rest for the next day. Prefer P1 over P2.

## Step 5 — Tracking comment (idempotent)

Post **one** upsertable comment on a tracking issue (open or create
`chore: Codex review backlog — daily`) with marker:

```html
<!-- codex-backlog-report window=<ISO>.. <ISO> -->
```

Table: PR · finding · disposition · follow-up PR# if any.

Identity line via:

```bash
bash scripts/agent-identity.sh --header "" --skill codex-review-backlog
```

## Step 6 — When to stop / quiet

Quiet if:

- No Codex comments in the window, or
- All dispositions are FIXED_LATER / REJECT / OPEN_HARD (none OPEN_EASY left).

Then the daily comment is a one-liner: `Codex backlog quiet — window …, 0 OPEN_EASY`.

**Do not** run a 45-minute poll loop. Daily (or manual) is enough: Codex lag is
hours, not minutes. Pair with `pr-sweep` for **pre-merge** open PRs.

## Relationship to other skills

| Skill | When |
|---|---|
| `pr-review` / `pr-sweep` | Open PRs **before** merge |
| **`codex-review-backlog`** | **After** merge lag + optional open late comments |
| `verification` | Gate every fix PR you open |

## Unattended rules

Same as issue-sweep / pr-sweep: no `AskUserQuestion` / `Workflow` / `EnterPlanMode`.
Escalate OPEN_HARD or ambiguous REJECT on the tracking issue and continue.

## Key principles

1. **Validate on tip of main** — comments are historical; code may have moved.
2. **Split PRs** — never one mega-PR across unrelated domains.
3. **Bounded daily work** — leave remainder for the next run.
4. **FIXED_LATER is success** — do not re-implement merged fixes.
5. **P1 before P2**; security/correctness before test polish.
