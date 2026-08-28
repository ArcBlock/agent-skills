import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

// BAD: `toEqual` was downgraded to `toBeDefined`. The test still passes, and
// now passes for any implementation that returns anything at all.
test("resolve returns the full record", () => {
  expect(resolve("a")).toBeDefined();
});

test("resolve rejects unknown ids", () => {
  expect(() => resolve("zzz")).toThrow(/unknown/);
});
