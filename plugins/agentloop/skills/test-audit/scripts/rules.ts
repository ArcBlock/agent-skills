/**
 * test-audit — rule registry and the static (tree-scoped) rules.
 *
 * ## Two non-negotiables encoded here
 *
 * 1. **Parse, don't regex.** The predecessor's `try/catch` rule was
 *    `'try \{[^}]*\} catch[^{]*\{[^}]*expect\('`. `[^}]*` cannot cross a nested
 *    brace, so the pattern was structurally unable to do the job it claimed:
 *    measured on a 3-fixture file, it flagged a correctly-guarded try (false
 *    positive) and MISSED an unguarded one whose try body contained `{ a: 1 }`
 *    (false negative). A 22-file sample of its real output scored 27% precision,
 *    with 13/22 false positives all caused by the one gap — it never looks for a
 *    guard token at all. `catchSwallow` below reads the actual try block.
 *
 * 2. **Every rule ships an accept fixture.** `fixtures/<rule>/bad.ts` must be
 *    flagged; `fixtures/<rule>/good.ts` must NOT be. `test/rules.test.ts`
 *    enforces both for every registered rule, and a rule missing either file
 *    fails the suite. This is the repo's own accept-path 铁律 pointed at the
 *    auditor: a rule that flags EVERYTHING satisfies every reject-only test, so
 *    reject-only coverage cannot distinguish a working rule from a broken one.
 */
import { createHash } from "node:crypto";
import ts from "typescript";
import { type Adapter, type Severity, severityOf } from "./adapter.ts";

export interface Finding {
  rule: string;
  severity: Severity;
  /** Repo-relative. */
  file: string;
  line: number;
  /** One sentence: what is wrong. */
  message: string;
  /**
   * Machine-checkable evidence for the claim. A finding without a witness is
   * not emitted — it is what makes "is this rule misfiring?" answerable by
   * reading output instead of re-auditing the rule.
   */
  witness: string;
  /** Stable under line drift: rule + file + hash of the offending snippet. */
  key: string;
}

/** A finding before the engine resolves severity and computes its key. */
export type RawFinding = Omit<Finding, "severity" | "key"> & { snippet: string };

export interface StaticRule {
  id: string;
  tier: "T0" | "T1";
  defaultSeverity: Severity;
  /** One line: the defect this rule states. Rendered in reports and issues. */
  what: string;
  scan(sf: ts.SourceFile, file: string, adapter: Adapter): RawFinding[];
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Whitespace-collapsed source of a node — the content half of a finding key.
 *
 * Keys must NOT be derived from line numbers: a finding whose identity moves
 * when an unrelated comment is added above it re-opens as "new" on every
 * reformat, which destroys both the baseline and issue dedup. Content-derived
 * keys drift only when the offending code actually changes.
 */
function norm(sf: ts.SourceFile, node: ts.Node): string {
  return node.getText(sf).replace(/\s+/g, " ").trim();
}

/** Root identifier of a call chain: `expect(x).a.b()` → "expect". */
function rootCallee(node: ts.CallExpression): string {
  let expr: ts.Node = node.expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(expr)) expr = expr.expression;
    else if (ts.isCallExpression(expr)) expr = expr.expression;
    else if (ts.isElementAccessExpression(expr)) expr = expr.expression;
    else break;
  }
  return ts.isIdentifier(expr) ? expr.text : "";
}

function walk(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((c) => walk(c, fn));
}

/** Does this subtree contain a call rooted at one of the dialect's assertion callees? */
function hasAssertion(node: ts.Node, adapter: Adapter): boolean {
  let found = false;
  walk(node, (n) => {
    if (found || !ts.isCallExpression(n)) return;
    if (adapter.dialect.assertionCallees.includes(rootCallee(n))) found = true;
  });
  return found;
}

/**
 * The matcher names applied in a subtree's assertion chains, e.g.
 * `expect(x).resolves.toEqual(y)` → ["toEqual"]. Used by the diff tier to tell
 * a strengthened assertion from a weakened one.
 */
