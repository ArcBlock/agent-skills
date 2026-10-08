# epic-conductor — closeout

> On-demand reference for [`epic-conductor`](../SKILL.md) (§9).

The epic is not done until closeout is posted, and you do not exit on unfinished state you created
(open PRs of yours with unresolved findings, live hired children).

## Cohesion — read nightly, do not run a private suite

N PRs merged in sequence must cohere. That is the job of the nightly full build + test on the
default branch. Read the nightly result for a run that includes the epic's last merge. Green →
record it. Red → its auto-opened issue is the link; the epic is not cohesive until nightly is green
again. Not yet covered → wait for the next nightly. You never write or "confirm" a nightly result.

## End-to-end

Drive the epic's thesis end to end on real infrastructure, as far as the merged code allows. Say
user-reachable vs mechanism-level where a wiring seam remains, and file the seam.

## UI

Screenshots of every real rendered surface, uploaded so they inline (the repo's upload script, arc:
`scripts/gh-upload-media.sh`), in ONE walkthrough comment on the epic with terminal evidence for the
non-UI steps.

## Wrap

Close sub-issues and the epic with a deliverables table, the nightly result, the follow-ups filed.
Clear the labels. Report the epic URL, PR URLs, and what each screenshot proves.
