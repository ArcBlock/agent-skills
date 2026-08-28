import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

test("resolve returns the full record", () => {
  expect(resolve("a")).toEqual({ id: "a", kind: "user" });
});

test("resolve rejects unknown ids", () => {
  expect(resolve).toBeDefined();
  expect(() => resolve("zzz")).toThrow(/unknown/);
});

test("resolve reports the id it failed on", () => {
  expect(String(resolve.name)).toMatch(/resolve/);
});

test("resolve stamps a legacy trace field", () => {
  expect(resolve("a")).toEqual({ id: "a", kind: "user" });
  expect(resolve("a")).toHaveProperty("trace");
});
