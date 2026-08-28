/**
 * test-audit — the diff tier (T3).
 *
 * ## Why a whole tier only exists on a diff
 *
 * The tree-scoped rules ask "is this test weak?". These ask "did this change
 * MAKE it weaker?" — and that question has no answer without a base revision.
 * It is also the question that matters most for machine-authored changes.
 *
 * An agent writing tests is graded on "the suite is green", not on "the suite
 * would catch a regression". When a test it wrote goes red, the cheapest route
 * back to green is to weaken the assertion: `toEqual` → `toBeDefined`, drop a
 * field from the expected object, wrap the call in try/catch, or mark the test
 * `.skip`. Every one of those is invisible to a tree scan (the resulting test
 * looks like thousands of legitimately-lenient tests) and invisible to a human
 * reviewer skimming for green. On a diff each one is unambiguous.
 *
 * All three rules here are structural comparisons of two parse trees. There is
 * no heuristic and no judgement: a strong matcher that was there before and is
 * not there now either moved or was removed, and both deserve a sentence in the
 * PR.
 */
import ts from "typescript";
import type { Adapter } from "./adapter.ts";
import { severityOf } from "./adapter.ts";
import { type Finding, findingKey, matcherNames, parse, type RawFinding } from "./rules.ts";

export interface DiffRule {
  id: string;
  tier: "T3";
  defaultSeverity: "block" | "warn" | "off";
  what: string;
  /** `before`/`after` are null when the file was added / deleted. */
  scan(
    file: string,
    before: ts.SourceFile | null,
    after: ts.SourceFile | null,
    adapter: Adapter,
  ): RawFinding[];
}

interface TestShape {
  title: string;
  modifier: string;
  matchers: string[];
  line: number;
  /** Identifier tokens of the body — the identity signal that survives a retitle. */
  tokens: Set<string>;
}

const TEST_KINDS = new Set(["test", "it"]);

