/**
 * Tests for the cross-process mutex behind the retry ledger (arc#6204).
 *
 * The concurrency test uses REAL child processes, because the defect it guards
 * cannot be reproduced any other way: two in-process calls share one event loop
 * and never interleave a read-modify-write. That is the same reason the repo's
 * `ifMatch` conformance suites insist on a `peerProvider` — a single-instance
 * lock and a real CAS look identical until a second process shows up.
 *
 * And it carries its own POSITIVE CONTROL. "8 of 8 records survived" satisfies
 * every assertion a harness that never actually raced would also satisfy, so the
 * same child script runs with the lock DISABLED and must lose records. If that
 * arm stops losing, the instrument went blind and the locked arm proves nothing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LivenessVerdict } from "./pid-liveness.ts";
import {
  DEFAULT_LOCK_STALE_MS,
  type LockHolder,
  LockUnavailableError,
  positiveFinite,
  withStrictFileLock,
} from "./strict-file-lock.ts";

const MODULE = new URL("./strict-file-lock.ts", import.meta.url).pathname;

const alive: LivenessVerdict = { alive: true, reason: "running", startTimeChecked: true };
const dead: LivenessVerdict = {
  alive: false,
  reason: "no-such-process",
  startTimeChecked: false,
  detail: "pid 999999 no longer exists (ESRCH)",
};

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "agentloop-strict-lock-"));
}

/**
 * A clock that ADVANCES on each read. A constant injected `now` makes the spin
 * loop immortal (`waited` is always 0) — measured: the first draft of this file
 * hung the runner for 120s. The clock has to move for a wait ceiling to mean
 * anything, so the fixture moves it.
 */
function advancingClock(from: number, stepMs = 25): () => number {
  let t = from;
  return () => {
    const at = t;
    t += stepMs;
    return at;
  };
}

/**
 * A child that appends one id to a JSON array with a DELIBERATE delay between
 * the read and the write. The delay makes the lost update deterministic instead
 * of a coin flip, so both arms of the control are decisive in one run.
 */
const CHILD = `
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { withStrictFileLock } from ${JSON.stringify(MODULE)};
const [, , store, id, mode, delay] = process.argv;
const append = () => {
  const cur = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : [];
  const until = Date.now() + Number(delay);
  while (Date.now() < until) {} // hold the read-modify-write window open
  cur.push(id);
  writeFileSync(store, JSON.stringify(cur));
};
if (mode === "locked") withStrictFileLock(store + ".lock", "append " + id, append, { waitMs: 30000 });
else append();
`;

