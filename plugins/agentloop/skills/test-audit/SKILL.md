---
name: test-audit
description: Find tests that cannot fail — bodies that assert nothing, assertions swallowed by `catch {}`, and changes that weaken, delete or disable coverage. Parses with the TypeScript AST (never regex) and reports every finding with a machine-checkable witness. Use when reviewing a PR that touches `*.test.*` and you need to know whether it made the suite weaker (a gutted test passes MORE reliably, so a green test run proves nothing); when asked what is wrong with a repo's tests or to sweep for tests that verify nothing; when asked to file issues for test-quality debt; or when deciding whether a rule is trustworthy enough to block on. Also triggers on "空跑的测试", "测试有没有用", "test quality", "vacuous test", "did this PR weaken the tests".
---

# Test Audit

A test suite has one job: **go red when the code is wrong.** This skill looks for
the places it cannot do that.

> **Repo profile.** The engine here is repo-agnostic. Every repo fact — scan
> surface, assertion dialect, per-rule severity, how to run a subset of tests —
> comes from an adapter at `.claude/test-audit.config.ts` in the consuming repo.
> Arc is the reference implementation.

## Usage

```bash
# One PR / working tree: what did this change do to the suite?
bun <plugin_root>/skills/test-audit/scripts/audit.ts diff [--base origin/main] [--json]

# Whole tree: which tests verify nothing? (advisory backlog, never a gate)
bun <plugin_root>/skills/test-audit/scripts/audit.ts scan [--json] [--rule <id>]
bun <plugin_root>/skills/test-audit/scripts/audit.ts scan --write-baseline

# Turn a sweep into a handful of actionable issue drafts (prints; never creates)
bun <plugin_root>/skills/test-audit/scripts/audit.ts issues [--rule <id>] [--json]

# Calibration: what would these rules have done to real merged history?
bun <plugin_root>/skills/test-audit/scripts/replay.ts [--limit 300] [--rule <id>] [--verbose]
```

`issues` groups findings by `(rule × owning unit)`, gives each draft the four
blocks a work item needs (问题 / 证据 / 方案 / 验收) and a `test-audit-key`
marker for upsert, and rolls the long tail of one-off groups into a single
per-rule list. On arc that turns 108 findings into 17 drafts. **It prints and
exits** — creating issues is a side effect on a shared surface and stays an
explicit act by whoever ran it.

## When invoked — pick the mode, then read the output

There are four modes and they answer different questions. Choose from what was
actually asked; do not run all of them.

| What you were asked | Mode | Then |
|---|---|---|
| "review this PR's tests" / a PR number / you are inside `pr-review` | `diff --base <merge-base>` | **Read the gate row first.** In a repo where this is wired as a verification check (arc: `testQuality`), `pre-merge` already ran it — quote that row rather than re-running. Only run it yourself when there is no such row. |
| "what's wrong with our tests" / "sweep" / "backlog" | `scan` | Report the NEW-vs-baseline split, not the raw total. The baseline is accepted debt; re-announcing it every time is how a report becomes wallpaper. |
| "file issues for this" | `issues` | Print the drafts. Add `--create --repo <owner/name>` **only if the human asked for issues to be created** — the flag is the authorisation, and it is never inferred. |
| "should rule X block?" / "is this rule any good?" | `replay --rule X --verbose` | Read the hits. A rule earns `block` only with a demonstrated true positive and a near-zero false-positive rate on that history. |

### Reading the output

1. **Separate blocking from advisory before saying anything.** They mean
   different things: `block` = this change makes the suite lie; `warn` = worth a
   glance. Reporting "12 findings" without that split is noise.
2. **Quote the witness, not just the count.** Every finding carries a
   machine-checkable reason. `path:line` plus the witness is the whole value —
   a bare count cannot be acted on or disputed.
3. **A finding is a claim about a test, not a verdict on the author.** Several
   rules are deliberately tuned for recall over precision (see the bar section
   below), so some advisory hits are legitimate code. Read the site before
   asserting it is broken.
4. **Never edit `.claude/test-audit-baseline.json` to make a run clean.** The
   baseline is accepted debt, rewritten only when a human decides to accept the
   current state (`scan --write-baseline`). Silencing a new finding by adding
   its key is indistinguishable from fixing it — and it is the one move that
   turns this whole tool back into decoration.