function tokenize(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Pair up before/after tests. Exact title first; then, for whatever is left,
 * best body-similarity match above `RENAME_THRESHOLD`.
 *
 * Both halves are load-bearing and were measured, not guessed. Replaying 300
 * real commits with title-only matching produced 381 `test-removed` findings
 * and would have blocked 23.7% of every test-touching commit in this repo's
 * history — the top offenders being ordinary retitles like
 * `"bare --no-browser resolves to true"` → `"bare --no-browser resolves browser
 * to false"`, where the test never went anywhere. That is the false-positive
 * half. The false-NEGATIVE half is the same fact from the other side: a change
 * that retitles a test AND guts its assertions is exactly the shape
 * `assertion-weakened` exists to catch, and title-only matching cannot see it
 * at all.
 */
const RENAME_THRESHOLD = 0.6;

export function pairTests(
  before: TestShape[],
  after: TestShape[],
): { pairs: [TestShape, TestShape][]; removed: TestShape[] } {
  const afterByTitle = new Map(after.map((s) => [s.title, s]));
  const pairs: [TestShape, TestShape][] = [];
  const unmatchedBefore: TestShape[] = [];
  const takenAfter = new Set<TestShape>();

  for (const b of before) {
    const exact = afterByTitle.get(b.title);
    if (exact && !takenAfter.has(exact)) {
      pairs.push([b, exact]);
      takenAfter.add(exact);
    } else {
      unmatchedBefore.push(b);
    }
  }

  const removed: TestShape[] = [];
  for (const b of unmatchedBefore) {
    let best: TestShape | undefined;
    let bestScore = 0;
    for (const a of after) {
      if (takenAfter.has(a)) continue;
      const score = jaccard(b.tokens, a.tokens);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    if (best && bestScore >= RENAME_THRESHOLD) {
      pairs.push([b, best]);
      takenAfter.add(best);
    } else {
      removed.push(b);
    }
  }
  return { pairs, removed };
}

/** Per-test assertion shape, keyed by title. */
function shapes(sf: ts.SourceFile, adapter: Adapter): Map<string, TestShape> {
  const out = new Map<string, TestShape>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      let kind = "";
      let modifier = "";
      if (ts.isIdentifier(n.expression)) kind = n.expression.text;
      else if (
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression)
      ) {
        kind = n.expression.expression.text;
        modifier = n.expression.name.text;
      }
      if (TEST_KINDS.has(kind)) {
        const [titleArg, fnArg] = n.arguments;
        const title =
          titleArg && (ts.isStringLiteral(titleArg) || ts.isNoSubstitutionTemplateLiteral(titleArg))
            ? titleArg.text
            : "";
        if (title) {
          const body =
            fnArg && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))
              ? fnArg.body
              : undefined;
          out.set(title, {
            title,
            modifier,
            matchers: body ? matcherNames(body, adapter) : [],
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            tokens: tokenize(body ? body.getText(sf) : ""),
          });
        }
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Multiset difference: which of `a`'s entries are not covered by `b`. */
function lost(a: string[], b: string[]): string[] {
  const pool = [...b];
  const missing: string[] = [];
  for (const x of a) {
    const i = pool.indexOf(x);
    if (i >= 0) pool.splice(i, 1);
    else missing.push(x);
  }
  return missing;
}

/**
 * A test that survived the diff and was LOOSENED: it lost semantic assertions
 * and gained shape-only ones.
 *
 * ## The judgement call this rule encodes, and the data behind it
 *
 * The obvious rule — "a strong matcher disappeared" — does not work. Replayed
 * over 300 real commits it fired on 70 sites across 23 commits (7.7% of all
 * test-touching commits), and reading them, essentially every one was a
 * legitimate rewrite:
 *
 *   - `feat(cli)!: remove ARC_HOME` — the ARC_HOME assertions went away with
 *     ARC_HOME. Correct.
 *   - `feat(did-space)!: remove Node CAS object store` — the cid assertions went
 *     away with the cid dual-write. Correct.
 *   - `feat(cli): emit arc service --json on stdout only` — swapped `toMatch`
 *     for `toBe`, i.e. loose regex → exact equality, and grew from 7 assertions
 *     to 10. That is a test getting STRICTER, and the naive rule flagged it.
 *
 * Behaviour changes legitimately delete assertions all day long, and no
 * examination of the test file alone can separate "deleted because the
 * behaviour went" from "deleted because it was failing". Blocking on it taxes
 * every honest refactor.
 *
 * What IS specific to the failure mode is the SUBSTITUTION: semantic assertions
 * down AND shape-only assertions up. That is the shape of "make it pass by
 * loosening" (`toEqual` → `toBeDefined`) and it is not the shape of any of the
 * legitimate rewrites above. Both halves are required — either alone is noise.
 */
/*
 * ## Severity: `warn`, and the measurement that decided it
 *
 * Replayed over 300 real test-touching commits, the tightened rule fires twice
 * (0.7%) and BOTH are false positives — deliberate behaviour changes whose
 * assertions correctly followed the behaviour:
 *
 *   - `feat(did-space)!: remove Node CAS object store` — `toThrow` went away
 *     because the CAS route it guarded was retired.
 *   - `fix(did-space): a folder space has ONE ledger` — `rejects.toBeInstanceOf(
 *     AFSUnsupportedError)` → `resolves.toBeDefined()` because the method
 *     deliberately stopped failing closed.
 *
 * So: zero demonstrated true positives on this repo's real history, and a 100%
 * false-positive record on the two times it spoke. The rule DOES detect the
 * shape — a fixture and a real hand-made weakening on
 * `packages/core/test/utils/uri.test.ts` both trip it — but detecting a shape
 * that has not once occurred in 300 commits does not earn the right to stop
 * anybody's PR. Finding a real problem and being worth blocking on are separate
 * questions, and this rule has so far answered neither.
 *
 * Keep it (it is free, and the failure mode it describes is real for
 * machine-authored changes, which is precisely what this repo's history has NOT
 * been full of yet), report it, and let a repo that measures actual true
 * positives raise it to `block` in its own adapter.
 */
const assertionWeakened: DiffRule = {
  id: "assertion-weakened",
  tier: "T3",
  defaultSeverity: "warn",
  what: "a surviving test swapped semantic assertions for shape-only ones",
  scan(file, before, after, adapter) {
    if (!before || !after) return [];
    const weakSet = new Set(adapter.dialect.weakMatchers);
    const strong = (m: string[]) => m.filter((x) => !weakSet.has(x));
    const weak = (m: string[]) => m.filter((x) => weakSet.has(x));

    const out: RawFinding[] = [];
    const { pairs } = pairTests(
      [...shapes(before, adapter).values()],
      [...shapes(after, adapter).values()],
    );
    for (const [was, now] of pairs) {
      const sBefore = strong(was.matchers);
      const sAfter = strong(now.matchers);
      const wBefore = weak(was.matchers);
      const wAfter = weak(now.matchers);
      // Both halves required — see the header. Semantic assertions must have
      // shrunk AND shape-only ones must have grown.
      if (!(sAfter.length < sBefore.length && wAfter.length > wBefore.length)) continue;

      const dropped = lost(sBefore, sAfter);
      const gained = lost(wAfter, wBefore);
      const renamed = was.title !== now.title ? ` (renamed from ${JSON.stringify(was.title)})` : "";
      out.push({
        rule: "assertion-weakened",
        file,
        line: now.line,
        message: `test ${JSON.stringify(now.title)}${renamed} traded ${dropped.map((d) => `.${d}()`).join(", ")} for ${gained.map((g) => `.${g}()`).join(", ")} — a loosened assertion passes without the behaviour being right`,
        witness: `semantic: [${sBefore.join(", ")}] → [${sAfter.join(", ")}]; shape-only: [${wBefore.join(", ")}] → [${wAfter.join(", ")}]`,
        snippet: `assertion-weakened:${now.title}:${dropped.sort().join(",")}>${gained.sort().join(",")}`,
      });
    }
    return out;
  },
};

/**
 * A test that is gone — not retitled, gone: no surviving test in the file has a
 * similar body.
 *
 * **This rule reports a FACT, never a verdict, and it must never block.** Its
 * headline claim would be "coverage was dropped", and it structurally cannot
 * establish that: deleting a feature's tests along with the feature is correct
 * and common. Measured over 300 real commits, the top hits were exactly that —
 * `refactor(cli): drop the -i REPL entry point` deleting the four tests for the
 * entry point it deleted. Blocking on this would tax every honest refactor,
 * and a gate that fires on honest work is a gate people learn to bypass.
 *
 * So it says what it can prove ("these N tests are gone") and leaves the
 * judgement to the reviewer, who can see the rest of the diff.
 */
const testRemoved: DiffRule = {
  id: "test-removed",
  tier: "T3",
  defaultSeverity: "warn",
  what: "a test disappeared (not a retitle) — check whether the behaviour went with it",
  scan(file, before, after, adapter) {
    if (!before || !after) return []; // whole-file add/delete is a reviewable act on its own
    const { removed } = pairTests(
      [...shapes(before, adapter).values()],
      [...shapes(after, adapter).values()],
    );
    return removed.map((was) => ({
      rule: "test-removed",
      file,
      line: was.line,
      message: `test ${JSON.stringify(was.title)} is gone and no surviving test in this file resembles it — intentional if the behaviour went too, a silent coverage drop if it did not`,
      witness: `present at ${file}:${was.line} in base; no test in head matches by title or by body similarity ≥ ${RENAME_THRESHOLD}`,
      snippet: `test-removed:${was.title}`,
    }));
  },
};

/** A test that gained `.skip`/`.todo` — green by exclusion. */
const testDisabled: DiffRule = {
  id: "test-disabled",
  tier: "T3",
  defaultSeverity: "block",
  what: "a test was disabled with .skip/.todo in this change",
  scan(file, before, after, adapter) {
    if (!before || !after) return [];
    const { pairs } = pairTests(
      [...shapes(before, adapter).values()],
      [...shapes(after, adapter).values()],
    );
    const out: RawFinding[] = [];
    for (const [was, now] of pairs) {
      const disabled = now.modifier === "skip" || now.modifier === "todo";
      if (!disabled || was.modifier === now.modifier) continue;
      out.push({
        rule: "test-disabled",
        file,
        line: now.line,
        message: `test ${JSON.stringify(now.title)} was changed to .${now.modifier}(); the suite is now green by exclusion`,
        witness: `modifier: ${was.modifier || "none"} → ${now.modifier}`,
        snippet: `test-disabled:${now.title}:${now.modifier}`,
      });
    }
    return out;
  },
};

export const DIFF_RULES: DiffRule[] = [assertionWeakened, testRemoved, testDisabled];

/** Run every enabled diff rule over one changed file. */
export function scanDiffFile(
  file: string,
  beforeText: string | null,
  afterText: string | null,
  adapter: Adapter,
): Finding[] {
  const before = beforeText === null ? null : parse(`${file}#base`, beforeText);
  const after = afterText === null ? null : parse(file, afterText);
  const out: Finding[] = [];
  for (const rule of DIFF_RULES) {
    const severity = severityOf(adapter, rule.id, rule.defaultSeverity);
    if (severity === "off") continue;
    for (const raw of rule.scan(file, before, after, adapter)) {
      out.push({ ...raw, severity, key: findingKey(raw) });
    }
  }
  return out;
}
