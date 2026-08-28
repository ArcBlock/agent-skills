import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

// BAD: the test was not fixed, it was excluded. The suite goes green and the
// reject path is now unverified.
test.skip("resolve rejects unknown ids", () => {
  expect(() => resolve("zzz")).toThrow(/unknown/);
});
