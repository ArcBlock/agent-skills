#!/usr/bin/env bun
/**
 * Tests for the repo-agnostic report kernel. Identity is INJECTED (the engine no
 * longer shells out to a repo's agent-identity script); the arc-side provenance
 * header + its agent-identity.sh integration are tested in
 * `.claude/verify/identity.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type CheckResult, renderReport } from "./report.ts";

const results: CheckResult[] = [
  {
    check: "build",
    title: "Build",
    pass: true,
    blocking: true,
    durationMs: 1234,
    stats: {},
  },
];

describe("renderReport", () => {
  test("injected identity string opens the report", () => {
    const identity = "> 🤖 AI Agent Verification @ host · runner:r · skills@abc";
    const md = renderReport(results, { scenario: "pre-pr", sha: "deadbeef123", identity });
    expect(md.split("\n")[0]).toBe(identity);
  });

  test("no identity → report opens directly with the heading (no blank leader)", () => {
    const md = renderReport(results, { scenario: "pre-pr" });
    expect(md.startsWith("## Verification Report")).toBe(true);
  });

  test("body content is intact: heading, table, overall", () => {
    const md = renderReport(results, { scenario: "pre-pr", base: "abcdef1234", sha: "deadbeef" });
    expect(md).toContain("## Verification Report");
    expect(md).toContain("| Build | ✅ PASS |");
    expect(md).toContain("**Overall: ✅ PASS**");
  });

  test("a blocking failure flips Overall to FAIL and renders a Failures block", () => {
    const failing: CheckResult[] = [
      {
        check: "types",
        title: "Types",
        pass: false,
        blocking: true,
        durationMs: 10,
        stats: { errors: 3 },
        rawTail: "TS2345: bad",
      },
    ];
    const md = renderReport(failing, { scenario: "pre-pr" });
    expect(md).toContain("**Overall: ❌ FAIL**");
    expect(md).toContain("### Failures");
    expect(md).toContain("TS2345: bad");
  });

  test("a warn-only (non-blocking) failure keeps Overall PASS", () => {
    const warn: CheckResult[] = [
      {
        check: "format",
        title: "Format",
        pass: false,
        blocking: false,
        durationMs: 5,
        stats: {},
      },
    ];
    const md = renderReport(warn, { scenario: "pre-pr" });
    expect(md).toContain("**Overall: ✅ PASS**");
    expect(md).toContain("⚠️ WARN");
  });
});
