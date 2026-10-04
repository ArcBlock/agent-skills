/**
 * strict-file-lock — a cross-process mutex over ONE small state file, for
 * read-modify-write sequences that must not lose an update (arc#6204).
 *
 * ## Why this exists and why it is not the one next door
 *
 * `fleet/runlock.ts` already has a per-repo advisory lock, and its
 * {@link withFileLock} is the obvious thing to reach for. It is the wrong thing
 * here, for one reason stated in its own docblock: after `maxWaitMs` it
 * **PROCEEDS ANYWAY**. That is correct for what it guards — the worst case there
 * is a lost cadence stamp, and the repo simply reruns next fire. It is exactly
 * wrong for a ledger of agent deaths: proceeding without the lock IS the lost
 * update, and a dropped record means dropped work with no second chance. So the
 * difference this module exists for is the one in its name: **it never proceeds
 * without the lock. It throws.**
 *
 * The other difference is the liveness predicate. `runlock`'s `isAlive` is bare
 * `process.kill(pid, 0)`, which `lib/pid-liveness.ts` was written to replace: a
 * RECYCLED pid makes a dead holder look alive forever, and measured, not
 * hypothetically (a check ledger named pid 58249 as a live check; 58249 was a
 * Chrome helper that inherited the number). This module routes staleness through
 * {@link evaluateOwnerLiveness}, so "the pid is alive" and "the pid is alive and
 * is still the process that took the lock" are different answers.
 *
 * ## Why `link()` and not `open(…, "wx")`
 *
 * `openSync(path, "wx")` is an atomic CREATE, but the content arrives in a
 * second syscall. A racer reading between the two sees a zero-byte file,
 * classifies it as garbage, and steals a LIVE holder's lock — the empty-file
 * window that the former machine-lane lock names explicitly. Writing a temp file
 * first and publishing it with `linkSync` makes the appearance of the lock and
 * the completeness of its content the same event. `link()` fails with EEXIST
 * when the target is present, so the claim IS the check: CAS, no window.
 *
 * ## Why the steal re-reads and compares bytes
 *
 * read → classify → unlink looks atomic and is not. The classify step runs `ps`,
 * which takes milliseconds, and a second entrant reaching the SAME stale record
 * during that window would unlink whatever is at the path by then — possibly the
 * first entrant's brand-new lock, leaving two holders. Re-reading immediately
 * before the unlink and comparing bytes narrows the gap to the unlink itself.
 * Same reasoning, same shape, as `reclaimLaneIfStale`.
 */
import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import {
  evaluateOwnerLiveness,
  type LivenessVerdict,
  type OwnerRecord,
  ownerIdentity,
} from "./pid-liveness.ts";

/** How long to wait for a contended lock before failing loudly. */
export const DEFAULT_LOCK_WAIT_MS = 10_000;

/**
 * Ceiling past which a lock is reclaimable even if its holder still LOOKS alive.
 *
 * The backstop for the case `pid-liveness.ts` deliberately fails closed on: a
 * host where the start time cannot be measured, or a record written on another
 * machine, both end in `alive: true` so that an over-eager verdict can never
 * steal a live lock. Without a ceiling, that safety turns into a permanent
 * wedge. A guarded section here reads and rewrites one small JSON file — sub-
 * millisecond — so 60s is four orders of magnitude of headroom, not a guess at
 * how long the work takes.
 */
export const DEFAULT_LOCK_STALE_MS = 60_000;

const SPIN_STEP_MS = 25;
/** `ps` costs milliseconds; do not pay it on every spin step. */
const STALE_RECHECK_INTERVAL_MS = 1000;

/** What a lock file holds. Shaped so {@link evaluateOwnerLiveness} can read it. */
export interface LockHolder extends OwnerRecord {
  pid: number;
  /** Epoch ms the lock was taken — the clock {@link DEFAULT_LOCK_STALE_MS} bounds. */
  at: number;
  /** What the holder is doing, so a contention message is actionable. */
  purpose: string;
  cwd: string;
}

export class LockUnavailableError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: LockHolder | undefined,
    readonly waitedMs: number,
    readonly verdict: LivenessVerdict | undefined,
    holderAgeMs = Number.NaN,
  ) {
    super(
      `could not take the lock at ${lockPath} after ${(waitedMs / 1000).toFixed(1)}s — ` +
        (holder
          ? `held by pid ${holder.pid} (${holder.purpose}) for ` +
            `${Math.round(holderAgeMs / 1000)}s in ${holder.cwd}` +
            (verdict ? `; liveness=${verdict.reason}` : "")
          : "the lock file is present but unreadable") +
        ". REFUSING to proceed without it: an unguarded read-modify-write here " +
        "silently deletes another process's record (arc#6204).",
    );
    this.name = "LockUnavailableError";
  }
}

export interface StrictFileLockOptions {
  waitMs?: number;
  staleMs?: number;
  now?: () => number;
  sleepMs?: (ms: number) => void;
  log?: (message: string) => void;
  /** Injectable so a test can drive staleness without spawning a doomed process. */
  liveness?: (holder: OwnerRecord) => LivenessVerdict;
}

