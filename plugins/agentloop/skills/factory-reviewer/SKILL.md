---
name: factory-reviewer
description: >-
  Data, not a workflow: the text of the factory's reviewer prompts (correctness contract, security
  contract, juror, jury-scoped re-review), read by the aos-factory review runner. Not invoked by hand.
---

# factory-reviewer — the reviewer prompts' text

The factory hires reviewers for every Change Set round: a correctness reviewer always, a security
reviewer when the round is on the security panel, jurors when reviewers and coder do not converge,
and a scoped re-review after a blocking jury. The **wording** each reviewer is handed lives here;
the **contract** — the role marker on the prompt's first line, the diff range, the head and nonce
to echo, the JSON shape of the answer and its strict parse — stays in code
(`packages/aos-factory/src/work-review-output.ts`, `work-review-jury.ts`, `work-review-panel.ts`).

This skill is **data the runner reads**, not a workflow for a person:

| file | used for |
|---|---|
| [reference/prompts.md](reference/prompts.md) | every prose block of the four prompts, verbatim |

## Where the runner reads it from: the bundled copy only

The runner always uses the copy bundled in `@aigne/aos-factory` (`source: "bundled"`), which a
package test keeps byte-equal to these files, and a prompt golden per role keeps byte-equal to the
prompts the code built before the text moved here. Every review records that copy's version.

Reviewer prompts are not pinnable until pin changes require authority unavailable to supervised
runs (see #9635 §11 follow-up). `skillSourcePins` is host settings that a run on the same host can
change, so honouring a pin for this skill would let a supervised coder repoint or clear the
instructions its own reviewer is handed. A pin set for `agentloop:factory-reviewer` is ignored.

## Block format (`reference/prompts.md`)

A block is the lines between `<!-- block: <name> -->` and `<!-- /block -->`, taken exactly (an empty
line is an empty prompt line). `{{name}}` is replaced by a value the runner supplies; each block may
use only the placeholders the runner declares for it. A missing block, an unknown block or an
unknown placeholder refuses the whole skill. Text outside blocks is commentary and is not sent.

Changing what a block says changes what every reviewer is told: it is reviewed like the gates it
instructs. The three classes that block a merge (build-break, data-loss, security) are R2 to
change (`factory-planner/reference/approve.md`); the rules text here only describes them.
