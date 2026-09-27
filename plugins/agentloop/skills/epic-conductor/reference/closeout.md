# epic-conductor — closeout procedure

> On-demand reference for [`epic-conductor`](../SKILL.md) (§9). Moved out of SKILL.md in #7105.
> The hard exit gate (`assert-no-blocked-prs.ts`, exit 0, fail-closed) stays in SKILL.md.
> Witness-precision limits: [closeout-gate.md](closeout-gate.md).

The epic is not done until closeout is posted. Run the blocked-PR gate before any wrap step. Exit 0 is required. There is no bypass flag.

This is the artifact-side twin of `assert-no-live-children.ts`. That one says no worker is still running. This one says no product is still hanging. One discipline: a conductor must not exit on unfinished state it created. Foreign-red ownership was assigned to the conductor so those PRs would have an owner. A conductor that closes the epic while one still hangs hands it straight back to nobody.

## Cohesion — read the catch-net, do not run your own suite

N PRs merged in sequence must cohere. That is the job of the repo's post-merge catch-net (arc: the L1 main catch-net, `docs/guides/main-catchnet.md`). Read its verdict for a range that includes the epic's last merge.

Where to read it (arc):

- The catch-net's state dir: `$ARC_CATCHNET_STATE_DIR`, else `<git-common-dir>/arc-catchnet/` **of the dedicated catch-net clone**, not necessarily your checkout. Look at `latest.json` and `verdicts/*.json`.
- Or the `main-catchnet hourly` presence heartbeat, whose outcome carries the verdict and range.
- `bun scripts/main-catchnet.ts plan` in that clone says when the next run covers the merge. Its `range.to` must be at or after that merge.

Green → record the verdict id in the closeout. Red → the catch-net's own bisect files the issue; link it and treat the epic as not cohesive until the catch-net itself turns green again. Not yet covered → wait for its next batch rather than running a private full suite.

**You never write, edit, or "confirm" a catch-net verdict or its heartbeat.** The verdict comes only from its deterministic script (catch-net independence, arc#7068 §5.3). A repo without a catch-net keeps the old step: run the deterministic gate across the touched packages on the merged main.

## End-to-end verification

Drive the epic's actual thesis end-to-end on real infrastructure (real data, real services), as far as the merged code allows. Be honest about **user-reachable vs mechanism-level** where a wiring seam remains, and file the seam as a follow-up. Do not describe a mechanism-level proof as something a user can already do.

## Visual verification when there is a UI

Capture screenshots of every real rendered surface. Upload them so they inline in GitHub (raw host on the default branch — a bare comment post can drop images; use the repo's upload script, arc: `scripts/gh-upload-media.sh`). Post ONE walkthrough comment on the epic with captioned inline screenshots plus the terminal evidence for non-UI steps. If the human asked for a screenshotted closeout, this step is the deliverable, not an extra.

## Wrap

Close sub-issues and the epic with a summary: a deliverables table, the closeout verdict (catch-net id or the reason it is not cohesive yet), and the follow-ups filed. Clear the lock list so the refresher exits. Report to the human with the epic URL, the PR URLs, and what each screenshot proves.