/**
 * A positive, finite millisecond count, or the stated default.
 *
 * Exported so a test can assert the coercion directly — the reason it exists is
 * that `opts.waitMs ?? DEFAULT` silently admits `NaN`, and every downstream
 * comparison against `NaN` is false, so the spin loop never ends.
 */
export function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Synchronous sleep. `Atomics.wait` so this works without a bun-only builtin. */
function sleepSyncMs(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function readHolder(lockPath: string): { raw: string; holder: LockHolder | undefined } | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return undefined; // vanished — the holder released it
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid < 1)
      return { raw, holder: undefined };
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at))
      return { raw, holder: undefined };
    return {
      raw,
      holder: {
        ...parsed,
        pid: parsed.pid,
        at: parsed.at,
        purpose: typeof parsed.purpose === "string" ? parsed.purpose : "(unknown)",
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : "(unknown)",
      },
    };
  } catch {
    return { raw, holder: undefined };
  }
}

/**
 * Publish `body` at `lockPath` atomically. Returns false when someone is already
 * there. The temp file carries our pid so two racers never share one.
 */
function publish(lockPath: string, body: string, pid: number): boolean {
  const tmp = `${lockPath}.${pid}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, lockPath); // atomic: EEXIST when already held
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort
    }
  }
}

/**
 * Run `fn` while holding an exclusive lock at `lockPath`.
 *
 * Throws {@link LockUnavailableError} rather than running `fn` unguarded. The
 * release happens in `finally` AND on process exit, because a `fn` that calls
 * `process.exit` (the CLI does, on a corrupt ledger) skips `finally`.
 */
export function withStrictFileLock<T>(
  lockPath: string,
  purpose: string,
  fn: () => T,
  opts: StrictFileLockOptions = {},
): T {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleepMs ?? sleepSyncMs;
  // `??` does NOT catch NaN, and `waited >= NaN` is false forever — so an
  // unguarded NaN here is a lock that hangs, which is the failure you least want
  // reachable in a lock. The CLI validates its own env override, but that guard
  // protects one caller; this one protects the module, which is where it belongs.
  // `Infinity` is rejected for the same reason, and a non-positive wait would
  // make the ceiling fire before a single attempt.
  const waitMs = positiveFinite(opts.waitMs, DEFAULT_LOCK_WAIT_MS);
  const staleMs = positiveFinite(opts.staleMs, DEFAULT_LOCK_STALE_MS);
  const liveness = opts.liveness ?? ((h: OwnerRecord) => evaluateOwnerLiveness(h));
  const log = opts.log ?? ((m: string) => console.error(m));
  const pid = process.pid;

  const body = `${JSON.stringify({
    ...ownerIdentity(),
    pid,
    at: now(),
    purpose,
    cwd: process.cwd(),
  })}\n`;

  const started = now();
  let lastStaleCheck = -Infinity;
  let lastHolder: LockHolder | undefined;
  let lastVerdict: LivenessVerdict | undefined;

  let held = false;
  for (;;) {
    if (publish(lockPath, body, pid)) {
      held = true;
      break;
    }
    // The ceiling is checked at the TOP, before either `continue` below. Checking
    // it only at the bottom let two paths — a lock that keeps vanishing between
    // our `link` and our read, and the stale branch — spin hot and never time out.
    const waited = now() - started;
    if (waited >= waitMs)
      throw new LockUnavailableError(
        lockPath,
        lastHolder,
        waited,
        lastVerdict,
        lastHolder ? now() - lastHolder.at : Number.NaN,
      );
    const current = readHolder(lockPath);
    if (current === undefined) continue; // released between our link and our read

    lastHolder = current.holder;
    if (now() - lastStaleCheck >= STALE_RECHECK_INTERVAL_MS) {
      lastStaleCheck = now();
      lastVerdict = current.holder ? liveness(current.holder) : undefined;
      // Three ways a lock is stale, and they are different facts:
      //  - unreadable content. `publish` makes an in-flight write INVISIBLE (the
      //    path appears only once the bytes are complete), so garbage here is
      //    real corruption, never a racer caught mid-write.
      //  - the holder is provably not the process that took it (dead, recycled).
      //  - it has outlived the ceiling, which is the escape hatch for every path
      //    where `pid-liveness` fails closed to `alive`.
      const stale =
        current.holder === undefined ||
        lastVerdict?.alive !== true ||
        now() - current.holder.at >= staleMs;
      if (stale) {
        // Re-read and compare BYTES before unlinking. Anything different means
        // another entrant already handled this record, and unlinking now would
        // remove a live holder's lock.
        const again = readHolder(lockPath);
        if (again !== undefined && again.raw === current.raw) {
          try {
            unlinkSync(lockPath);
            log(
              `[strict-file-lock] reclaimed a stale lock at ${lockPath} ` +
                `(pid ${current.holder?.pid ?? "?"}, ${
                  lastVerdict ? lastVerdict.reason : "unreadable content"
                }) — arc#6204`,
            );
          } catch {
            // someone beat us to it; the loop re-reads
          }
        }
        continue;
      }
    }
    sleep(SPIN_STEP_MS);
  }

  const release = () => {
    if (!held) return;
    held = false;
    const current = readHolder(lockPath);
    if (current === undefined) return;
    if (current.holder?.pid !== pid) return; // a stale-steal handed it on; not ours to remove
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  try {
    return fn();
  } finally {
    release();
  }
}
