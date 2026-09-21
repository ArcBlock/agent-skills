/**
 * Tests for the agent-death classifier and the retry ledger (arc#6204).
 *
 * These carry the discipline the module exists to serve. A classifier that
 * matches NOTHING calls every death non-retryable — and "no 429s happened" and
 * "the detector is blind" are then the same colour. A classifier that matches
 * EVERYTHING retries genuine task failures, burning budget and repeating side
 * effects. So every reject here has an accept twin, and the pair is asserted
 * to land on DIFFERENT answers.
 */
import { describe, expect, test } from "bun:test";
import {
  claimRecord,
  classifyAgentDeath,
  DEFAULT_BACKOFF_MS,
  DEFAULT_CLAIM_LEASE_MS,
  dueRecords,
  type RetryRecord,
  reclaimStaleClaims,
  recordFor,
  terminationNotice,
  zonedTimeToEpoch,
} from "./agent-retry.ts";

/** The verbatim summary from arc#6204's first real occurrence. */
const REAL_429 =
  "Agent terminated early due to an API error: You've hit your session limit · " +
  "resets 7pm (America/Los_Angeles) (error type rate_limit, HTTP 429, " +
  "request id req_011Cepxg86xWpZaLeKb8EPy9, model sent to the API: claude-opus-5)";

const REAL_TASK_FAILURE =
  "Agent finished: the build fails on main and I could not reproduce the issue; " +
  "the linked issue describes a file that does not exist in this repo.";

/**
 * The case the original guard test MISSED. It picked an example containing no
 * `429` at all, so its reject arm passed while never touching the hole: the
 * signal set held a bare /\bHTTP\s*429\b/, and a worker REPORTING a 429 it
 * observed in the system under test matched it. Measured on the pre-fix code:
 * `retryable: true`.
 */
const TASK_FAILURE_MENTIONING_429 =
  "Agent finished: I added the retry coverage for the upstream client. The endpoint " +
  "under test returned HTTP 429 (error type rate_limit) on the third call, which is " +
  "the documented behaviour, so I asserted on it. Two tests still fail because the " +
  "fixture the issue describes does not exist in this repo.";

/** A termination notice whose API error is NOT a capacity limit. */
const REAL_TERMINATION_NOT_RATE_LIMITED =
  "Agent terminated early due to an API error: Overloaded " +
  "(error type overloaded_error, HTTP 529, request id req_011CepQQQQQQQQQQQQQQQQQQ)";

/** A real termination notice on a capacity limit that names no reset instant. */
const REAL_429_NO_RESET =
  "Agent terminated early due to an API error: rate limit exceeded " +
  "(error type rate_limit, HTTP 429, request id req_011CepZZZZZZZZZZZZZZZZZZ)";

// 2026-09-07 16:34 America/Los_Angeles === 23:34Z
const NOW_1634_PT = Date.parse("2026-09-07T23:34:00Z");
// 2026-09-07 20:05 America/Los_Angeles === 2026-09-08T03:05Z (past 7pm)
const NOW_2005_PT = Date.parse("2026-09-08T03:05:00Z");

