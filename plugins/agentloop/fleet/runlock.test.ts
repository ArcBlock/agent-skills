import { describe, expect, test } from "bun:test";
import {
  acquire,
  formatLock,
  type LockIO,
  parseLock,
  release,
  runLockPath,
  withFileLock,
} from "./runlock.ts";

/** In-memory LockIO with an injectable liveness set — models the filesystem + `kill -0`. */
function fakeIO(alive: Set<number>) {
  const files = new Map<string, string>();
  const io: LockIO = {
    create(path, content) {
      if (files.has(path)) return false; // atomic wx semantics
      files.set(path, content);
      return true;
    },
    read: (path) => files.get(path),
    remove: (path) => void files.delete(path),
    isAlive: (pid) => alive.has(pid),
  };
  return { io, files, alive };
}

describe("parseLock / formatLock", () => {
  test("round-trips pid + ts", () => {
    expect(parseLock(formatLock(4242, 1000))).toEqual({ owner: 4242, ts: 1000 });
  });
  test("undefined / garbage / empty → undefined", () => {
    expect(parseLock(undefined)).toBeUndefined();
    expect(parseLock("")).toBeUndefined();
    expect(parseLock("not a lock")).toBeUndefined();
    expect(parseLock("\x1b[m garbage")).toBeUndefined();
  });
});

describe("runLockPath", () => {
  test("filesystem-safe leaf per (repo, skill)", () => {
    expect(runLockPath("/base/.locks", "ArcBlock/arc", "pr-sweep")).toBe(
      "/base/.locks/ArcBlock__arc__pr-sweep.run.lock",
    );
  });
});

describe("acquire / release", () => {
  const LOCK = "/l/arc.run.lock";

  test("absent → acquired, and the file records our pid", () => {
    const { io, files } = fakeIO(new Set([100]));
    expect(acquire(LOCK, 100, 5, io)).toBe(true);
    expect(parseLock(files.get(LOCK))).toEqual({ owner: 100, ts: 5 });
  });

  test("held by a LIVE owner → NOT acquired (skip this repo)", () => {
    const { io } = fakeIO(new Set([100, 200]));
    expect(acquire(LOCK, 100, 5, io)).toBe(true); // 100 holds it
    expect(acquire(LOCK, 200, 6, io)).toBe(false); // 200 sees a live owner → skip
  });

  test("held by a DEAD owner → stolen (stale self-heal)", () => {
    const { io, files } = fakeIO(new Set([200])); // 100 is NOT alive
    expect(acquire(LOCK, 100, 5, io)).toBe(true);
    // 100 "dies": drop it from the alive set, 200 comes along and steals the stale lock
    const stolen = acquire(LOCK, 200, 7, io);
    expect(stolen).toBe(true);
    expect(parseLock(files.get(LOCK))?.owner).toBe(200);
  });

  test("garbage lock file → stolen", () => {
    const { io } = fakeIO(new Set([300]));
    io.create(LOCK, "\x1b(B\x1b[m not-a-lock");
    expect(acquire(LOCK, 300, 9, io)).toBe(true);
  });

  test("release only removes OUR lock, never a live steal's", () => {
    const { io, files } = fakeIO(new Set([100, 200]));
    acquire(LOCK, 100, 5, io);
    release(LOCK, 200, io); // not ours → no-op
    expect(files.has(LOCK)).toBe(true);
    release(LOCK, 100, io); // ours → removed
    expect(files.has(LOCK)).toBe(false);
  });

  test("full cycle: acquire → release → re-acquire by another pid", () => {
    const { io } = fakeIO(new Set([100, 200]));
    expect(acquire(LOCK, 100, 1, io)).toBe(true);
    release(LOCK, 100, io);
    expect(acquire(LOCK, 200, 2, io)).toBe(true); // free again
  });
});

describe("withFileLock (shared state/summary writer)", () => {
  const SL = "/l/state.lock";

  test("runs fn while holding the lock, releases after", () => {
    const { io, files } = fakeIO(new Set([1]));
    let ranWhileHeld = false;
    const out = withFileLock(
      SL,
      1,
      io,
      () => 0,
      () => {},
      () => {
        ranWhileHeld = files.has(SL); // held during fn
        return "done";
      },
    );
    expect(out).toBe("done");
    expect(ranWhileHeld).toBe(true);
    expect(files.has(SL)).toBe(false); // released after
  });

  test("waits for a live holder, then proceeds; sleep is called while contended", () => {
    const { io } = fakeIO(new Set([1, 2]));
    acquire(SL, 2, 0, io); // pid 2 (alive) holds it and never releases
    let slept = 0;
    let now = 0;
    const out = withFileLock(
      SL,
      1,
      io,
      () => now,
      (ms) => {
        slept += ms;
        now += ms;
      },
      () => "proceeded-anyway",
      100, // maxWaitMs
      20, // stepMs
    );
    expect(out).toBe("proceeded-anyway"); // advisory: never deadlocks
    expect(slept).toBeGreaterThanOrEqual(100); // it DID spin before giving up
  });
});
