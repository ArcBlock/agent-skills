/**
 * Agent-death classification + the retry ledger (arc#6204).
 *
 * ## The defect this closes
 *
 * A fanned-out agent that dies from a provider capacity limit and one that
 * fails at its task both arrive as `status=failed`. Two different states, one
 * colour — and the consequence is identical: the work is dropped unless a human
 * happens to be watching. Measured twice in one epic-conductor run: one agent
 * had already committed its fix and died queued behind a check; another died
 * mid-edit holding +319/-113 uncommitted. Both were recovered by hand.
 *
 * ## Why fail-closed
 *
 * An unrecognised death is NOT retryable. Auto-retrying a genuine task failure
 * burns budget and can repeat side effects (a second PR, a second comment), so
 * "I don't know what this is" must land on needs-a-human.
 *
 * The classifier requires TWO things together — an agent-termination notice AND
 * a machine-readable capacity error type inside it. Either one alone is prose:
 * an agent REPORTING that the endpoint under test answered `HTTP 429` is not an
 * agent that died of one, and a termination on `overloaded_error` is not a
 * capacity limit this ledger waits out. The first draft tested only the token
 * half and its guard test picked an example with no status code in it, so the
 * reject arm passed while the hole stayed open.
 *
 * ## This module is only two of the three pieces
 *
 * Classification and the ledger live here. Re-dispatch is the caller's, because
 * it is the only part that knows how to spawn. A classifier without a ledger is
 * just a better error message; a ledger without a waker is just a list.
 *
 * NOT the same domain as `./failure-class.ts`, which classifies TEST failures
 * inside a verification run. This one classifies AGENT PROCESS deaths. Do not
 * merge them.
 */

/** Retry delay used when a death is a rate limit but names no reset instant. */
export const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

/** Default cap on automatic retries before a record needs a human. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export type DeathKind = "rate-limit" | "task-failure" | "unknown";

export interface AgentDeath {
  kind: DeathKind;
  retryable: boolean;
  /** Epoch ms a retry may first be attempted; null when not retryable. */
  resetAt: number | null;
  /** How `resetAt` was obtained — so a report never implies precision it lacks. */
  resetSource: "parsed" | "default-backoff" | "none";
  reason: string;
}

/**
 * The harness's own death notice — the agent PROCESS was terminated, and the
 * summary is the harness speaking, not the agent.
 *
 * This half is the one the first draft was missing, and the miss was not
 * theoretical: with only the token half below, a worker writing
 *
 *     "the endpoint under test returned HTTP 429 (error type rate_limit) …"
 *
 * classified as a retryable death. That is a genuine task outcome — the 429 was
 * observed in the system under TEST — and auto-retrying it is exactly the
 * budget burn and repeated side effect the docblock above forbids.
 *
 * The observed shape is
 *
 *     Agent terminated early due to an API error: <text>
 *     (error type rate_limit, HTTP 429, request id req_…, model sent to the API: …)
 *
 * ## ONE marker, and it carries the colon
 *
 * This list held a second, bare entry — `/\bagent (?:was )?terminated early\b/i`
 * — and the docblock right here asserted that it was safe: *"'terminated early'
 * is the harness's phrasing; a human writing about a worker does not use it."*
 *
 * That sentence was false, and it was falsified by a ONE-WORD edit of the very
 * fixture it cited. The shipped reject fixture ends "…the agent was terminated
 * **after** the check timed out."; change one word and the summary flips:
 *
 *     reject     "…the agent was terminated after the check timed out."
 *     RETRYABLE  "…the agent was terminated early, so the remaining 429
 *                 assertions never ran."
 *
 * Because the bare marker matched mid-sentence, `NOTICE_END` then measured to the
 * end of THAT sentence — which is exactly where a report discussing its own death
 * puts the capacity word. Measured over 875 generated report sentences (7
 * prefixes × 5 subjects × 5 verbs × 5 tails): **350 classified as retryable
 * capacity deaths**, in the forbidden direction.
 *
 * ## The reason this kept happening, which is worth more than the fix
 *
 * That bare marker was itself an un-sampled widening — a guess at harness
 * phrasing with no observed sample behind it — **sitting three lines below the
 * paragraph that forbids exactly that**. The rule was applied at cost to new work
 * (the multi-line widening was declined for want of a sample) and never applied
 * to the code already written. Existing code is where the hole was.
 *
 * So: ONE marker, the one observed shape, **including its colon** — the colon is
 * what makes it a harness header rather than a clause a human can write. Nothing
 * goes in this list without a captured sample and a verbatim accept test.
 *
 * A shape this list does not know lands on needs-a-human, which is the safe
 * direction.
 */
