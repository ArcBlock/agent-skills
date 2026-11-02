---
name: factory-steward
description: >-
  Data, not a workflow: a factory node steward's reading rules and own-node engine rule, read by
  the code-agents provider. Not invoked by hand.
---

# factory-steward — the node steward's rules

The steward is a special run of one factory node. It judges its own
node's health and reports; it never builds, never dispatches, and never sends a `command` to another
node. Its self-report never gates dispatch.

This skill is **data the provider reads**, not a workflow for a person:

| file | read by | used for |
|---|---|---|
| [reference/reading-rules.md](reference/reading-rules.md) | the recurring steward start | the prompt text before `Facts (JSON):` — verbatim |
| [reference/engine-health.json](reference/engine-health.json) | the steward patrol | the default N of the own-node engine-health rule |

## Where the provider reads it from

- `skillSource` set and this skill (`agentloop:factory-steward`) pinned in `skillSourcePins`: read
  through the host's AFS, verified against the pin; a refusal starts no steward
  (the `steward-silent` absence alarm then says so). The steward run records the version.
- otherwise: the copy bundled in `@aigne/afs-code-agents` (`source: "bundled"`), which a package test
  keeps byte-equal to these files.

## Reading rules (`reference/reading-rules.md`)

Each `- <fact>:` line tells the steward how to read one fact the node reports. A rule may name only
a fact the node really emits (a sentinel event kind or a `numbers` key); a package self-test checks
every rule against them. The file must not contain the publish marker (the word observation
directly followed by a colon): the run log echoes the prompt.

## Own-node engine health (`reference/engine-health.json`)

N consecutive review outputs from one engine on this node that are not the engine's declared
envelope at all (a **format** failure, e.g. a CLI whose output format changed under a user setting)
→ the steward patrol disables that engine **on this node only** through the core gate, and leaves
one advisory `capability` message to the manager. Work is then dispatched elsewhere by the ordinary
`disabledEngines` reads; the steward adds no dispatch logic.

- Only format failures count. A well-formed envelope of a failed run (overload, usage limit, max
  turns, no schema'd answer) and a missing or unreadable output file never count.
- `disableAfter` is the default N. The node setting `stewardUnparsableDisableAfter` overrides it;
  `0` turns the rule off.
- Code floor: N is never below 2 — one bad output does not disable an engine.
- Only outputs settled after the latest of {the last disable it saw, the last operator `enable`}
  count, so an `enable` is never undone by old evidence. The enable's watermark is metadata of
  the `disabledEngines` setting, saved in the same write as the enable itself: durable exactly
  when the enable is, across restarts and every process on the node. Settings writes are
  compare-and-swap against the file on disk, so no process saves a stale copy over them.
  Enables and the patrol's decision share one state-dir lock; both marks are re-read inside it,
  and the disable's mark is written first. An authorized settings writer can edit the
  `enabledAt:<engine>` metadata (an older time lets older evidence count again) — the same
  authority that can already edit `disabledEngines` directly. An
  unreadable or unwritable marks file, or a pinned skill that cannot be verified, refuses the rule
  (fail closed).
- Evidence is the host's own review-output file in its state dir (never the run's worktree), and
  only settled local contract-review runs count. Accepted residual: a same-uid process that can
  write the host's state dir can forge it — the same class as re-pinning `skillSource`.