describe("classifyAgentDeath", () => {
  test("ACCEPT — the real 429 summary is recognised as retryable", () => {
    // Without this, a classifier hardcoded to `retryable: false` would satisfy
    // every other test in this block.
    const d = classifyAgentDeath(REAL_429, NOW_1634_PT);
    expect(d.kind).toBe("rate-limit");
    expect(d.retryable).toBe(true);
  });

  test("ACCEPT — the reset instant is parsed, not defaulted", () => {
    const d = classifyAgentDeath(REAL_429, NOW_1634_PT);
    expect(d.resetSource).toBe("parsed");
    // 7pm PT on the same day === 02:00Z the next day.
    expect(d.resetAt).toBe(Date.parse("2026-09-08T02:00:00Z"));
  });

  test("REJECT — a genuine task failure is NOT retryable", () => {
    const d = classifyAgentDeath(REAL_TASK_FAILURE, NOW_1634_PT);
    expect(d.kind).toBe("task-failure");
    expect(d.retryable).toBe(false);
  });

  test("REJECT — an unrecognised death is NOT silently retryable (fail-closed)", () => {
    // Auto-retrying a real failure burns budget and can repeat side effects, so
    // "I don't know what this is" must land on needs-a-human, never on retry.
    const d = classifyAgentDeath("segfault", NOW_1634_PT);
    expect(d.kind).toBe("unknown");
    expect(d.retryable).toBe(false);
  });

  test("DISCRIMINATES — a rate limit and a task failure do not land on the same answer", () => {
    // The defect this module exists to remove: both arrive as status=failed.
    expect(classifyAgentDeath(REAL_429, NOW_1634_PT).retryable).not.toBe(
      classifyAgentDeath(REAL_TASK_FAILURE, NOW_1634_PT).retryable,
    );
  });

  test("a rate limit whose reset instant is unparseable still retries, on a STATED default", () => {
    const d = classifyAgentDeath(REAL_429_NO_RESET, NOW_1634_PT);
    expect(d.retryable).toBe(true);
    expect(d.resetSource).toBe("default-backoff");
    expect(d.resetAt).toBe(NOW_1634_PT + DEFAULT_BACKOFF_MS);
  });

  test("the rate-limit signal is the error type, not the prose", () => {
    // A task report that merely mentions the words must not be retried.
    const d = classifyAgentDeath(
      "I could not finish because the docs mention a session limit and rate limits.",
      NOW_1634_PT,
    );
    expect(d.retryable).toBe(false);
  });

  // ── The hole the test above did NOT cover (Codex P1-3) ────────────────────
  //
  // Its example contained no `429`, so the reject arm passed against a signal
  // set that keyed on a BARE status code anywhere in free text. The two tests
  // below are the pair that actually exercises it: a task report that DOES say
  // `HTTP 429` and `error type rate_limit`, and a termination notice that does
  // not. Both halves of the conjunction (death marker AND capacity token) are
  // load-bearing, and each is asserted separately.

  test("REJECT — a task report that MENTIONS HTTP 429 is a task outcome, not a death", () => {
    // Measured on the pre-fix classifier: retryable === true. The endpoint under
    // TEST returned the 429; the agent did not die of one.
    const d = classifyAgentDeath(TASK_FAILURE_MENTIONING_429, NOW_1634_PT);
    expect(d.retryable).toBe(false);
    expect(d.kind).toBe("task-failure");
    // And it must be rejected for the RIGHT reason: no termination marker, not
    // "the classifier happens to reject everything".
    expect(d.reason).toContain("no agent-termination notice");
  });

  test("REJECT — a real termination notice whose error type is NOT a capacity limit", () => {
    // The other half of the conjunction. An overload (529) is a death the
    // harness reports in the same shape, and it is not what this ledger retries.
    const d = classifyAgentDeath(REAL_TERMINATION_NOT_RATE_LIMITED, NOW_1634_PT);
    expect(d.retryable).toBe(false);
  });

  test("DISCRIMINATES — the death marker and the capacity token are BOTH required", () => {
    // Neither half alone may flip the answer; both together must. A classifier
    // that ignored one half would satisfy the accept test and one reject test.
    expect(classifyAgentDeath(REAL_429, NOW_1634_PT).retryable).toBe(true);
    expect(classifyAgentDeath(TASK_FAILURE_MENTIONING_429, NOW_1634_PT).retryable).toBe(false);
    expect(classifyAgentDeath(REAL_TERMINATION_NOT_RATE_LIMITED, NOW_1634_PT).retryable).toBe(
      false,
    );
  });

  // ── The SECOND round of the same mistake (review of the fix above) ─────────
  //
  // The fix required a marker AND a token, but tested each over the whole blob.
  // "a marker somewhere and a token somewhere" is not "a token inside the
  // notice", and the two reject tests above passed only because their fixtures
  // happened to lack the other half — the EXACT flaw the fix was written to
  // remove from the old guard test. Each fixture below is one of those same
  // reject fixtures plus ONE appended sentence, and each was measured retryable
  // before the notice region was introduced.

  test("REJECT — a token in a LATER sentence is not a token inside the notice", () => {
    const d = classifyAgentDeath(
      `${REAL_TERMINATION_NOT_RATE_LIMITED}. Earlier the suite logged "status 429" from the mock server.`,
      NOW_1634_PT,
    );
    expect(d.retryable).toBe(false);
  });

  test("REJECT — a task report that ends by mentioning the agent was terminated", () => {
    const d = classifyAgentDeath(
      `${TASK_FAILURE_MENTIONING_429} Note: the agent was terminated after the gate timed out.`,
      NOW_1634_PT,
    );
    expect(d.retryable).toBe(false);
    // Rejected for the right reason: "terminated" in prose is not the harness's
    // "terminated early", so there is no notice at all.
    expect(d.reason).toContain("no agent-termination notice");
  });

  test("the notice region ends at the sentence, and covers the whole real notice", () => {
    // Pinning the scoping directly, not only through the verdict. A region that
    // always returned the whole text, or always the first few words, would still
    // satisfy some verdict assertions above.
    expect(terminationNotice(REAL_429)).toBe(REAL_429); // one sentence, kept whole
    expect(terminationNotice(`${REAL_429}. Later I also saw a 500.`)).toBe(`${REAL_429}.`);
    expect(terminationNotice(REAL_TASK_FAILURE)).toBeUndefined();
    // A notice that does not start the summary is still found, and still bounded.
    expect(terminationNotice(`Context first. ${REAL_429}`)).toBe(REAL_429);
  });

  // ── Real 429 shapes a machine-token-only set rejected (review finding) ─────
  //
  // Both were missed before this fix too, so neither is a regression — but they
  // are the likeliest real arrivals, and failing closed on them is safe and
  // useless. Inside the notice the harness is the speaker, so the token set is
  // wider there than it could ever be over free text.

  test("ACCEPT — the plainest real 429 body: `rate_limit_error`, no `HTTP 429`", () => {
    // `/rate_limit\b/` cannot match `rate_limit_error`: `_` is a word character,
    // so the word boundary fails. Measured — this shape was NOT retryable.
    const d = classifyAgentDeath(
      'Agent terminated early due to an API error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      NOW_1634_PT,
    );
    expect(d.retryable).toBe(true);
  });

  test("ACCEPT — the real shape TRUNCATED before its trailing parenthetical", () => {
    // The machine-readable half sits at the END of that line, so any summary
    // truncation keeps the marker and drops the token.
    const d = classifyAgentDeath(
      "Agent terminated early due to an API error: You have hit your session limit · " +
        "resets 7pm (America/Los_Angeles)",
      NOW_1634_PT,
    );
    expect(d.retryable).toBe(true);
    // And the reset instant still parses out of the truncated form.
    expect(d.resetSource).toBe("parsed");
  });

  // ── The THIRD round of the same mistake, and the class-level answer ────────
  //
  // Round 2's boundary was `/\.[\s]+(?=[A-Z])|\n/` — a period, whitespace, and an
  // ASCII CAPITAL. The counterexample that motivated it began with "Earlier", so
  // the boundary was written against the shape of the one fixture that broke it.
  // Review then produced seven more from the SAME construction, varying only the
  // appended sentence's first character. Measured on that boundary: 8 of 10
  // classified a 529 / overloaded_error death as a retryable capacity limit.
  //
  // Named fixtures are what produced three rounds of this. The sweep below is the
  // class: every joiner × every leading character, generated, so the next variant
  // is covered before anyone thinks to look for it.

  const DEATH_529 =
    "Agent terminated early due to an API error: Overloaded " +
    "(error type overloaded_error, HTTP 529, request id req_01Y)";

  /** How an appended sentence can be attached to the notice. */
  const JOINERS = [
    ". ",
    ".  ",
    ".\t",
    ".\n",
    "! ",
    "!\n",
    "? ",
    "; ",
    ";\n",
    "。",
    "！",
    "？",
    "；",
    "\n",
    "\n\n",
  ];
  /** What it can start with. The 2026-09 defect was: only `A-Z` closed the notice. */
  const LEADERS = [
    "Earlier the suite", // capital — the ONE the old boundary handled
    "earlier the suite",
    "429 responses",
    '"status 429"',
    "`HTTP 429`",
    "模拟服务器返回",
    "[note] the mock",
    "(aside) the mock",
    "-- the mock",
    "…the mock",
    "🙂 the mock",
    "_the mock_",
    "$MOCK returned",
    "3 of the calls",
  ];

  test("CLASS — no appended sentence can lend its 429 to a notice that is not one", () => {
    // A 529 / overloaded_error death is NOT a capacity limit. Appending a
    // sentence that mentions 429 must never change that, whatever the sentence
    // looks like.
    const cases: string[] = [];
    const wrong: string[] = [];
    for (const joiner of JOINERS) {
      for (const leader of LEADERS) {
        const text = `${DEATH_529}${joiner}${leader} answered HTTP 429 (error type rate_limit).`;
        cases.push(text);
        if (classifyAgentDeath(text, NOW_1634_PT).retryable)
          wrong.push(`${JSON.stringify(joiner)} + ${JSON.stringify(leader)}`);
      }
    }
    // POSITIVE CONTROL on the generator itself: a sweep that produced nothing
    // would satisfy the assertion below without testing anything at all.
    expect(cases.length).toBe(JOINERS.length * LEADERS.length);
    expect(cases.length).toBeGreaterThan(150);
    expect(wrong).toEqual([]);
  });

  test("CLASS CONTROL — the sweep's own base strings still classify correctly", () => {
    // If the generator's base were malformed, every case would reject for the
    // wrong reason and the sweep above would be vacuously green.
    //
    // ASSERTING THE REASON, NOT THE REJECTION. This control was itself partially
    // vacuous: making DEATH_529 not a death notice at all left both this test and
    // the 210-case sweep green, because "rejected because it is a 529" and
    // "rejected because it is not a notice" were the same colour — inside the
    // control that exists to prevent exactly that. DEATH_529 must be a NOTICE
    // that fails on its error type.
    expect(terminationNotice(DEATH_529)).toBeDefined();
    const d529 = classifyAgentDeath(DEATH_529, NOW_1634_PT);
    expect(d529.retryable).toBe(false);
    expect(d529.reason).toContain("but its error type is not a capacity limit");
    expect(d529.reason).not.toContain("no agent-termination notice");
    expect(classifyAgentDeath(REAL_429, NOW_1634_PT).retryable).toBe(true);
    // And the appended sentence really does carry a token the classifier can see
    // — proven by finding it when it is the WHOLE summary's notice instead.
    expect(
      classifyAgentDeath(
        "Agent terminated early due to an API error: 429 answered (error type rate_limit).",
        NOW_1634_PT,
      ).retryable,
    ).toBe(true);
  });

  test("CLASS — the same sweep on a REAL 429 notice still accepts every case", () => {
    // The accept twin of the sweep. A boundary that shortened the region to
    // nothing would pass the reject sweep and fail here.
    let accepted = 0;
    for (const joiner of JOINERS) {
      for (const leader of LEADERS) {
        const text = `${REAL_429}${joiner}${leader} is unrelated commentary.`;
        if (classifyAgentDeath(text, NOW_1634_PT).retryable) accepted++;
      }
    }
    expect(accepted).toBe(JOINERS.length * LEADERS.length);
  });

  // ── The FOURTH instance: the defect moved from where the region ENDS to ───
  // ── where it STARTS. ──────────────────────────────────────────────────────
  //
  // `TERMINATION_MARKERS` held a bare `/\bagent (?:was )?terminated early\b/i`,
  // so ordinary report prose reached the marker mid-sentence and `NOTICE_END`
  // measured to the end of THAT sentence — exactly where a report discussing its
  // own death puts the capacity word. The docblock asserted this was safe, and a
  // ONE-WORD edit of the fixture it cited falsified it.
  //
  // Same lesson as the boundary: the class is generated, not enumerated.

  const REPORT_PREFIXES = [
    "Agent finished: ",
    "Note: ",
    "I could not finish — ",
    "Summary: ",
    "Result: ",
    "Context: ",
    "FYI ",
  ];
  const REPORT_SUBJECTS = [
    "the agent",
    "the worker agent",
    "my agent",
    "this agent",
    "the child agent",
  ];
  const REPORT_VERBS = [
    "was terminated",
    "terminated",
    "got terminated",
    "had been terminated",
    "was apparently terminated",
  ];
  const REPORT_TAILS = [
    ", so the remaining 429 assertions never ran.",
    " while I was asserting on the HTTP 429 path.",
    " and the rate_limit regression test never completed.",
    ", leaving the 429 fixture half-written.",
    " before the session limit case was covered.",
  ];

  test("CLASS — ordinary report prose saying an agent terminated early is NOT a death", () => {
    const cases: string[] = [];
    const wrong: string[] = [];
    for (const p of REPORT_PREFIXES)
      for (const s of REPORT_SUBJECTS)
        for (const v of REPORT_VERBS)
          for (const t of REPORT_TAILS) {
            const text = `${p}${s} ${v} early${t}`;
            cases.push(text);
            if (classifyAgentDeath(text, NOW_1634_PT).retryable) wrong.push(text);
          }
    // POSITIVE CONTROL on the generator, same discipline as the boundary sweep.
    expect(cases.length).toBe(875);
    expect(new Set(cases).size).toBe(875);
    expect(wrong).toEqual([]);
  });

  test("CLASS CONTROL — the report sentences really do carry a token the classifier sees", () => {
    // Without this, all 875 could be rejecting because the generator emits text
    // with no capacity word in it at all, and the sweep would prove nothing.
    const sentence = "the agent was terminated early, so the remaining 429 assertions never ran.";
    expect(/429/.test(sentence)).toBe(true);
    // The same words INSIDE a real harness header are still a death.
    expect(
      classifyAgentDeath(`Agent terminated early due to an API error: ${sentence}`, NOW_1634_PT)
        .retryable,
    ).toBe(true);
  });

  test("ONE WORD — the shipped reject fixture must not flip when 'after' becomes 'early'", () => {
    // The exact falsification of the old docblock's claim, kept as a fixture so
    // the claim cannot be re-asserted without this going red.
    const shipped = `${TASK_FAILURE_MENTIONING_429} Note: the agent was terminated after the gate timed out.`;
    const reworded = shipped.replace(
      "terminated after the gate timed out.",
      "terminated early, so the remaining 429 assertions never ran.",
    );
    expect(classifyAgentDeath(shipped, NOW_1634_PT).retryable).toBe(false);
    expect(classifyAgentDeath(reworded, NOW_1634_PT).retryable).toBe(false);
  });

  test("the marker requires the harness's COLON, not just its words", () => {
    // The colon is what makes it a header rather than a clause a human can write.
    expect(
      classifyAgentDeath(
        "Agent terminated early due to an API error: rate limit (error type rate_limit, HTTP 429)",
        NOW_1634_PT,
      ).retryable,
    ).toBe(true);
    expect(
      classifyAgentDeath(
        "The agent terminated early due to an API error and I saw HTTP 429 in the log",
        NOW_1634_PT,
      ).retryable,
    ).toBe(false);
  });

  test("at least two REJECT fixtures whose appended sentence is NOT capital-led", () => {
    // Named, not only generated: without these, "the boundary was fixed" and "the
    // boundary still only sees capitals" stay the same colour in a diff review.
    expect(
      classifyAgentDeath(`${DEATH_529}. 429 responses came from the mock.`, NOW_1634_PT).retryable,
    ).toBe(false);
    expect(
      classifyAgentDeath(`${DEATH_529}; the mock server answered HTTP 429 earlier`, NOW_1634_PT)
        .retryable,
    ).toBe(false);
    expect(
      classifyAgentDeath(`${DEATH_529}. 模拟服务器返回了 HTTP 429`, NOW_1634_PT).retryable,
    ).toBe(false);
  });

  test("KNOWN MISS — ANY non-terminator join stays inside the notice, at its real width", () => {
    // This was first written as "a comma-joined clause", naming 1 of at least 15
    // members and understating the miss by an order of magnitude. The disclosure
    // is now the measured list, and it is ASSERTED rather than described: adding
    // `,` to the terminator set immediately reds this test, so it cannot silently
    // expire, and "we know we miss it" and "we think we don't" stay different
    // colours.
    //
    // It CANNOT be closed by widening NOTICE_END — `,` `:` `/` `·` `(` `)` `'`
    // all occur INSIDE the real notice, so promoting any of them cuts a genuine
    // death short and reds the accept face. What bounds it in practice is the
    // --summary-file contract: reaching it means the harness's notice was EDITED.
    const NON_TERMINATOR_JOINS = [
      ", and later the mock returned 429",
      ": the mock returned 429",
      " — the mock returned 429",
      " – the mock returned 429",
      " … the mock returned 429",
      " / the mock returned 429",
      " | the mock returned 429",
      " · the mock returned 429",
      " -> the mock returned 429",
      " -- the mock returned 429",
      " + the mock returned 429",
      " & the mock returned 429",
      "\tthe mock returned 429",
      " (the mock returned 429)",
      ".the mock returned 429",
    ];
    const leaking = NON_TERMINATOR_JOINS.filter(
      (j) => classifyAgentDeath(`${DEATH_529}${j}`, NOW_1634_PT).retryable,
    );
    // The whole list is the disclosure. If any of these ever STOPS leaking, the
    // miss narrowed and this test must be updated to say so.
    expect(leaking.length).toBe(NON_TERMINATOR_JOINS.length);
    expect(NON_TERMINATOR_JOINS.length).toBeGreaterThanOrEqual(15);
  });

  test("the retry instant comes from the notice, not from stray prose", () => {
    // A `resets` in appended commentary must not set when we retry.
    const d = classifyAgentDeath(
      "Agent terminated early due to an API error: rate limit exceeded " +
        "(error type rate_limit, HTTP 429). The dashboard resets 3am (America/New_York).",
      NOW_1634_PT,
    );
    expect(d.retryable).toBe(true);
    expect(d.resetSource).toBe("default-backoff"); // NOT the prose's 3am
    expect(d.resetAt).toBe(NOW_1634_PT + DEFAULT_BACKOFF_MS);
  });

  test("REJECT — widening the token set did NOT open free text back up", () => {
    // The accept twin of the widening: `session limit` and a bare `429` are
    // legitimate INSIDE a notice and must stay inert outside one.
    for (const prose of [
      "Agent finished: the account limit doc says a bare 429 is retryable; I wrote the test.",
      "I could not finish: we have hit your session limit of open PRs in the org settings.",
      "Agent finished: rate-limit handling now backs off on 429 as the issue asked.",
    ]) {
      expect(classifyAgentDeath(prose, NOW_1634_PT).retryable).toBe(false);
    }
  });
});

