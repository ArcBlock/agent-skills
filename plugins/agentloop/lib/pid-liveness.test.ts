#!/usr/bin/env bun
/**
 * #5815 — a lease owner's liveness used to be pure pid existence:
 *
 *     try { process.kill(pid, 0); return true } catch { return false }
 *
 * Two distinct defects lived in those lines, failing in OPPOSITE directions:
 *
 *  1. a RECYCLED pid makes a dead owner look alive. Fail-closed for the lease
 *     (it is never reclaimed), but the former hygiene check NAMES the pid for a
 *     human to act on, so it names an innocent process.
 *  2. `process.kill(pid, 0)` throws EPERM when the process EXISTS but may not
 *     be signalled. The bare `catch` folded EPERM into ESRCH, so a LIVE owner
 *     was judged dead — the lease gets taken while its owner is still working.
 *
 * Three arms must be DISJOINT, i.e. each mutation must red its own arm only:
 *
 *  | mutation                                    | arm that reds            |
 *  |---------------------------------------------|--------------------------|
 *  | fold the start-time comparison away         | REJECT (pid-recycled)    |
 *  | treat every probe result as dead            | ACCEPT (running)         |
 *  | re-merge EPERM into "dead"                  | EPERM (denied)           |
 *
 * The ACCEPT arm is the one that matters most: judged the other way, every
 * check steals every lease, which is far worse than today's wedge.
 */
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOCK_AGREEMENT_TOLERANCE_MS,
  clockInstrumentsAgree,
  evaluateOwnerLiveness,
  type LivenessDeps,
  type OwnerRecord,
  ownerIdentity,
  PS_TIMEOUT_MS,
  parseLstart,
  parseProcStartTimeMs,
  probeSignal,
  RECYCLE_TOLERANCE_MS,
  readClkTck,
  readProcessStartTime,
  readProcessStartTimeMs,
  resetClkTckCache,
  type StartTimeSource,
} from "./pid-liveness.ts";

/** A pid that certainly does not exist: the kernel refuses pids this large. */
const GONE_PID = 4194304;

/**
 * A REAL signal-refusing process on this host, found rather than assumed.
 *
 * pid 1 would do on most hosts, but it is also the container check's own pid and
 * therefore a legitimate owner here, so leaning on it would conflate two arms.
 * This sweeps the live process table for a root-owned daemon with an ordinary
 * pid instead, which works on macOS and Linux alike; running as root there is
 * none, and the injected-errno arm below carries the case instead.
 */
function findEpermPid(): { pid?: number; scanned: number } {
  const ps = spawnSync("ps", ["-Ao", "pid="], { encoding: "utf8" });
  if (ps.status !== 0) return { scanned: 0 };
  let scanned = 0;
  for (const line of ps.stdout.split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) continue;
    scanned++;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return { pid, scanned };
    }
  }
  return { scanned };
}

const EPERM_SCAN = findEpermPid();
const EPERM_PID = EPERM_SCAN.pid;

/**
 * When this host offers no signal-refusing process, the EPERM arms cannot run
 * on a real one — and 「the scan found none」 must not look like 「the scan never
 * ran」. This asserts the instrument actually swept the process table, so a
 * broken scan reds instead of quietly turning three arms into no-ops. The
 * injected-errno twins below carry the case regardless.
 */
function assertEpermScanWasReal(): void {
  expect(
    EPERM_SCAN.scanned,
    "the EPERM scan must have examined a real process table",
  ).toBeGreaterThan(1);
}

