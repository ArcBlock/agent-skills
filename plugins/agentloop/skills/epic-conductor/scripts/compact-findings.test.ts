import { describe, expect, test } from "bun:test";
import {
  type CurrentSnippet,
  compactFindings,
  fixerBrief,
  type RawFinding,
  validateCompactOutput,
} from "./compact-findings.ts";

// Accept-path table from ArcBlock/arc#4316's acceptance criteria (A1-A3), reject-path (R1-R3).

describe("compactFindings — A1 accept: still-valid", () => {
  test("finding's code is still there, description still matches → status=still-valid, path:line preserved", () => {
    const findings: RawFinding[] = [
      {
        id: "c1",
        severity: "P1",
        path: "src/auth.ts",
        line: 42,
        description: "token compared with !== instead of constant-time compare",
        expectedSnippet: "if (token !== expected)",
      },
    ];
    const current: CurrentSnippet[] = [
      {
        path: "src/auth.ts",
        line: 42,
        snippet: "  if (token !== expected) {\n    throw new Error();",
      },
    ];

    const result = compactFindings(findings, current);

    expect(result).toEqual([
      {
        id: "c1",
        severity: "P1",
        path: "src/auth.ts",
        line: 42,
        description: "token compared with !== instead of constant-time compare",
        expectedSnippet: "if (token !== expected)",
        status: "still-valid",
      },
    ]);
  });
});

describe("compactFindings — A2 accept: stale (already fixed)", () => {
  test("file changed, described defect no longer present → excluded from fixerBrief, marked stale", () => {
    const findings: RawFinding[] = [
      {
        id: "c2",
        severity: "P2",
        path: "src/auth.ts",
        line: 42,
        description: "token compared with !== instead of constant-time compare",
        expectedSnippet: "if (token !== expected)",
      },
    ];
    const current: CurrentSnippet[] = [
      { path: "src/auth.ts", line: 42, snippet: "  if (timingSafeEqual(token, expected)) {" },
    ];

    const compacted = compactFindings(findings, current);

    expect(compacted[0]?.status).toBe("stale");
    expect(fixerBrief(compacted)).toEqual([]);
  });
});

describe("compactFindings — A3 accept: duplicate", () => {
  test("two findings at the same path:line → only one survives, the other is duplicate-of", () => {
    const findings: RawFinding[] = [
      {
        id: "codex-1",
        severity: "P1",
        path: "src/db.ts",
        line: 10,
        description: "SQL injection via string concat",
      },
      {
        id: "cursor-1",
        severity: "High",
        path: "src/db.ts",
        line: 10,
        description: "unescaped user input in query",
      },
    ];
    const current: CurrentSnippet[] = [{ path: "src/db.ts", line: 10, snippet: undefined }];

    const compacted = compactFindings(findings, current);

    expect(compacted).toHaveLength(2);
    expect(compacted[0]?.status).toBe("still-valid");
    expect(compacted[1]?.status).toBe("duplicate");
    expect(compacted[1]?.duplicateOf).toBe("codex-1");
    expect(fixerBrief(compacted)).toHaveLength(1);
  });

  test("same review thread restated at a different path:line collapses too (threadId wins over location)", () => {
    const findings: RawFinding[] = [
      {
        id: "t1",
        severity: "High",
        path: "src/db.ts",
        line: 10,
        description: "original wording",
        threadId: "thread-9",
      },
      {
        id: "t2",
        severity: "High",
        path: "src/db.ts",
        line: 12,
        description: "reworded after conductor moved the line",
        threadId: "thread-9",
      },
    ];
    const current: CurrentSnippet[] = [
      { path: "src/db.ts", line: 10, snippet: undefined },
      { path: "src/db.ts", line: 12, snippet: undefined },
    ];

    const compacted = compactFindings(findings, current);

    expect(compacted[1]?.status).toBe("duplicate");
    expect(compacted[1]?.duplicateOf).toBe("t1");
  });
});

describe("validateCompactOutput — R1 reject: summary-only fake compact", () => {
  test("a count-only object is rejected, not treated as a usable list", () => {
    const fakeCompact = { findings: 3, stale: 2 };
    expect(validateCompactOutput(fakeCompact)).toBe(false);
  });

  test("an array missing required per-finding fields is rejected", () => {
    const partial = [{ id: "c1", severity: "P1" }]; // missing path/line/description/status
    expect(validateCompactOutput(partial)).toBe(false);
  });

  test("a real compacted array validates", () => {
    const findings: RawFinding[] = [
      { id: "c1", severity: "P1", path: "a.ts", line: 1, description: "x" },
    ];
    const compacted = compactFindings(findings, [{ path: "a.ts", line: 1, snippet: undefined }]);
    expect(validateCompactOutput(compacted)).toBe(true);
  });
});

describe("compactFindings — R2 reject: must never drop a still-valid finding", () => {
  test("no expectedSnippet to compare against → uncertain, kept as still-valid (never silently dropped)", () => {
    const findings: RawFinding[] = [
      {
        id: "p1",
        severity: "P1",
        path: "src/gate.ts",
        line: 5,
        description: "auth bypass on empty token",
      },
    ];
    // No expectedSnippet on the finding, and the current snippet is unreadable — both
    // signals are missing, so the module cannot tell fixed from not-fixed.
    const current: CurrentSnippet[] = [{ path: "src/gate.ts", line: 5, snippet: undefined }];

    const compacted = compactFindings(findings, current);

    expect(compacted[0]?.status).toBe("still-valid");
    expect(fixerBrief(compacted)).toHaveLength(1);
  });

  test("current file unreadable (deleted/renamed) but expectedSnippet was given → still kept, not auto-marked stale", () => {
    const findings: RawFinding[] = [
      {
        id: "p2",
        severity: "P1",
        path: "src/moved.ts",
        line: 5,
        description: "still a real defect",
        expectedSnippet: "dangerouslySetInnerHTML",
      },
    ];
    const current: CurrentSnippet[] = [{ path: "src/moved.ts", line: 5, snippet: undefined }];

    const compacted = compactFindings(findings, current);

    expect(compacted[0]?.status).toBe("still-valid");
  });
});

describe("fixerBrief", () => {
  test("only still-valid findings reach the fixer; stale and duplicate are excluded", () => {
    const findings: RawFinding[] = [
      {
        id: "a",
        severity: "P1",
        path: "x.ts",
        line: 1,
        description: "valid",
        expectedSnippet: "foo()",
      },
      {
        id: "b",
        severity: "P2",
        path: "y.ts",
        line: 2,
        description: "fixed already",
        expectedSnippet: "bar()",
      },
      { id: "c", severity: "Medium", path: "y.ts", line: 2, description: "same spot as b" },
    ];
    const current: CurrentSnippet[] = [
      { path: "x.ts", line: 1, snippet: "  foo();" },
      { path: "y.ts", line: 2, snippet: "  baz();" },
    ];

    const compacted = compactFindings(findings, current);
    const brief = fixerBrief(compacted);

    expect(brief.map((f) => f.id)).toEqual(["a"]);
  });
});
