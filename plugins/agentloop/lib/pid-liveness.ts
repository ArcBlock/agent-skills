#!/usr/bin/env bun
/**
 * pid-liveness — is the pid recorded in a lease STILL the process that took it?
 *
 * The predicate this replaces was pure pid existence (#5815):
 *
 *     try { process.kill(pid, 0); return true } catch { return false }
 *
 * Two distinct defects lived in those five lines, failing in opposite directions.
 *
 * ① A RECYCLED pid makes a dead owner look alive. Measured, not hypothetical:
 *    a check ledger recorded pid 58249 as a "live check"; rechecked, 58249 was a
 *    Chrome helper that had inherited the number, and the other five recorded
 *    pids no longer existed at all. For the lease itself that direction is
 *    fail-closed (it is never reclaimed, so nothing is corrupted), but the
 *    hygiene check NAMES those pids for a human to act on — so it names an
 *    innocent process.
 *
 * ② `process.kill(pid, 0)` throws ESRCH when no such process exists and EPERM
 *    when the process EXISTS but may not be signalled. A bare `catch` folds
 *    both into "dead", and THAT direction is not safe: a live owner judged dead
 *    means the lease is taken while its owner is still working.
 *
 * The discriminator is a fact the owner cannot fake: its own start time.
 *
 * ONE-DIRECTIONAL BY DESIGN. Only "this pid started LATER than the anchor" is
 * evidence the pid changed hands. A measured start time EARLIER than the anchor
 * is treated as clock skew or a coarser measurement source and does NOT reclaim.
 * The reason is asymmetric blast radius: an over-eager verdict makes every check
 * steal every lease, which is far worse than the wedge being fixed. Every path
 * where the instrument cannot answer therefore ends in `alive`, and says so
 * with its own reason rather than blending into "verified alive".
 *
 * PORTABILITY. `ps -o lstart= -p <pid>` is the primary source and works on both
 * macOS (BSD ps) and Linux (procps-ng); it is also what a human reaches for, so
 * a report's numbers can be rechecked by hand. Linux `/proc/<pid>/stat` is a
 * fallback for hosts whose `ps` lacks `lstart` (busybox images). No `/proc`
 * assumption is made anywhere else — macOS has no `/proc`.
 *
 * WHY THIS PARSES `lstart` AT ALL, when the repo already has a module that
 * refuses to. the repo's former ownership ledger states the hazard exactly:
 *
 *   「Deliberately NOT derived from `lstart` minus a clock: `lstart` carries no
 *    timezone, so any parse of it is a guess about the reader's TZ, and a test
 *    that pins one would pass in UTC and fail in Asia/Shanghai.」
 *
 * ⚠️ READ THIS BEFORE ADDING A REASON HERE. Two successive review rounds each
 * replaced this paragraph's central justification with a DIFFERENT claim, and
 * both were false in the same way — an unmeasured assertion about what the
 * `etime` construction would do. Round 1: 「an ordering cannot be built from a
 * duration」. Round 2: 「macOS `lstart` comes from `kinfo_proc.p_starttime` and
 * therefore survives a wall-clock step, unlike etime」. Neither was measured
 * before being written down. If a reason you want to add needs a claim about
 * what `ps` does internally, MEASURE IT OR DROP IT.
 *
 * What is actually measured (this host, macOS, `probe-etime`):
 * `Date.now() - parseEtime(ps -o etime=)` and `parseLstart(ps -o lstart=)`
 * return THE SAME INSTANT, delta 0.7 s — exactly etime's sub-second truncation
 * — for pid 1 at 7 days old and for pids seconds old. They are one quantity
 * computed two ways, and `parseEtime` already exists in the former ownership ledger.
 * So the etime construction is entirely viable, and **no step-immunity
 * advantage has been demonstrated for either construction, on either
 * platform.** Nothing below rests on one.
 *
 * The two reasons this module does rest on, both checkable without knowing
 * anything about `ps` internals:
 *
 *   a. `ps -o lstart= -p <pid>` is the command a human runs to recheck a number
 *      in a report — it is how the incident in #5815 was diagnosed in the first
 *      place;
 *   b. the former ownership ledger already stores this exact C-locale rendering as
 *      `identity.startTime`, so the two modules name the same field rather than
 *      two derivations of it.
 *
 * That is a preference, not a necessity: an etime-based rewrite would be
 * correct, would make both routes same-instrument, and would retire
 * `parseLstart`, the ` GMT` pin, the shape anchor and `clockInstrumentsAgree()`
 * outright. It is a reasonable future simplification. Given `lstart` IS parsed
 * here, three things make that safe:
 *
 *   1. the rendering is pinned at BOTH ends (`TZ=UTC` on the spawn + a literal
 *      ` GMT` in the parser), so the reading does not depend on the host zone;
 *   2. the string must match the C-locale `lstart` SHAPE before it is parsed —
 *      the same anchor the former ownership ledger applies — because `Date.parse`
 *      will otherwise swallow a degraded rendering and read `dd/mm` as `mm/dd`;
 *   3. route 1 compares two readings from the SAME instrument, so any constant
 *      misparse cancels. That sameness is a recorded fact (`startTimeSource`:
 *      `"ps"` | `"proc"`), not an assumption: `readProcessStartTime` has two
 *      backends, and a PATH/busybox swap can make write use one and check use
 *      the other. A mismatch (or an old record that never pinned the source)
 *      is `start-time-unavailable`, never silent route 1. Route 2 does not
 *      cancel a misparse — it compares an `lstart`-derived epoch against a
 *      true ISO clock — so route 2 is used ONLY after
 *      `clockInstrumentsAgree()` has MEASURED that the two agree on this host.
 *
 * KNOWN BOUNDARY, not closed: a wall-clock STEP (NTP) spanning a lease's
 * lifetime. A step large enough to move a start-time reading past its anchor
 * would make a live owner look younger than its own record. This is NOT claimed
 * to differ between `lstart` and an etime-derived start — see above; that claim
 * has been made twice and been wrong twice. Nothing purely local closes it, and
 * the former ownership ledger carries an exposure of the same shape, confirmed in
 * review: `identityAgrees` (`:372-380`) returns false on a shifted `lstart` and
 * `isLiveCandidate` (`:392-393`) then reads a LIVE check as dead, the unsafe
 * direction. Bounded here by leases living for minutes; stated rather than
 * papered over.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Two independent measurements of the same process's start time can differ by
 * up to a second: BSD `lstart` has one-second resolution, and `/proc` starttime
 * is derived from boot time. Only a difference LARGER than this counts.
 */
