/**
 * The accept path for `catch-swallow`.
 *
 * Every shape below is airtight and MUST NOT be flagged. They are not
 * hypothetical: a 22-file sample of the predecessor regex's output scored 27%
 * precision, and 13 of its 22 false positives were exactly GOOD 1 and GOOD 3,
 * with GOOD 4 additionally exposing a false NEGATIVE (a nested `{` inside the
 * try body made `[^}]*` terminate early, so a genuinely broken test went
 * unflagged). This file is the regression pin for all four.
 */
import { expect, test } from "bun:test";

function validate(v: string) {
  if (v === "") throw new Error("empty");
  return v;
}

// GOOD 1 — guard token inside the try body.
test("guarded by expect.unreachable", () => {
  try {
    validate("");
    expect.unreachable();
  } catch (e) {
    expect((e as Error).message).toBe("empty");
  }
});

// GOOD 2 — two valid paths; both branches assert.
test("both branches assert", () => {
  try {
    const r = validate("x");
    expect(r).toBe("x");
  } catch (e) {
    expect((e as Error).message).toBe("empty");
  }
});

// GOOD 3 — guard placed AFTER the try/catch (the `threw` flag idiom).
test("guarded by a trailing assertion", () => {
  let threw = false;
  try {
    validate("");
  } catch (e) {
    threw = true;
    expect((e as Error).message).toBe("empty");
  }
  expect(threw).toBe(true);
});

// GOOD 4 — a nested brace in the try body. The old regex went blind here.
test("nested braces, still guarded", () => {
  try {
    validate(JSON.stringify({ a: 1 }).slice(0, 0));
    expect.unreachable();
  } catch (e) {
    expect((e as Error).message).toBe("empty");
  }
});

// GOOD 5 — the throw is already pinned ABOVE; the try/catch only refines which
// error came out. Widen validate() and the `.toThrow` on the line above fails
// first, so nothing here can pass vacuously.
test("throw already pinned above the try/catch", () => {
  expect(() => validate("")).toThrow();
  try {
    validate("");
  } catch (e) {
    expect((e as Error).message).toBe("empty");
  }
});