const TERMINATION_MARKERS = [/\bagent (?:was )?terminated early due to an? \w+ error\s*:/i];

/**
 * Where the notice ENDS: the first sentence terminator, or a newline.
 *
 * ## Read this before touching the regex
 *
 * This one line has now been wrong THREE times, each time in the same way, and
 * the third time was a fix for the second:
 *
 *  1. A reject test named "the signal is the error type, not the prose" whose
 *     example contained no `429` at all — so the reject arm passed without ever
 *     reaching the hole.
 *  2. A conjunction that required a marker AND a token but matched each over the
 *     WHOLE summary. Broken by one of this module's own reject fixtures plus one
 *     appended sentence.
 *  3. `/\.[\s]+(?=[A-Z])|\n/` — a boundary that only closes on a period followed
 *     by an ASCII CAPITAL. The counterexample that motivated it happened to begin
 *     with "Earlier", so **the boundary was written against the shape of the one
 *     fixture that broke it.** Review then produced seven more from the same
 *     construction, varying only the appended sentence's first character (digit,
 *     lowercase, quote, backtick, CJK, a bracket, a semicolon-joined clause with
 *     no period at all). Measured on that regex: 8 of 10 classified a **529 /
 *     `overloaded_error`** death as a retryable capacity limit.
 *
 * The lesson is not about capitals. **Fixing the instance is what produces the
 * next instance.** So the class is characterised in the test file by a generated
 * sweep over joiners × first characters, not by however many named fixtures
 * someone has found so far — see `agent-retry.test.ts`.
 *
 * A `.` must be followed by whitespace or end-of-string so that `req_01.2` and
 * `claude-opus-5.1` do not truncate a notice mid-token. CJK terminators carry no
 * such requirement because CJK text does not put a space after them.
 *
 * This regex may only ever be made to match MORE, never less: every additional
 * terminator SHORTENS the region, and a shorter region cannot turn a reject into
 * an accept. A change that lengthens the region needs an accept fixture taken
 * from a real observed death notice.
 */
const NOTICE_END = /[.!?;](?=\s|$)|[。！？；]|\n/;

/**
 * The capacity signal, read ONLY inside the notice region.
 *
 * Wider than a machine-readable error type, deliberately, and the region is what
 * earns it: once the marker has matched, the HARNESS is the speaker, so the
 * anti-false-positive property comes from the marker plus the region, not from
 * the token's structure. Two real shapes a machine-token-only set rejects:
 *
 *     "…due to an API error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}"
 *         — no "HTTP 429" at all, and /rate_limit\b/ cannot match `rate_limit_error`
 *           (`_` is a word character, so the \b fails).
 *     "…due to an API error: You have hit your session limit · resets 7pm (…)"
 *         — the real observed shape with its trailing parenthetical truncated
 *           away. The machine-readable half sits at the END of that line, so any
 *           summary truncation keeps the marker and drops the token.
 *
 * Both would fail closed to needs-a-human, which is safe but useless: they are
 * the most likely real arrivals.
 */
const RATE_LIMIT_TOKENS = [
  /\b429\b/,
  /rate[_ -]?limit/i,
  /\b(?:session|usage|weekly|daily|account|organization) limit\b/i,
];

/**
 * The notice region, or undefined when the summary carries no death notice.
 * Exported so a test can pin the scoping directly rather than only through the
 * classifier's verdict.
 */
