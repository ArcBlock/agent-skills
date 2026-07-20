#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import { analyze, parse } from "./fleet-report.ts";

const rec = (o: Record<string, unknown>) =>
  JSON.stringify({
    ts: "2026-07-20T10:00:00.000Z",
    runner: "r",
    slug: "ArcBlock/arc",
    skill: "issue-sweep",
    outcome: "ok",
    exitCode: 0,
    ms: 600_000,
    detail: "d",
    ...o,
  });

describe("parse", () => {
  it("skips a torn trailing line instead of throwing", () => {
    // Concurrent appends mean the reader can see a half-written last line. Losing that one
    // record is correct; refusing to report at all because of it is not.
    const rows = parse(`${rec({})}\n{"ts":"2026-07-20T10:0`);
    expect(rows).toHaveLength(1);
  });

  it("ignores blank lines and non-record JSON", () => {
    expect(parse(`\n${rec({})}\n\n[1,2]\n"str"\n`)).toHaveLength(1);
  });
});

describe("analyze", () => {
  it("separates rounds that RAN from rounds that were skipped", () => {
    const s = analyze(
      parse(
        [
          rec({}),
          rec({ outcome: "failed", exitCode: 1 }),
          rec({ outcome: "skipped-cadence", ms: 0 }),
          rec({ outcome: "skipped-locked", ms: 0 }),
        ].join("\n"),
      ),
      null,
    );
    expect(s.total).toBe(4);
    expect(s.executed).toBe(2); // a skip is recorded, but it is not a run
    expect(s.ok).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.skippedCadence).toBe(1);
    expect(s.skippedLocked).toBe(1);
  });

  // The reason the report states coverage instead of just a rate: a window of mostly-old
  // records would otherwise show "0 PRs" and read as a fleet doing nothing, when in fact
  // those rounds simply predate the field.
  it("reports field coverage, so a partial window cannot masquerade as a finding", () => {
    const s = analyze(
      parse([rec({}), rec({ produced: { noop: true }, residualProcs: 0, runId: "x" })].join("\n")),
      null,
    );
    expect(s.executed).toBe(2);
    expect(s.coverage.produced).toBe(1);
    expect(s.coverage.residual).toBe(1); // residualProcs:0 COUNTS as measured
    expect(s.coverage.runId).toBe(1);
  });

  it("counts a measured-zero residual as measured, not as missing", () => {
    const s = analyze(parse(rec({ residualProcs: 0 })), null);
    expect(s.coverage.residual).toBe(1);
    expect(s.residualRounds).toBe(0);
  });

  it("sums real output and keeps noop distinct from 'produced nothing'", () => {
    const s = analyze(
      parse(
        [
          rec({ produced: { prsOpened: [1, 2], issuesClosed: [9], commentsPosted: 3 } }),
          rec({ produced: { noop: true } }),
          rec({ produced: { noop: false } }), // worked, opened no PR — NOT a noop
        ].join("\n"),
      ),
      null,
    );
    expect(s.prsOpened).toBe(2);
    expect(s.issuesClosed).toBe(1);
    expect(s.commentsPosted).toBe(3);
    expect(s.noop).toBe(1);
    expect(s.withProduct).toBe(3);
  });

  it("computes duration stats per repo × skill from executed rounds only", () => {
    const s = analyze(
      parse(
        [
          rec({ ms: 60_000 }),
          rec({ ms: 180_000 }),
          rec({ ms: 300_000 }),
          rec({ outcome: "skipped-cadence", ms: 0 }), // must not drag the median to 0
        ].join("\n"),
      ),
      null,
    );
    const t = s.byTarget[0];
    expect(t.runs).toBe(3);
    expect(t.medianMin).toBe(3);
    expect(t.maxMin).toBe(5);
    expect(t.skipped).toBe(1);
  });

  it("honours the day window", () => {
    const old = new Date(Date.now() - 5 * 86400_000).toISOString();
    const rows = parse([rec({ ts: old }), rec({ ts: new Date().toISOString() })].join("\n"));
    expect(analyze(rows, null).total).toBe(2);
    expect(analyze(rows, 1).total).toBe(1);
  });

  it("survives an empty file rather than dividing by zero", () => {
    const s = analyze(parse(""), null);
    expect(s.total).toBe(0);
    expect(s.byTarget).toEqual([]);
    expect(Number.isNaN(s.residualMax)).toBe(false);
  });
});
