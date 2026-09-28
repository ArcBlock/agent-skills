#!/usr/bin/env bun
import { describe, expect, test } from "bun:test";
import { scopeTestsToDiff } from "./diff-test-scope.ts";

const read = (path: string, source: string) => ({ path, source });

describe("scopeTestsToDiff", () => {
  test("ACCEPT: a relative import selects that test and not its neighbour", () => {
    const scope = scopeTestsToDiff({
      changed: ["scripts/lint-issue-cost-gate.ts"],
      tests: [
        read(
          "scripts/test/lint-issue-cost-gate.test.ts",
          'import { checkRoutineSweep } from "../lint-issue-cost-gate.ts";\n',
        ),
        read("scripts/test/other.test.ts", 'import { x } from "../other.ts";\n'),
      ],
    });
    expect(scope).toEqual({
      mode: "scoped",
      files: ["scripts/test/lint-issue-cost-gate.test.ts"],
      unread: [],
    });
  });

  test("ACCEPT: a changed test file is itself the run set", () => {
    const scope = scopeTestsToDiff({
      changed: ["lib/a.test.ts"],
      tests: [
        read("lib/a.test.ts", "test('a', () => {})\n"),
        read("lib/b.test.ts", "test('b', () => {})\n"),
      ],
    });
    expect(scope.mode).toBe("scoped");
    expect(scope.files).toEqual(["lib/a.test.ts"]);
  });

  test("ACCEPT: a quoted path selects the test that names it", () => {
    const scope = scopeTestsToDiff({
      changed: ["skills/land/SKILL.md"],
      tests: [
        read("scripts/record-change-set.test.ts", 'const files = ["skills/land/SKILL.md"];\n'),
        read("lib/other.test.ts", "test('x', () => {})\n"),
      ],
    });
    expect(scope.files).toEqual(["scripts/record-change-set.test.ts"]);
  });

  test("ACCEPT: a named suite reader covers a SKILL.md the static scan cannot see", () => {
    const scope = scopeTestsToDiff({
      changed: ["skills/land/SKILL.md"],
      tests: [read("lib/skill-rigor.golden.test.ts", "export const skill = (name) => name;\n")],
      suiteReaders: [
        {
          path: "lib/skill-rigor.golden.test.ts",
          when: (p) => p.endsWith("/SKILL.md"),
        },
      ],
    });
    expect(scope.mode).toBe("scoped");
    expect(scope.files).toEqual(["lib/skill-rigor.golden.test.ts"]);
  });

  test("REJECT: a changed source file nobody reads falls back to the whole tree", () => {
    const scope = scopeTestsToDiff({
      changed: ["scripts/lint-issue-cost-gate.ts"],
      tests: [read("scripts/test/other.test.ts", 'import { x } from "../other.ts";\n')],
    });
    expect(scope.mode).toBe("full");
    expect(scope.files).toEqual([]);
    expect(scope.unread).toEqual(["scripts/lint-issue-cost-gate.ts"]);
  });

  test("REJECT: an empty test list is full, never a scoped pass of nothing", () => {
    const scope = scopeTestsToDiff({
      changed: ["scripts/lint-issue-cost-gate.ts"],
      tests: [],
    });
    expect(scope.mode).toBe("full");
    expect(scope.files).toEqual([]);
  });

  test("mutation: dropping the import arm leaves the direct test unread", () => {
    const changed = "scripts/lint-issue-cost-gate.ts";
    const tests = [
      read("scripts/test/lint-issue-cost-gate.test.ts", 'import { x } from "../unrelated.ts";\n'),
    ];
    expect(scopeTestsToDiff({ changed: [changed], tests }).mode).toBe("full");
  });
});