export function terminationNotice(text: string): string | undefined {
  for (const marker of TERMINATION_MARKERS) {
    const m = marker.exec(text);
    if (!m) continue;
    const rest = text.slice(m.index);
    const end = NOTICE_END.exec(rest);
    return end ? rest.slice(0, end.index + 1) : rest;
  }
  return undefined;
}

/**
 * ## Two widenings deliberately NOT made, and why
 *
 * Both would make a fail-closed case useful, and both were declined under the
 * rule stated on {@link TERMINATION_MARKERS}: *widening requires a real observed
 * sample AND an accept test carrying that sample verbatim — not a guess at what
 * the harness might also print.* That rule exists because guessing at output
 * shapes is exactly how the boundary above went wrong three times. Applying it to
 * my own convenience is the whole point of writing it down.
 *
 * **1. A multi-line notice whose `(error type rate_limit, HTTP 429…)` sits on
 * line 2** is rejected, because `\n` ends the region. Review raised this as a
 * real cost — it partly cancels the reason the token set was widened. I have no
 * observed multi-line sample. Every rule I could write to admit one ("continue
 * past a newline when the next line opens a parenthetical", "bound on a blank
 * line instead") is a guess, and each demonstrably opens an accept path that the
 * appended-sentence construction walks straight through. The failure here is
 * needs-a-human on a real 429: safe, merely useless. The failure from a guessed
 * continuation rule is auto-retrying a task failure. **What would change this:**
 * one captured multi-line death notice, pasted verbatim into an accept test.
 *
 * **2. ANY join that is not a sentence terminator** keeps the appended text
 * inside the region. This was first written down as "a clause joined by a comma",
 * which named **1 of at least 15** members and so understated the miss by an
 * order of magnitude. Measured against a 529 notice, every one of these leaks:
 *
 *     ,   :   —   –   …   /   |   ·   ->   --   +   &   <tab>   (…)   .no-space
 *
 * **This one CANNOT be closed by widening the terminator set**, and that is a
 * mechanism fact rather than a preference: `,` `:` `/` `·` `(` `)` and `'` all
 * occur INSIDE the real notice, so promoting any of them to a terminator cuts a
 * genuine death notice short and reds the accept face. The `NOTICE_END` docblock
 * says the regex may only ever match more; these are the cases where that door
 * is shut.
 *
 * It is a known miss, ASSERTED as such in the test file — adding `,` to the
 * terminator set immediately reds that test — so it cannot silently expire, and
 * so "we know we miss it" and "we think we don't" stay different colours. What
 * bounds it in practice is the `--summary-file` contract: reaching it requires
 * the harness's own notice to have been EDITED rather than captured.
 */

/**
 * `resets 7pm (America/Los_Angeles)` / `resets 7:30 pm (…)` / `resets 19:00 (…)`.
 *
 * Read inside the notice region only, for the same reason the capacity token is:
 * stray prose must not be able to set the retry instant. A summary whose notice
 * carries no reset falls back to the stated default backoff, which is the safe
 * direction — a longer wait, never a shorter one.
 */
const RESET_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z]+\/[A-Za-z_+-]+)\))?/i;

/** Wall-clock offset of `tz` at `epoch`, in ms. */
function tzOffsetMs(epoch: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epoch));
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // `hour12:false` renders midnight as 24 in some ICU versions.
  const hour = at("hour") % 24;
  const asUtc = Date.UTC(at("year"), at("month") - 1, at("day"), hour, at("minute"), at("second"));
  return asUtc - epoch;
}

/**
 * The next instant at which the wall clock in `tz` reads `hour:minute`, strictly
 * after `now`.
 *
 * The rollover is the thing that silently breaks: at 20:05 local, "resets 7pm"
 * means TOMORROW. A naive same-day construction returns an instant in the past,
 * and a ledger full of already-due records retries immediately, straight back
 * into the limit.
 */
