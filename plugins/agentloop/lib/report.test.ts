#!/usr/bin/env bun
/**
 * Tests for the repo-agnostic report kernel. Identity is INJECTED (the engine no
 * longer shells out to a repo's agent-identity script); the arc-side provenance
 * header + its agent-identity.sh integration are tested in
 * `.claude/verify/identity.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckResult,
  deriveResult,
  renderReport,
  run,
  sumNum,
  trimFullLogsSection,
} from "./report.ts";

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

describe("renderReport totality (#2734 — a check's missing optional field must not kill the report)", () => {
  // Regression: check-publish-drift's skip path returned neither `stats` nor
  // `durationMs`, so `Object.entries(undefined)` threw inside the renderer and
  // the ENTIRE report was lost — including the N checks that really ran. The
  // report kernel is the shared collection point for every check (incl. ones a
  // consuming repo writes), so it must degrade, never throw.
  const skipOnly = [
    {
      check: "publishDrift",
      title: "Plugin publish drift",
      pass: true,
      blocking: false,
      skipped: "gh not available — cannot read the mirror",
    },
  ] as CheckResult[];

  test("a skip carrying only the required fields renders instead of throwing", () => {
    expect(() => renderReport(skipOnly, { scenario: "pre-pr" })).not.toThrow();
    const md = renderReport(skipOnly, { scenario: "pre-pr" });
    expect(md).toContain("⊘ SKIP");
    expect(md).toContain("**Overall: ✅ PASS**");
  });

  test("missing durationMs renders 0.0s, never NaNs — in the row and in the total", () => {
    const md = renderReport(skipOnly, { scenario: "pre-pr" });
    expect(md).not.toContain("NaN");
    expect(md).toContain("| 0.0s |");
    expect(md).toContain("(0.0s total)");
  });

  test("a skip reason surfaces in the row so ⊘ SKIP always says why", () => {
    const md = renderReport(skipOnly, { scenario: "pre-pr" });
    expect(md).toContain("gh not available — cannot read the mirror");
  });

  test("a sibling check's real results survive alongside a field-less skip", () => {
    const md = renderReport([...skipOnly, ...results], { scenario: "pre-pr" });
    expect(md).toContain("| Build | ✅ PASS |");
    expect(md).toContain("(1.2s total)");
  });

  test("skipped: true with no stats and no reason still renders a bare cell", () => {
    const bare = [
      { check: "native", title: "Native", pass: true, blocking: false, skipped: true },
    ] as CheckResult[];
    expect(() => renderReport(bare, { scenario: "pre-pr" })).not.toThrow();
    expect(renderReport(bare, { scenario: "pre-pr" })).toContain("| — |");
  });

  // Found by adversarially fuzzing the renderer while fixing #2734: `null` is not
  // `undefined`, so `?? {}` alone would not have covered a JSON-round-tripped result.
  test("stats/durationMs explicitly null degrade like absent ones", () => {
    const nulled = [
      { check: "a", title: "A", pass: true, blocking: false, skipped: true, stats: null },
    ] as unknown as CheckResult[];
    expect(() => renderReport(nulled, { scenario: "pre-pr" })).not.toThrow();
    expect(renderReport(nulled, { scenario: "pre-pr" })).not.toContain("NaN");
  });

  test("a NaN durationMs renders 0.0s, not NaNs", () => {
    const nan = [
      { check: "b", title: "B", pass: true, blocking: true, durationMs: NaN, stats: {} },
    ] as CheckResult[];
    expect(renderReport(nan, { scenario: "pre-pr" })).not.toContain("NaN");
  });

  test("an empty skip reason still reads as SKIP, never as PASS", () => {
    // `skipped: ""` is falsy — plain truthiness silently mislabels the row.
    const blank = [
      { check: "c", title: "C", pass: true, blocking: false, skipped: "" },
    ] as CheckResult[];
    expect(renderReport(blank, { scenario: "pre-pr" })).toContain("⊘ SKIP");
  });

  test("a reason containing | is escaped so it cannot forge a table column", () => {
    const piped = [
      { check: "d", title: "D", pass: true, blocking: false, skipped: "cmd a | b failed" },
    ] as CheckResult[];
    const row = renderReport(piped, { scenario: "pre-pr" })
      .split("\n")
      .find((l) => l.startsWith("| D |")) as string;
    expect(row).toContain("cmd a \\| b failed");
    expect(row.split(" | ")).toHaveLength(4);
  });

  test("a runaway reason is capped so one check cannot eat the comment budget", () => {
    const huge = [
      { check: "e", title: "E", pass: true, blocking: false, skipped: "x".repeat(50_000) },
    ] as CheckResult[];
    expect(renderReport(huge, { scenario: "pre-pr" }).length).toBeLessThan(1_000);
  });
});

describe("trimFullLogsSection (#1922 — comment-filter work-budget retry)", () => {
  test("strips the Full Logs appendix, keeping the summary table and a note", () => {
    const results: CheckResult[] = [
      {
        check: "build",
        title: "Build",
        pass: true,
        blocking: true,
        durationMs: 1000,
        stats: {},
        rawFull: "a".repeat(100),
      },
    ];
    const md = renderReport(results, { scenario: "pre-pr", sha: "deadbeef123" });
    expect(md).toContain("### Full Logs");
    expect(md).toContain("<details>");

    const trimmed = trimFullLogsSection(md);
    expect(trimmed).toContain("## Verification Report");
    expect(trimmed).toContain("**Overall: ✅ PASS**");
    expect(trimmed).toContain("### Full Logs");
    expect(trimmed).not.toContain("<details>");
    expect(trimmed).toContain("Omitted");
    // The trailing generated-by line survives the trim (plugin's de-arc-ified text).
    expect(trimmed).toContain("Generated by the `agentloop` verification engine");
  });

  test("names the cache file when the sha is known — the pointer is the only route left", () => {
    const results: CheckResult[] = [
      {
        check: "build",
        title: "Build",
        pass: false,
        blocking: true,
        durationMs: 1000,
        stats: {},
        rawFull: "a".repeat(100),
      },
    ];
    const md = renderReport(results, { scenario: "pre-merge", sha: "deadbeef123" });
    expect(trimFullLogsSection(md, "deadbeef123")).toContain("`.verify/deadbeef123.md`");
    // Without a sha it degrades to the placeholder rather than inventing a path.
    expect(trimFullLogsSection(md)).toContain("`.verify/<sha>.md`");
  });

  test("is a no-op when the report has no Full Logs section", () => {
    const results: CheckResult[] = [
      { check: "build", title: "Build", pass: true, blocking: true, durationMs: 1000, stats: {} },
    ];
    const md = renderReport(results, { scenario: "pre-pr" });
    expect(md).not.toContain("### Full Logs");
    expect(trimFullLogsSection(md)).toBe(md);
  });
});

// Ported from main's verification/scripts/report.test.ts on merge (#1922/#2054): the run() subprocess
// timeout landed in report.ts via auto-merge; its test lives here now that the engine is in the plugin.
describe("sumNum (arc#2080 — check-tests must total per-task summaries, not grab the first)", () => {
  test("sums every match instead of returning only the first", () => {
    // Real shape: turbo runs test tasks concurrently and interleaves each
    // package's own bun-test summary line into one combined stdout.
    const out = [
      "@aigne/afs-aup:test:  12 pass",
      "@aigne/afs-aup:test:  0 fail",
      "@aigne/aos:test:  1147 pass",
      "@aigne/aos:test:  0 fail",
      "@aigne/afs-integration-tests:test:  1353 pass",
      "@aigne/afs-integration-tests:test:  0 fail",
    ].join("\n");
    expect(sumNum(/(\d+) pass(?=\s*(?:\/|$|\n))/gim, out)).toBe(12 + 1147 + 1353);
    expect(sumNum(/(\d+) fail(?=\s*(?:\/|$|\n))/gim, out)).toBe(0);
  });

  test("handles the combined 'N pass / N fail / N skip' single-line summary shape too", () => {
    const out = "@aigne/afs-ui:test: 7283 pass / 0 fail / 15 skip";
    expect(sumNum(/(\d+) pass(?=\s*(?:\/|$|\n))/gim, out)).toBe(7283);
    expect(sumNum(/(\d+) fail(?=\s*(?:\/|$|\n))/gim, out)).toBe(0);
  });

  test("does not false-positive on digit+'fail'/'pass' phrases inside test NAMES (arc#2080, real captured cases)", () => {
    // Real lines pulled from an actual affected-tests run: "P3 fail-closed" and
    // "T5.1 fail-loud" are describe-block labels, not bun-test summary lines —
    // a naive `\d+ fail` match previously reported these as real failures
    // (passed=1147 / failed=3 was actually a fully-green run, code===0).
    const out = [
      "@aigne/arc-worker:test: (pass) exec /.actions/write {path:/user/...} → REJECTED (P3 fail-closed, write does not leak) [1.2ms]",
      "@aigne/arc-worker:test: (pass) deriveInstallerDid (T5.1 fail-loud) > derives a normalized did [0.5ms]",
      "@aigne/arc-worker:test: (pass) deriveInstallerDid (T5.1 fail-loud) > is deterministic [0.3ms]",
      "@aigne/arc-worker:test: (pass) deriveInstallerDid (T5.1 fail-loud) > throws on empty input [0.4ms]",
      "@aigne/arc-worker:test:  4 pass",
      "@aigne/arc-worker:test:  0 fail",
    ].join("\n");
    expect(sumNum(/(\d+) fail(?=\s*(?:\/|$|\n))/gim, out)).toBe(0);
    expect(sumNum(/(\d+) pass(?=\s*(?:\/|$|\n))/gim, out)).toBe(4);
  });

  test("returns undefined when there are no matches", () => {
    expect(sumNum(/(\d+) pass(?=\s*(?:\/|$|\n))/gim, "no test output here")).toBeUndefined();
  });
});

describe("deriveResult (#3170 — a watchdog timeout with 0 real failures must read as TIMEOUT, not FAIL)", () => {
  const check = (over: Partial<CheckResult>): CheckResult => ({
    check: "tests",
    title: "Tests (affected)",
    pass: false,
    blocking: true,
    ...over,
  });

  test("every check passing → PASS", () => {
    expect(deriveResult([check({ pass: true }), check({ pass: true, check: "build" })])).toBe(
      "PASS",
    );
  });

  test("a real test failure (failed > 0, no timedOut) → FAIL", () => {
    expect(deriveResult([check({ stats: { failed: 3 } })])).toBe("FAIL");
  });

  test("a watchdog kill with 0 observed failures and no `failed` stat at all → TIMEOUT", () => {
    expect(deriveResult([check({ stats: { timedOut: "true" } })])).toBe("TIMEOUT");
  });

  test("a watchdog kill with an explicit failed:0 → TIMEOUT", () => {
    expect(deriveResult([check({ stats: { timedOut: "true", failed: 0 } })])).toBe("TIMEOUT");
  });

  test("real failure always dominates: one TIMEOUT-shaped check alongside one real failure → FAIL", () => {
    const timeoutCheck = check({ check: "testsHeavy", stats: { timedOut: "true" } });
    const realFailure = check({ check: "build", stats: { failed: 1 } });
    expect(deriveResult([timeoutCheck, realFailure])).toBe("FAIL");
  });

  test("timedOut:true but failed > 0 on the SAME check is a real failure, not a TIMEOUT", () => {
    expect(deriveResult([check({ stats: { timedOut: "true", failed: 2 } })])).toBe("FAIL");
  });

  test("a skipped check never counts as a failure feeding TIMEOUT/FAIL", () => {
    expect(
      deriveResult([
        check({ pass: true }),
        check({ check: "native", skipped: "no Xcode here", pass: false }),
      ]),
    ).toBe("PASS");
  });

  test("a non-blocking (warn-only) failure never flips PASS", () => {
    expect(deriveResult([check({ pass: false, blocking: false })])).toBe("PASS");
  });
});

describe("run() color env (#4591 — FORCE_COLOR must not leak into gh JSON.parse)", () => {
  test("unsets FORCE_COLOR even when the caller passed it in env", () => {
    const r = run('printf %s "${FORCE_COLOR-unset}"', { FORCE_COLOR: "1" });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("unset");
  });

  test("sets GH_NO_COLOR=1 so gh does not color --jq JSON", () => {
    const r = run('printf %s "${GH_NO_COLOR-}"');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("1");
  });

  test("strips ANSI CSI from captured stdout so JSON.parse can consume gh --jq output", () => {
    const r = run("printf '\\033[1;38m{\"ok\":true}\\033[m'");
    expect(r.out).toBe('{"ok":true}');
    expect(JSON.parse(r.out)).toEqual({ ok: true });
  });
});

describe("run() timeoutMs (#2054 — a stuck subprocess must not hang pre-pr.ts forever)", () => {
  test("kills a hung command at timeoutMs and reports code 124 + timedOut:true", () => {
    const start = Date.now();
    const r = run("sleep 999", {}, undefined, 300);
    const elapsed = Date.now() - start;
    expect(r.code).toBe(124);
    expect(r.timedOut).toBe(true);
    // Must return promptly after the timeout, not after the full 999s sleep.
    expect(elapsed).toBeLessThan(10_000);
  });

  test("without timeoutMs, behavior is unchanged — real exit code, no timedOut flag", () => {
    const r = run("exit 3");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBeUndefined();
  });

  test("a fast command under a generous timeoutMs completes normally", () => {
    const r = run("echo hi", {}, undefined, 5000);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("hi");
    expect(r.timedOut).toBeUndefined();
  });

  test("the timeout kills GRANDCHILDREN too — no orphaned process tree survives", () => {
    // The regression: spawnSync's kill only reaches the `bash -c` it started, so a
    // timed-out `turbo run test` left the whole test tree (and any daemon it had
    // spawned) running under init, once per timed-out run.
    const pidFile = join(tmpdir(), `agentloop-orphan-test-${process.pid}`);
    rmSync(pidFile, { force: true });
    const r = run(`bash -c 'echo $$ > ${pidFile}; sleep 60' & wait`, {}, undefined, 1500);
    expect(r.timedOut).toBe(true);

    const grandchild = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    rmSync(pidFile, { force: true });
    expect(Number.isFinite(grandchild)).toBe(true);

    // signal 0 = existence probe. Poll rather than probe once: SIGKILL is
    // delivered asynchronously and the corpse stays visible until init reaps it,
    // so a single immediate probe reports "alive" on a loaded machine even when
    // the kill landed. What is being asserted is that it goes away at all — an
    // un-reaped tree stays up for its full 60s sleep.
    const gone = () => {
      try {
        process.kill(grandchild, 0);
        return false;
      } catch {
        return true;
      }
    };
    const deadline = Date.now() + 5000;
    while (!gone() && Date.now() < deadline) Bun.sleepSync(50);
    const alive = !gone();
    if (alive) process.kill(grandchild, "SIGKILL"); // don't leak out of the test either
    expect(alive).toBe(false);
  });

  test("the process-group wrapper stays invisible: no job-control lines in the output", () => {
    // Job control has to be ON to get a fresh process group, but while it is on
    // bash narrates `[1]+ Done  { … }` into the stream every check parses.
    const r = run("echo payload; exit 5", {}, undefined, 5000);
    expect(r.code).toBe(5);
    expect(r.out.trim()).toBe("payload");
    expect(r.out).not.toContain("[1]+");
  });

  test("stdin still reaches the command under the wrapper", () => {
    const r = run("cat", {}, "piped\n", 5000);
    expect(r.out.trim()).toBe("piped");
  });

  test("the pgid handoff file is cleaned up on both paths", () => {
    const leftovers = () =>
      readdirSync(tmpdir()).filter((f) => f.startsWith(`agentloop-pgid-${process.pid}-`));
    run("true", {}, undefined, 5000);
    run("sleep 999", {}, undefined, 300);
    expect(leftovers()).toEqual([]);
  });
});
