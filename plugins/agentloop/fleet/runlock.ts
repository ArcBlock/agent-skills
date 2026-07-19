#!/usr/bin/env bun
/**
 * Per-repo advisory run-lock for the fleet driver.
 *
 * WHY: cron fires one driver invocation per skill. A slow repo (blockchain's pr-sweep
 * runs ~2h on a fresh backlog) used to be serialized by a cron-level `shlock <skill>.lock`
 * that wrapped the WHOLE invocation — so while it ran, the next hourly fire (where a
 * DIFFERENT repo like arc had become due) couldn't get the lock and was skipped entirely.
 * Parallelism only ever existed WITHIN one invocation; cadence scatters repos across
 * different fires, so a lone slow repo starved everyone else.
 *
 * FIX: move the lock to per-(repo,skill) granularity, INSIDE the driver, and drop the
 * cron-level lock. Overlapping invocations now coexist: a second invocation SKIPS the
 * repo already running (its lock is held by a live pid) and runs the rest.
 *
 * The lock file holds "<pid> <epochMs>". Liveness is PID-based (like `shlock -p`): a lock
 * whose owner process is dead is STALE and gets stolen, so a killed driver never wedges a
 * repo forever. Advisory, not a distributed lock — the atomic `wx` create closes the common
 * race; the rare stale-steal has a tiny window, acceptable for a single-host scheduler
 * (cross-host claiming stays GitHub-label based, see fleet/README.md).
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export interface RunLock {
  owner: number; // pid that holds it
  ts: number; // epoch ms the lock was taken (informational)
}

/** IO seam so the decision logic is unit-testable without a real filesystem. */
export interface LockIO {
  /** Atomically create the file with content; return false if it ALREADY exists (never overwrite). */
  create(path: string, content: string): boolean;
  read(path: string): string | undefined; // undefined when absent
  remove(path: string): void;
  isAlive(pid: number): boolean;
}

export const formatLock = (pid: number, ts: number): string => `${pid} ${ts}\n`;

export function parseLock(content: string | undefined): RunLock | undefined {
  if (!content) return undefined;
  const m = content.trim().match(/^(\d+)\s+(\d+)/);
  return m ? { owner: Number(m[1]), ts: Number(m[2]) } : undefined;
}

/** owner/name (× skill) → a filesystem-safe lock path under lockDir. */
export function runLockPath(lockDir: string, slug: string, skill: string): string {
  const leaf = `${slug.replace("/", "__")}__${skill}`;
  return `${lockDir.replace(/\/+$/, "")}/${leaf}.run.lock`;
}

/**
 * Try to take the lock. Returns true if acquired (caller MUST release), false if a LIVE
 * owner already holds it (caller should skip this repo this invocation). A lock owned by a
 * dead pid — or an unparseable/garbage file — is stolen (stale self-heal).
 *
 * The stale-steal itself races through the SAME atomic create, so if two invocations both
 * spot a stale lock only one wins the re-create; the other sees a live owner and skips.
 */
export function acquire(path: string, pid: number, ts: number, io: LockIO): boolean {
  const content = formatLock(pid, ts);
  if (io.create(path, content)) return true; // was absent → ours
  const cur = parseLock(io.read(path));
  if (cur && io.isAlive(cur.owner)) return false; // a live run holds it → skip
  io.remove(path); // stale (dead owner / garbage) → steal
  return io.create(path, content);
}

/** Release only if WE still own it (a stale-steal may have handed it to someone else). */
export function release(path: string, pid: number, io: LockIO): void {
  const cur = parseLock(io.read(path));
  if (!cur || cur.owner === pid) io.remove(path);
}

/**
 * Run `fn` while holding a cross-process lock at `path` — for the SHARED files (the
 * .fleet-state.json cadence stamps + fleet.jsonl) that overlapping invocations both write.
 * Spins briefly to acquire; after `maxWaitMs` it PROCEEDS ANYWAY (advisory: the worst case
 * is a lost cadence stamp → that repo simply reruns next fire, never a deadlock).
 */
export function withFileLock<T>(
  path: string,
  pid: number,
  io: LockIO,
  now: () => number,
  sleep: (ms: number) => void,
  fn: () => T,
  maxWaitMs = 1000,
  stepMs = 20,
): T {
  let held = false;
  let waited = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: acquire-or-spin is the idiom
  while (!(held = acquire(path, pid, now(), io))) {
    if (waited >= maxWaitMs) break; // give up waiting, proceed advisory
    sleep(stepMs);
    waited += stepMs;
  }
  try {
    return fn();
  } finally {
    if (held) release(path, pid, io);
  }
}

/** Real filesystem LockIO. `wx` = create-exclusive: atomic, throws EEXIST if present. */
export const realLockIO: LockIO = {
  create(path, content) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, content);
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined; // absent
    }
  },
  remove(path) {
    try {
      unlinkSync(path);
    } catch {
      // already gone — fine
    }
  },
  isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe only, never actually signals
      return true;
    } catch (e) {
      // ESRCH = no such process (dead); EPERM = alive but not ours → still alive
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

export const ensureLockDir = (lockDir: string): void => {
  mkdirSync(lockDir, { recursive: true });
};