export function zonedTimeToEpoch(hour: number, minute: number, tz: string, now: number): number {
  const dayMs = 24 * 60 * 60 * 1000;
  for (let addDays = 0; addDays <= 2; addDays++) {
    const probe = now + addDays * dayMs;
    const off = tzOffsetMs(probe, tz);
    const local = new Date(probe + off);
    const wall = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      hour,
      minute,
    );
    // Resolve the offset AT the candidate instant, so a DST boundary between
    // `now` and the target does not shift the answer by an hour.
    let epoch = wall - off;
    const settled = tzOffsetMs(epoch, tz);
    if (settled !== off) epoch = wall - settled;
    if (epoch > now) return epoch;
  }
  return now + dayMs;
}

export function classifyAgentDeath(summary: string, now: number): AgentDeath {
  const text = summary ?? "";
  // BOTH halves are required, and the second is read INSIDE the first. The marker
  // says the harness killed the process; the token, within that notice, says the
  // reason was capacity. A marker anywhere plus a token anywhere is not the same
  // claim — see NOTICE_END for the two counterexamples that proved it.
  const notice = terminationNotice(text);
  const terminated = notice !== undefined;
  const hasCapacityToken = notice !== undefined && RATE_LIMIT_TOKENS.some((re) => re.test(notice));
  if (!terminated || !hasCapacityToken) {
    // Distinguish "an agent said why it stopped" from "we have no idea", so a
    // report can say which. Neither is retryable.
    const kind: DeathKind = text.trim().length > 40 ? "task-failure" : "unknown";
    // Name WHICH half was absent, so a rejection cannot be mistaken for a
    // classifier that rejects everything — and so a genuine death the marker
    // list does not yet know is legible as exactly that.
    const missing = !terminated
      ? "no agent-termination notice — the summary is a report, not a death"
      : "an agent-termination notice, but its error type is not a capacity limit";
    return {
      kind,
      retryable: false,
      resetAt: null,
      resetSource: "none",
      reason:
        kind === "task-failure"
          ? `${missing} — treated as a real task outcome`
          : `${missing} — fail-closed to needs-human`,
    };
  }

  // Scoped to the notice, not the whole summary: the token already is, and a
  // retry instant taken from stray prose is the same defect in a quieter place.
  const m = RESET_RE.exec(notice);
  if (m) {
    let hour = Number(m[1]);
    const minute = Number(m[2] ?? 0);
    const mer = m[3]?.toLowerCase();
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    const tz = m[4];
    if (Number.isFinite(hour) && hour < 24 && Number.isFinite(minute) && minute < 60 && tz) {
      return {
        kind: "rate-limit",
        retryable: true,
        resetAt: zonedTimeToEpoch(hour, minute, tz, now),
        resetSource: "parsed",
        reason: `provider capacity limit; resets ${m[1]}${m[2] ? `:${m[2]}` : ""}${mer ?? ""} ${tz}`,
      };
    }
  }
  return {
    kind: "rate-limit",
    retryable: true,
    resetAt: now + DEFAULT_BACKOFF_MS,
    resetSource: "default-backoff",
    reason: "provider capacity limit; no parseable reset instant — using the stated default",
  };
}

/**
 * `in-flight` is the state the first draft was missing, and its absence was the
 * whole bug: `bump` counted an attempt and left the record `pending` with an
 * already-expired `notBefore`, so the next `due` poll handed the SAME brief out
 * again. Measured on the pre-fix CLI: three dispatches of one target in a few
 * seconds, the attempt cap burned, and the record parked at needs-human without
 * one retry ever having been given time to finish.
 *
 * A claimed state on its own would only trade that for a worse bug — a retry
 * that crashes mid-flight would wedge its record forever. So the claim carries
 * its holder, and {@link reclaimStaleClaims} is the way back out.
 */
export type RecordStatus = "pending" | "in-flight" | "needs-human" | "resolved";

