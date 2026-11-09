# pr-review — the verdict comment the host merger reads

> On-demand reference for [`pr-review`](../SKILL.md) Step 6 (agent-factory#157 follow-up).

The factory host merger auto-merges an ad-hoc PR (not a factory run) only on a **canonical verdict
line**. Free-text `Verdict: MERGE` never triggers a merge. Grammar and rules live in
`packages/aos-factory/src/work-adhoc-merge.ts` (`canonicalVerdictLine`, `parseCanonicalVerdict`,
`judgeAdhocVerdicts`); `lib/verdict.ts` renders the same line, and `lib/verdict.test.ts` pins the
two regexes together.

## Layout

```text
<!-- pr-review-verdict -->
> 🤖 AI Agent PR Review @ … · skill:pr-review · engine:…
<!-- pr-review-verdict v1 head=<40-hex head sha> lens=correctness verdict=MERGE -->
HEAD <40-hex head sha>
Verdict: MERGE

<evidence: claim table, cross-cutting rows, test command + counts, findings>
```

- Line 1 (legacy marker) stays: pr-sweep Step 1 and `scripts/factory-epic-status.ts` find the
  review by it, and `HEAD <sha>` / `Verdict:` are what they read.
- `verdict` is one of `MERGE`, `COMMENT`, `BLOCK`, `SUPERSEDE`, `CLOSE` — all emitted. Only
  `MERGE` arms the merger; the others (and any non-MERGE comment) veto.
- `MERGE (held)` under `agent:hold` is display only; the canonical line says `verdict=MERGE` (the
  label alone keeps the merger away).
- P3-only findings are a `MERGE` with the notes in its evidence (listed for the PR body), not a
  `COMMENT`: only `MERGE` arms the merger, and a P3 never blocks.

## What the merger requires (so what the reviewer must do)

| merger rule | reviewer duty |
|---|---|
| exactly one canonical line per comment, whole line, outside code fences | render with `lib/verdict.ts`; never quote another canonical line in the evidence (it refuses) |
| `head=` is the full 40-char lowercase PR head | pass `headRefOid` from Step 0, re-read just before posting |
| the comment was **never edited** (`updatedAt == createdAt`; review bodies `lastEditedAt` null) | post a **new** comment every round; never PATCH, never edit a typo — post again. `lib/comment.ts` `postOnce` refuses to PATCH any verdict |
| author has write access; identity line `skill:pr-review` or `skill:review`, distinct from the PR author's identity line | header from `agent-identity.sh --skill pr-review`; never review a PR from the context that wrote it |
| security panel hit → a second canonical MERGE with `lens=security` | the security reviewer posts its **own** comment with `--lens security` (two lines in one comment parse as none) |
| any writer non-bot comment (issue comment, review body, inline) at or after the MERGE that is not itself a canonical MERGE at the head stales **every** lens | after a MERGE, post nothing more on the PR. A note that must be added afterwards (dedup twins, fix summary) is followed by a fresh MERGE of every lens relied on |

Deleting a comment withdraws it. A later writer MERGE at the current head clears an earlier veto.

## Lens order on a security-panel PR

When a non-MERGE `lens=security` verdict at the same head exists (BLOCK / COMMENT / …),
do not post a correctness MERGE over it: post the correctness verdict as `COMMENT` naming the open security
verdict, or wait for the security reviewer's fresh MERGE. The merger itself still refuses (no
valid security MERGE, or the BLOCK stales an older one), but status readers — pr-sweep Step 5,
`factory-epic-status.ts` — take the **last** verdict comment, and a correctness MERGE posted last
would read to them as "this PR is clear" while the security veto stands. Re-read the
PR's comments for canonical lines at this head right before posting.

## Staleness and re-posting (pr-sweep)

A MERGE goes stale the moment any writer posts a non-bot comment at or after it — a human "LGTM",
an agent reply, the sweep's own dedup note. The merger measures from the **oldest** relied-on
lens's latest MERGE (`judgeAdhocVerdicts`: `since = min(...)` over correctness, plus security on a
panel PR; a comment at `>= since` that is not itself a canonical MERGE stales every lens). So the
check is per lens, never against the last MERGE only:

- relied-on lenses = correctness, plus security when the diff is on the security panel;
- for each, take its latest canonical MERGE at the current head;
- needs-review when any writer non-bot comment is at or after **any** of those (equivalently, the
  oldest one).

Example: security MERGE → writer note → correctness MERGE. Nothing is newer than the correctness
MERGE, yet the note is after the security MERGE, so the merger reads `verdict-stale`. The sweep reads
the note (a human comment is a new review of the delta) and, if the verdict still holds, re-posts
the MERGE of each stale lens — here security — the one exception to "never re-post an unchanged
conclusion". Each stale lens is re-posted by a reviewer of that lens.

Dedup notes on a keeper go before the keeper's verdict. "Needs a runner with the factory" and other
sweep status go to the run summary, never onto the PR.
