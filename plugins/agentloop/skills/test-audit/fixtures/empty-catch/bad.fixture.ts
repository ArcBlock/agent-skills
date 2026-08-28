import { expect, test } from "bun:test";

function isolatedRead(key: string): string | undefined {
  return key === "leaked" ? "SHOULD NOT BE VISIBLE" : undefined;
}

// BAD: the assertion is INSIDE the try. When isolation breaks and the expect
// throws, the empty `catch {}` eats it and the test still reports green.
test("provider B cannot see provider A's data", () => {
  try {
    expect(isolatedRead("leaked")).toBeUndefined();
  } catch {}
});