/**
 * Ceiling on how long a claim may be held before it is reclaimable even though
 * its holder still looks alive.
 *
 * Needed because `lib/pid-liveness.ts` is one-directional on purpose: every path
 * where the instrument cannot answer (no `ps`, a claim taken on another host)
 * ends in `alive`, so that an over-eager verdict can never steal a live claim.
 * Without a ceiling that safety becomes a permanent stall. Six hours is chosen
 * to sit well above any real re-dispatch, so it never preempts live work — the
 * fast path out is the holder being provably gone, not this clock.
 */
export const DEFAULT_CLAIM_LEASE_MS = 6 * 60 * 60 * 1000;

/**
 * Who holds an in-flight claim. Field names match `OwnerRecord` in
 * `./pid-liveness.ts` so `evaluateOwnerLiveness` can read one directly — the
 * discriminator is the holder's own start time, which a recycled pid cannot fake.
 */
export interface RetryClaim {
  /**
   * The process actually doing the re-dispatch — NOT the CLI invocation that
   * stamped the claim, which exits within milliseconds. Measured while fixing
   * this: anchoring on the stamping process makes every claim look dead on the
   * very next poll, which is the duplicate dispatch back again wearing a claim.
   *
   * ABSENT is legitimate and means "liveness cannot be checked for this claim":
   * recovery then rests on {@link DEFAULT_CLAIM_LEASE_MS} alone. Slower, still
   * bounded, and visible in `due`'s output rather than silent.
   */
  pid?: number;
  processStartedAt?: number;
  startTimeSource?: "ps" | "proc";
  startedAt?: string;
  /** Epoch ms the claim was taken — the clock {@link DEFAULT_CLAIM_LEASE_MS} bounds. */
  at: number;
}

export interface RetryRecord {
  /** Idempotency key — the unit of work, so two deaths on one target collapse. */
  target: string;
  agentId: string;
  /** The brief to re-dispatch verbatim. A record without it is not actionable. */
  brief: string;
  /** Where partial work was preserved (branch or sha), if the agent left any. */
  wipRef: string | null;
  notBefore: number;
  attempts: number;
  maxAttempts: number;
  status: RecordStatus;
  /** Set exactly while `status === "in-flight"`; null otherwise. */
  claim: RetryClaim | null;
  recordedAt: number;
  reason: string;
}

export function recordFor(input: {
  agentId: string;
  target: string;
  brief: string;
  notBefore: number;
  wipRef?: string | null;
  reason?: string;
  maxAttempts?: number;
  now?: number;
}): RetryRecord {
  return {
    target: input.target,
    agentId: input.agentId,
    brief: input.brief,
    wipRef: input.wipRef ?? null,
    notBefore: input.notBefore,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    status: "pending",
    claim: null,
    recordedAt: input.now ?? Date.now(),
    reason: input.reason ?? "",
  };
}

/**
 * Take the record out of the dispatchable set and name who took it.
 *
 * This is what `bump` must do instead of only incrementing `attempts`. The
 * attempt count and the claim move TOGETHER: counting an attempt without
 * claiming is the duplicate-dispatch bug, and claiming without counting would
 * let a crash loop run forever.
 */
export function claimRecord(rec: RetryRecord, claim: RetryClaim): RetryRecord {
  rec.attempts += 1;
  rec.status = "in-flight";
  rec.claim = claim;
  return rec;
}

export type ReclaimReason = "no-holder" | "holder-gone" | "lease-expired" | "claim-in-future";

export interface ReclaimedClaim {
  target: string;
  reason: ReclaimReason;
  detail: string;
}

export interface ReclaimResult {
  reclaimed: ReclaimedClaim[];
  /** Claims still held after the sweep. Reported so "none in flight" and "the sweep never ran" differ. */
  inFlight: number;
}

/**
 * The way out of `in-flight` when a claim dies without resolving.
 *
 * Without this, adding a claimed state would trade a duplicate-dispatch bug for
 * a permanent-stall bug — a re-dispatcher killed by the very limit it was
 * waiting out would leave its record claimed forever, which is precisely the
 * silently-dropped work this ledger exists to stop.
 *
 * `attempts` is deliberately NOT reset. A record whose claims keep dying walks
 * its attempt budget down and lands on needs-human, so the loop terminates.
 */