export function matcherNames(node: ts.Node, adapter: Adapter): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (!adapter.dialect.assertionCallees.includes(rootCallee(n))) return;
    if (ts.isPropertyAccessExpression(n.expression)) out.push(n.expression.name.text);
  });
  return out;
}

interface TestCall {
  node: ts.CallExpression;
  /** "test" | "it" | "describe" */
  kind: string;
  /** "skip" | "todo" | "only" | "" */
  modifier: string;
  title: string;
  body?: ts.Node;
}

const TEST_KINDS = new Set(["test", "it", "describe"]);

function testCalls(sf: ts.SourceFile): TestCall[] {
  const out: TestCall[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    let kind = "";
    let modifier = "";
    if (ts.isIdentifier(n.expression)) {
      kind = n.expression.text;
    } else if (
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression)
    ) {
      kind = n.expression.expression.text;
      modifier = n.expression.name.text;
    }
    if (!TEST_KINDS.has(kind)) return;
    const [titleArg, fnArg] = n.arguments;
    const title =
      titleArg && (ts.isStringLiteral(titleArg) || ts.isNoSubstitutionTemplateLiteral(titleArg))
        ? titleArg.text
        : "";
    const body =
      fnArg && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))
        ? fnArg.body
        : undefined;
    out.push({ node: n, kind, modifier, title, body });
  });
  return out;
}

/**
 * Local functions that ASSERT — directly, or by calling another one that does.
 *
 * The distinction is load-bearing and easy to get wrong: `await
 * assertRoundtrip(afs, path)` delegates real assertions and must not be
 * flagged, while `widen(21)` merely calls the code under test and must be. A
 * first cut here treated every locally-declared function as an assertion
 * delegate, which silently exempted exactly the tests this rule exists to
 * catch — the accept/reject fixture pair caught it on the first run.
 */
function assertingHelpers(sf: ts.SourceFile, adapter: Adapter): Set<string> {
  const bodies = new Map<string, ts.Node>();
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) bodies.set(n.name.text, n.body);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      bodies.set(n.name.text, n.initializer.body);
    }
  });

  const asserting = new Set<string>();
  // NOTE: a helper that merely THROWS does not count. Tried and reverted: it
  // would catch `waitForTree()` (polls, then throws "Timed out waiting for tree
  // predicate" — a real assertion), but it also catches every setup factory
  // that validates its input — `setupAFSWithProgram()`, `createProvider()` —
  // and silenced two confirmed true positives to win one false positive.
  // Throwing on bad input is not asserting on behaviour, and nothing at the AST
  // level tells the two apart. A `throw` in the TEST BODY itself is different
  // and does count (see `hasThrow` at the call site).
  for (const [name, body] of bodies) if (hasAssertion(body, adapter)) asserting.add(name);

  // Fixpoint: a helper that calls an asserting helper is itself asserting.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of bodies) {
      if (asserting.has(name)) continue;
      if (callsAnyOf(body, asserting)) {
        asserting.add(name);
        changed = true;
      }
    }
  }
  return asserting;
}

/** Does this subtree call any of `names`? */
function callsAnyOf(node: ts.Node, names: Set<string>): boolean {
  let found = false;
  walk(node, (n) => {
    if (found || !ts.isCallExpression(n)) return;
    if (names.has(rootCallee(n))) found = true;
  });
  return found;
}

/** Calls a helper whose NAME says it asserts (`assertFileAbsent`, `expectTree`, …). */
function callsNamedAssertionHelper(node: ts.Node, adapter: Adapter): boolean {
  const re = new RegExp(adapter.dialect.assertionHelperPattern);
  let found = false;
  walk(node, (n) => {
    if (found || !ts.isCallExpression(n)) return;
    if (re.test(rootCallee(n))) found = true;
  });
  return found;
}