5. **Never raise a severity to make a point.** Promotion to `block` requires a
   `replay` run, and it is the repo owner's call, not the reviewing agent's.

In arc the diff mode is also wired into the verification gate as the
`testQuality` check (`.claude/verify/checks/check-test-quality.ts`), so
`pre-pr` / `pre-merge` carry it automatically.

## The five ways a suite fails

| # | Failure | Covered by |
|---|---|---|
| 1 | **Vacuous** — passes regardless of behaviour | `no-assertions`, `catch-swallow`, `empty-catch` |
| 2 | **Absent** — nothing covers the behaviour | not covered (needs coverage/mutation data) |
| 3 | **Wrong-target** — asserts something other than its claim | not covered (needs judgement) |
| 4 | **Not executed** — exists but never runs | `only`, `test-disabled` |
| 5 | **Weakened** — a change made it weaker | `assertion-weakened`, `test-removed` |

Rows 2 and 3 are honest gaps, not oversights. They are listed so nobody reads a
green run as "the suite is fine".

## Rules

| id | tier | asks | default |
|---|---|---|---|
| `only` | T0 | is `.only` committed, silently skipping the rest of the file? | **block** |
| `test-disabled` | T3 | did this diff change a test to `.skip`/`.todo`? | **block** |
| `no-assertions` | T1 | does this test body assert anything at all? | warn |
| `catch-swallow` | T1 | do the only assertions live in `catch`, with the non-throwing path unguarded? | warn |
| `empty-catch` | T1 | is an assertion wrapped in a try whose `catch {}` eats its failure? | warn |
| `assertion-weakened` | T3 | did a surviving test trade semantic assertions for shape-only ones? | warn |
| `test-removed` | T3 | did a test disappear (not a retitle)? | warn |

## The three disciplines this skill is built on

### 1. Parse, don't regex

A regex cannot express "the `try` block has no guard", because `[^}]*` cannot
cross a nested brace. A predecessor rule of this shape scored **27% precision**
over a 22-file hand-labelled sample; 13 of its 22 false positives came from the
single fact that it never looked for a guard token at all, and it silently
missed any unguarded try whose body contained a `{`.

`catch-swallow` reads the actual try block and honours five guard shapes: a
dialect guard token, an assertion in the try, an assertion after the try/catch,
an assertion before it naming the same callee, and the two-valid-paths idiom.
Re-measured against the same hand-labelled sample: **14/14 known false positives
eliminated, 6/6 known true positives retained.**

### 2. Every rule ships an accept fixture

`fixtures/<rule>/bad.fixture.ts` must be flagged; `fixtures/<rule>/good.fixture.ts`
must be flagged by **no** rule. Diff rules ship a `before` / `bad-after` /
`good-after` triple. `test/rules.test.ts` enforces this for every registered
rule, so **a rule cannot be registered without one.**

This is the accept-path rule pointed at the auditor. A rule that flags
everything satisfies every reject-only test it will ever be given — "catches the
bad fixture" and "also catches correct code" are the same colour without an
accept fixture. It works: the first run of `no-assertions` failed its own bad
fixture, because its helper escape-hatch was exempting the code under test.

**When real history exposes a false positive, it goes into the good fixture.**
The accept fixtures currently pin: `toMatch`→`toBe` tightening, assertions
removed because the feature was removed, `afterEach` cleanup, capability probes,
sentinel-after-try, retitles, void-guard accept halves, `node:assert` imports,
and hand-rolled `throw` assertions.

### 3. A rule may only block once measured on real history

`scripts/replay.ts` walks real commits, feeds each `(parent, head)` pair through
the same code path the gate uses, and reports what the gate **would** have done.
Run it before promoting any rule to `block`, and again whenever a rule changes.

The bar is two-sided, because **finding a real problem and being worth blocking
are separate questions.** A rule that stops honest work is a tax on every honest
change, and the first thing anyone does with a gate that cries wolf is route
around it — at which point it protects nothing.

Measured on arc's last 300 test-touching commits:

| rule | as first written | after measurement |
|---|---|---|
| `test-removed` | block, 381 findings, **would have stopped 23.7% of commits** | warn + rename detection → states a fact, leaves the call to the reviewer |
| `empty-catch` | any empty catch, **7.4% precision** (4/54) | narrowed to "the try contains an assertion" → 366 findings became 20 |
| `assertion-weakened` | block; fired 13×, **0 true positives** | narrowed to the strong↓ ∧ weak↑ substitution, then demoted to warn — it fires twice in 300 commits and both are deliberate behaviour changes |
| `no-assertions` | 121 findings, **65% precision** on a full-population audit | four escape hatches (accept/reject pairs, `node:assert` roots, body-level `throw`, named helpers) → 34 findings at **76.5% precision with 100% recall** |
| `only`, `test-disabled` | block | block — 0 occurrences in 300 commits, so holding the line is free |

Shipped blocking set: **0.0% of real commits.** Whole-tree scan never gates.

### The bar is different for `warn` than for `block`

`no-assertions` sits at 76.5% precision, and that is deliberate: it is the point
of **maximum precision reachable without giving up a single true positive.**
Two further exclusions were implemented, measured, and reverted, because each
bought fewer false positives than it cost true ones:

- *"this test is setup for later tests"* (assigns a describe-scoped `let` that an
  asserting test reads) — removed 3 false positives, silenced 3 confirmed true
  positives. `server = await createAuthServer()` at the top of an ordinary test
  is the same shape.
- *"a local helper that throws is asserting"* — would catch a polling
  `waitForTree()`, but also catches every setup factory that validates its
  input; removed 1 false positive, silenced 2 true ones.

Both reverts are the same judgement: **for a rule that only ever writes to an
advisory backlog, a false negative is the more expensive error.** A missed
vacuous test stays hidden indefinitely; a false positive costs a reviewer thirty
seconds. A rule that *blocks* inverts this, which is why the blocking set is
held to a near-zero false-positive rate instead. Pick the operating point from
what the rule is allowed to do, not from a single number.

## Adapter

```ts
import { type Adapter, BUN_VITEST_DIALECT } from "<plugin_root>/skills/test-audit/scripts/adapter.ts";

const adapter: Adapter = {
  root: "",                                  // filled in by the engine
  testGlobs: ["**/*.test.ts", "**/*.test.tsx"],
  excludes: ["nested-checkouts/", "coverage.test.ts"],
  dialect: BUN_VITEST_DIALECT,               // or override per framework
  runTests: (files) => `bun test ${files.map((f) => `./${f}`).join(" ")}`,
  testsForSource: (source, all) => /* tests that plausibly cover it */ [],
  rules: { only: "block", "no-assertions": "warn" /* … */ },
  baseline: ".claude/test-audit-baseline.json",
};
export default adapter;
```

**Scan the whole tree plus explicit excludes — never a hand-listed set of
directories.** A predecessor hardcoded five and, two months on, was blind to 844
of the repo's 3392 test files, including all of `runtimes/`. One of its rules
scanned a single directory that had since been cleaned, reported 0, and looked
healthy while 51 instances of the same defect sat in trees it never opened.

**`dialect.tracksFloatingExpects` is a fact about the runner, not a preference.**
Bun settles floating `expect(...).rejects` promises and fails the test anyway;
jest and vitest do not. Verify with a throwaway fixture before setting it. A
predecessor rule flagged 43 unawaited sites as P0 "vacuous pass" on a premise
nobody had run — measured on bun 1.3.14, all three variants
(resolve-instead-of-reject, late resolve, wrong error type) go red.

## Adding a rule

1. Write it in `scripts/rules.ts` (static) or `scripts/diff.ts` (diff), keyed on
   content, never on a line number — a finding whose identity moves when a
   comment is added above it re-opens as "new" on every reformat.
2. Emit a **witness**: machine-checkable evidence for the claim. A finding
   without one cannot be audited later without re-auditing the rule.
3. Ship the fixture pair. The harness fails without it.
4. `bun test ./test/rules.test.ts`.
5. `bun scripts/replay.ts --limit 300 --rule <id> --verbose`, and **read the
   hits**. Default to `warn`. Promote to `block` only with a demonstrated true
   positive and a near-zero false-positive rate on real history.

## Cost

| | measured |
|---|---|
| whole-tree scan (3368 files) | ~5.6s |
| diff mode, 5 changed test files | ~0.3s |
| gate row when the diff has no tests | self-skips with a reason |