export function reclaimStaleClaims(
  records: RetryRecord[],
  now: number,
  holderLiveness: (claim: RetryClaim) => { alive: boolean; detail?: string },
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): ReclaimResult {
  const reclaimed: ReclaimedClaim[] = [];
  let inFlight = 0;
  for (const r of records) {
    if (r.status !== "in-flight") continue;
    const claim = r.claim;
    let verdict: { reason: ReclaimReason; detail: string } | undefined;
    if (!claim) {
      // An in-flight record with no holder can never be shown to be finished.
      verdict = { reason: "no-holder", detail: "in-flight with no claim recorded" };
    } else {
      // A claim with no pid is UNANCHORED, not dead: the probe is never asked,
      // and the lease below is the only way out. Asking anyway would return
      // `no-owner-pid` → `alive: false` → instant reclaim, which is the
      // duplicate-dispatch defect restored.
      const live = claim.pid === undefined ? { alive: true } : holderLiveness(claim);
      if (!live.alive)
        verdict = {
          reason: "holder-gone",
          detail: live.detail ?? `pid ${claim.pid ?? "?"} is no longer the process that claimed it`,
        };
      else if (now < claim.at)
        // A claim stamped in the FUTURE never ages, so the lease can never
        // expire and an unanchored claim would wedge without bound — the exact
        // failure mode the lease exists to prevent, arriving through the clock
        // instead of through the holder. Reachable from an NTP step backwards or
        // a caller passing an inconsistent `--now`. Reclaim and say which.
        verdict = {
          reason: "claim-in-future",
          detail:
            `claim is stamped ${Math.round((claim.at - now) / 1000)}s in the future — ` +
            "the clock moved backwards, so the lease could never expire",
        };
      else if (now - claim.at >= leaseMs)
        verdict = {
          reason: "lease-expired",
          detail: `claim held ${Math.round((now - claim.at) / 60000)}min, past the ${Math.round(leaseMs / 60000)}min ceiling`,
        };
    }
    if (!verdict) {
      inFlight++;
      continue;
    }
    r.status = "pending";
    r.claim = null;
    reclaimed.push({ target: r.target, ...verdict });
  }
  return { reclaimed, inFlight };
}

export interface DueResult {
  due: RetryRecord[];
  needsHuman: RetryRecord[];
  /**
   * How many records were examined. Reported so a caller can tell "the ledger
   * holds nothing, because nothing was ever recorded" from "it holds twelve and
   * none are ripe". Those two render the same through `due.length` alone, and
   * the first one means the RECORDER is broken — the more urgent of the two.
   */
  scanned: number;
  pending: number;
  /**
   * Records a re-dispatcher is currently working on. Reported for the same
   * reason as `scanned`: "nothing is in flight" and "the claim mechanism never
   * fired" are different facts, and only one of them is fine.
   */
  inFlight: number;
}

export function dueRecords(all: readonly RetryRecord[], now: number): DueResult {
  const due: RetryRecord[] = [];
  const needsHuman: RetryRecord[] = [];
  let pending = 0;
  let inFlight = 0;
  for (const r of all) {
    // `in-flight` is EXCLUDED from `due` — that exclusion is the fix for the
    // duplicate-dispatch defect, so it is stated here rather than folded into
    // the generic "not pending" skip.
    if (r.status === "in-flight") {
      inFlight++;
      continue;
    }
    // A record whose status was PERSISTED as needs-human must still surface in
    // `needsHuman`, not vanish into `scanned` alone. Nothing writes that status
    // today — the cap is judged from `attempts` — but a status the reader silently
    // drops is how a future writer would make work invisible.
    if (r.status === "needs-human") {
      needsHuman.push(r);
      continue;
    }
    if (r.status !== "pending") continue;
    pending++;
    if (r.attempts >= r.maxAttempts) {
      needsHuman.push(r);
      continue;
    }
    if (r.notBefore <= now) due.push(r);
  }
  return { due, needsHuman, scanned: all.length, pending, inFlight };
}