/*
 * ## A rejected exclusion: "this test is setup for later tests"
 *
 * Three of a 40-finding population were fixtures wearing a `test()` wrapper —
 * `test("setup: mount provider", …)` writing to a describe-scoped `let` that
 * later tests read and assert on. The structural signal looks clean: does this
 * body assign to an outer `let` that another asserting test reads?
 *
 * Measured, it is not. Implementing it removed those 3 false positives and
 * simultaneously silenced at least 3 confirmed TRUE positives, because
 * `server = await createAuthServer()` at the top of an ordinary test matches
 * the same shape. `runtimes/node/test/credential/auth-server.test.ts:68` is the
 * clearest: it assigns an outer `let`, then does substantive work whose every
 * outcome it accepts (`try { await fetch(...) } catch {}`), asserting nothing.
 * Excluding it trades a false positive for a false negative at par, and a false
 * negative is the worse of the two here — an unflagged vacuous test is exactly
 * what this rule exists to find.
 *
 * Left unimplemented deliberately. Three known false positives are the cheaper
 * bill.
 */

/**
 * An exploratory benchmark that prints a report rather than gating on one.
 *
 * Five of a 40-finding population were these — `test("print summary", …)`,
 * multi-model comparison tables, corpora deltas — all under one directory, all
 * carrying comments like "Informational — no hard quality gate".
 *
 * Two conditions, both required. Console-heaviness alone would excuse a
 * genuinely broken test that happens to log; the title check is what keeps the
 * exclusion to bodies that never claimed anything. A title with a claim verb
 * ("rejects", "returns", "is idempotent") is making an assertion in prose and
 * must still be held to making one in code.
 */
const CLAIM_VERB =
  /\b(should|must|is|are|does|do|returns?|rejects?|accepts?|throws?|never|only|cannot|can't|fails?|keeps?|stays?|preserves?)\b/i;

function isPrintingBenchmark(title: string, body: ts.Node): boolean {
  if (CLAIM_VERB.test(title)) return false;
  let logs = 0;
  walk(body, (n) => {
    if (ts.isCallExpression(n) && rootCallee(n) === "console") logs++;
  });
  return logs >= 3;
}

/** A hand-rolled `throw new Error("expected …")` is an assertion, just not a library one. */
function hasThrow(node: ts.Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (ts.isThrowStatement(n)) found = true;
  });
  return found;
}

/**
 * Callees that some test in this file asserts will throw or reject.
 *
 * This is what makes an accept-path test legible to the auditor. The shape
 *
 *     test("rejects a path outside the root", () => {
 *       expect(() => assertWithinRoot("../x")).toThrow();
 *     });
 *     test("accepts a path inside the root", () => {
 *       assertWithinRoot("a/b");           // ← no assertion; not throwing IS the claim
 *     });
 *
 * is not a test that forgot to assert. It is the accept half of an accept/reject
 * pair, and for a void guard it is the only way to write that half. Flagging it
 * would have this tool argue against the single discipline this repo cares most
 * about — a check with only reject coverage is indistinguishable from a check
 * that rejects everything. Ten of these turned up in a 38-finding sample.
 */