export const RECYCLE_TOLERANCE_MS = 2000;

/**
 * How far the `ps` clock may sit from the runtime clock before the two stop
 * being comparable. Larger than RECYCLE_TOLERANCE_MS on purpose: this is a
 * calibration, and a false "they disagree" only costs route 2 (fail-closed to
 * alive), while a false "they agree" would have to survive a sub-5 s misparse —
 * no timezone offset, and no `dd/mm` swap, is ever that small.
 */
export const CLOCK_AGREEMENT_TOLERANCE_MS = 5000;

/** Hard ceiling on the `ps` probe. Measured at ~1.5 ms; this is 3000x that. */
export const PS_TIMEOUT_MS = 5000;

/**
 * Which backend produced a process start time. Route 1 is valid only when the
 * recorded source and the live source are this same value. `"ps"` is
 * `ps -o lstart=`; `"proc"` is Linux `/proc/<pid>/stat`.
 */
export type StartTimeSource = "ps" | "proc";

export interface MeasuredStartTime {
  ms: number;
  source: StartTimeSource;
}

/** The owner fields `owner.json` carries that bear on liveness. */
export interface OwnerRecord {
  pid?: number;
  /** Epoch ms of the OWNER PROCESS's own start, measured when the lease was taken. */
  processStartedAt?: number;
  /**
   * Which instrument produced `processStartedAt`. Absent on records written
   * before #5829 — those cannot assume same-instrument (see `anchorOf`).
   */
  startTimeSource?: StartTimeSource;
  /** ISO-8601 lease creation time. Weaker, but present on records written before #5815. */
  startedAt?: string;
}

export type SignalProbe =
  /** the process exists and we may signal it */
  | "signalable"
  /** ESRCH — no such process */
  | "gone"
  /** EPERM — it exists, it is simply not ours to signal */
  | "denied"
  /** some other errno; we do not know, so we do not guess */
  | "unclear";