describe("zonedTimeToEpoch — the rollover is the easy thing to get silently wrong", () => {
  test("ACCEPT — 7pm PT today when it is still 16:34 PT", () => {
    expect(zonedTimeToEpoch(19, 0, "America/Los_Angeles", NOW_1634_PT)).toBe(
      Date.parse("2026-09-08T02:00:00Z"),
    );
  });

  test("ROLLS OVER — 7pm PT means TOMORROW when it is already 20:05 PT", () => {
    expect(zonedTimeToEpoch(19, 0, "America/Los_Angeles", NOW_2005_PT)).toBe(
      Date.parse("2026-09-09T02:00:00Z"),
    );
  });

  test("the returned instant is always in the future", () => {
    for (const now of [NOW_1634_PT, NOW_2005_PT, Date.parse("2026-01-15T12:00:00Z")]) {
      expect(zonedTimeToEpoch(19, 0, "America/Los_Angeles", now)).toBeGreaterThan(now);
    }
  });

  test("handles a winter date too (standard time, not DST)", () => {
    // 7pm PST === 03:00Z next day; 7pm PDT === 02:00Z. A hardcoded offset fails one.
    expect(zonedTimeToEpoch(19, 0, "America/Los_Angeles", Date.parse("2026-01-15T12:00:00Z"))).toBe(
      Date.parse("2026-01-16T03:00:00Z"),
    );
  });
});

