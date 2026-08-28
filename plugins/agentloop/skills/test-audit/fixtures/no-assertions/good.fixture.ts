/**
 * The accept path for `no-assertions`.
 *
 * GOOD 2–5 are all shapes measured as real false positives of earlier cuts of
 * this rule over a 38-finding hand-verified sample. GOOD 3 is the important
 * one: for a void guard, "calling it does not throw" is the ONLY way to write
 * the accept half of an accept/reject pair, and a rule that flags it would be
 * arguing against the one discipline that separates a working check from a
 * check that rejects everything.
 */

import { expect, test } from "bun:test";
import { deepStrictEqual } from "node:assert";

function widen(x: number) {
  return x * 2;
}
function assertWithinRoot(p: string): void {
  if (p.startsWith("..")) throw new Error(`escapes root: ${p}`);
}

// GOOD 1 — a direct assertion.
test("widen doubles its input", () => {
  expect(widen(21)).toBe(42);
});

// GOOD 2 — assertions delegated to a helper declared in this file.
function assertDoubles(input: number, want: number) {
  expect(widen(input)).toBe(want);
}

test("widen doubles via helper", () => {
  assertDoubles(21, 42);
});

// GOOD 3 — the accept/reject pair. The reject half names the callee...
test("assertWithinRoot rejects an escaping path", () => {
  expect(() => assertWithinRoot("../etc/passwd")).toThrow(/escapes root/);
});

// ...and the accept half has nothing to assert but the absence of a throw.
// A broken guard that rejected everything would fail HERE and nowhere else.
test("assertWithinRoot accepts a path inside the root", () => {
  assertWithinRoot("a/b");
});

// GOOD 4 — a hand-rolled assertion. Not a library call, still an assertion.
test("widen is monotonic", () => {
  for (let i = 0; i < 5; i++) {
    if (widen(i + 1) <= widen(i)) throw new Error(`not monotonic at ${i}`);
  }
});

// GOOD 5 — `node:assert` imported directly, so there is no `assert.` root.
test("widen doubles, via node:assert", () => {
  deepStrictEqual(widen(21), 42);
});

// GOOD 6 — an assertion helper IMPORTED from another module. Cross-file
// resolution is not worth it for one instance in 40; the dialect's
// `assertionHelperPattern` recognises the naming convention instead.
declare function assertFileAbsent(path: string): void;

test("teardown removes the scratch file", () => {
  assertFileAbsent("/tmp/scratch");
});

// GOOD 7 — an exploratory benchmark. It prints a report and claims nothing:
// its title carries no claim verb, so there is no assertion to be missing.
test("print summary", () => {
  console.log("corpus A", widen(1));
  console.log("corpus B", widen(2));
  console.log("corpus C", widen(3));
});
