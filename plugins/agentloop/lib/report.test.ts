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
  passed,
  redactPublicEvidencePaths,
  renderReport,
  run,
  stripJobControlNoise,
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

  test("over budget and a test failure are different colours (#7106)", () => {
    const md = renderReport(
      [
        {
          check: "rootTests",
          title: "Tests (root)",
          pass: false,
          blocking: true,
          durationMs: 600_000,
          stats: { timedOut: "true", failed: 0 },
          failure: { class: "BUDGET", reason: "budget-exhausted" },
          rawTail: "Timed out after 600000ms (budget 600000ms).",
        },
        {
          check: "tests",
          title: "Tests (affected)",
          pass: false,
          blocking: true,
          durationMs: 10,
          stats: { failed: 2 },
          failure: { class: "CODE", reason: "observed-test-failures" },
          rawTail: "(fail) boom",
        },
      ],
      { scenario: "main-catchnet" },
    );
    expect(md).toContain("| Tests (root) | ⏱️ BUDGET |");
    expect(md).toContain("| Tests (affected) | ❌ FAIL |");
    expect(md).toContain("**Overall: ❌ FAIL**");
  });

  test("a run that only exceeded its budget is not painted as tests failed", () => {
    const md = renderReport(
      [
        {
          check: "rootTests",
          title: "Tests (root)",
          pass: false,
          blocking: true,
          durationMs: 1,
          stats: { timedOut: "true" },
          failure: { class: "BUDGET", reason: "budget-exhausted" },
        },
      ],
      { scenario: "main-catchnet", derived: "TIMEOUT" },
    );
    expect(md).toContain("| Tests (root) | ⏱️ BUDGET |");
    expect(md).toContain("**Overall: ⏱️ BUDGET**");
    expect(md).not.toContain("❌ FAIL");
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

  // ⏱ wall clock. `total` is the SUM of per-check durations and always has been;
  // `wallMs` is the gate process's real elapsed time, which additionally covers
  // broker queueing and git work. Both are shown because the GAP between them is
  // the diagnostic — a round that waited four minutes for another runner's lease
  // is otherwise indistinguishable from one that started instantly.
  test("omits the wall clock when it was not measured (byte-identical to before)", () => {
    expect(renderReport(results, { scenario: "pre-pr" })).toContain("(1.2s total)");
  });

  test("shows the wall clock beside the checks total when measured", () => {
    const md = renderReport(results, { scenario: "pre-pr", wallMs: 5000 });
    expect(md).toContain("(1.2s total · 5.0s wall)");
    expect(md).not.toContain("NaN");
  });

  test("a wall clock far above the checks total still renders both (the queueing case)", () => {
    expect(renderReport(results, { scenario: "pre-pr", wallMs: 254000 })).toContain(
      "(1.2s total · 254.0s wall)",
    );
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

  test("a logPath is a pointer, not an inlined body (#5223)", () => {
    const withPath: CheckResult[] = [
      {
        check: "build",
        title: "Build",
        pass: true,
        blocking: true,
        durationMs: 1000,
        stats: {},
        rawFull: "a".repeat(10_000),
        logPath: ".verify/deadbeef.build.log",
      },
    ];
    const md = renderReport(withPath, { scenario: "pre-pr", sha: "deadbeef123" });
    expect(md).toContain("### Full Logs");
    expect(md).toContain("`.verify/deadbeef.build.log`");
    expect(md).not.toContain("<details>");
    expect(md).not.toContain("a".repeat(100));
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

/**
 * #6420 / taxonomy R2 — `reusable: false` is a publish-time flag. It must not
 * recolour a check, flip `passed()`, or widen/narrow `deriveResult`. A green
 * that cannot travel is still a green; a red that cannot travel is still a red.
 */
describe("#6420 R2 — reusable:false does not recolour passed() / deriveResult", () => {
  test("a blocking green with reusable:false is still PASS", () => {
    const r: CheckResult = {
      check: "pr-body",
      title: "PR body",
      pass: true,
      blocking: true,
      reusable: false,
    };
    expect(passed([r])).toBe(true);
    expect(deriveResult([r])).toBe("PASS");
  });

  test("a blocking red with reusable:false is still FAIL — withhold is not a skip", () => {
    const r: CheckResult = {
      check: "pr-body",
      title: "PR body",
      pass: false,
      blocking: true,
      reusable: false,
    };
    expect(passed([r])).toBe(false);
    expect(deriveResult([r])).toBe("FAIL");
  });

  test("a non-blocking miss with reusable:false keeps Overall PASS (the aside timeout shape)", () => {
    const r: CheckResult = {
      check: "pr-body",
      title: "PR body",
      pass: false,
      blocking: false,
      reusable: false,
    };
    expect(passed([r])).toBe(true);
    expect(deriveResult([r])).toBe("PASS");
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

  test("stripJobControlNoise drops the #6090 job-status leak and keeps the payload", () => {
    // Exact shape observed under saturation: bash narrates the background
    // job after the command's own stdout. Callers assert exact payload.
    const leaked = "hi\n[1]   Done                    { echo hi; }\n";
    expect(stripJobControlNoise(leaked).trim()).toBe("hi");
    expect(stripJobControlNoise("[1]+ Done  { echo payload; }\npayload\n").trim()).toBe("payload");
    expect(stripJobControlNoise("plain\n")).toBe("plain\n");
  });

  test("the no-output watchdog reaps only its own silent group and preserves its output", () => {
    const start = Date.now();
    const r = run("printf started; sleep 60", {}, undefined, 5000, { noOutputTimeoutMs: 250 });
    const elapsed = Date.now() - start;
    expect(r.code).toBe(124);
    expect(r.timedOut).toBe(true);
    expect(r.noOutputTimedOut).toBe(true);
    expect(r.out).toContain("started");
    expect(r.out).toContain("[agentloop: no-output watchdog]");
    // The implementation uses a deliberately coarse one-second polling clock,
    // but it must still stop far before the normal five-second total timeout.
    expect(elapsed).toBeLessThan(3000);
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
    // The #6090 leak was `[1]   Done` (no +/-). `[1]+` alone is a false accept.
    const r = run("echo payload; exit 5", {}, undefined, 5000);
    expect(r.code).toBe(5);
    expect(r.out.trim()).toBe("payload");
    expect(r.out).not.toMatch(/\[\d+\][+-]?\s+(Done|Exit|Running|Stopped|Terminated|Killed)\b/);
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

/**
 * #6406: `run()` used to treat ANY captured output containing the no-output
 * watchdog sentinel as a timeout (`code=124`, `timedOut:true`), even when this
 * call never installed the wrapper. Documenting the sentinel — or a check that
 * prints a PR body that quotes it — then painted a green command red. The
 * identity of "I killed it" must be unforgeable by the observed content.
 *
 * Both arms are load-bearing. "payload cites sentinel → not a timeout" is the
 * bug. "silent group really dies → timeout" (the test above) is the accept
 * path; a detector that never fires satisfies the first arm while going
 * blind to a real stall.
 */
describe("run() no-output sentinel is not content-addressable (#6406)", () => {
  const SENTINEL = "[agentloop: no-output watchdog]";

  test("弄坏: documenting the sentinel in captured output must not rewrite a green exit to 124", () => {
    // Exact issue repro: same printf, exit 0, ~1ms, previously code 124.
    const clean = run('printf %s "hello"');
    const cited = run(`printf %s "hello ${SENTINEL} world"`);
    expect(clean.code).toBe(0);
    expect(clean.timedOut).toBeUndefined();
    expect(cited.code).toBe(0);
    expect(cited.timedOut).toBeUndefined();
    expect(cited.noOutputTimedOut).toBeUndefined();
    expect(cited.out).toContain(SENTINEL);
  });

  test("弄坏: a real failure whose output cites the sentinel stays FAIL, not TIMEOUT", () => {
    const r = run(`printf %s "failed: ${SENTINEL}"; exit 1`);
    expect(r.code).toBe(1);
    expect(r.timedOut).toBeUndefined();
    expect(r.noOutputTimedOut).toBeUndefined();
  });

  test("弄坏: timeoutMs wrapper without noOutputTimeoutMs still ignores a cited sentinel", () => {
    const r = run(`printf %s "hello ${SENTINEL} world"`, {}, undefined, 5000);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.noOutputTimedOut).toBeUndefined();
  });

  test("弄坏: last-line citation with the watchdog installed is still not a kill", () => {
    // Last-line anchoring is not enough: a command that prints the sentinel
    // as its last line while noOutputTimeoutMs is set must still be green.
    // Only an out-of-band stall flag (the wrapper wrote it) is the kill.
    const r = run(`printf '%s\\n' payload '${SENTINEL}'`, {}, undefined, 5000, {
      noOutputTimeoutMs: 30_000,
    });
    expect(r.code).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.noOutputTimedOut).toBeUndefined();
    expect(r.out).toContain("payload");
    expect(r.out).toContain(SENTINEL);
  });

  test("accept: a command with no sentinel is not a timeout", () => {
    const r = run("printf %s hello");
    expect(r.code).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r.noOutputTimedOut).toBeUndefined();
    expect(r.out).toBe("hello");
  });

  test("accept: source does not classify timeout by scanning captured output for the sentinel", () => {
    const src = readFileSync(join(import.meta.dir, "report.ts"), "utf8");
    expect(src).not.toMatch(/out\.includes\(\s*NO_OUTPUT_TIMEOUT_MARKER\s*\)/);
    expect(src).toMatch(/\.stalled/);
  });

  test("accept: stall flag and output log are cleaned up on both paths", () => {
    const leftovers = () =>
      readdirSync(tmpdir()).filter((f) => f.startsWith(`agentloop-output-${process.pid}-`));
    run("true", {}, undefined, 5000, { noOutputTimeoutMs: 30_000 });
    run("printf started; sleep 60", {}, undefined, 5000, { noOutputTimeoutMs: 250 });
    expect(leftovers()).toEqual([]);
  });
});

/**
 * #6090 instance 2: wrapInOwnGroup leaked bash job-status into captured
 * stdout, so `echo hi` was not `"hi"` in the packed plugin suite and was
 * `"hi"` solo. Saturation only made bash emit the leak; once it is in the
 * stream the colour split is deterministic. `run()` must strip it.
 *
 * Isolating this file, or deleting the original `toBe("hi")` assertion,
 * would hide the bug. The leak is injected here so packed and solo agree
 * without waiting for load1 ≥ 2.5× ncpu.
 */
describe("run() job-control leak (#6090 — batch and solo must share a colour)", () => {
  // Exact captured stream from the issue (report.test.ts:412, load1 248/14).
  const ISSUE_LEAK = "hi\n[1]   Done                    { echo hi; }\n";

  test("reject: the leaked stream is a different colour from echo hi", () => {
    expect(ISSUE_LEAK.trim()).not.toBe("hi");
    expect(ISSUE_LEAK).toMatch(/\[\d+\]\s+Done\b/);
  });

  test("restore: run() returns only the command payload when the leak is in the captured stream", () => {
    // Mutation: drop stripJobControlNoise from run() → this is red.
    const r = run(
      "printf 'hi\\n[1]   Done                    { echo hi; }\\n'",
      {},
      undefined,
      5000,
    );
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("hi");
    expect(r.timedOut).toBeUndefined();
    expect(r.out).not.toMatch(/\[\d+\][+-]?\s+Done\b/);
  });

  test("accept: a fast command with no leak is still exactly hi (the original assertion)", () => {
    const r = run("echo hi", {}, undefined, 5000);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("hi");
    expect(r.timedOut).toBeUndefined();
  });

  test("accept: a line that is not a bash job-status is kept", () => {
    const r = run("printf 'hi\\n[1] not a job status\\n'", {}, undefined, 5000);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("hi\n[1] not a job status");
  });

  test("accept-path ratchet: #5067 arm 1 still lives in scenario.test.ts", () => {
    const src = readFileSync(join(import.meta.dir, "scenario.test.ts"), "utf8");
    expect(src).toContain("arm 1 (accept): a full scenario PASS is still a gate token");
    expect(src).toContain("arm 1 survives a partial run afterwards");
    expect(src).toContain("partial verification is not a gate token (#5067)");
  });
});

/**
 * #6401: `📍 Produced at` / Reused evidence notices carry absolute local paths
 * (OS username + checkout layout) into the markdown the engine later posts as a
 * public PR comment. Local stdout/disk keep the full strings (renderReport is
 * verbatim); only the public-comment form is redacted.
 *
 * Fixture is the aside#1514 landing text from the issue body.
 */
describe("redactPublicEvidencePaths (#6401 — no home dir on a public comment)", () => {
  const TREE = "/Users/robmao/.arc-workers/trees/aside-1464";
  const HOST = "/Users/robmao/work/arcblock/aside/.git";
  const RECORD =
    "/Users/robmao/work/arcblock/aside/.git/agentloop/verification/f4a7c31abc/pre-pr/4341d87def/by-location/aside-1464-8a33c01eac9f";
  const SHA = "f4a7c31abcdeadbeefcafef00d";

  const origin = `> 📍 **Produced at** — tree \`${TREE}\` · host clone \`${HOST}\` · scenario \`pre-pr\` · base \`${SHA}\``;
  const reused =
    `> ℹ **Reused evidence** — produced by an earlier run at a sibling location in this git common-dir store, under the ` +
    "same declared capabilities, for this same commit — not by the invocation that delivered it.\n" +
    `> Produced at tree \`${TREE}\` · host clone \`${HOST}\`.\n` +
    `> Shared record: \`${RECORD}\`\n` +
    `> Force a real re-run here: \`rm -rf .verify/${SHA}.* '${RECORD}'\`\n\n`;

  const leak = (s: string) => s.includes("/Users/robmao") || s.includes("C:\\Users\\robmao");

  test("reject: the aside#1514 Produced at line still names /Users/<os-user> before redaction", () => {
    expect(origin).toContain("/Users/robmao");
    expect(origin).toContain(TREE);
    expect(origin).toContain(HOST);
  });

  test("accept: Produced at keeps tree basename + <repo>/.git and drops the home dir", () => {
    const out = redactPublicEvidencePaths(origin);
    expect(leak(out)).toBe(false);
    expect(out).toContain("tree `aside-1464`");
    expect(out).toContain("host clone `<repo>/.git`");
    expect(out).toContain("scenario `pre-pr`");
    expect(out).toContain(`base \`${SHA}\``);
    expect(out).toContain("📍 **Produced at**");
  });

  test("accept: Reused evidence keeps the by-location slot and a pasteable relative rm", () => {
    const out = redactPublicEvidencePaths(reused);
    expect(leak(out)).toBe(false);
    expect(out).toContain("**Reused evidence**");
    expect(out).toContain("tree `aside-1464`");
    expect(out).toContain("host clone `<repo>/.git`");
    expect(out).toContain("by-location/aside-1464-8a33c01eac9f");
    expect(out).toContain("<git-common-dir>/agentloop/verification/");
    expect(out).toContain(`rm -rf .verify/${SHA}.*`);
    expect(out).not.toContain(RECORD);
  });

  test("accept: Linux /home/<user> and Windows C:\\Users\\<user> redact the same way", () => {
    const linux = "> tree `/home/alice/src/arc` · host clone `/home/alice/src/arc/.git`";
    const win =
      "> tree `C:\\Users\\robmao\\.arc-workers\\trees\\aside-1464` · host clone `C:\\Users\\robmao\\work\\arc\\.git`";
    const linuxOut = redactPublicEvidencePaths(linux);
    const winOut = redactPublicEvidencePaths(win);
    expect(linuxOut).not.toContain("/home/alice");
    expect(linuxOut).toContain("tree `arc`");
    expect(linuxOut).toContain("host clone `<repo>/.git`");
    expect(winOut).not.toContain("C:\\Users\\robmao");
    expect(winOut).not.toContain("C:/Users/robmao");
    expect(winOut).toContain("tree `aside-1464`");
    expect(winOut).toContain("host clone `<repo>/.git`");
  });

  test("accept: host clone `unknown` and non-path backticks are left alone", () => {
    const line =
      "> 📍 **Produced at** — tree `/tmp/tree` · host clone `unknown` · scenario `pre-pr` · base `abc`";
    const out = redactPublicEvidencePaths(line);
    expect(out).toContain("host clone `unknown`");
    expect(out).toContain("scenario `pre-pr`");
    expect(out).toContain("tree `tree`");
    expect(out).not.toContain("`/tmp/tree`");
  });

  test("accept: a Failures tail that cites a source file under $HOME is not rewritten", () => {
    const report =
      origin +
      "\n\n### Failures\n\n```\nTS2345: /Users/robmao/work/arcblock/aside/src/foo.ts(1,1)\n```\n";
    const out = redactPublicEvidencePaths(report);
    expect(out).toContain("/Users/robmao/work/arcblock/aside/src/foo.ts");
    expect(out).toContain("tree `aside-1464`");
    expect(out).not.toContain(`tree \`${TREE}\``);
  });

  test("accept: redaction is idempotent", () => {
    const once = redactPublicEvidencePaths(`${origin}\n${reused}`);
    expect(redactPublicEvidencePaths(once)).toBe(once);
  });

  test("accept: shQuote apostrophe path in the force-rerun command still redacts", () => {
    const record = "/tmp/o'brien/agentloop/verification/abc/by-location/tree-deadbeefcaf";
    const quoted = `'${record.replace(/'/g, `'\\''`)}'`;
    const line = `> Force a real re-run here: \`rm -rf .verify/${SHA}.* ${quoted}\``;
    const out = redactPublicEvidencePaths(line);
    expect(out).not.toContain("/tmp/o'brien");
    expect(out).toContain("by-location/tree-deadbeefcaf");
    expect(out).toContain(`rm -rf .verify/${SHA}.*`);
  });

  test("renderReport still embeds the caller-supplied origin verbatim (local stdout keeps full paths)", () => {
    const md = renderReport(results, { scenario: "pre-pr", origin });
    expect(md).toContain(TREE);
    expect(md).toContain("/Users/robmao");
  });
});

/**
 * #6197 — Overall is the adjudicated verdict, not a re-sum of the table.
 * Attribution (#5593 / #5877) leaves the foreign-flaky row red on purpose;
 * `passed(results)` is then false while `derived` (and `.result`) is PASS.
 * Recolouring the header from the rows makes the same report contradict itself.
 */
describe("renderReport Overall follows derived, not the row sum (#6197)", () => {
  const foreignFlaky: CheckResult[] = [
    {
      check: "build",
      title: "Build",
      pass: true,
      blocking: true,
      durationMs: 1200,
      stats: {},
    },
    {
      check: "tests",
      title: "Tests (root: scripts)",
      pass: false,
      blocking: true,
      durationMs: 186_300,
      stats: { passed: 3766, failed: 1 },
      rawTail:
        "ACCEPT: identity-snapshotted group members are escalated when their leader exits on TERM",
    },
  ];

  const overall = (md: string): string => {
    const m = md.match(/\*\*Overall: ([^*]+)\*\*/);
    expect(m).not.toBeNull();
    return m?.[1] ?? "";
  };

  test("弄坏: derived PASS + one foreign-flaky red must not render Overall FAIL", () => {
    // Mutation: `const ok = passed(results)` inside renderReport → this is red.
    expect(passed(foreignFlaky)).toBe(false);
    expect(deriveResult(foreignFlaky)).toBe("FAIL");
    const md = renderReport(foreignFlaky, { scenario: "pre-pr", derived: "PASS" });
    expect(overall(md)).toBe("✅ PASS");
    expect(md).not.toContain("**Overall: ❌ FAIL**");
  });

  test("恢复: same fixture keeps the foreign row red — attribution is not a wash", () => {
    const md = renderReport(foreignFlaky, { scenario: "pre-pr", derived: "PASS" });
    expect(md).toMatch(/\| Tests \(root: scripts\) \| ❌ FAIL \|/);
    expect(md).toContain("passed=3766 failed=1");
    expect(md).toContain("### Failures");
    expect(md).toContain(
      "ACCEPT: identity-snapshotted group members are escalated when their leader exits on TERM",
    );
  });

  test("ACCEPT: a real in-diff FAIL still renders Overall FAIL when derived is FAIL", () => {
    const md = renderReport(foreignFlaky, { scenario: "pre-pr", derived: "FAIL" });
    expect(overall(md)).toBe("❌ FAIL");
    expect(md).toMatch(/\| Tests \(root: scripts\) \| ❌ FAIL \|/);
  });

  test("ACCEPT: omitting derived on a real FAIL is still Overall FAIL (legacy unit-test shape)", () => {
    const supplied = renderReport(foreignFlaky, { scenario: "pre-pr", derived: "FAIL" });
    const omitted = renderReport(foreignFlaky, { scenario: "pre-pr" });
    expect(overall(omitted)).toBe("❌ FAIL");
    expect(omitted).toBe(supplied);
  });

  test("TIMEOUT derived and an omitted derived agree, and that colour is not a test failure (#7106)", () => {
    const timeoutRow: CheckResult = {
      check: "tests",
      title: "Tests (affected)",
      pass: false,
      blocking: true,
      durationMs: 1000,
      stats: { timedOut: "true", failed: 0 },
    };
    expect(deriveResult([timeoutRow])).toBe("TIMEOUT");
    const supplied = renderReport([timeoutRow], { scenario: "pre-pr", derived: "TIMEOUT" });
    const omitted = renderReport([timeoutRow], { scenario: "pre-pr" });
    expect(supplied).toBe(omitted);
    expect(overall(supplied)).toBe("⏱️ BUDGET");
    expect(supplied).toContain("| Tests (affected) | ⏱️ BUDGET |");
    expect(supplied).not.toContain("❌ FAIL");
  });

  test("误拦: green rows + derived PASS (PARTIAL's underlying derived) stay Overall PASS", () => {
    const supplied = renderReport(results, { scenario: "pre-pr", derived: "PASS" });
    const omitted = renderReport(results, { scenario: "pre-pr" });
    expect(supplied).toBe(omitted);
    expect(overall(supplied)).toBe("✅ PASS");
    expect(supplied).not.toMatch(/\*\*Overall:[^*]*PARTIAL/);
  });

  test("wiring: renderReport Overall reads opts.derived, not a bare passed(results)", () => {
    const src = readFileSync(join(import.meta.dir, "report.ts"), "utf8");
    const start = src.indexOf("export function renderReport");
    const end = src.indexOf("export function trimFullLogsSection");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/opts\.derived/);
    expect(fn).not.toMatch(/const ok = passed\(results\);/);
  });
});
