import { expect, test } from "bun:test";
import { resolve } from "./subject.ts";

// GOOD 1 — strengthened: the original assertion is intact and one was added.
test("resolve returns the full record", () => {
  expect(resolve("a")).toEqual({ id: "a", kind: "user" });
  expect(resolve("a").kind).toBe("user");
});

// GOOD 2 — a WEAK matcher (`toBeDefined`) was dropped while the semantic one
// (`toThrow`) stayed. That is a test getting tidier, not weaker. Flagging it
// would punish improvement, which is how a gate becomes decoration people mute.
test("resolve rejects unknown ids", () => {
  expect(() => resolve("zzz")).toThrow(/unknown/);
});

// GOOD 3 — loose regex swapped for exact equality, and MORE assertions than
// before. Strictly better. Observed as a real false positive of the first cut
// of this rule on `feat(cli): emit arc service --json on stdout only`.
test("resolve reports the id it failed on", () => {
  expect(resolve.name).toBe("resolve");
  expect(resolve.length).toBe(1);
});

// GOOD 4 — a field was REMOVED from the product, so its assertion went with it.
// Semantic assertions shrank and nothing shape-only replaced them. Observed as
// a real false positive on `feat(cli)!: remove ARC_HOME` and
// `feat(did-space)!: remove Node CAS object store`.
test("resolve stamps a legacy trace field", () => {
  expect(resolve("a")).toEqual({ id: "a", kind: "user" });
});