describe("dueRecords — 'scanned zero' must not look like 'nothing was due'", () => {
  const rec = (over: Partial<ReturnType<typeof recordFor>>) =>
    ({
      ...recordFor({ agentId: "a", target: "t", brief: "b", notBefore: 0 }),
      ...over,
    }) as ReturnType<typeof recordFor>;

  test("ACCEPT — a pending record whose time has come is due", () => {
    const r = dueRecords([rec({ notBefore: 100 })], 200);
    expect(r.due.length).toBe(1);
    expect(r.scanned).toBe(1);
  });

  test("REJECT — a record whose time has not come is not due", () => {
    expect(dueRecords([rec({ notBefore: 300 })], 200).due.length).toBe(0);
  });

  test("REJECT — a resolved record is never due again", () => {
    expect(dueRecords([rec({ notBefore: 0, status: "resolved" })], 200).due.length).toBe(0);
  });

  test("REJECT — a record over its attempt cap goes to needs-human, not to due", () => {
    const r = dueRecords([rec({ notBefore: 0, attempts: 3, maxAttempts: 3 })], 200);
    expect(r.due.length).toBe(0);
    expect(r.needsHuman.length).toBe(1);
  });

  test("POSITIVE CONTROL — an empty ledger and a ledger with nothing due differ in `scanned`", () => {
    // Both have due.length === 0. If a caller only prints that, "the ledger is
    // empty because nothing ever recorded" and "12 records, none ripe yet" are
    // the same line — and the first one means the recorder is broken.
    const empty = dueRecords([], 200);
    const notYet = dueRecords([rec({ notBefore: 300 })], 200);
    expect(empty.due.length).toBe(notYet.due.length);
    expect(empty.scanned).not.toBe(notYet.scanned);
  });

  test("DISCRIMINATES — due and not-due do not land on the same answer", () => {
    expect(dueRecords([rec({ notBefore: 100 })], 200).due.length).not.toBe(
      dueRecords([rec({ notBefore: 300 })], 200).due.length,
    );
  });

  test("REJECT — a CLAIMED record is not handed out again (the duplicate-dispatch defect)", () => {
    // Pre-fix: `bump` only did `attempts += 1`, leaving the record pending with
    // an expired notBefore, so this same poll returned it again. Measured: three
    // dispatches of one target in a few seconds and the cap burned.
    const claimed = claimRecord(rec({ notBefore: 0 }), { pid: process.pid, at: 100 });
    const r = dueRecords([claimed], 200);
    expect(r.due.length).toBe(0);
    expect(r.inFlight).toBe(1);
    // And it is NOT silently invisible: `scanned` still counts it.
    expect(r.scanned).toBe(1);
  });

  test("POSITIVE CONTROL — 'nothing in flight' and 'the claim never fired' differ in `inFlight`", () => {
    const nothingClaimed = dueRecords([rec({ notBefore: 300 })], 200);
    const oneClaimed = dueRecords([claimRecord(rec({ notBefore: 0 }), { pid: 1, at: 0 })], 200);
    expect(nothingClaimed.due.length).toBe(oneClaimed.due.length); // same through `due` alone
    expect(nothingClaimed.inFlight).not.toBe(oneClaimed.inFlight);
  });
});

