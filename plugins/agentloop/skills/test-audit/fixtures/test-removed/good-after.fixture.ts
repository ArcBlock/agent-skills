import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

test("resolve returns the full record", () => {
  expect(resolve("a")).toEqual({ id: "a", kind: "user" });
});

test("resolve rejects unknown ids", () => {
  expect(() => resolve("zzz")).toThrow(/unknown/);
});

// Adding a test must never be mistaken for removing one.
test("resolve is case sensitive", () => {
  expect(() => resolve("A")).toThrow(/unknown/);
});
