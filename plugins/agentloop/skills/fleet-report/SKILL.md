---
name: fleet-report
description: Read a fleet's own telemetry (fleet.jsonl) back — how many rounds ran vs were skipped and why, what they produced, per-repo×skill duration, and whether any round left processes behind. Runs the deterministic reporter, then flags what is worth acting on. Use to answer "is the fleet healthy", "what did it actually accomplish", "why has this repo not moved", or to open the HTML dashboard.
allowed-tools: Bash(bun *), Bash(open *), Bash(ls *), Bash(test *), Read
---

# Fleet Report — read the fleet's telemetry back

The fleet writes one JSON record per round to `fleet.jsonl`. This skill turns that into
numbers, then says which of them deserve attention.

## The one rule

**You never compute, estimate, or restate a number that the script did not print.**

The script is the fact layer; you are the judgement layer. Every count, rate, percentile and
duration comes from its output verbatim. A number you produce yourself is indistinguishable
from a correct one to the reader — that is precisely why it is forbidden. If a number you
want is not in the output, say it is not measured rather than deriving it.

## Step 1 — run it

```bash
bun "${AGENTLOOP_ROOT:-$HOME/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop}/scripts/fleet-report.ts" $ARGS
```

`$ARGS` from what was asked:

| Asked for | Args |
|---|---|
| default / "how's the fleet" | `--days 7` |
| a specific window | `--days N` |
| everything | *(none)* |
| a dashboard / "看图" / visual | `--days 7 --html /tmp/fleet-report.html` then `open /tmp/fleet-report.html` |
| a non-default deployment | add `--file <path>/fleet.jsonl` |

Default to `--days 7`. An all-time window buries a regression that started yesterday under
weeks of healthy history.

If it exits non-zero, report the message as-is — usually the file does not exist (no fleet on
this machine, or a different `logDir`). Do not invent a substitute path beyond the default.

## Step 2 — read the output for what matters

Report the headline numbers, then work down this list. Only raise an item if its condition is
met; a healthy fleet should produce a short report.

| Look at | Raise it when | Why it matters |
|---|---|---|
| **field coverage** | coverage < executed | **Check this FIRST.** Old records lack newer fields. Every rate below is over the covered subset only — say so before quoting any of them, or you will report a young field as a fleet-wide finding. |
| **residual processes** | any round > 0 | A round left processes running. These accumulate and burn the machine unattended; they are invisible without this number. |
| **failures** | failed > 0 | Name the repo×skill and the outcome (`checkout-failed` ≠ `setup-failed` ≠ `failed`). |
| **skipped-locked** | more than an occasional one | A round collided with its own previous round still running. Means the effective cadence is longer than configured — the repo's rounds outlast its interval. |
| **noop rate** | high, or rising | Rounds that ran and deliberately did nothing. Healthy for a review-shaped skill (`pr-sweep` reviews; it does not open PRs), suspicious for a work-shaped one (`issue-sweep`). Judge per skill, never in aggregate. |
| **P90 vs median** | P90 ≫ median | A long tail. Combined with `skipped-locked`, that tail is what is eating the cadence. |
| **produced summaries** | always worth reading | The only place a round says what it did in its own words. Quote one or two verbatim rather than paraphrasing — the wording carries the reason. |

## Step 3 — say what to do

At most three suggestions, each tied to a number that appeared in the output. Prefer a
concrete knob:

- long tail + lock collisions → raise `cadenceMinutes` for that repo, or split the skill
- residual processes → note that the reap is per-round; residue means something escaped it
- a repo failing repeatedly → point at its per-(repo,skill) log, which the driver names in
  its own output

If nothing meets a threshold, say the fleet looks healthy and stop. Padding a clean report
with speculation trains the reader to skim it, and the next real signal gets skimmed too.

## Not this skill's job

- **Per-issue or per-PR outcomes** — those live on GitHub, which is their source of truth.
  This reads the fleet's view of its own rounds: how long, how often, what escaped.
- **Changing anything.** Read-only. Report a knob worth turning; do not turn it.
