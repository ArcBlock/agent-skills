import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

// Unchanged modifier — editing a test's body must not read as disabling it.
test("resolve rejects unknown ids", () => {
  expect(() => resolve("zzz")).toThrow(/unknown id: zzz/);
});
