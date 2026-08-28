/**
 * test-audit — the repo-agnostic half of the contract.
 *
 * Everything in this file is a TYPE or a default. No arc facts live here: the
 * consuming repo supplies an `Adapter` (conventionally `.claude/test-audit.config.ts`)
 * and the engine reads it.
 *
 * ## Why the dialect is data, not code
 *
 * The single most expensive bug in the predecessor skill was a rule whose
 * premise was never checked against the repo's actual runner. It flagged 43
 * unawaited `expect(...).rejects` sites as P0 "vacuous pass". Measured on
 * bun 1.3.14 (this repo's `engines` floor), bun tracks floating expect-promises
 * and fails the test anyway — three variants (resolve-instead-of-reject, a
 * 20ms-late resolve, and a wrong error type) all went red. The finding was
 * real-shaped and wrong.
 *
 * That is not a bug you fix by editing the rule; it is a fact that DIFFERS PER
 * RUNNER. Under jest/vitest the same shape genuinely is vacuous. So the answer
 * is `dialect.tracksFloatingExpects` — the rule reads it and switches itself
 * off where the runner already covers the case.
 *
 * The same reasoning covers `guardTokens` (`expect.unreachable()` in bun/vitest,
 * `fail()` in jest, `t.Fatal` in Go) and `weakMatchers`. A rule that hardcodes
 * one framework's vocabulary is a rule that silently misfires in every other repo.
 */

/** What the gate does with a finding. `off` disables the rule entirely. */
export type Severity = "block" | "warn" | "off";

export interface Dialect {
  /**
   * Callee names that count as an assertion (`expect`, `assert`, `chai.expect`…).
   * Matched against the ROOT identifier of a call chain.
   */
  assertionCallees: string[];
  /**
   * Matchers that assert existence or shape but not semantics. A test whose
   * every assertion is weak passes for almost any implementation.
   */
  weakMatchers: string[];
  /**
   * Source fragments that, when present in a `try` body, prove the
   * non-throwing path fails the test. Matched as text WITHIN the try block
   * only — never file-wide (file-wide matching is what made the predecessor's
   * regex unable to tell a guarded try from an unguarded one).
   */
  guardTokens: string[];
  /**
   * Regex source matching helper functions that assert on their caller's behalf.
   *
   * Cross-file resolution would be the "correct" answer and is not worth it: a
   * full-population audit found exactly one instance in 40 findings
   * (`assertFileAbsent`, imported from a test harness, which throws when the
   * file is present). A naming convention covers it for a fraction of the cost,
   * and lives here rather than in the engine so a repo whose helpers are named
   * differently can say so.
   */
  assertionHelperPattern: string;
  /**
   * True when the runner settles floating `expect(...).rejects/.resolves`
   * promises before finishing a test. When true, a missing `await` is a
   * portability/style issue, NOT a vacuous pass — and rules that would flag it
   * as a defect must stay silent. Verify with a throwaway fixture before
   * setting this; do not assume.
   */
  tracksFloatingExpects: boolean;
}

export interface Adapter {
  /** Absolute repo root. */
  root: string;
  /** Globs (repo-relative) selecting test files. */
  testGlobs: string[];
  /**
   * Path substrings excluded from every scan. `node_modules/` and `/dist/` are
   * always excluded by the engine; this is for repo-specific noise such as
   * nested checkouts or vendored trees.
   *
   * Getting the SCAN SURFACE right matters more than it looks. The predecessor
   * skill hardcoded five directories and, two months on, was blind to 844 of
   * the repo's 3392 test files (25%) — including the entire `runtimes/` tree.
   * One of its rules scanned a single directory that had since been cleaned,
   * reported 0, and looked healthy while 51 instances of the same defect sat in
   * trees it never opened. Prefer a whole-tree glob plus explicit excludes.
   */
  excludes?: string[];
  /** Build a shell command running exactly these test files and nothing else. */
  runTests(files: string[]): string;
  /**
   * Which test files plausibly cover this source file. Used by the mutation
   * tier to keep a mutant's verification narrow. Returning too many tests is
   * slow but correct; returning too few produces FALSE "survived" verdicts, so
   * when in doubt, over-select.
   */
  testsForSource(source: string, allTests: string[]): string[];
  dialect: Dialect;
  /** Per-rule severity override. Unlisted rules use their declared default. */
  rules: Record<string, Severity>;
  /** Repo-relative path of the accepted-findings baseline. */
  baseline: string;
  /**
   * Which owning unit a test file belongs to. Findings are grouped by
   * `(rule × group)` when drafting issues, so this decides how many issues a
   * sweep produces: 108 findings become one issue per rule per package, not 108
   * issues. Defaults to the first two path segments.
   */
  groupOf?: (file: string) => string;
}

/** Default owning unit: the first two path segments (`packages/core`). */
export function defaultGroupOf(file: string): string {
  return file.split("/").slice(0, 2).join("/");
}

/**
 * Bun / Vitest share `expect` semantics closely enough to start from one
 * dialect. A repo on jest or another runner overrides the fields it needs.
 */
export const BUN_VITEST_DIALECT: Dialect = {
  // `expect`/`assert` cover the vast majority. The rest are `node:assert`'s
  // functions imported DIRECTLY (`import { deepStrictEqual } from "node:assert"`),
  // which have no `assert.` prefix to root on and would otherwise read as a
  // test that asserts nothing.
  assertionCallees: [
    "expect",
    "assert",
    "deepStrictEqual",
    "notDeepStrictEqual",
    "strictEqual",
    "notStrictEqual",
    "equal",
    "notEqual",
    "ok",
    "match",
    "doesNotMatch",
    "throws",
    "doesNotThrow",
  ],
  /**
   * "Weak" means: passes for almost any value the code could plausibly return.
   *
   * Be strict about what earns a place here. A first cut also listed
   * `toBeNull`, `toBeUndefined`, `toBeInstanceOf`, `toHaveLength`,
   * `toBeGreaterThan(OrEqual)` — and replaying 300 real commits showed why that
   * is wrong: `expect(rows).toHaveLength(50)` is an EXACT count, `toBeNull()`
   * is an exact value, `toBeInstanceOf(AFSError)` is an exact type. Calling
   * them shape-only made `assertion-weakened` read ordinary rewrites like
   * `toBe → toHaveLength` as loosening, and produced 13 findings of which 0
   * were real.
   *
   * The test to apply: could this matcher pass against a value that is wrong in
   * the way the test is meant to catch? `toBeDefined` yes. `toHaveLength(50)` no.
   */
  weakMatchers: [
    "toBeDefined",
    "toBeTruthy",
    "toBeFalsy",
    "toBeString",
    "toBeNumber",
    "toBeBoolean",
    "toBeObject",
    "toBeArray",
  ],
  guardTokens: [
    "expect.unreachable",
    "expect(true).toBe(false)",
    "expect(false).toBe(true)",
    "throw new Error",
    ".fail(",
  ],
  assertionHelperPattern: "^(assert|expect|verify|ensure)[A-Z_]",
  // Measured, not assumed — see the file header.
  tracksFloatingExpects: true,
};

/** Resolve a rule's effective severity for this repo. */
export function severityOf(adapter: Adapter, ruleId: string, fallback: Severity): Severity {
  return adapter.rules[ruleId] ?? fallback;
}