describe("reclaimStaleClaims — a claimed record must not wedge forever", () => {
  const claimedRec = (over: Partial<RetryRecord> = {}, claimAt = 1_000_000): RetryRecord => {
    const r = { ...recordFor({ agentId: "a", target: "t", brief: "b", notBefore: 0 }), ...over };
    return claimRecord(r, { pid: 4242, at: claimAt, processStartedAt: 1, startTimeSource: "ps" });
  };
  const LIVE = () => ({ alive: true });
  const GONE = () => ({ alive: false, detail: "pid 4242 no longer exists (ESRCH)" });

  test("ACCEPT — a claim whose holder is ALIVE and inside its lease is left alone", () => {
    // Without this arm, a reclaimer hardcoded to reclaim everything would satisfy
    // every test below — and reclaiming a live claim re-creates the duplicate
    // dispatch the claim exists to prevent.
    const records = [claimedRec()];
    const r = reclaimStaleClaims(records, 1_000_001, LIVE);
    expect(r.reclaimed).toEqual([]);
    expect(r.inFlight).toBe(1);
    expect(records[0]?.status).toBe("in-flight");
  });

  test("RECOVERS — a claim whose holder is provably gone goes back to pending", () => {
    const records = [claimedRec()];
    const r = reclaimStaleClaims(records, 1_000_001, GONE);
    expect(r.reclaimed.map((x) => x.reason)).toEqual(["holder-gone"]);
    expect(records[0]?.status).toBe("pending");
    expect(records[0]?.claim).toBeNull();
    // It is dispatchable again — the whole point.
    expect(dueRecords(records, 1_000_002).due.length).toBe(1);
  });

  test("RECOVERS — a claim past its lease ceiling, even with a holder that looks alive", () => {
    // pid-liveness fails closed to `alive` wherever it cannot measure (no `ps`,
    // another host). Without the ceiling, that safety is a permanent stall.
    const records = [claimedRec()];
    const r = reclaimStaleClaims(records, 1_000_000 + DEFAULT_CLAIM_LEASE_MS, LIVE);
    expect(r.reclaimed.map((x) => x.reason)).toEqual(["lease-expired"]);
    expect(records[0]?.status).toBe("pending");
  });

  // An UNANCHORED claim — one with no holder pid — is what `bump` writes when the
  // caller cannot name a process that outlives the CLI invocation. Found by
  // mutation: replacing the unanchored branch with a plain liveness probe (which
  // answers `no-owner-pid` → not alive → instant reclaim, i.e. the duplicate
  // dispatch back) SURVIVED, because nothing here exercised a pid-less claim.
  test("ACCEPT — an UNANCHORED claim is held for its lease, not reclaimed on sight", () => {
    const r0 = { ...recordFor({ agentId: "a", target: "t", brief: "b", notBefore: 0 }) };
    const records = [claimRecord(r0, { at: 1_000_000 })]; // no pid
    const probed: string[] = [];
    const r = reclaimStaleClaims(records, 1_000_001, () => {
      probed.push("probed");
      return { alive: false };
    });
    expect(r.reclaimed).toEqual([]);
    expect(records[0]?.status).toBe("in-flight");
    // The probe is not even ASKED: "no pid" is unanchored, not dead.
    expect(probed).toEqual([]);
  });

  test("RECOVERS — an UNANCHORED claim still comes back once its lease expires", () => {
    const r0 = { ...recordFor({ agentId: "a", target: "t", brief: "b", notBefore: 0 }) };
    const records = [claimRecord(r0, { at: 1_000_000 })];
    const r = reclaimStaleClaims(records, 1_000_000 + DEFAULT_CLAIM_LEASE_MS, () => ({
      alive: true,
    }));
    expect(r.reclaimed.map((x) => x.reason)).toEqual(["lease-expired"]);
    expect(records[0]?.status).toBe("pending");
  });

  test("RECOVERS — a claim stamped in the FUTURE cannot wedge (the lease via the clock)", () => {
    // A future `claim.at` never ages, so `now - at >= leaseMs` is never true and
    // an unanchored claim would be held without bound. Reachable from an NTP step
    // backwards. The same wedge, arriving through the clock instead of the holder.
    const r0 = { ...recordFor({ agentId: "a", target: "t", brief: "b", notBefore: 0 }) };
    const records = [claimRecord(r0, { at: 2_000_000 })];
    const r = reclaimStaleClaims(records, 1_000_000, () => ({ alive: true }));
    expect(r.reclaimed.map((x) => x.reason)).toEqual(["claim-in-future"]);
    expect(records[0]?.status).toBe("pending");
  });

  test("ACCEPT — a claim stamped at exactly `now` is fresh, not 'in the future'", () => {
    // The boundary: an off-by-one here would reclaim every claim the instant it
    // was taken, which is the duplicate dispatch back again.
    const r0 = { ...recordFor({ agentId: "a", target: "t", brief: "b", notBefore: 0 }) };
    const records = [claimRecord(r0, { at: 1_000_000 })];
    const r = reclaimStaleClaims(records, 1_000_000, () => ({ alive: true }));
    expect(r.reclaimed).toEqual([]);
    expect(r.inFlight).toBe(1);
  });

  test("RECOVERS — an in-flight record with no holder at all is reclaimed", () => {
    const records = [claimedRec()];
    const target = records[0];
    if (target) target.claim = null;
    const r = reclaimStaleClaims(records, 1_000_001, LIVE);
    expect(r.reclaimed.map((x) => x.reason)).toEqual(["no-holder"]);
  });

  test("the attempt budget is NOT refunded, so a crash loop still terminates", () => {
    // Otherwise "reclaim on a dead holder" becomes an infinite retry engine: the
    // duplicate-dispatch bug back, wearing a claim.
    const records = [claimedRec({ attempts: 2, maxAttempts: 3 })]; // claimRecord makes it 3
    expect(records[0]?.attempts).toBe(3);
    reclaimStaleClaims(records, 1_000_001, GONE);
    expect(records[0]?.attempts).toBe(3);
    const r = dueRecords(records, 1_000_002);
    expect(r.due.length).toBe(0);
    expect(r.needsHuman.length).toBe(1);
  });

  test("DISCRIMINATES — live and gone holders do not land on the same answer", () => {
    const live = [claimedRec()];
    const gone = [claimedRec()];
    reclaimStaleClaims(live, 1_000_001, LIVE);
    reclaimStaleClaims(gone, 1_000_001, GONE);
    expect(live[0]?.status).not.toBe(gone[0]?.status);
  });

  test("resolved and pending records are untouched — the sweep only looks at claims", () => {
    const records: RetryRecord[] = [
      { ...recordFor({ agentId: "a", target: "p", brief: "b", notBefore: 0 }) },
      { ...recordFor({ agentId: "a", target: "r", brief: "b", notBefore: 0 }), status: "resolved" },
    ];
    const r = reclaimStaleClaims(records, 9_999_999, GONE);
    expect(r.reclaimed).toEqual([]);
    expect(records.map((x) => x.status)).toEqual(["pending", "resolved"]);
  });
});
