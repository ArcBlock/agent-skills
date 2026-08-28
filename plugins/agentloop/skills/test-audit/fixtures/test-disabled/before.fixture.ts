import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

test("resolve rejects unknown ids", () => {
  expect(() => resolve("zzz")).toThrow(/unknown/);
});
