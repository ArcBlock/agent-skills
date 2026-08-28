import { test } from "bun:test";

function widen(x: number) {
  return x * 2;
}

// BAD: executes the code, asserts nothing. Green for ANY implementation of widen().
test("widen doubles its input", () => {
  widen(21);
});