function throwAssertedCallees(sf: ts.SourceFile, adapter: Adapter): Set<string> {
  const out = new Set<string>();
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (!adapter.dialect.assertionCallees.includes(rootCallee(n))) return;
    const text = n.getText(sf);
    if (!/\btoThrow\w*\b|\brejects\b|\bthrows\b/.test(text)) return;
    // Every callee named inside the assertion, e.g. `expect(() => f(x)).toThrow()`.
    walk(n, (m) => {
      if (ts.isCallExpression(m)) {
        const r = rootCallee(m);
        if (r && !adapter.dialect.assertionCallees.includes(r)) out.add(r);
      }
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * `.only` silently drops every sibling test in the file. It is the cheapest
 * possible way to turn a green suite into a suite that proves nothing, and it
 * survives review because the report still says "pass".
 */
const only: StaticRule = {
  id: "only",
  tier: "T0",
  defaultSeverity: "block",
  what: "`.only` is committed — every other test in this file is silently skipped",
  scan(sf, file) {
    return testCalls(sf)
      .filter((t) => t.modifier === "only")
      .map((t) => ({
        rule: "only",
        file,
        line: lineOf(sf, t.node),
        message: `${t.kind}.only() is committed; the rest of this file does not run`,
        witness: `${t.kind}.only(${JSON.stringify(t.title)})`,
        snippet: `${t.kind}.only:${t.title}`,
      }));
  },
};

/**
 * A test body containing no assertion — directly or via a helper declared in
 * the same file — verifies only that the code under test does not throw. That
 * is a real (weak) property, but it is almost never the property the test's
 * title claims, and it stays green through any behavioural regression.
 *
 * The local-helper escape hatch matters: `await assertRoundtrip(afs, path)` is
 * a perfectly good test body. Flagging it would have made this rule the same
 * kind of noise generator its predecessor was.
 */
const noAssertions: StaticRule = {
  id: "no-assertions",
  tier: "T1",
  defaultSeverity: "warn",
  what: "test body executes code but asserts nothing about the result",
  scan(sf, file, adapter) {
    const helpers = assertingHelpers(sf, adapter);
    const acceptPair = throwAssertedCallees(sf, adapter);
    return testCalls(sf)
      .filter((t) => t.kind !== "describe" && !t.modifier && t.body)
      .filter((t) => {
        const body = t.body!;
        if (hasAssertion(body, adapter)) return false; // asserts directly
        if (callsAnyOf(body, helpers)) return false; // local helper that asserts or throws
        if (callsNamedAssertionHelper(body, adapter)) return false; // imported `assertX(...)`
        if (hasThrow(body)) return false; // hand-rolled assertion
        if (callsAnyOf(body, acceptPair)) return false; // accept half of an accept/reject pair
        if (isPrintingBenchmark(t.title, body)) return false; // exploratory report, claims nothing
        return true;
      })
      .map((t) => ({
        rule: "no-assertions",
        file,
        line: lineOf(sf, t.node),
        message: `test ${JSON.stringify(t.title)} contains no assertion; it only proves nothing threw`,
        witness:
          "no call rooted at an assertion callee, no local asserting helper, no throw, and no sibling test asserts any of its callees throw",
        snippet: `no-assertions:${t.title}`,
      }));
  },
};

/**
 * An empty `catch {}` wrapped around an ASSERTION — the assertion's own failure
 * is what gets swallowed.
 *
 * ## Why the `try`-contains-an-assertion condition is the whole rule
 *
 * "Empty catch in a test file" on its own is a 7.4%-precision signal: measured
 * over a hand-verified 54-finding sample, 50 were legitimate —
 *
 *   - 26 cleanup (`afterEach` removing a temp dir, `close()`, `kill()`),
 *   - 15 best-effort probes (warmup fetch, optional-capability detection),
 *   -  9 induce-an-error-then-assert-on-a-sentinel-after-the-try.
 *
 * In all 50, the empty catch swallows an error nobody was asserting on, which
 * is exactly what it is there for. In all 4 true positives an `expect()` sat
 * INSIDE the try, so when the assertion failed, the `catch {}` ate it and the
 * test went green:
 *
 *     try {
 *       const readB = await afs.read("/provider-b/items/gamma");
 *       expect(readB.data).toBeUndefined();   // ← isolation breaks, this throws
 *     } catch {}                              // ← and is silently eaten
 *
 * Restricting to that shape separated all 4 from all 50 with no false negative
 * in the sample. A hook/naming exclusion (`afterEach`, `cleanup*`) was the
 * obvious alternative and is strictly worse: it covers 22 of the 26 cleanup
 * cases and none of the other 24.
 */
const emptyCatch: StaticRule = {
  id: "empty-catch",
  tier: "T1",
  defaultSeverity: "warn",
  what: "an assertion sits inside a try whose `catch {}` swallows its failure",
  scan(sf, file, adapter) {
    const out: RawFinding[] = [];
    walk(sf, (n) => {
      if (!ts.isTryStatement(n) || !n.catchClause) return;
      if (n.catchClause.block.statements.length > 0) return;
      if (!hasAssertion(n.tryBlock, adapter)) return;
      out.push({
        rule: "empty-catch",
        file,
        line: lineOf(sf, n.catchClause),
        message:
          "an assertion inside this try will be swallowed by the empty `catch {}` — when it fails, the test still passes",
        witness: `try block contains a call rooted at [${adapter.dialect.assertionCallees.join(", ")}]; catch block has 0 statements`,
        // Keyed on the enclosing try/catch text: `catch {}` alone is not unique
        // within a file, and a line number is not stable (see `norm`).
        snippet: `empty-catch:${norm(sf, n)}`,
      });
    });
    return out;
  },
};

/**
 * The real version of the pattern the predecessor's regex could not express:
 * the `catch` block holds the only assertions, and nothing makes the
 * non-throwing path fail. If the code under test stops throwing, the try body
 * runs to completion, the catch never fires, and the test passes having
 * asserted nothing.
 *
 * Three guard shapes are honoured, because all three appear in real suites and
 * all three make the test airtight:
 *   - a dialect guard token inside the try body (`expect.unreachable()`, …);
 *   - an assertion inside the try body (the two-valid-paths idiom);
 *   - an assertion in the statement immediately after the try/catch (the
 *     `let threw = false; … expect(threw).toBe(true)` idiom).
 */
const catchSwallow: StaticRule = {
  id: "catch-swallow",
  tier: "T1",
  defaultSeverity: "warn",
  what: "`catch` holds the only assertions and the non-throwing path is unguarded",
  scan(sf, file, adapter) {
    const out: RawFinding[] = [];
    walk(sf, (n) => {
      if (!ts.isTryStatement(n) || !n.catchClause) return;
      if (!hasAssertion(n.catchClause.block, adapter)) return;
      if (hasAssertion(n.tryBlock, adapter)) return;

      const tryText = n.tryBlock.getText(sf);
      if (adapter.dialect.guardTokens.some((g) => tryText.includes(g))) return;

      const parent = n.parent;
      if (parent && ts.isBlock(parent)) {
        const idx = parent.statements.indexOf(n as ts.Statement);

        // Guard living just after the try/catch (`expect(threw).toBe(true)`).
        const next = idx >= 0 ? parent.statements[idx + 1] : undefined;
        if (next && hasAssertion(next, adapter)) return;

        // Guard living BEFORE it: an earlier assertion in the same test already
        // pins that this call throws, so the try/catch is refining the error's
        // content rather than being the sole check. Matched on the CALLEE, not
        // merely "an assertion appears above" — the loose version would suppress
        // a genuinely unguarded try/catch that happens to follow an unrelated
        // `.toThrow`, trading this rule's whole purpose for one false positive.
        const calleesInTry = new Set<string>();
        walk(n.tryBlock, (m) => {
          if (ts.isCallExpression(m)) {
            const r = rootCallee(m);
            if (r) calleesInTry.add(r);
          }
        });
        const pinnedAbove = parent.statements.slice(0, Math.max(idx, 0)).some((prev) => {
          const text = prev.getText(sf);
          if (!/\btoThrow\b|\brejects\b/.test(text)) return false;
          return [...calleesInTry].some((c) => text.includes(c));
        });
        if (pinnedAbove) return;
      }

      out.push({
        rule: "catch-swallow",
        file,
        line: lineOf(sf, n),
        message:
          "assertions live only in `catch`; if the code stops throwing this test passes having asserted nothing",
        witness: `try block: 0 assertions, no guard token from [${adapter.dialect.guardTokens.join(", ")}]; no assertion follows the try/catch`,
        snippet: `catch-swallow:${norm(sf, n)}`,
      });
    });
    return out;
  },
};

export const STATIC_RULES: StaticRule[] = [only, noAssertions, emptyCatch, catchSwallow];

// ---------------------------------------------------------------------------
// Engine glue
// ---------------------------------------------------------------------------

export function findingKey(raw: RawFinding): string {
  const h = createHash("sha1").update(`${raw.rule}\0${raw.file}\0${raw.snippet}`).digest("hex");
  return h.slice(0, 12);
}

/** Run every enabled static rule over one parsed file. */
export function scanFile(sf: ts.SourceFile, file: string, adapter: Adapter): Finding[] {
  const out: Finding[] = [];
  for (const rule of STATIC_RULES) {
    const severity = severityOf(adapter, rule.id, rule.defaultSeverity);
    if (severity === "off") continue;
    for (const raw of rule.scan(sf, file, adapter)) {
      out.push({ ...raw, severity, key: findingKey(raw) });
    }
  }
  return out;
}
