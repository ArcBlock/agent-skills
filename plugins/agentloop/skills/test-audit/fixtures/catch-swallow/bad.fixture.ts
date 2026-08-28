import { expect, test } from "bun:test";

function validate(v: string) {
  if (v === "") throw new Error("empty");
  return v;
}

// BAD: the assertions live only in `catch`. Widen validate() to accept "" and
// this test STILL PASSES, having asserted nothing at all.
test("validate rejects empty", () => {
  try {
    validate("");
  } catch (e) {
    expect((e as Error).message).toBe("empty");
  }
});
