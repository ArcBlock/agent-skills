import { expect, test } from "bun:test";

// BAD: `.only` silently drops the second test. The run reports green either way.
test.only("first", () => {
  expect(1).toBe(1);
});

test("second — never runs", () => {
  expect(1).toBe(2);
});