export type LivenessReason =
  | "no-owner-pid"
  | "no-such-process"
  | "pid-recycled"
  | "signal-permission-denied"
  | "start-time-unavailable"
  | "clock-instruments-disagree"
  | "signal-probe-unclear"
  | "running";

export interface LivenessVerdict {
  alive: boolean;
  reason: LivenessReason;
  /** Whether a start time was actually measured. `false` means the instrument was blind. */
  startTimeChecked: boolean;
  /** Human-facing sentence; the hygiene remedy quotes it before naming a pid. */
  detail?: string;
}

export interface LivenessDeps {
  probe?: (pid: number) => SignalProbe;
  startTimeMs?: (pid: number) => number | undefined;
  /** Preferred over `startTimeMs`: carries the instrument that produced the number. */
  startTime?: (pid: number) => MeasuredStartTime | undefined;
  /**
   * Whether the `ps` clock and the runtime clock are close enough to be
   * compared against each other. Checks route 2 only; route 1 never needs it.
   */
  clocksAgree?: () => boolean;
  now?: () => number;
}

/** Split ESRCH / EPERM / alive into the three colours they actually are. */
export function probeSignal(pid: number): SignalProbe {
  try {
    process.kill(pid, 0);
    return "signalable";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "denied";
    return "unclear";
  }
}

/**
 * `Wed Sep  2 09:52:17 2026` → epoch ms.
 *
 * `ps` renders `lstart` in the TIMEZONE IT INHERITS and prints no offset, so the
 * pair (spawn env, parser) has to agree or every reading is silently hours off.
 * Measured under `bun test`, whose runtime clock is UTC while `ps` inherited the
 * host zone: the parsed start time came out 7 h early — inside the recycling
 * tolerance's blind spot in one direction and a false "recycled" in the other.
 * Both ends are therefore pinned to UTC explicitly: `TZ=UTC` on the spawn (see
 * `readProcessStartTimeMs`) and a literal ` GMT` here, so the reading does not
 * depend on the host zone, on `$TZ`, or on the runtime's own clock setting.
 */
