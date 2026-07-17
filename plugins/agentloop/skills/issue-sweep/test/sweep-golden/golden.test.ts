#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
/**
 * L1 golden-scenario evals for issue-sweep Step 2 filter logic.
 *
 * Covers 6 historical cases (all fixtures in ./fixtures/) and the pure TS
 * predicates in lib.ts — hermetic, no LLM, no network.
 *
 * References:
 *   ArcBlock/arc#1207 — L1 golden-scenario eval harness acceptance criteria
 *   ArcBlock/arc#1211 — L0/L1/L2/L3 framework discussion
 *   .claude/plugins/agentloop/skills/issue-sweep/SKILL.md Step 2
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Comment,
  extractSweepTraces,
  type Issue,
  isAiAgentComment,
  isNonTerminalAiComment,
  isTerminalAiComment,
  shouldProcess,
} from "./lib.ts";

// ---------------------------------------------------------------------------
// Fixture schema (mirrors the JSON shape)
// ---------------------------------------------------------------------------
interface Fixture {
  _comment?: string;
  issue: {
    number: number;
    labels?: string[];
    body?: string;
    comments?: Array<{ body: string; created_at?: string }>;
  };
  expected: {
    step2_keep: boolean;
    reason: string;
  };
  forbidden_actions: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixtureToIssue(f: Fixture): Issue {
  return {
    number: f.issue.number,
    labels: f.issue.labels,
    body: f.issue.body,
    comments: (f.issue.comments ?? []) as Comment[],
  };
}

async function loadFixtures(): Promise<Array<{ name: string; fixture: Fixture }>> {
  const dir = join(import.meta.dir, "fixtures");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  return Promise.all(
    files.map(async (name) => ({
      name,
      fixture: JSON.parse(await readFile(join(dir, name), "utf8")) as Fixture,
    })),
  );
}

// ---------------------------------------------------------------------------
// isAiAgentComment
// ---------------------------------------------------------------------------
describe("isAiAgentComment", () => {
  it("detects the canonical `> 🤖 AI Agent` prefix", () => {
    expect(isAiAgentComment("> 🤖 AI Agent — issue-sweep 2026-07-01\nsome body")).toBe(true);
  });

  it("detects `@ vm` header + `> 🤖 AI Agent` pattern (CLAUDE.md hostname convention)", () => {
    expect(isAiAgentComment("@ vm\n\n> 🤖 AI Agent — pr-sweep 2026-07-01\nbody text")).toBe(true);
  });

  it("detects hostname with local machine format", () => {
    expect(isAiAgentComment("@ MacBook-Pro.local\n\n> 🤖 AI Agent — issue-review\ntext")).toBe(
      true,
    );
  });

  it("returns false for plain human comment", () => {
    expect(isAiAgentComment("LGTM on the proposed fix.")).toBe(false);
  });

  it("returns false for human comment that mentions 🤖 in body (not as prefix)", () => {
    expect(isAiAgentComment("I asked the 🤖 AI Agent to fix this")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isAiAgentComment("")).toBe(false);
  });

  it("handles leading whitespace before `> 🤖 AI Agent`", () => {
    expect(isAiAgentComment("  > 🤖 AI Agent — sweep\nbody")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isNonTerminalAiComment
// ---------------------------------------------------------------------------
describe("isNonTerminalAiComment", () => {
  it("detects '不在本轮范围 / 留开放' pattern (#533 archetype)", () => {
    expect(
      isNonTerminalAiComment(
        "> 🤖 AI Agent — issue-sweep 2026-05-20\n🟠 不在本轮范围 / 留开放：需要架构决策。",
      ),
    ).toBe(true);
  });

  it("detects 'candidate-queued' english alias", () => {
    expect(isNonTerminalAiComment("> 🤖 AI Agent\ncandidate-queued for next run")).toBe(true);
  });

  it("detects 'queued' pattern", () => {
    expect(isNonTerminalAiComment("> 🤖 AI Agent\nThis is queued for the next sweep.")).toBe(true);
  });

  it("detects 'in-progress' continuation marker", () => {
    expect(
      isNonTerminalAiComment(
        "> 🤖 AI Agent — issue-sweep 2026-06-01\nin-progress: phase 2 pending",
      ),
    ).toBe(true);
  });

  it("detects '排队' pattern", () => {
    expect(isNonTerminalAiComment("> 🤖 AI Agent\n🟡 排队中，下轮处理。")).toBe(true);
  });

  it("detects '本轮未做' pattern", () => {
    expect(isNonTerminalAiComment("> 🤖 AI Agent\n本轮未做，稍后继续。")).toBe(true);
  });

  it("returns false for terminal PR-linked comment", () => {
    expect(isNonTerminalAiComment("> 🤖 AI Agent\n已完成，见 PR #538。")).toBe(false);
  });

  it("returns false for needs-human-confirm verdict", () => {
    expect(isNonTerminalAiComment("> 🤖 AI Agent\n安全敏感，needs-human-confirm。")).toBe(false);
  });

  it("returns false for a terminal 'needs-design' verdict", () => {
    expect(isNonTerminalAiComment("> 🤖 AI Agent\nneeds-design: A-vs-B decision required")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// isTerminalAiComment
// ---------------------------------------------------------------------------
describe("isTerminalAiComment", () => {
  it("terminal when comment links a PR", () => {
    expect(isTerminalAiComment("> 🤖 AI Agent\n修复已提交，见 PR #540。")).toBe(true);
  });

  it("terminal when comment says needs-human-confirm", () => {
    expect(isTerminalAiComment("> 🤖 AI Agent\nneeds-human-confirm: 需要 A-vs-B 决策。")).toBe(
      true,
    );
  });

  it("NOT terminal when comment says 留开放 (non-terminal wins over terminal check)", () => {
    expect(isTerminalAiComment("> 🤖 AI Agent\n🟠 不在本轮范围 / 留开放，PR 暂无计划。")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// shouldProcess — inline unit cases
// ---------------------------------------------------------------------------
describe("shouldProcess — inline", () => {
  it("zero-comment issue with plain body → keep (unprocessed)", () => {
    const issue: Issue = {
      number: 1,
      comments: [],
      body: "Please fix the flaky login test.",
    };
    expect(shouldProcess(issue)).toBe(true);
  });

  it("zero-comment issue whose body IS an agent comment → skip", () => {
    // This edge case: spin-off body starts with > 🤖 but that's a spin-off author quoting
    // — body of an issue is never actually an agent comment in practice,
    // but we test the predicate logic directly
    const issue: Issue = {
      number: 2,
      comments: [],
      body: "> 🤖 AI Agent — auto-generated spin-off\nDelete sample.test.ts",
    };
    // Body itself IS an AI agent comment → treated as "already processed" → skip
    expect(shouldProcess(issue)).toBe(false);
  });

  it("last comment is human → keep", () => {
    const issue: Issue = {
      number: 3,
      comments: [
        { body: "> 🤖 AI Agent — sweep\nAudit note." },
        { body: "I've confirmed the bug in staging. LGTM." },
      ],
    };
    expect(shouldProcess(issue)).toBe(true);
  });

  it("last comment is terminal AI → skip", () => {
    const issue: Issue = {
      number: 4,
      comments: [
        { body: "Confirmed." },
        { body: "> 🤖 AI Agent — sweep\nFix delivered in PR #99. Closing." },
      ],
    };
    expect(shouldProcess(issue)).toBe(false);
  });

  it("last comment is non-terminal AI (deferred) → keep and re-process", () => {
    const issue: Issue = {
      number: 5,
      comments: [
        { body: "Good idea." },
        { body: "> 🤖 AI Agent — sweep 2026-05-20\n🟠 不在本轮范围 / 留开放。" },
      ],
    };
    expect(shouldProcess(issue)).toBe(true);
  });

  it("single AI-audit-only comment → skip (terminal audit, no human reply)", () => {
    const issue: Issue = {
      number: 6,
      comments: [{ body: "> 🤖 AI Agent — doc-audit\nDocument is drifted. needs-human-confirm." }],
    };
    expect(shouldProcess(issue)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven golden scenarios
// ---------------------------------------------------------------------------
describe("shouldProcess — golden fixtures", async () => {
  const fixtures = await loadFixtures();

  for (const { name, fixture } of fixtures) {
    it(`fixture ${name}: step2_keep=${fixture.expected.step2_keep} — ${fixture.expected.reason}`, () => {
      const issue = fixtureToIssue(fixture);
      const result = shouldProcess(issue);
      expect(result).toBe(fixture.expected.step2_keep);
    });
  }
});

// ---------------------------------------------------------------------------
// Forbidden action assertions
// ---------------------------------------------------------------------------
describe("forbidden_actions", async () => {
  const fixtures = await loadFixtures();

  it("every fixture has a forbidden_actions array (schema guard)", () => {
    for (const { name, fixture } of fixtures) {
      expect(
        Array.isArray(fixture.forbidden_actions),
        `fixture ${name}: forbidden_actions must be an array`,
      ).toBe(true);
    }
  });

  it("fixture 1025 must forbid pr-merge (never auto-merge a PR)", () => {
    const f = fixtures.find(({ name }) => name.startsWith("1025-"));
    expect(f, "1025 fixture not found").toBeDefined();
    const forbidden = f!.fixture.forbidden_actions;
    // Both the gh CLI command AND the MCP tool name must be forbidden
    expect(forbidden.some((a) => a.includes("pr merge") || a.includes("merge_pull_request"))).toBe(
      true,
    );
  });

  it("fixture 535 must forbid git rm of the file (false-premise trap)", () => {
    const f = fixtures.find(({ name }) => name.startsWith("535-"));
    expect(f, "535 fixture not found").toBeDefined();
    const forbidden = f!.fixture.forbidden_actions;
    expect(forbidden.some((a) => a.includes("git rm") && a.includes("sample.test.ts"))).toBe(true);
  });

  it("fixtures with step2_keep=false have no forbidden_actions (not reached)", () => {
    for (const { name, fixture } of fixtures) {
      if (!fixture.expected.step2_keep) {
        expect(
          fixture.forbidden_actions.length,
          `fixture ${name}: step2_keep=false should have no forbidden_actions`,
        ).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// extractSweepTraces
// ---------------------------------------------------------------------------
describe("extractSweepTraces", () => {
  it("extracts a well-formed trace from a comment body", () => {
    const body =
      '> 🤖 AI Agent\n<!-- sweep-trace: {"ver":1,"issue":533,"gate":"step2","val":"non-terminal","run":"2026-07-10T12:00:00Z"} -->';
    const traces = extractSweepTraces(body);
    expect(traces.length).toBe(1);
    expect(traces[0]).toMatchObject({ ver: 1, issue: 533, gate: "step2", val: "non-terminal" });
  });

  it("extracts multiple traces from a single body", () => {
    const body = [
      '<!-- sweep-trace: {"ver":1,"gate":"step1","val":"keep","run":"2026-07-10T12:00:00Z"} -->',
      '<!-- sweep-trace: {"ver":1,"gate":"step2","val":"human-reply","run":"2026-07-10T12:00:01Z"} -->',
    ].join("\n");
    const traces = extractSweepTraces(body);
    expect(traces.length).toBe(2);
    expect(traces.map((t) => t.gate)).toEqual(["step1", "step2"]);
  });

  it("returns an empty array when no trace is present", () => {
    expect(extractSweepTraces("> 🤖 AI Agent\nNo trace here.")).toEqual([]);
  });

  it("skips malformed JSON gracefully", () => {
    const body = "<!-- sweep-trace: {not valid json} -->";
    expect(extractSweepTraces(body)).toEqual([]);
  });

  it("handles extra whitespace around the JSON", () => {
    const body = '<!--  sweep-trace:  {"ver":1,"gate":"test","val":"ok","run":"r"}  -->';
    const traces = extractSweepTraces(body);
    expect(traces.length).toBe(1);
  });
});
