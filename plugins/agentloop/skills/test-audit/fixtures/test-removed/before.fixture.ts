import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

test("resolve returns the full record", () => {
  expect(resolve("a")).toEqual({ id: "a", kind: "user" });
});

test("resolve rejects unknown ids", () => {
  expect(() => resolve("zzz")).toThrow(/unknown/);
});