export function parseLstart(raw: string): number | undefined {
  const text = raw.trim().replace(/\s+/g, " ");
  // Shape-anchored BEFORE parsing, the same guard the former ownership ledger
  // applies to the same field. `Date.parse` is far too permissive to be a
  // validator: measured across plausible degraded renderings, most of them
  // parse, and a `dd/mm/yyyy` rendering is silently read as `mm/dd` whenever
  // the day is ≤ 12 — landing on the UNSAFE side (an over-read start time
  // becomes a false `pid-recycled`) about half the time. `LC_ALL=C` is supposed
  // to prevent that; this is the check that it actually did.
  if (!/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(text)) return undefined;
  const ms = Date.parse(`${text} GMT`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Parse `/proc/<pid>/stat` + boot time into epoch ms.
 *
 * `comm` is parenthesised and may itself contain spaces and parentheses, so the
 * fields are taken after the LAST `)`. `starttime` is field 22 counting from 1,
 * i.e. index 19 of what follows `comm`.
 */
export function parseProcStartTimeMs(
  stat: string,
  bootMs: number,
  clkTck: number,
): number | undefined {
  // A guessed USER_HZ is the unsafe direction: a larger-than-real value
  // overstates elapsed, so start looks later, so a live owner looks recycled.
  // Invalid / non-positive hz is "cannot measure", never a fallback constant.
  if (!Number.isFinite(clkTck) || clkTck <= 0) return undefined;
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ticks = Number(fields[19]);
  if (!Number.isFinite(ticks)) return undefined;
  return bootMs + (ticks / clkTck) * 1000;
}

let cachedClkTck: number | undefined;
let clkTckResolved = false;

/**
 * `getconf CLK_TCK` once per process. `undefined` means we could not measure;
 * callers must fail closed rather than guess 100.
 */
export function readClkTck(): number | undefined {
  if (clkTckResolved) return cachedClkTck;
  clkTckResolved = true;
  const result = spawnSync("getconf", ["CLK_TCK"], {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
    // Spread so a test (or a host) that mutates PATH is actually observed —
    // bun's default env snapshot does not always see `process.env.PATH` writes.
    env: { ...process.env },
  });
  if (result.status === 0 && typeof result.stdout === "string") {
    const n = Number(result.stdout.trim());
    if (Number.isInteger(n) && n > 0) {
      cachedClkTck = n;
      return n;
    }
  }
  cachedClkTck = undefined;
  return undefined;
}

/** Test seam: forget the cached CLK_TCK. */
export function resetClkTckCache(): void {
  clkTckResolved = false;
  cachedClkTck = undefined;
}

function readBootTimeMs(): number | undefined {
  try {
    const line = readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((l) => l.startsWith("btime "));
    if (!line) return undefined;
    const seconds = Number(line.slice("btime ".length).trim());
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

const lastMeasuredByPid = new Map<number, MeasuredStartTime>();

/**
 * The process's own start time and the instrument that produced it, or
 * `undefined` when it cannot be measured (the pid is gone, or this host offers
 * neither source, or CLK_TCK could not be read for the `/proc` fallback).
 *
 * `undefined` is deliberately NOT "dead": callers must fail closed on it, and
 * `LivenessVerdict.startTimeChecked` keeps "measured" distinguishable from
 * "never looked".
 */
export function readProcessStartTime(pid: number): MeasuredStartTime | undefined {
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    // `process.kill(pid, 0)` structurally could not hang; a subprocess can, and
    // this one now sits on the check's critical path. A wedged `ps` must degrade
    // to "cannot measure" (fail-closed to alive) rather than stop the check.
    timeout: PS_TIMEOUT_MS,
    // LC_ALL pins the month names; TZ pins the clock the timestamp is rendered
    // in. Without TZ the reading depends on the host zone (see parseLstart).
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (ps.status === 0 && typeof ps.stdout === "string") {
    const parsed = parseLstart(ps.stdout);
    if (parsed !== undefined) {
      const measured: MeasuredStartTime = { ms: parsed, source: "ps" };
      lastMeasuredByPid.set(pid, measured);
      return measured;
    }
  }
  // Linux fallback for a `ps` without `lstart` (busybox). Absent on macOS.
  try {
    const boot = readBootTimeMs();
    if (boot === undefined) return undefined;
    const hz = readClkTck();
    if (hz === undefined) return undefined;
    const parsed = parseProcStartTimeMs(
      readFileSync(join("/proc", String(pid), "stat"), "utf8"),
      boot,
      hz,
    );
    if (parsed === undefined) return undefined;
    const measured: MeasuredStartTime = { ms: parsed, source: "proc" };
    lastMeasuredByPid.set(pid, measured);
    return measured;
  } catch {
    return undefined;
  }
}

export function readProcessStartTimeMs(pid: number): number | undefined {
  return readProcessStartTime(pid)?.ms;
}

/**
 * Do the `ps` clock and the runtime clock agree on this host, right now?
 *
 * This is the positive control that route 2 rests on. Route 2 compares an
 * `lstart`-derived epoch against `Date.parse(owner.startedAt)`, an ISO string
 * written by the runtime clock — two DIFFERENT instruments, so their agreement
 * is a premise, and an unverified premise is exactly how a live owner ends up
 * reclaimed. Here that premise is measured instead: `ps` is asked for THIS
 * process's start time, and the runtime is asked the same question a way that
 * cannot involve `ps` at all (`Date.now() - process.uptime() * 1000`). If the
 * two answers differ by more than the tolerance, the timezone/locale pinning
 * did not hold on this host and route 2 is refused rather than trusted.
 *
 * It is deliberately NOT used to check route 1: route 1 compares two readings
 * from the same instrument, where a constant misparse cancels, and disabling it
 * on a host with an odd clock would throw away the accurate check to protect
 * the approximate one.
 */
export function clockInstrumentsAgree(
  startTimeMs: (pid: number) => number | undefined = readProcessStartTimeMs,
): boolean {
  const viaPs = startTimeMs(process.pid);
  if (viaPs === undefined) return false;
  const viaRuntime = Date.now() - process.uptime() * 1000;
  // Latency in the probe itself does NOT register as disagreement: a slow `ps`
  // delays both terms equally, because `process.uptime()` advances with
  // `Date.now()`. Measured with a 9 s `ps` shim: still agree.
  return Math.abs(viaPs - viaRuntime) <= CLOCK_AGREEMENT_TOLERANCE_MS;
}

let cachedClockAgreement: boolean | undefined;

/**
 * `clockInstrumentsAgree()` for the hot path.
 *
 * The answer is a property of this process and this host, so re-deriving it is
 * pure cost — and it was being paid once per poll of a wait loop that can run
 * for 900 s at 100 ms intervals. Cached for the process lifetime, which is also
 * the lifetime over which `process.uptime()` and the `ps` rendering are fixed.
 */
export function clockInstrumentsAgreeCached(): boolean {
  if (cachedClockAgreement === undefined) cachedClockAgreement = clockInstrumentsAgree();
  return cachedClockAgreement;
}

/** Test seam: forget the cached calibration. */
export function resetClockAgreementCache(): void {
  cachedClockAgreement = undefined;
}

/**
 * A start-time reader that measures each pid at most once.
 *
 * A live process's start time cannot change, so within one lease acquisition
 * every re-read returns the same number at the price of another subprocess.
 * Scoped per acquisition rather than per process so a long-lived caller cannot
 * accumulate readings for pids that have since died.
 */
export function memoizedStartTimeReader(
  read: (pid: number) => number | undefined = readProcessStartTimeMs,
): (pid: number) => number | undefined {
  const seen = new Map<number, number | undefined>();
  return (pid) => {
    if (!seen.has(pid)) seen.set(pid, read(pid));
    return seen.get(pid);
  };
}

/**
 * The owner block a lease writes. `processStartedAt` plus `startTimeSource` are
 * the discriminator that makes a recycled pid distinguishable from the process
 * that took the lease, and that keeps write-time vs check-time backends from
 * silently becoming a cross-instrument comparison (#5829).
 */
export function ownerIdentity(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const started = readProcessStartTime(process.pid);
  return {
    pid: process.pid,
    processStartedAt: started?.ms,
    startTimeSource: started?.source,
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

interface Anchor {
  ms: number;
  kind: string;
  /** Route 2 anchors come from a DIFFERENT instrument than the measurement. */
  crossInstrument: boolean;
}

function isStartTimeSource(value: unknown): value is StartTimeSource {
  return value === "ps" || value === "proc";
}

function measureLive(
  pid: number,
  deps: LivenessDeps,
): { ms: number; source?: StartTimeSource } | undefined {
  if (deps.startTime) return deps.startTime(pid);
  if (deps.startTimeMs) {
    const ms = deps.startTimeMs(pid);
    if (ms === undefined) return undefined;
    const cached = lastMeasuredByPid.get(pid);
    return { ms, source: cached !== undefined && cached.ms === ms ? cached.source : undefined };
  }
  return readProcessStartTime(pid);
}

function anchorOf(owner: OwnerRecord, liveSource?: StartTimeSource): Anchor | undefined {
  // Route 1 — same instrument at both ends, so a constant misparse cancels.
  // Sameness is recorded (`startTimeSource`) AND matches the live source;
  // missing or mismatched source is NOT silent route 1 (#5829).
  if (
    typeof owner.processStartedAt === "number" &&
    Number.isFinite(owner.processStartedAt) &&
    isStartTimeSource(owner.startTimeSource) &&
    owner.startTimeSource === liveSource
  )
    return { ms: owner.processStartedAt, kind: "recorded owner start", crossInstrument: false };
  // Route 2 (records written before #5815, and hosts where the start time could
  // not be measured at lease time): the owner process necessarily started
  // BEFORE it created its own lease, so lease creation is a valid upper bound.
  // `startedAt` comes from the RUNTIME clock while the measurement comes from
  // `ps`, so this anchor is only usable once the two have been shown to agree.
  if (typeof owner.startedAt === "string") {
    const ms = Date.parse(owner.startedAt);
    if (Number.isFinite(ms)) return { ms, kind: "lease creation", crossInstrument: true };
  }
  return undefined;
}

/**
 * Is the process that took this lease still running?
 *
 * Never signals anything: the probe is signal 0, and the start-time source is
 * read-only. Deciding to kill anything remains a human's call.
 */
export function evaluateOwnerLiveness(
  owner: OwnerRecord | undefined,
  deps: LivenessDeps = {},
): LivenessVerdict {
  const pid = owner?.pid;
  // A POSITIVE INTEGER, not merely "a finite number". Measured adversarially:
  // `process.kill(-1, 0)` and `kill(0, 0)` SUCCEED — they are group/broadcast
  // permission probes, not existence checks — so a record naming pid -1 or 0
  // would read as alive forever and wedge its lease. (Signal 0 delivers
  // nothing, so nothing was ever harmed; the verdict was simply meaningless.)
  //
  // pid 1 is ALLOWED, deliberately: inside a container the check genuinely runs
  // as pid 1, and rejecting it would return `alive: false` — the unsafe
  // direction — on every containerised host. This module ships to many repos
  // and many hosts; it does not get to assume it is not pid 1.
  if (owner === undefined || typeof pid !== "number" || !Number.isInteger(pid) || pid < 1)
    return {
      alive: false,
      reason: "no-owner-pid",
      startTimeChecked: false,
      detail: "the lease names no usable owner pid",
    };

  const probe = (deps.probe ?? probeSignal)(pid);
  if (probe === "gone")
    return {
      alive: false,
      reason: "no-such-process",
      startTimeChecked: false,
      detail: `pid ${pid} no longer exists (ESRCH)`,
    };

  // The process exists — signalable or merely not ours to signal. Both are
  // "exists", and the only remaining question is whether it is the SAME one.
  const live = measureLive(pid, deps);
  const measured = live?.ms;
  const liveSource = live?.source;

  // Write-time vs check-time instrument mismatch: NEVER silent route 1.
  // Comparing the numbers would be the unsafe direction (a wrong USER_HZ
  // overstates elapsed → false pid-recycled). Fail closed.
  if (
    isStartTimeSource(owner.startTimeSource) &&
    isStartTimeSource(liveSource) &&
    owner.startTimeSource !== liveSource
  )
    return {
      alive: true,
      reason: "start-time-unavailable",
      startTimeChecked: false,
      detail:
        `pid ${pid} exists; start time was recorded via ${owner.startTimeSource} but the live ` +
        `measurement is via ${liveSource}, so the two are not comparable — recycling was NOT ruled out`,
    };

  const anchor = anchorOf(owner, liveSource);
  if (
    measured !== undefined &&
    anchor?.crossInstrument === true &&
    !(
      deps.clocksAgree ??
      (deps.startTimeMs
        ? () => clockInstrumentsAgree(deps.startTimeMs)
        : clockInstrumentsAgreeCached)
    )()
  )
    return {
      alive: true,
      reason: "clock-instruments-disagree",
      startTimeChecked: true,
      detail:
        `pid ${pid} exists; the only anchor on this lease is its ${anchor.kind} time, and this ` +
        `host's ps clock does not agree with the runtime clock, so the two are not comparable — ` +
        `recycling was NOT ruled out`,
    };
  if (measured !== undefined && anchor !== undefined && measured > anchor.ms + RECYCLE_TOLERANCE_MS)
    return {
      alive: false,
      reason: "pid-recycled",
      startTimeChecked: true,
      detail:
        `pid ${pid} is alive but started ${new Date(measured).toISOString()}, after the ` +
        `${anchor.kind} ${new Date(anchor.ms).toISOString()} — the owner exited and this pid ` +
        `has been recycled to an unrelated process`,
    };

  if (probe === "denied")
    return {
      alive: true,
      reason: "signal-permission-denied",
      startTimeChecked: measured !== undefined,
      detail: `pid ${pid} exists but cannot be signalled from here (EPERM); it is not dead`,
    };
  if (probe === "unclear")
    return {
      alive: true,
      reason: "signal-probe-unclear",
      startTimeChecked: measured !== undefined,
      detail: `pid ${pid} could not be probed conclusively; treating it as alive`,
    };
  if (measured === undefined)
    return {
      alive: true,
      reason: "start-time-unavailable",
      startTimeChecked: false,
      detail: `pid ${pid} exists; its start time could not be measured, so recycling was NOT ruled out`,
    };
  // Route 1 is the only path that may claim "verified alive". An old record
  // that never pinned `startTimeSource` is the same colour as a blind
  // instrument — fail closed, do not look verified.
  if (!isStartTimeSource(owner.startTimeSource) || owner.startTimeSource !== liveSource)
    return {
      alive: true,
      reason: "start-time-unavailable",
      startTimeChecked: false,
      detail:
        `pid ${pid} exists; the owner record does not pin a start-time instrument that matches ` +
        `the live measurement, so recycling was NOT ruled out`,
    };
  return {
    alive: true,
    reason: "running",
    startTimeChecked: true,
    detail: `pid ${pid} is the process that took this lease`,
  };
}