async function storm(mode: "locked" | "unlocked", n: number, delayMs: number) {
  const dir = scratch();
  try {
    const child = join(dir, "child.ts");
    writeFileSync(child, CHILD);
    const store = join(dir, "store.json");
    writeFileSync(store, "[]");
    const kids = Array.from({ length: n }, (_, i) =>
      Bun.spawn(["bun", child, store, `id-${i}`, mode, String(delayMs)], {
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const codes = await Promise.all(kids.map((k) => k.exited));
    return {
      survived: (JSON.parse(readFileSync(store, "utf8")) as string[]).sort(),
      codes,
      lockLeft: existsSync(`${store}.lock`),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("withStrictFileLock", () => {
  test("ACCEPT — an uncontended section runs, returns, and leaves no lock behind", () => {
    const dir = scratch();
    try {
      const lock = join(dir, "x.lock");
      const got = withStrictFileLock(lock, "unit", () => {
        // The lock is held DURING the section — a no-op implementation that
        // never created the file would satisfy the release assertion below.
        expect(existsSync(lock)).toBe(true);
        return 42;
      });
      expect(got).toBe(42);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("REJECT — a LIVE holder is never stolen, and the waiter THROWS rather than proceeding", () => {
    const dir = scratch();
    try {
      const lock = join(dir, "x.lock");
      const holder: LockHolder = {
        pid: process.pid,
        at: 1_000_000,
        purpose: "the other gate",
        cwd: "/somewhere",
        processStartedAt: 999_000,
        startTimeSource: "ps",
      };
      writeFileSync(lock, `${JSON.stringify(holder)}\n`);
      let ran = false;
      expect(() =>
        withStrictFileLock(
          lock,
          "unit",
          () => {
            ran = true;
          },
          {
            waitMs: 60,
            now: advancingClock(1_000_100), // well inside the stale ceiling
            sleepMs: () => {},
            liveness: () => alive,
          },
        ),
      ).toThrow(LockUnavailableError);
      // The whole point: `fn` did NOT run, and the holder's file is untouched.
      expect(ran).toBe(false);
      expect(JSON.parse(readFileSync(lock, "utf8")).purpose).toBe("the other gate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the refusal names the holder, so it is actionable and not just a timeout", () => {
    const dir = scratch();
    try {
      const lock = join(dir, "x.lock");
      writeFileSync(
        lock,
        `${JSON.stringify({ pid: 4242, at: 1_000_000, purpose: "record", cwd: "/tree" })}\n`,
      );
      try {
        withStrictFileLock(lock, "due", () => 0, {
          waitMs: 60,
          now: advancingClock(1_000_100),
          sleepMs: () => {},
          liveness: () => alive,
        });
        throw new Error("should have thrown");
      } catch (e) {
        const err = e as LockUnavailableError;
        expect(err.message).toContain("pid 4242");
        expect(err.message).toContain("record");
        expect(err.message).toContain("/tree");
        // And it says WHY refusing beats proceeding — the distinction from
        // fleet/runlock.ts's advisory withFileLock.
        expect(err.message).toContain("REFUSING to proceed");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("RECOVERS — a lock whose holder is provably gone is reclaimed, not waited on forever", () => {
    const dir = scratch();
    try {
      const lock = join(dir, "x.lock");
      writeFileSync(
        lock,
        `${JSON.stringify({ pid: 999_999, at: 1_000_000, purpose: "dead gate", cwd: "/x" })}\n`,
      );
      const got = withStrictFileLock(lock, "unit", () => "ran", {
        waitMs: 500,
        now: advancingClock(1_000_100), // INSIDE the stale ceiling: liveness alone reclaims
        sleepMs: () => {},
        liveness: () => dead,
        log: () => {},
      });
      expect(got).toBe("ran");
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("RECOVERS — a holder that still LOOKS alive is reclaimed once past the ceiling", () => {
    // The escape hatch for pid-liveness's deliberate fail-closed-to-alive paths
    // (ps unavailable, a record from another host). Without it that safety
    // becomes a permanent wedge.
    const dir = scratch();
    try {
      const lock = join(dir, "x.lock");
      writeFileSync(
        lock,
        `${JSON.stringify({ pid: process.pid, at: 1_000_000, purpose: "wedged", cwd: "/x" })}\n`,
      );
      const got = withStrictFileLock(lock, "unit", () => "ran", {
        waitMs: 500,
        now: advancingClock(1_000_000 + DEFAULT_LOCK_STALE_MS + 1),
        sleepMs: () => {},
        liveness: () => alive,
        log: () => {},
      });
      expect(got).toBe("ran");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the steal does NOT remove a lock that changed hands while `ps` was running", () => {
    // read → classify → unlink is not atomic: the classify step runs `ps`, which
    // costs milliseconds, and another entrant reaching the SAME stale record in
    // that window would unlink whatever is at the path by then — possibly a
    // brand-new live holder's lock, leaving two holders.
    //
    // The liveness probe below stands in for that window: while it is "running"
    // it replaces the file with a DIFFERENT holder, exactly as a racer that won
    // the steal would have. The byte compare must notice and decline to unlink.
    const dir = scratch();
    try {
      const lock = join(dir, "x.lock");
      const stale = { pid: 999_999, at: 1_000_000, purpose: "dead gate", cwd: "/x" };
      const fresh = { pid: process.pid, at: 1_000_050, purpose: "the racer that won", cwd: "/y" };
      writeFileSync(lock, `${JSON.stringify(stale)}\n`);
      let swapped = false;
      expect(() =>
        withStrictFileLock(lock, "unit", () => "should not run", {
          waitMs: 60,
          now: advancingClock(1_000_100),
          sleepMs: () => {},
          log: () => {},
          liveness: () => {
            if (!swapped) {
              swapped = true;
              writeFileSync(lock, `${JSON.stringify(fresh)}\n`); // the window
            }
            return dead; // our verdict is about the record we READ, now gone
          },
        }),
      ).toThrow(LockUnavailableError);
      expect(swapped).toBe(true);
      // The racer's lock is intact. Without the byte compare it would be gone.
      expect(JSON.parse(readFileSync(lock, "utf8")).purpose).toBe("the racer that won");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a NaN/Infinity/zero wait cannot make the lock hang — guarded in the MODULE", () => {
    // `opts.waitMs ?? DEFAULT` admits NaN, and `waited >= NaN` is false forever.
    // The CLI validates its own env override, but that protects one caller; a
    // second caller passing a computed value would reach the hang. So the guard
    // lives here, and this test drives the library directly.
    expect(positiveFinite(Number.NaN, 10_000)).toBe(10_000);
    expect(positiveFinite(Number.POSITIVE_INFINITY, 10_000)).toBe(10_000);
    expect(positiveFinite(0, 10_000)).toBe(10_000);
    expect(positiveFinite(-5, 10_000)).toBe(10_000);
    expect(positiveFinite(undefined, 10_000)).toBe(10_000);
    // ACCEPT: a real value is NOT clobbered. Without this, a function hardwired
    // to return the fallback would satisfy every assertion above.
    expect(positiveFinite(250, 10_000)).toBe(250);

    // And end to end: a NaN wait against a live holder still TERMINATES.
    const dir = scratch();
    try {
      const lock = join(dir, "x.lock");
      writeFileSync(
        lock,
        `${JSON.stringify({ pid: process.pid, at: 1_000_000, purpose: "holder", cwd: "/x" })}\n`,
      );
      let ran = false;
      expect(() =>
        withStrictFileLock(
          lock,
          "unit",
          () => {
            ran = true;
          },
          {
            waitMs: Number.NaN,
            now: advancingClock(1_000_100, 5_000), // 5s per read: the default ceiling arrives fast
            sleepMs: () => {},
            liveness: () => alive,
          },
        ),
      ).toThrow(LockUnavailableError);
      expect(ran).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt lock file is reclaimed — `publish` makes a mid-write file invisible", () => {
    const dir = scratch();
    try {
      const lock = join(dir, "x.lock");
      writeFileSync(lock, "not json at all");
      const got = withStrictFileLock(lock, "unit", () => "ran", {
        waitMs: 500,
        now: advancingClock(1_000_000),
        sleepMs: () => {},
        liveness: () => alive,
        log: () => {},
      });
      expect(got).toBe("ran");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ACCEPT (real processes) — every concurrent append survives, and the POSITIVE CONTROL loses", async () => {
    const N = 6;
    // 400ms, not 120: the control arm relies on the children's read-modify-write
    // windows OVERLAPPING, and on a loaded machine bun's startup skew alone can
    // exceed a short delay — turning the control green for the wrong reason, which
    // is the one outcome that makes the locked arm prove nothing. It costs the
    // locked arm ~2.4s of serialised sleeping and buys a control that does not
    // depend on how busy the box is.
    const DELAY = 400;
    // Control first: the same child WITHOUT the lock must lose records. If this
    // arm ever survives all N, the harness is not racing and the locked arm
    // below proves nothing at all.
    const control = await storm("unlocked", N, DELAY);
    expect(control.codes.every((c) => c === 0)).toBe(true); // silent, which is the defect
    expect(control.survived.length).toBeLessThan(N);

    const locked = await storm("locked", N, DELAY);
    expect(locked.codes.every((c) => c === 0)).toBe(true);
    expect(locked.survived).toEqual(Array.from({ length: N }, (_, i) => `id-${i}`).sort());
    // And the last holder released it.
    expect(locked.lockLeft).toBe(false);
  }, 60_000);
});