describe("readProcessStartTimeMs — positive control: the instrument can SEE", () => {
  /**
   * A start-time reader that returns `undefined` for everything satisfies every
   * "no recycling detected" assertion. Prove it measures a real process before
   * trusting any verdict built on it (度量正控).
   */
  test("ACCEPT: our own pid yields a plausible start time", () => {
    const started = readProcessStartTimeMs(process.pid);
    expect(started).toBeDefined();
    const now = Date.now();
    // Started in the past, and this test process is minutes old at most.
    expect(started as number).toBeLessThanOrEqual(now + RECYCLE_TOLERANCE_MS);
    expect(started as number).toBeGreaterThan(now - 6 * 60 * 60 * 1000);
  });

  /**
   * The sharpest positive control available: a child spawned RIGHT NOW must
   * measure as having started right now. A start time that is hours off — the
   * `ps` timezone trap, where `ps` renders the host zone and the runtime parses
   * as UTC — passes every "is it a number" assertion and every recycled/alive
   * assertion built on a same-process anchor, and only shows up here.
   */
  test("ACCEPT: a just-spawned child measures as having started just now", async () => {
    const before = Date.now();
    const child = spawn("sleep", ["30"]);
    await new Promise((r) => setTimeout(r, 150));
    const started = readProcessStartTimeMs(child.pid as number);
    const after = Date.now();
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(started).toBeDefined();
    // ±2 s of slack for lstart's one-second resolution, and nothing more.
    expect(started as number).toBeGreaterThan(before - RECYCLE_TOLERANCE_MS);
    expect(started as number).toBeLessThan(after + RECYCLE_TOLERANCE_MS);
  });

  /**
   * The ` GMT` pin, detected DELIBERATELY rather than by luck.
   *
   * Under `bun test` the runtime clock is already UTC, so the plain assertion
   * below cannot see the pin: dropping ` GMT` reds nothing in this file. The
   * mutation only surfaces two files away, in `scenario.test.ts`, which spawns
   * a real `bun` subprocess that inherits the HOST zone. Relying on that is
   * relying on an accident of where the arms happen to live, so this arm flips
   * the runtime zone itself and pins the invariant in the file that owns it.
   */
  test("ACCEPT: lstart is read as UTC regardless of the host zone", () => {
    expect(parseLstart("Wed Sep  2 09:52:17 2026")).toBe(Date.parse("2026-09-02T09:52:17Z"));
    expect(parseLstart("  ")).toBeUndefined();
    expect(parseLstart("not a date")).toBeUndefined();

    const original = process.env.TZ;
    try {
      for (const zone of ["Asia/Shanghai", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = zone;
        // Positive control for the arm itself: prove the runtime actually
        // honoured the flip, otherwise this loop asserts nothing three times.
        if (zone !== "UTC")
          expect(
            Date.parse("Wed Sep  2 09:52:17 2026"),
            `TZ=${zone} must move an unpinned parse`,
          ).not.toBe(Date.parse("2026-09-02T09:52:17Z"));
        expect(parseLstart("Wed Sep  2 09:52:17 2026"), `TZ=${zone}`).toBe(
          Date.parse("2026-09-02T09:52:17Z"),
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  /**
   * `process.kill(pid, 0)` structurally could not hang. A subprocess can, and
   * this one now sits on the check's critical path, so a wedged `ps` must be
   * bounded rather than able to stop the check (review round 2).
   *
   * Platform-independent by construction: the assertion is that the call
   * RETURNS in bounded time. What it returns differs — no `/proc` means it
   * could not measure, `/proc` means the fallback rescued it — and both sides
   * are asserted so neither half is a branch that never runs.
   */
  test("a wedged ps is bounded by a timeout, on both platforms", () => {
    const binDir = mkdtempSync(join(tmpdir(), "agentloop-5815-hangps-"));
    writeFileSync(join(binDir, "ps"), "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    const started = Date.now();
    try {
      process.env.PATH = `${binDir}:${originalPath}`;
      const measured = readProcessStartTimeMs(process.pid);
      const elapsed = Date.now() - started;
      // The property under test: bounded, not hung.
      expect(elapsed).toBeLessThan(PS_TIMEOUT_MS + 5000);
      // And it actually waited for the timeout rather than failing instantly,
      // which is what proves the shim was really in front of the real `ps`.
      expect(elapsed).toBeGreaterThan(PS_TIMEOUT_MS - 1000);
      if (existsSync("/proc/stat")) expect(measured).toBeDefined();
      else expect(measured).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 20000);

  test("REJECT: a pid that does not exist yields no start time (it DISCRIMINATES)", () => {
    expect(readProcessStartTimeMs(GONE_PID)).toBeUndefined();
  });

  test("ACCEPT: a signal-refusing process still yields a start time (EPERM ≠ invisible)", () => {
    if (EPERM_PID === undefined) {
      assertEpermScanWasReal();
      return;
    }
    expect(readProcessStartTimeMs(EPERM_PID)).toBeDefined();
  });

  const PROC_STAT_FIXTURE =
    "4242 (my (weird) proc) S 1 4242 4242 0 -1 4194560 1234 0 0 0 12 3 0 0 20 0 4 0 " +
    "360000 123 456 18446744073709551615 1 2 3 4 5 6 7 8 9\n";
  const PROC_BOOT_MS = 1_700_000_000_000;

  test("ACCEPT: the Linux /proc backend parses a real-shaped stat line", () => {
    // Synthetic /proc fixture — this host is macOS; the arm exists so the Linux
    // path is not shipped unexecuted. comm contains spaces AND parentheses.
    // CLK_TCK is an argument, not a guessed constant: 360000 ticks @ 100 Hz = 3600 s.
    expect(parseProcStartTimeMs(PROC_STAT_FIXTURE, PROC_BOOT_MS, 100)).toBe(
      PROC_BOOT_MS + 3_600_000,
    );
  });

  test("REJECT: a malformed /proc stat line yields no start time", () => {
    expect(parseProcStartTimeMs("garbage without parens", 1_700_000_000_000, 100)).toBeUndefined();
    expect(parseProcStartTimeMs("4242 (proc) S 1 2 3", 1_700_000_000_000, 100)).toBeUndefined();
  });
});

describe("probeSignal — ESRCH, EPERM and alive are three colours, not two", () => {
  test("ACCEPT: our own pid is signalable", () => {
    expect(probeSignal(process.pid)).toBe("signalable");
  });

  test("REJECT: a nonexistent pid is `gone`", () => {
    expect(probeSignal(GONE_PID)).toBe("gone");
  });

  test("EPERM: a signal-refusing pid is `denied`, NOT `gone`", () => {
    if (EPERM_PID === undefined) {
      assertEpermScanWasReal();
      return;
    }
    expect(probeSignal(EPERM_PID)).toBe("denied");
  });
});

describe("evaluateOwnerLiveness", () => {
  /** The dominant arm: a genuinely alive owner must stay alive. */
  test("ACCEPT: a real live process recorded by ownerIdentity is judged alive", () => {
    const owner = ownerIdentity({ scenario: "unit" }) as OwnerRecord;
    expect(owner.pid).toBe(process.pid);
    const verdict = evaluateOwnerLiveness(owner);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("running");
    expect(verdict.startTimeChecked).toBe(true);
  });

  test("ACCEPT: a real spawned child, alive, is judged alive; after it exits it is not", async () => {
    const child = spawn("sleep", ["30"]);
    await new Promise((r) => setTimeout(r, 150));
    const pid = child.pid as number;
    const live = readProcessStartTime(pid);
    const owner: OwnerRecord = {
      pid,
      processStartedAt: live?.ms,
      startTimeSource: live?.source,
      startedAt: new Date().toISOString(),
    };
    expect(evaluateOwnerLiveness(owner).alive).toBe(true);

    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    // The pid is now free; while it is unassigned the verdict must be "gone".
    const after = evaluateOwnerLiveness(owner);
    expect(after.alive).toBe(false);
    expect(after.reason).toBe("no-such-process");
  });

  test("REJECT: pid exists but started AFTER the recorded process start ⇒ pid-recycled", () => {
    // A real, live pid whose recorded owner start time belongs to a long-dead
    // predecessor — exactly the measured 58249 → Chrome-helper case.
    const owner: OwnerRecord = {
      pid: process.pid,
      processStartedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      startTimeSource: readProcessStartTime(process.pid)?.source,
      startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const verdict = evaluateOwnerLiveness(owner);
    expect(verdict.alive).toBe(false);
    // The REASON must name pid recycling, not a generic "not alive": the human
    // reading the former hygiene check decides whether to act on this pid.
    expect(verdict.reason).toBe("pid-recycled");
    expect(verdict.detail ?? "").toContain("recycled");
    expect(verdict.detail ?? "").toContain(String(process.pid));
  });

  test("REJECT: legacy record with only the lease startedAt still catches recycling", () => {
    // Route 2 fallback — owner.json written by a version that recorded no
    // process start time. A process that started after the lease was created
    // cannot be the process that created it.
    const owner: OwnerRecord = {
      pid: process.pid,
      startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const verdict = evaluateOwnerLiveness(owner);
    expect(verdict.alive).toBe(false);
    expect(verdict.reason).toBe("pid-recycled");
  });

  test("ACCEPT: a start time EARLIER than the anchor is not recycling evidence", () => {
    // Clock skew / a coarser measurement source must never mass-reclaim leases.
    // Only "started later than the anchor" is proof the pid changed hands.
    const owner: OwnerRecord = {
      pid: process.pid,
      processStartedAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      startTimeSource: readProcessStartTime(process.pid)?.source,
      startedAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const verdict = evaluateOwnerLiveness(owner);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("running");
  });

  test("ACCEPT: sub-tolerance jitter between two measurements is not recycling", () => {
    const live = readProcessStartTime(process.pid);
    const owner: OwnerRecord = {
      pid: process.pid,
      processStartedAt: (live?.ms as number) - (RECYCLE_TOLERANCE_MS - 1),
      startTimeSource: live?.source,
      startedAt: new Date().toISOString(),
    };
    expect(evaluateOwnerLiveness(owner).alive).toBe(true);
  });

  test("EPERM: exists but not ours to signal ⇒ alive, with its own reason", () => {
    if (EPERM_PID === undefined) {
      assertEpermScanWasReal();
      return;
    }
    const live = readProcessStartTime(EPERM_PID);
    const owner: OwnerRecord = {
      pid: EPERM_PID,
      processStartedAt: live?.ms,
      startTimeSource: live?.source,
      startedAt: new Date().toISOString(),
    };
    const verdict = evaluateOwnerLiveness(owner);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("signal-permission-denied");
    // Distinct from BOTH neighbours — this is the same-colour defect itself.
    expect(verdict.reason).not.toBe("no-such-process");
    expect(verdict.reason).not.toBe("running");
  });

  test("EPERM (injected errno): holds even on a host with no unsignalable pid", () => {
    const deps: LivenessDeps = {
      probe: () => "denied",
      startTimeMs: () => Date.now() - 60_000,
      // This record's only anchor is route 2, so the calibration applies; pin it
      // true so this arm measures the EPERM branch and nothing else.
      clocksAgree: () => true,
    };
    const owner: OwnerRecord = { pid: 4242, startedAt: new Date().toISOString() };
    const verdict = evaluateOwnerLiveness(owner, deps);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("signal-permission-denied");
  });

  test("EPERM + recycled: a denied pid that started after the anchor is still recycled", () => {
    const deps: LivenessDeps = {
      probe: () => "denied",
      startTime: () => ({ ms: Date.now(), source: "ps" }),
    };
    const owner: OwnerRecord = {
      pid: 4242,
      processStartedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      startTimeSource: "ps",
    };
    expect(evaluateOwnerLiveness(owner, deps).reason).toBe("pid-recycled");
  });

  /**
   * MEDIUM 1 (review round 1). `Date.parse` is not a validator: measured across
   * plausible degraded `lstart` renderings, most of them PARSE, and a `dd/mm`
   * rendering is read as `mm/dd` whenever the day is ≤ 12 — an over-read start
   * time, which is the UNSAFE direction (a false `pid-recycled`). The stated
   * fail-closed path only ever covered `ps` exiting non-zero.
   */
  test("REJECT: a degraded lstart rendering is refused, not guessed at", () => {
    for (const bad of [
      "Sep  2 09:52", // no year — Date.parse happily returns year 2001
      "02/09/2026 09:52:17", // dd/mm — read as mm/dd whenever day <= 12
      "2026-09-02 09:52:17", // ISO-ish, not lstart
      "mer.  2 sept. 2026 09:52:17", // a non-C locale slipped through
      "Wed Sep 2 09:52:17", // year missing
      "", // ps produced nothing
    ]) {
      expect(parseLstart(bad), `must refuse ${JSON.stringify(bad)}`).toBeUndefined();
    }
    // ACCEPT — the anchor is not "refuse everything": the real shape passes,
    // including the double-space day padding BSD ps emits.
    expect(parseLstart("Wed Sep  2 09:52:17 2026")).toBe(Date.parse("2026-09-02T09:52:17Z"));
    expect(parseLstart("Wed Sep 22 09:52:17 2026")).toBe(Date.parse("2026-09-22T09:52:17Z"));
  });

  test("no pid recorded ⇒ dead, with its own reason", () => {
    expect(evaluateOwnerLiveness({}).reason).toBe("no-owner-pid");
    expect(evaluateOwnerLiveness(undefined).reason).toBe("no-owner-pid");
  });

  /**
   * Adversarial, and it found something: `process.kill(-1, 0)` and
   * `process.kill(0, 0)` SUCCEED — they are group/broadcast permission probes,
   * not "does this process exist". Before the `pid > 1 && Number.isInteger`
   * guard, a record naming pid -1 or 0 was judged ALIVE, forever, wedging its
   * lease permanently. Signal 0 delivers nothing so nothing was harmed; the
   * verdict was simply meaningless.
   */
  /**
   * The check genuinely runs as pid 1 inside a container, and this module ships
   * to many hosts. Rejecting pid 1 would return `alive: false` there — the
   * unsafe direction — on every containerised run.
   */
  test("ACCEPT: pid 1 is a legitimate owner (the check IS pid 1 in a container)", () => {
    const verdict = evaluateOwnerLiveness({ pid: 1 });
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).not.toBe("no-owner-pid");
  });

  test("REJECT: broadcast/group and non-integer pids are never a live owner", () => {
    for (const pid of [-1, 0, 4242.7, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = evaluateOwnerLiveness({ pid, startedAt: new Date().toISOString() });
      expect(verdict.alive, `pid ${pid} must not read as a live owner`).toBe(false);
      expect(verdict.reason).toBe("no-owner-pid");
    }
    // The guard is not "reject everything": a real pid still passes it.
    expect(evaluateOwnerLiveness({ pid: process.pid }).alive).toBe(true);
  });

  test("a garbage anchor degrades to alive, never to a false recycled verdict", () => {
    for (const owner of [
      { pid: process.pid, startedAt: "not-a-date" },
      { pid: process.pid, processStartedAt: Number.NaN },
      { pid: process.pid, processStartedAt: "1234" as unknown as number },
    ]) {
      const verdict = evaluateOwnerLiveness(owner as OwnerRecord);
      expect(verdict.alive).toBe(true);
      expect(verdict.reason).not.toBe("pid-recycled");
    }
  });

  test("ACCEPT: a blind start-time reader fails CLOSED (alive) and says it is blind", () => {
    // A reader that can see nothing must not silently look like "verified alive".
    const deps: LivenessDeps = { probe: () => "signalable", startTimeMs: () => undefined };
    const verdict = evaluateOwnerLiveness({ pid: 4242, processStartedAt: 1 }, deps);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("start-time-unavailable");
    expect(verdict.startTimeChecked).toBe(false);
  });

  test("an unclear signal errno fails closed (alive) with its own reason", () => {
    const deps: LivenessDeps = { probe: () => "unclear", startTimeMs: () => Date.now() - 1000 };
    const verdict = evaluateOwnerLiveness({ pid: 4242 }, deps);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("signal-probe-unclear");
  });
});

/**
 * MEDIUM 2 (review round 1). Route 1 compares two readings from the SAME
 * instrument, so a constant misparse cancels and the verdict survives it.
 * Route 2 does not: it compares an `lstart`-derived epoch against
 * `Date.parse(startedAt)`, written by the runtime clock. The reviewer measured
 * that an 8-hour over-read there produces a FALSE `pid-recycled` — the unsafe
 * direction, on legacy records, with none of route 1's protection.
 *
 * the repo's former ownership ledger avoids the whole class by never
 * converting `lstart` at all. Two review rounds each gave a different reason
 * why this module cannot follow suit, and BOTH were false — see the warning at
 * the top of `pid-liveness.ts`. Measured: `Date.now() - parseEtime(...)` and
 * `parseLstart(...)` are the same instant to etime's 1 s truncation, so an
 * etime rewrite is viable and no step-immunity advantage exists either way.
 * `lstart` is a preference (human-recheckable with one command; the same field
 * the former ownership ledger already stores), and parsing it is what obliges this
 * module to MEASURE the premise that module got to avoid.
 */
describe("clockInstrumentsAgree — the premise route 2 rests on, measured", () => {
  test("ACCEPT: on this host, ps and the runtime clock do agree", () => {
    expect(clockInstrumentsAgree()).toBe(true);
  });

  test("REJECT: a whole-hour misparse is caught (it DISCRIMINATES)", () => {
    // Exactly the 7-hour shape the unpinned parser produced here, and the
    // 8-hour one the reviewer measured. A calibration that cannot see this
    // would be a calibration in name only.
    for (const offsetHours of [-8, -7, 7, 8]) {
      expect(
        clockInstrumentsAgree(() => Date.now() - process.uptime() * 1000 + offsetHours * 3600_000),
        `a ${offsetHours}h skew must be caught`,
      ).toBe(false);
    }
    // Sub-tolerance jitter is not a disagreement.
    expect(
      clockInstrumentsAgree(
        () => Date.now() - process.uptime() * 1000 + (CLOCK_AGREEMENT_TOLERANCE_MS - 500),
      ),
    ).toBe(true);
  });

  test("REJECT: a blind instrument is a disagreement, never a silent yes", () => {
    expect(clockInstrumentsAgree(() => undefined)).toBe(false);
  });

  test("route 2 is REFUSED when the clocks disagree — legacy record, alive not recycled", () => {
    const owner: OwnerRecord = {
      pid: process.pid,
      startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    // Same record that is `pid-recycled` when the instruments agree...
    expect(evaluateOwnerLiveness(owner, { clocksAgree: () => true }).reason).toBe("pid-recycled");
    // ...must NOT be reclaimed when they do not.
    const guarded = evaluateOwnerLiveness(owner, { clocksAgree: () => false });
    expect(guarded.alive).toBe(true);
    expect(guarded.reason).toBe("clock-instruments-disagree");
  });

  test("route 1 is NOT conditioned by the calibration — same instrument at both ends", () => {
    // A recorded process start time is comparable to a fresh reading whatever
    // the clocks are doing, so disabling route 1 here would throw away the
    // accurate check in order to protect the approximate one.
    const owner: OwnerRecord = {
      pid: process.pid,
      processStartedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      startTimeSource: readProcessStartTime(process.pid)?.source,
      startedAt: new Date().toISOString(),
    };
    expect(evaluateOwnerLiveness(owner, { clocksAgree: () => false }).reason).toBe("pid-recycled");
  });
});

describe("ownerIdentity", () => {
  test("records this process's own start time alongside the lease creation time", () => {
    const owner = ownerIdentity({ scenario: "unit", sha: "abc" }) as Record<string, unknown>;
    expect(owner.pid).toBe(process.pid);
    expect(owner.scenario).toBe("unit");
    expect(owner.sha).toBe("abc");
    expect(typeof owner.startedAt).toBe("string");
    expect(typeof owner.processStartedAt).toBe("number");
    expect(owner.startTimeSource === "ps" || owner.startTimeSource === "proc").toBe(true);
    // It is THIS process's start time, not "now".
    expect(owner.processStartedAt as number).toBeLessThanOrEqual(Date.now());
  });

  test("survives a JSON round-trip, which is how the lease actually stores it", () => {
    const owner = JSON.parse(JSON.stringify(ownerIdentity({ scenario: "unit" }))) as OwnerRecord;
    const verdict = evaluateOwnerLiveness(owner);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("running");
  });
});

describe("real pid-recycling shape, end to end", () => {
  /**
   * The measured incident: a lease recorded pid P; P's owner died; the kernel
   * handed P to something else. The ledger still says "live". Reconstruct it by
   * recording a real child, letting it die, then re-using its pid for a process
   * that is demonstrably younger than the record.
   */
  test("a record whose pid was reassigned to a younger process reads as recycled", async () => {
    const first = spawn("sleep", ["30"]);
    await new Promise((r) => setTimeout(r, 120));
    const pid = first.pid as number;
    const live = readProcessStartTime(pid);
    const record: OwnerRecord = {
      pid,
      processStartedAt: live?.ms,
      startTimeSource: live?.source,
      startedAt: new Date().toISOString(),
    };
    expect(evaluateOwnerLiveness(record).alive).toBe(true);

    first.kill("SIGKILL");
    await new Promise((r) => first.once("exit", r));

    // The kernel will not hand us that exact pid on demand, so simulate the
    // reassignment the only honest way available: a live pid whose measured
    // start time is later than the record's. The discriminator under test is
    // the comparison, not which integer the kernel picked.
    const recycled: OwnerRecord = {
      ...record,
      pid: process.pid,
      processStartedAt: (readProcessStartTime(process.pid)?.ms as number) - 60_000,
      startTimeSource: readProcessStartTime(process.pid)?.source,
    };
    const verdict = evaluateOwnerLiveness(recycled);
    expect(verdict.alive).toBe(false);
    expect(verdict.reason).toBe("pid-recycled");
  });
});

/**
 * #5829 — route 1's "same instrument at both ends" was an unenforced assumption.
 * `processStartedAt` is comparable to a fresh reading ONLY when both numbers
 * came from the same backend (`ps` or `/proc`). A PATH/busybox swap that makes
 * write use `ps` and check use `/proc` (or reverse) silently turns route 1 into
 * the cross-instrument case `crossInstrument` exists to refuse.
 *
 * Mutation pair:
 *  BREAK — write `ps`, check `/proc`, skip the check → must NOT be `running`.
 *  RESTORE — same instrument, start times agree, pid live → `running`.
 */
describe("startTimeSource — same-instrument is a recorded fact, not an assumption", () => {
  test("BREAK: write via ps, check via proc is NOT same-instrument (even if the numbers match)", () => {
    const ms = Date.now() - 5_000;
    const deps: LivenessDeps = {
      probe: () => "signalable",
      startTime: () => ({ ms, source: "proc" }),
      clocksAgree: () => true,
    };
    const owner: OwnerRecord = {
      pid: 4242,
      processStartedAt: ms,
      startTimeSource: "ps",
      startedAt: new Date().toISOString(),
    };
    const verdict = evaluateOwnerLiveness(owner, deps);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).not.toBe("running");
    expect(verdict.reason).toBe("start-time-unavailable");
    expect(verdict.startTimeChecked).toBe(false);
  });

  test("BREAK: the reverse swap (write proc, check ps) is the same colour", () => {
    const ms = Date.now() - 5_000;
    const deps: LivenessDeps = {
      probe: () => "signalable",
      startTime: () => ({ ms, source: "ps" }),
    };
    const owner: OwnerRecord = {
      pid: 4242,
      processStartedAt: ms,
      startTimeSource: "proc",
    };
    const verdict = evaluateOwnerLiveness(owner, deps);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("start-time-unavailable");
    expect(verdict.reason).not.toBe("running");
  });

  test("BREAK: a mismatched instrument must not produce pid-recycled even when the number looks later", () => {
    // The unsafe direction: /proc with a wrong USER_HZ overstates elapsed, so
    // start looks later than the recorded ps reading. That is a false recycle.
    const deps: LivenessDeps = {
      probe: () => "signalable",
      startTime: () => ({ ms: Date.now(), source: "proc" }),
      clocksAgree: () => true,
    };
    const owner: OwnerRecord = {
      pid: 4242,
      processStartedAt: Date.now() - 60_000,
      startTimeSource: "ps",
    };
    const verdict = evaluateOwnerLiveness(owner, deps);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).not.toBe("pid-recycled");
    expect(verdict.reason).toBe("start-time-unavailable");
  });

  test("RESTORE: same instrument, start time agrees, pid live → running", () => {
    const ms = Date.now() - 5_000;
    for (const source of ["ps", "proc"] as StartTimeSource[]) {
      const deps: LivenessDeps = {
        probe: () => "signalable",
        startTime: () => ({ ms, source }),
      };
      const owner: OwnerRecord = {
        pid: 4242,
        processStartedAt: ms,
        startTimeSource: source,
        startedAt: new Date().toISOString(),
      };
      const verdict = evaluateOwnerLiveness(owner, deps);
      expect(verdict.alive, source).toBe(true);
      expect(verdict.reason, source).toBe("running");
      expect(verdict.startTimeChecked, source).toBe(true);
    }
  });

  test("ACCEPT: ownerIdentity pins the live source, and a JSON round-trip still verifies", () => {
    const owner = JSON.parse(JSON.stringify(ownerIdentity({ scenario: "unit" }))) as OwnerRecord;
    expect(owner.startTimeSource === "ps" || owner.startTimeSource === "proc").toBe(true);
    const verdict = evaluateOwnerLiveness(owner);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe("running");
  });

  test("old record without startTimeSource cannot assume same-instrument (not verified alive)", () => {
    const live = readProcessStartTime(process.pid);
    const owner: OwnerRecord = {
      pid: process.pid,
      processStartedAt: live?.ms,
      startedAt: new Date().toISOString(),
    };
    const verdict = evaluateOwnerLiveness(owner);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).not.toBe("running");
    expect(verdict.reason).toBe("start-time-unavailable");
  });

  test("old record without startTimeSource still catches recycle via the lease-creation route", () => {
    // Compatibility is fail-closed on the identity claim, not blind to recycling:
    // startedAt is still a valid upper bound, conditioned by clockInstrumentsAgree.
    const owner: OwnerRecord = {
      pid: process.pid,
      processStartedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const verdict = evaluateOwnerLiveness(owner, { clocksAgree: () => true });
    expect(verdict.reason).toBe("pid-recycled");
    expect(verdict.alive).toBe(false);
  });
});

/**
 * #5829 — `USER_HZ = 100` was a guess. A larger real CLK_TCK overstates elapsed
 * → start looks later → false `pid-recycled` (the unsafe direction #5815 fixed).
 * Mutation: putting the constant back, or changing it toward the unsafe side,
 * must red a test. A correct getconf read / explicit fail-closed must be green.
 */
describe("CLK_TCK — measured, never a guessed USER_HZ", () => {
  const stat =
    "4242 (my (weird) proc) S 1 4242 4242 0 -1 4194560 1234 0 0 0 12 3 0 0 20 0 4 0 " +
    "360000 123 456 18446744073709551615 1 2 3 4 5 6 7 8 9\n";
  const bootMs = 1_700_000_000_000;

  test("REJECT: a smaller-than-real CLK_TCK overstates elapsed (the unsafe direction)", () => {
    // elapsed = ticks / hz * 1000. A guessed hz that is TOO SMALL (hardcoded
    // 100 when the real CLK_TCK is larger) overstates elapsed → start looks
    // later → false pid-recycled. That is the same unsafe direction #5815 fixed.
    const at100 = parseProcStartTimeMs(stat, bootMs, 100);
    const tooSmall = parseProcStartTimeMs(stat, bootMs, 10);
    expect(at100).toBe(bootMs + 3_600_000);
    expect(tooSmall).toBeDefined();
    expect(tooSmall as number).toBeGreaterThan(at100 as number);
    // A larger-than-real hz understates elapsed (start looks earlier) — the
    // fail-closed side. It must stay distinguishable from the unsafe side.
    const tooLarge = parseProcStartTimeMs(stat, bootMs, 1000);
    expect(tooLarge as number).toBeLessThan(at100 as number);
  });

  test("REJECT: invalid CLK_TCK is cannot-measure, never a guessed 100", () => {
    expect(parseProcStartTimeMs(stat, bootMs, 0)).toBeUndefined();
    expect(parseProcStartTimeMs(stat, bootMs, Number.NaN)).toBeUndefined();
    expect(parseProcStartTimeMs(stat, bootMs, -1)).toBeUndefined();
  });

  test("ACCEPT: getconf CLK_TCK on this host is a positive integer, or we refuse", () => {
    const hz = readClkTck();
    const live = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
    if (live.status === 0) {
      expect(hz).toBe(Number(live.stdout.trim()));
      expect(hz as number).toBeGreaterThan(0);
      expect(Number.isInteger(hz)).toBe(true);
      expect(parseProcStartTimeMs(stat, bootMs, hz as number)).toBe(
        bootMs + (360_000 / (hz as number)) * 1000,
      );
    } else {
      expect(hz).toBeUndefined();
    }
  });

  test("REJECT: when getconf fails, we do not fall back to a hardcoded USER_HZ", () => {
    const binDir = mkdtempSync(join(tmpdir(), "agentloop-5829-nogetconf-"));
    writeFileSync(join(binDir, "getconf"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${originalPath}`;
      resetClkTckCache();
      expect(readClkTck()).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      resetClkTckCache();
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("REJECT: the production module does not hardcode USER_HZ = <n>", () => {
    const src = readFileSync(fileURLToPath(new URL("./pid-liveness.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/USER_HZ\s*=\s*\d+/);
    expect(src).not.toMatch(/(clkTck|CLK_TCK|userHz|USER_HZ)[^;\n]*(\?\?|\|\|)\s*\d+/);
    expect(src).toMatch(/getconf/);
    expect(src).toMatch(/CLK_TCK/);
  });
});
