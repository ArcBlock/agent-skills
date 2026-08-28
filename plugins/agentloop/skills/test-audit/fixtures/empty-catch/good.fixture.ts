/**
 * The accept path for `empty-catch`.
 *
 * All three shapes below were measured as real false positives of the first cut
 * of this rule ("any empty catch in a test file"), which scored 7.4% precision
 * over a hand-verified 54-finding sample. They must stay unflagged.
 */
import { afterEach, expect, test } from "bun:test";

function isolatedRead(key: string): string | undefined {
  return key === "leaked" ? "SHOULD NOT BE VISIBLE" : undefined;
}
function removeTempDir(): void {
  throw new Error("already gone");
}
function warmup(): void {
  throw new Error("cold");
}

// GOOD 1 — cleanup. Best-effort teardown; there is no assertion to swallow.
afterEach(() => {
  try {
    removeTempDir();
  } catch {}
});

// GOOD 2 — capability probe. "It did not work" is a legitimate branch.
test("serves a request after an optional warmup", () => {
  try {
    warmup();
  } catch {}
  expect(isolatedRead("other")).toBeUndefined();
});

// GOOD 3 — induce an error, then assert on a sentinel AFTER the try. The
// assertion is outside the catch's reach, so nothing can be swallowed.
test("read of a missing key does not leak", () => {
  let threw = false;
  try {
    removeTempDir();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(isolatedRead("other")).toBeUndefined();
});
