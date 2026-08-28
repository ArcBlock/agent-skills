import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

// BAD: the reject-path test was deleted while the file lived on. The suite is
// greener and the behaviour it covered is now unverified.
test("resolve returns the full record", () => {
  expect(resolve("a")).toEqual({ id: "a", kind: "user" });
});
