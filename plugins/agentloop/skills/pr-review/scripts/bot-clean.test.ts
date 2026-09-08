/**
 * The executable judge for ArcBlock/arc#6013 — "Codex `✅ Completed` read as
 * `bot clean`".
 *
 * ## Why a test file and not a paragraph in SKILL.md
 *
 * SKILL.md:127 ALREADY said 取失败 ≠ 没有 finding, in prose, before both
 * misreads happened. Prose did not stop them. #6013's own cost-gate says so:
 * 「散文规则在这条路径上已经被实测证伪一次了」. So the deliverable is this file
 * plus `bot-clean.ts`; the SKILL.md wording is the secondary half that points
 * at them.
 *
 * ## The accept-path iron law is the spine of this file
 *
 * This is a GATE ("is the bot clean?"), and **a gate that answers `not clean`
 * to everything satisfies every reject assertion in here**. The ACCEPT arm —
 * a real PR (#6097) that really was clean, on head, and must still be judged
 * clean — therefore comes first and is load-bearing. Without it, reverting the
 * whole judge to `() => "findings"` would leave this suite fully green.
 *
 * Every classifier the judge grew after the pre-PR adversarial review carries
 * its own accept/reject pair for the same reason. A "conversation comment is a
 * finding" filter that matches EVERYTHING satisfies the P1a arm — so §3b also
 * asserts the summary and the quota notice are NOT counted. A staleness test
 * that answers "stale" to everything satisfies the P1b arm — so §3c also
 * asserts the fresh 👍 is still clean.
 *
 * ## The mutation pair, in-suite and permanent
 *
 * `treatCompletedSummaryAsClean` re-creates the exact defect. Section 4 asserts
 * that turning it on flips every reject arm THAT CARRIES A `✅ Completed`
 * SUMMARY to `clean` (⇒ those arms go red) while leaving the accept arm
 * untouched (⇒ the mutation DISCRIMINATES, it is not a global wrecking ball).
 * The number of flipping arms is pinned — a fixture edit that quietly reduces
 * it to zero must not read as "the mutation still works".
 *
 * ## Positive control (CLAUDE.md 度量正控)
 *
 * The fixture enumeration is the instrument. Section 1 proves it can SEE
 * (pinned baseline counts, named arms) and proves an empty enumeration is
 * LOUD (`loadArmFixtures` on an empty dir throws) — 「数出来是 0」 and 「根本
 * 没数」 must not share a colour.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BotFaces,
  type BotState,
  buildVerdictLine,
  CODEX_VENDOR,
  EYES,
  enumerateUnknownBots,
  enumerateVendors,
  exitCodeFor,
  isBotClean,
  isSummaryComment,
  judgeBotReview,
  main,
  parseArgs,
  parsePaginatedArray,
  QUOTA_NOTICE_RE,
  RECOGNISED_REVIEW_VENDORS,
  SUMMARY_COMPLETED_RE,
  SUMMARY_MARKER,
  THUMBS_UP,
} from "./bot-clean.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const SKILL = fileURLToPath(new URL("../SKILL.md", import.meta.url));

/* ------------------------------------------------------------------ *
 * The fixture instrument
 * ------------------------------------------------------------------ */

interface ArmFixture {
  name: string;
  arm: "accept" | "reject";
  vendor: string;
  source: string;
  recordedAt: string;
  provenance: string;
  expect: { state: BotState; botFindings: number | "UNAVAILABLE" };
  expectVendors?: string[];
  faces: BotFaces;
}

/**
 * Enumerate the recorded-PR fixtures.
 *
 * **Empty enumeration THROWS.** A judge whose fixture directory silently went
 * empty would run zero arms and render exactly like one that ran all of them —
 * the #5638 `countExecutedTests` shape, in this suite. `PC-vacuous-scan` below
 * proves this throw actually fires, which is the part that is easy to get wrong
 * (a "control" that never fires is the thing it was written to prevent).
 */
function loadArmFixtures(dir: string): ArmFixture[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `bot-clean fixtures: enumerated ZERO fixtures under ${dir}. ` +
        `Refusing to report green — an empty arm set proves nothing.`,
    );
  }
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ArmFixture);
}

const FIXTURES = loadArmFixtures(FIXTURE_DIR);
const byName = (n: string): ArmFixture => {
  const f = FIXTURES.find((x) => x.name === n);
  if (!f) throw new Error(`fixture "${n}" is missing — the contract's arms are not all present`);
  return f;
};
const vendorComments = (f: ArmFixture) =>
  (f.faces.issueComments ?? []).filter((c) => c.user.login === CODEX_VENDOR);

/* ------------------------------------------------------------------ *
 * 1. Positive control — the instrument can see, and silence is loud
 * ------------------------------------------------------------------ */

describe("PC — the fixture enumeration is a working instrument", () => {
  /**
   * Pinned, not derived (CLAUDE.md: 「一个会自己更新的基线什么也没测量」). Bump
   * deliberately when an arm is added, and say why in the commit.
   */
  const ARM_BASELINE = { total: 8, accept: 1, reject: 7 };

  test("PC-vacuous-scan — an EMPTY fixture dir throws, it does not pass quietly", () => {
    const empty = mkdtempSync(join(tmpdir(), "bot-clean-empty-"));
    try {
      expect(() => loadArmFixtures(empty)).toThrow(/enumerated ZERO fixtures/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("PC-vacuous-scan — a dir with a fixture in it does NOT throw (the control discriminates)", () => {
    const one = mkdtempSync(join(tmpdir(), "bot-clean-one-"));
    try {
      writeFileSync(join(one, "x.json"), JSON.stringify(byName("accept-thumbsup-for-head-sha")));
      expect(loadArmFixtures(one)).toHaveLength(1);
    } finally {
      rmSync(one, { recursive: true, force: true });
    }
  });

  test("the enumerated arm counts match the pinned baseline", () => {
    expect(FIXTURES).toHaveLength(ARM_BASELINE.total);
    expect(FIXTURES.filter((f) => f.arm === "accept")).toHaveLength(ARM_BASELINE.accept);
    expect(FIXTURES.filter((f) => f.arm === "reject")).toHaveLength(ARM_BASELINE.reject);
  });

  test("every arm the #6013 contract and the pre-PR review name is present", () => {
    for (const n of [
      "accept-thumbsup-for-head-sha",
      "reject-completed-with-inline-findings",
      "reject-completed-no-thumbsup-empty-inline",
      "reject-conversation-face-finding",
      "reject-stale-thumbsup",
      "reject-quota-blocked",
    ]) {
      expect(FIXTURES.map((f) => f.name)).toContain(n);
    }
  });

  test("the arms are not all the same expectation (an all-identical set measures nothing)", () => {
    const states = new Set(FIXTURES.map((f) => f.expect.state));
    expect(states.size).toBeGreaterThanOrEqual(5);
  });

  test("every fixture carries provenance naming the real PR it was recorded from", () => {
    for (const f of FIXTURES) {
      expect(f.source).toMatch(/ArcBlock\/arc#\d+/);
      expect(f.provenance.length).toBeGreaterThan(60);
    }
  });

  test("every fixture records the head sha face (a missing one would silently disable §3c)", () => {
    for (const f of FIXTURES) expect(f.faces.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  /**
   * The 同色 fact this whole issue rests on, asserted rather than described:
   * the clean PR and the 3-finding PR publish the SAME summary status cell.
   */
  test("the accept arm and the findings arm publish an INDISTINGUISHABLE summary status", () => {
    const summaryOf = (f: ArmFixture) =>
      vendorComments(f).find((c) => c.body.includes(SUMMARY_MARKER))?.body ?? "";
    expect(SUMMARY_COMPLETED_RE.test(summaryOf(byName("accept-thumbsup-for-head-sha")))).toBe(true);
    expect(
      SUMMARY_COMPLETED_RE.test(summaryOf(byName("reject-completed-with-inline-findings"))),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 2. ACCEPT arm — a real clean PR, reviewed AT HEAD, must still be clean
 * ------------------------------------------------------------------ */

describe("ACCEPT — 👍 bound to head + both faces empty ⇒ bot clean", () => {
  const f = byName("accept-thumbsup-for-head-sha");

  test("judged clean", () => {
    const v = judgeBotReview(f.faces);
    expect(v.state).toBe("clean");
    expect(isBotClean(v)).toBe(true);
    expect(v.botFindings).toBe(0);
    expect(exitCodeFor(v)).toBe(0);
  });

  test("the 👍 it relies on is a real `+1` from the vendor, not from a human", () => {
    const r = (f.faces.issueReactions ?? []).find((x) => x.content === THUMBS_UP);
    expect(r?.user.login).toBe(CODEX_VENDOR);
  });

  test("the reviewed sha it relies on really IS head (else this arm proves nothing)", () => {
    const v = judgeBotReview(f.faces);
    const reviewed = v.signals.reviewedSha;
    expect(reviewed).toBeTruthy();
    expect(f.faces.headSha).toStartWith(reviewed as string);
  });

  test("a 👍 from a HUMAN is not the bot's signal", () => {
    const v = judgeBotReview({
      ...f.faces,
      issueReactions: [{ content: THUMBS_UP, user: { login: "mave99a" } }],
    });
    expect(v.state).not.toBe("clean");
  });
});

/* ------------------------------------------------------------------ *
 * 3. REJECT arms — every way "clean" must NOT be concluded
 * ------------------------------------------------------------------ */

describe("REJECT — `✅ Completed` is never on its own evidence of clean", () => {
  for (const f of FIXTURES.filter((x) => x.arm === "reject")) {
    test(`${f.name} (${f.source}) is NOT clean`, () => {
      const v = judgeBotReview(f.faces);
      expect(isBotClean(v)).toBe(false);
      expect(v.state).toBe(f.expect.state);
      expect(v.botFindings).toEqual(f.expect.botFindings);
      expect(exitCodeFor(v)).not.toBe(0);
    });
  }

  test("reject arm 1 — non-empty inline face outranks the summary (real #6011, 3 findings)", () => {
    const v = judgeBotReview(byName("reject-completed-with-inline-findings").faces);
    expect(v.state).toBe("findings");
    expect(v.botFindings).toBe(3);
    expect(v.signals.summaryCompleted).toBe(true);
  });

  test("reject arm 2 — no 👍 and an empty inline face is INCOMPLETE, not clean (real #6009)", () => {
    const v = judgeBotReview(byName("reject-completed-no-thumbsup-empty-inline").faces);
    expect(v.state).toBe("incomplete");
    expect(v.botFindings).toBe(0);
    expect(v.signals.summaryCompleted).toBe(true);
    expect(v.reason).toMatch(/👍|thumbs/i);
  });

  test("a failed inline fetch is UNAVAILABLE, never 0 (取失败 ≠ 没有 finding)", () => {
    const v = judgeBotReview(byName("reject-inline-fetch-unavailable").faces);
    expect(v.state).toBe("unavailable");
    expect(v.botFindings).toBe("UNAVAILABLE");
    expect(isBotClean(v)).toBe(false);
  });

  test("`null` and `[]` inline faces do not share a verdict", () => {
    const base = byName("reject-completed-no-thumbsup-empty-inline").faces;
    expect(judgeBotReview({ ...base, inlineComments: null }).state).toBe("unavailable");
    expect(judgeBotReview({ ...base, inlineComments: [] }).state).toBe("incomplete");
  });

  test("an unreadable reactions face is UNAVAILABLE, not `no 👍`", () => {
    const base = byName("accept-thumbsup-for-head-sha").faces;
    expect(judgeBotReview({ ...base, issueReactions: null }).state).toBe("unavailable");
    expect(judgeBotReview(base).state).toBe("clean");
  });

  test("an unreadable conversation face is UNAVAILABLE, not `absent`", () => {
    const base = byName("reject-completed-no-thumbsup-empty-inline").faces;
    expect(judgeBotReview({ ...base, issueComments: null }).state).toBe("unavailable");
    expect(judgeBotReview(base).state).toBe("incomplete");
  });

  test("an unreadable HEAD SHA is UNAVAILABLE — staleness cannot be judged without it", () => {
    const base = byName("accept-thumbsup-for-head-sha").faces;
    expect(judgeBotReview({ ...base, headSha: null }).state).toBe("unavailable");
    expect(judgeBotReview(base).state).toBe("clean");
  });

  test("a bot that never spoke at all is `absent`, not clean", () => {
    const v = judgeBotReview({
      headSha: "a".repeat(40),
      issueReactions: [],
      inlineComments: [],
      issueComments: [],
    });
    expect(v.state).toBe("absent");
    expect(isBotClean(v)).toBe(false);
  });

  test("👀 (review still running) is not clean", () => {
    const v = judgeBotReview({
      headSha: "a".repeat(40),
      issueReactions: [{ content: "eyes", user: { login: CODEX_VENDOR } }],
      inlineComments: [],
      issueComments: [],
    });
    expect(v.state).toBe("incomplete");
    expect(v.signals.eyes).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3b. P1a — findings on the CONVERSATION face (#5978 / #6015)
 *
 * Codex posts the whole review as a top-level issue comment when it cannot
 * attach to diff lines. Counting only `pulls/<n>/comments` printed
 * `botFindings=0` next to a live P1 — #6013 rebuilt inside its own fix.
 * ------------------------------------------------------------------ */

describe("P1a — a review posted as a top-level comment is a finding", () => {
  const f = byName("reject-conversation-face-finding");

  test("REJECT: #5978's top-level P1 is counted, with an EMPTY inline face", () => {
    const v = judgeBotReview(f.faces);
    expect(f.faces.inlineComments).toHaveLength(0);
    expect(v.state).toBe("findings");
    expect(v.botFindings).toBe(1);
    expect(v.signals.conversationFindings).toBe(1);
    expect(v.signals.inlineFindings).toBe(0);
  });

  test("the fixture really does carry the review body it claims (else it proves nothing)", () => {
    const body = vendorComments(f).find((c) => c.id === 5552106533)?.body ?? "";
    expect(body).toContain("Codex Review");
    expect(body).toContain("P1");
  });

  /**
   * ACCEPT-PATH for the classifier itself. "Every vendor comment is a finding"
   * satisfies the arm above; these two say it does not match everything.
   */
  test("ACCEPT: the SUMMARY comment is NOT counted as a finding", () => {
    const summary = vendorComments(f).find((c) => c.body.includes(SUMMARY_MARKER));
    expect(summary).toBeDefined();
    const only = judgeBotReview({ ...f.faces, issueComments: summary ? [summary] : [] });
    expect(only.signals.conversationFindings).toBe(0);
  });

  test("ACCEPT: the QUOTA notice is NOT counted as a finding", () => {
    const q = vendorComments(byName("reject-quota-blocked"))[0];
    expect(QUOTA_NOTICE_RE.test(q?.body ?? "")).toBe(true);
    const only = judgeBotReview({ ...f.faces, issueComments: q ? [q] : [] });
    expect(only.signals.conversationFindings).toBe(0);
  });

  test("ACCEPT: a HUMAN's top-level comment is not the vendor's finding", () => {
    const human = {
      id: 1,
      user: { login: "mave99a" },
      created_at: "2026-09-05T00:00:00Z",
      body: "### 💡 Codex Review\nP1 — quoted by a human",
    };
    expect(
      judgeBotReview({ ...f.faces, issueComments: [human] }).signals.conversationFindings,
    ).toBe(0);
  });

  test("both faces add up — inline and conversation findings are one total", () => {
    const inl = byName("reject-completed-with-inline-findings").faces.inlineComments ?? [];
    const v = judgeBotReview({ ...f.faces, inlineComments: inl });
    expect(v.signals.inlineFindings).toBe(3);
    expect(v.signals.conversationFindings).toBe(1);
    expect(v.botFindings).toBe(4);
  });
});

/* ------------------------------------------------------------------ *
 * 3c. P1b — the 👍 is per-PR and is never cleared, so it must be bound
 *      to a commit before it can mean anything.
 * ------------------------------------------------------------------ */

describe("P1b — a 👍 that names a commit which is not head is STALE, not clean", () => {
  const stale = byName("reject-stale-thumbsup");

  test("REJECT: #6070's 👍 named `44b4546`, head is `041fce5` ⇒ stale", () => {
    const v = judgeBotReview(stale.faces);
    expect(v.state).toBe("stale");
    expect(v.signals.thumbsUp).toBe(true);
    expect(v.signals.reviewedSha).toBe("44b4546");
    expect(stale.faces.headSha?.startsWith("041fce5")).toBe(true);
    expect(isBotClean(v)).toBe(false);
    expect(v.reason).toMatch(/44b4546/);
  });

  /** "always stale" would satisfy the arm above. This says it does not. */
  test("ACCEPT: a 👍 whose sha IS head stays clean", () => {
    expect(judgeBotReview(byName("accept-thumbsup-for-head-sha").faces).state).toBe("clean");
  });

  test("the comparison is a prefix match — a 7-char cell against a 40-char head", () => {
    const base = byName("accept-thumbsup-for-head-sha").faces;
    const head = base.headSha ?? "";
    expect(head.length).toBe(40);
    expect(
      judgeBotReview({ ...base, headSha: `${head.slice(0, 39)}${head[39] === "a" ? "b" : "a"}` })
        .state,
    ).toBe("clean");
    expect(judgeBotReview({ ...base, headSha: `0${head.slice(1)}` }).state).toBe("stale");
  });

  test("a 👍 with NO readable reviewed sha is `unbound` — not clean and not stale", () => {
    const base = byName("accept-thumbsup-for-head-sha").faces;
    const v = judgeBotReview({ ...base, issueComments: [] });
    expect(v.state).toBe("unbound");
    expect(isBotClean(v)).toBe(false);
    expect(v.signals.reviewedSha).toBeNull();
  });

  test("findings still outrank staleness — a stale PR with findings reads `findings`", () => {
    const inl = byName("reject-completed-with-inline-findings").faces.inlineComments ?? [];
    expect(judgeBotReview({ ...stale.faces, inlineComments: inl }).state).toBe("findings");
  });
});

/* ------------------------------------------------------------------ *
 * 3c-bis. Codex #6119 `3948679018` (P1) — a RETAINED 👍 must not survive
 *         an active review.
 *
 * Measured on THIS PR: the summary was created 10:05:50Z already naming head
 * `2de275e`, the three findings were published 10:10:18Z, and the Status cell
 * only became `✅ Completed` at 10:10:21Z. So `reviewedSha == head` holds for
 * 4.5 minutes BEFORE the conclusion exists. Reactions are never cleared (the
 * #6070/#6097 pair proves that), so any PR carrying a prior round's 👍 answered
 * `clean` throughout that window — reproduced against the accept fixture.
 *
 * `Completed` is still NOT evidence of clean. The new rule is the contrapositive
 * and only that: NOT-Completed guarantees NOT-clean.
 * ------------------------------------------------------------------ */

describe("P1 — a retained 👍 does not survive an active review", () => {
  const f = byName("accept-thumbsup-for-head-sha");
  const codexSummary = () => {
    const c = vendorComments(f).find((x) => x.body.includes(SUMMARY_MARKER));
    if (!c) throw new Error("accept fixture lost its summary comment");
    return c;
  };

  /**
   * THE ACCEPT ARM FOR THE NEW CONDITION. Without it, requiring `Completed`
   * and no-👀 satisfies every reject arm below in the reject-everything shape
   * this whole PR is about — the defect, a third time, inside its own fix.
   */
  test("ACCEPT: 👍 at head + `Completed` + no 👀 is still clean", () => {
    const v = judgeBotReview(f.faces);
    expect(v.state).toBe("clean");
    expect(v.signals.summaryCompleted).toBe(true);
    expect(v.signals.eyes).toBe(false);
    expect(exitCodeFor(v)).toBe(0);
  });

  test("REJECT: a retained 👍 with 👀 in flight is `running`, not clean", () => {
    const reactions = [
      ...(f.faces.issueReactions ?? []),
      { content: "eyes", user: { login: CODEX_VENDOR }, created_at: "2026-09-07T10:05:50Z" },
    ];
    const v = judgeBotReview({ ...f.faces, issueReactions: reactions });
    expect(v.state).toBe("running");
    expect(v.signals.thumbsUp).toBe(true);
    expect(v.signals.eyes).toBe(true);
    expect(isBotClean(v)).toBe(false);
  });

  test("REJECT: a retained 👍 while the Status cell is not `Completed` is `running`", () => {
    const running = {
      ...codexSummary(),
      body: codexSummary().body.replace("✅ **Completed**", "🔄 **In Progress**"),
    };
    const v = judgeBotReview({ ...f.faces, issueComments: [running] });
    expect(v.state).toBe("running");
    expect(v.signals.thumbsUp).toBe(true);
    expect(v.signals.summaryCompleted).toBe(false);
    expect(isBotClean(v)).toBe(false);
  });

  /**
   * The two variants differ in ONE cell of one table row. If the judge answered
   * the same for both, that byte would be carrying no information — which is the
   * whole shape of #6013.
   */
  test("the clean and running fixtures differ ONLY in the Status cell", () => {
    const done = codexSummary().body;
    const running = done.replace("✅ **Completed**", "🔄 **In Progress**");
    expect(running).not.toBe(done);
    expect(running.replace("🔄 **In Progress**", "✅ **Completed**")).toBe(done);
    expect(judgeBotReview({ ...f.faces, issueComments: [codexSummary()] }).state).toBe("clean");
    expect(
      judgeBotReview({ ...f.faces, issueComments: [{ ...codexSummary(), body: running }] }).state,
    ).toBe("running");
  });

  test("`running` still reports a countable botFindings and a reason naming the cause", () => {
    const v = judgeBotReview({
      ...f.faces,
      issueReactions: [
        ...(f.faces.issueReactions ?? []),
        { content: "eyes", user: { login: CODEX_VENDOR } },
      ],
    });
    expect(v.botFindings).toBe(0);
    expect(buildVerdictLine(v)).toContain("botFindings=0");
    expect(v.reason).toMatch(/👀|in flight|Completed/);
  });

  test("findings still outrank an in-flight review", () => {
    const inl = byName("reject-completed-with-inline-findings").faces.inlineComments ?? [];
    const v = judgeBotReview({
      ...f.faces,
      inlineComments: inl,
      issueReactions: [
        ...(f.faces.issueReactions ?? []),
        { content: "eyes", user: { login: CODEX_VENDOR } },
      ],
    });
    expect(v.state).toBe("findings");
  });
});

/* ------------------------------------------------------------------ *
 * 3d. P2b — "will never run" must not wear the colour of "still running"
 * ------------------------------------------------------------------ */

describe("P2b — a usage-limit notice is `blocked`, not `incomplete`", () => {
  const f = byName("reject-quota-blocked");

  test("REJECT: #5982's quota notice ⇒ blocked, and the reason does not say `wait`", () => {
    const v = judgeBotReview(f.faces);
    expect(v.state).toBe("blocked");
    expect(v.signals.quotaBlocked).toBe(true);
    expect(isBotClean(v)).toBe(false);
    expect(v.reason).toMatch(/never run|will not run|limit/i);
  });

  /** "everything is a quota notice" would satisfy the arm above. */
  test("ACCEPT: an ordinary summary comment is NOT read as a quota notice", () => {
    expect(judgeBotReview(byName("accept-thumbsup-for-head-sha").faces).signals.quotaBlocked).toBe(
      false,
    );
    expect(
      judgeBotReview(byName("reject-conversation-face-finding").faces).signals.quotaBlocked,
    ).toBe(false);
  });

  test("findings outrank a quota notice (a later run may have produced both)", () => {
    const inl = byName("reject-completed-with-inline-findings").faces.inlineComments ?? [];
    expect(judgeBotReview({ ...f.faces, inlineComments: inl }).state).toBe("findings");
  });

  /* ---------------------------------------------------------------- *
   * `blocked` must not be ABSORBING (#6119 codex `f1n2ryut`)
   *
   * The notice is a COMMENT, and comments are never deleted. Scanning the
   * whole history for one meant a PR that once hit the limit could never read
   * `clean` again — not even after the quota was restored and the vendor
   * completed a run on head, which is exactly what the `blocked` reason tells
   * you to go and do. Reproduced by prepending #5982's REAL notice to #6097's
   * REAL clean faces; nothing here is invented.
   * ---------------------------------------------------------------- */
  const notice = (f.faces.issueComments ?? []).filter((c) => c.user.login === CODEX_VENDOR);
  const cleanFaces = byName("accept-thumbsup-for-head-sha").faces;
  const recovered: BotFaces = {
    ...cleanFaces,
    issueComments: [...notice, ...(cleanFaces.issueComments ?? [])],
  };

  test("the reproduction really does carry the notice (else the arms below prove nothing)", () => {
    expect(notice.length).toBeGreaterThan(0);
    expect(judgeBotReview(recovered).signals.quotaBlocked).toBe(true);
  });

  test("ACCEPT: an earlier notice is superseded by a COMPLETED head-bound 👍", () => {
    const v = judgeBotReview(recovered);
    expect(v.state).toBe("clean");
    expect(isBotClean(v)).toBe(true);
  });

  /**
   * Supersession, not bypass. A rule that let ANY 👍 cancel the notice would
   * satisfy the accept arm above — these two pin the other end.
   */
  test("REJECT: a STALE 👍 does not cancel the notice — still blocked", () => {
    const v = judgeBotReview({ ...recovered, headSha: "f".repeat(40) });
    expect(v.state).toBe("blocked");
  });

  test("REJECT: a 👍 with a run still in flight does not cancel the notice", () => {
    const eyes = [
      ...(recovered.issueReactions ?? []),
      { content: EYES, user: { login: CODEX_VENDOR } },
    ];
    expect(judgeBotReview({ ...recovered, issueReactions: eyes }).state).toBe("blocked");
  });

  /* ---------------------------------------------------------------- *
   * The notice match must not swallow a finding that QUOTES it
   * (#6119 review F1) — a false-`clean` inside the false-`clean` judge
   *
   * A bare substring match did two things at once to a top-level review body
   * that mentions the phrase: `isReviewBody()` dropped it from
   * `conversationFindings`, AND `quotaBlocked` went true — which a head-bound
   * 👍 then superseded. Net result `state=clean botFindings=0` beside a live
   * P1. A review OF THIS FILE is exactly such a body.
   * ---------------------------------------------------------------- */
  const quotingFinding = {
    user: { login: CODEX_VENDOR },
    body:
      "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  " +
      "Anchor the quota notice match**\n\n`QUOTA_NOTICE_RE` matches any body containing " +
      '"reached your Codex usage limits", so a finding that quotes it is dropped.\n',
  };

  test("the quoting body really does contain the phrase (else this arm proves nothing)", () => {
    expect(quotingFinding.body).toContain("reached your Codex usage limits");
  });

  test("ACCEPT: a finding that QUOTES the notice is still counted, and is not a notice", () => {
    const s = judgeBotReview({ ...cleanFaces, issueComments: [quotingFinding] }).signals;
    expect(s.quotaBlocked).toBe(false);
    expect(s.conversationFindings).toBe(1);
  });

  test("REJECT: the exact false-`clean` construction now reads `findings`, not `clean`", () => {
    const faces: BotFaces = {
      ...cleanFaces,
      issueComments: [...(cleanFaces.issueComments ?? []), quotingFinding],
    };
    const v = judgeBotReview(faces);
    expect(v.state).toBe("findings");
    expect(v.botFindings).toBe(1);
    expect(isBotClean(v)).toBe(false);
  });

  /** Anchoring must not stop the REAL notice from matching — that is the other end. */
  test("ACCEPT: the real #5982 notice still matches from the comment's opening", () => {
    const real = notice[0]?.body ?? "";
    expect(QUOTA_NOTICE_RE.test(real)).toBe(true);
    expect(real.slice(0, 30)).toContain("reached your");
  });

  test("REJECT: the phrase buried after a paragraph is not an opener", () => {
    expect(QUOTA_NOTICE_RE.test(`Some earlier prose.\n\nYou have reached your usage limits`)).toBe(
      false,
    );
  });

  /* ---------------------------------------------------------------- *
   * The supersession must be ORDERED, not merely sha-matched
   * (#6119 codex `fidsouz`) — a regression introduced by the fix above
   *
   * The first cut compared only the sha, so a notice posted AFTER a completed
   * run on the same head was cancelled by that OLDER completion:
   * `quotaBlocked=true` and still `clean`. Over-refusal and under-refusal are
   * one edit apart here, so both ends are pinned.
   * ---------------------------------------------------------------- */
  const summaryAt = (cleanFaces.issueComments ?? []).find((c) =>
    c.body.includes(SUMMARY_MARKER),
  )?.created_at;

  test("the reproduction is well-formed: the clean fixture's summary carries a timestamp", () => {
    expect(summaryAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(summaryAt ?? ""))).toBe(false);
  });

  const noticeAfter = (iso: string) => ({
    user: { login: CODEX_VENDOR },
    created_at: iso,
    body: "You have reached your Codex usage limits for code reviews.\n",
  });

  test("REJECT: a notice posted AFTER the completed run is not superseded by it", () => {
    const later = new Date(Date.parse(summaryAt ?? "") + 60_000).toISOString();
    const v = judgeBotReview({
      ...cleanFaces,
      issueComments: [...(cleanFaces.issueComments ?? []), noticeAfter(later)],
    });
    expect(v.signals.quotaBlocked).toBe(true);
    expect(v.state).toBe("blocked");
  });

  test("ACCEPT: a notice posted BEFORE it still is (else the fix would just re-block everything)", () => {
    const earlier = new Date(Date.parse(summaryAt ?? "") - 60_000).toISOString();
    const v = judgeBotReview({
      ...cleanFaces,
      issueComments: [...(cleanFaces.issueComments ?? []), noticeAfter(earlier)],
    });
    expect(v.signals.quotaBlocked).toBe(true);
    expect(v.state).toBe("clean");
  });

  test("REJECT: an unorderable notice (no timestamp) is fail-closed, not superseded", () => {
    const undated = { user: { login: CODEX_VENDOR }, body: noticeAfter("x").body };
    const v = judgeBotReview({
      ...cleanFaces,
      issueComments: [...(cleanFaces.issueComments ?? []), undated],
    });
    expect(v.signals.latestQuotaAt).toBeNull();
    expect(v.state).toBe("blocked");
  });
});

/* ------------------------------------------------------------------ *
 * 3b-bis. The summary MARKER must identify the summary, not a quotation
 * ------------------------------------------------------------------ */

describe("the summary marker is anchored, so a finding that quotes it is still a finding", () => {
  const clean = byName("accept-thumbsup-for-head-sha").faces;

  /**
   * #6119 codex `fzrmpv0`. `body.includes(SUMMARY_MARKER)` classified any
   * comment MENTIONING the marker as the status comment — so a top-level
   * finding quoting it (a review of this file does, which is how it was
   * found) was dropped from `conversationFindings` and the verdict came back
   * `clean` beside a live P1.
   */
  const quotingMarker = {
    user: { login: CODEX_VENDOR },
    created_at: "2026-09-07T12:00:00Z",
    body:
      "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  " +
      "Anchor the marker test**\n\n`isReviewBody()` drops any body containing " +
      `\`${SUMMARY_MARKER}\`, so this very finding disappears.\n`,
  };

  test("the quoting body really does carry the marker (else this arm proves nothing)", () => {
    expect(quotingMarker.body).toContain(SUMMARY_MARKER);
    expect(quotingMarker.body.trimStart().startsWith(SUMMARY_MARKER)).toBe(false);
  });

  test("ACCEPT: the REAL summary is still recognised (anchoring did not blind it)", () => {
    const real = (clean.issueComments ?? []).find((c) => c.body.includes(SUMMARY_MARKER));
    expect(real).toBeTruthy();
    expect(isSummaryComment(real?.body ?? "")).toBe(true);
    expect(judgeBotReview(clean).signals.summaryCompleted).toBe(true);
  });

  test("REJECT: a finding that merely QUOTES the marker is not the summary", () => {
    expect(isSummaryComment(quotingMarker.body)).toBe(false);
  });

  test("REJECT: the exact false-`clean` construction now reads `findings`", () => {
    const v = judgeBotReview({
      ...clean,
      issueComments: [...(clean.issueComments ?? []), quotingMarker],
    });
    expect(v.state).toBe("findings");
    expect(v.botFindings).toBe(1);
    expect(isBotClean(v)).toBe(false);
  });

  test("the summary lookup and the review-body filter use the SAME predicate", () => {
    // Two notions of "is the summary" is how a comment ends up neither
    // counted nor read. With one predicate, the real summary is excluded from
    // findings and drives summaryCompleted; the quoting finding does neither.
    const v = judgeBotReview(clean);
    expect(v.signals.conversationFindings).toBe(0);
    expect(v.signals.summaryCompleted).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3d-bis. A SUCCESSFUL multi-page fetch must not read as a failed one
 * ------------------------------------------------------------------ */

describe("parsePaginatedArray — `gh --paginate` output, including page seams", () => {
  const one = '[{"id":1},{"id":2}]';

  test("ACCEPT: the measured gh 2.83.2 shape — one merged array — parses", () => {
    expect(parsePaginatedArray<{ id: number }>(one)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("ACCEPT: concatenated page documents flatten into one array", () => {
    expect(parsePaginatedArray<{ id: number }>('[{"id":1}][{"id":2}]')).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    // A trailing EMPTY page contributes nothing and is not a failure.
    expect(parsePaginatedArray<{ id: number }>('[{"id":1}]\n[{"id":2}]\n[]')).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  /**
   * The reason this is a scanner and not a `][` regex: a review comment body
   * containing those two characters would be corrupted by the naive repair.
   * This PR's own comments contain them.
   */
  test("ACCEPT: `][` INSIDE a string stays one document and one element", () => {
    const withSeamText = '[{"body":"`JSON.parse` on `][` seams"}]';
    const parsed = parsePaginatedArray<{ body: string }>(withSeamText);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.body).toContain("][");
  });

  test("ACCEPT: an empty body is an empty result (an empty page is not a failure)", () => {
    expect(parsePaginatedArray("")).toEqual([]);
    expect(parsePaginatedArray("  \n ")).toEqual([]);
    expect(parsePaginatedArray("[]")).toEqual([]);
  });

  /** Widening what parses must not weaken fail-closed. */
  test("REJECT: a truncated document is `null`, never a short array", () => {
    expect(parsePaginatedArray('[{"id":1}')).toBeNull();
    expect(parsePaginatedArray('[{"id":1}][{"id":2}')).toBeNull();
    expect(parsePaginatedArray('[{"body":"unterminated]')).toBeNull();
  });

  test("REJECT: a non-array document is `null` (an error object is not data)", () => {
    expect(parsePaginatedArray('{"message":"Not Found"}')).toBeNull();
    expect(parsePaginatedArray("null")).toBeNull();
    expect(parsePaginatedArray('[{"id":1}]{"message":"Not Found"}')).toBeNull();
  });

  test("REJECT: trailing garbage is `null`, not a silent truncation", () => {
    expect(parsePaginatedArray('[{"id":1}] oops')).toBeNull();
    expect(parsePaginatedArray('[{"id":1}]]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 3e. P2a — the accept-set enumerator (host-gate discipline)
 * ------------------------------------------------------------------ */

describe("P2a — which vendors are PRESENT is enumerated, not assumed", () => {
  const two = byName("reject-two-vendors-one-dirty");

  test("both vendors on the two-vendor fixture are enumerated", () => {
    const seen = enumerateVendors(two.faces);
    for (const v of two.expectVendors ?? []) expect(seen).toContain(v);
  });

  test("humans are not vendors", () => {
    expect(enumerateVendors(two.faces).some((v) => !v.endsWith("[bot]"))).toBe(false);
    expect(enumerateVendors(two.faces)).not.toContain("mave99a");
  });

  /**
   * Codex #6119 `3948679028`. `[bot]` is not the same predicate as "review
   * connector". Reproduced by the reviewer: an ordinary `github-actions[bot]`
   * "Deploy preview ready" status comment was judged `findings botFindings=1`,
   * because `isReviewBody()` is fail-closed and for an UNKNOWN vendor that
   * default points the wrong way. Not reachable in arc today (0 of the last 60
   * PRs), but this skill is declared repo-agnostic and any consuming repo with
   * a CI / coverage / preview bot goes permanently red on day one — and
   * permanently red is a synonym for ignored.
   */
  describe("only RECOGNISED review connectors are judged", () => {
    const ciBot = {
      id: 42,
      user: { login: "github-actions[bot]" },
      created_at: "2026-09-07T00:00:00Z",
      body: "Deploy preview ready: https://example.invalid/preview",
    };
    const withCi: BotFaces = {
      ...byName("accept-thumbsup-for-head-sha").faces,
      issueComments: [...(byName("accept-thumbsup-for-head-sha").faces.issueComments ?? []), ciBot],
    };

    test("ACCEPT: the recognised connectors are still enumerated", () => {
      expect(RECOGNISED_REVIEW_VENDORS).toContain(CODEX_VENDOR);
      expect(RECOGNISED_REVIEW_VENDORS).toContain("cursor[bot]");
      expect(enumerateVendors(two.faces)).toContain("cursor[bot]");
      expect(enumerateVendors(withCi)).toContain(CODEX_VENDOR);
    });

    test("REJECT: a CI bot is not enumerated as a review vendor", () => {
      expect(enumerateVendors(withCi)).not.toContain("github-actions[bot]");
    });

    test("a CI bot's status comment does not turn the command red", () => {
      const out: string[] = [];
      const code = main(["--pr", "1"], { fetchFaces: () => withCi, log: (s) => out.push(s) });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("state=clean");
    });

    /**
     * …but it must not vanish either. An unrecognised bot that IS a new review
     * connector would then be silently unjudged — "we looked and it was fine"
     * and "we never looked" sharing a colour, one level up.
     */
    test("PC: an unrecognised bot is REPORTED, not silently dropped", () => {
      expect(enumerateUnknownBots(withCi)).toEqual(["github-actions[bot]"]);
      const out: string[] = [];
      main(["--pr", "1"], { fetchFaces: () => withCi, log: (s) => out.push(s) });
      expect(out.join("\n")).toContain("unknownBot=github-actions[bot]");
    });

    test("PC discriminates — no unrecognised bot means no unknownBot line", () => {
      const out: string[] = [];
      main(["--pr", "1"], {
        fetchFaces: () => byName("accept-thumbsup-for-head-sha").faces,
        log: (s) => out.push(s),
      });
      expect(enumerateUnknownBots(byName("accept-thumbsup-for-head-sha").faces)).toEqual([]);
      expect(out.join("\n")).not.toContain("unknownBot=");
    });

    test("humans are never reported as unknown bots", () => {
      expect(enumerateUnknownBots(two.faces)).not.toContain("mave99a");
    });
  });

  test("a second vendor's findings are not invisible behind the default vendor", () => {
    const cursor = judgeBotReview(two.faces, { vendor: "cursor[bot]" });
    expect(cursor.state).toBe("findings");
    expect(cursor.botFindings).toBe(1);
  });

  test("PC — an empty vendor set is reported, not silently skipped", () => {
    const none: BotFaces = {
      headSha: "a".repeat(40),
      issueReactions: [],
      inlineComments: [],
      issueComments: [],
    };
    expect(enumerateVendors(none)).toEqual([]);
    const out: string[] = [];
    const code = main(["--pr", "1"], { fetchFaces: () => none, log: (s) => out.push(s) });
    expect(out.join("\n")).toContain("vendorsSeen=0");
    expect(code).not.toBe(0);
  });

  test("the CLI judges EVERY enumerated vendor when --vendor is not given", () => {
    const out: string[] = [];
    const code = main(["--pr", "6011"], { fetchFaces: () => two.faces, log: (s) => out.push(s) });
    const text = out.join("\n");
    expect(text).toContain("vendor=chatgpt-codex-connector[bot]");
    expect(text).toContain("vendor=cursor[bot]");
    expect(text).toMatch(/vendorsSeen=2/);
    expect(code).not.toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. THE MUTATION PAIR — revert the criterion, the reject arms go red
 * ------------------------------------------------------------------ */

describe("MUTATION — `Completed ⇒ clean` must break the reject arms and only them", () => {
  const MUTANT = { treatCompletedSummaryAsClean: true };
  /**
   * Pinned. The mutant can only reach arms that actually carry a `✅ Completed`
   * summary — #5982 (quota) has no summary at all. Deriving this number from
   * the fixtures would make a fixture edit that drops it to zero read as
   * "the mutation still works".
   */
  const MUTATION_FLIP_BASELINE = 6;

  const flippable = FIXTURES.filter(
    (f) => f.arm === "reject" && judgeBotReview(f.faces).signals.summaryCompleted,
  );

  test("the set of arms the mutation can reach is the pinned size", () => {
    expect(flippable).toHaveLength(MUTATION_FLIP_BASELINE);
  });

  for (const f of flippable) {
    test(`${f.name}: under the mutant the verdict flips to clean ⇒ its arm goes RED`, () => {
      const healthy = judgeBotReview(f.faces);
      const mutated = judgeBotReview(f.faces, MUTANT);
      expect(isBotClean(healthy)).toBe(false);
      expect(isBotClean(mutated)).toBe(true);
      expect(mutated.state).not.toBe(healthy.state);
    });
  }

  test("the accept arm is UNCHANGED by the mutant (the mutation discriminates)", () => {
    const f = byName("accept-thumbsup-for-head-sha");
    const healthy = judgeBotReview(f.faces);
    const mutated = judgeBotReview(f.faces, MUTANT);
    expect(mutated.state).toBe(healthy.state);
    expect(mutated.botFindings).toEqual(healthy.botFindings);
  });

  test("the knob is OFF by default — nothing has to opt out of correctness", () => {
    for (const f of FIXTURES) {
      expect(judgeBotReview(f.faces)).toEqual(
        judgeBotReview(f.faces, { treatCompletedSummaryAsClean: false }),
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. The number must always be printed (#6013 direction 2)
 * ------------------------------------------------------------------ */

describe("the verdict line always carries a countable botFindings", () => {
  test("zero prints as `botFindings=0`, not as an absent field", () => {
    const line = buildVerdictLine(judgeBotReview(byName("accept-thumbsup-for-head-sha").faces));
    expect(line).toContain("botFindings=0");
    expect(line).toContain("state=clean");
  });

  test("an unfetchable face prints UNAVAILABLE, never 0", () => {
    const line = buildVerdictLine(judgeBotReview(byName("reject-inline-fetch-unavailable").faces));
    expect(line).toContain("botFindings=UNAVAILABLE");
    expect(line).not.toContain("botFindings=0");
  });

  /** P3b — an absent byte must not render as a negative one. */
  test("signals derived from an UNREAD face print UNKNOWN, not false", () => {
    const base = byName("accept-thumbsup-for-head-sha").faces;
    const noRx = buildVerdictLine(judgeBotReview({ ...base, issueReactions: null }));
    expect(noRx).toContain("thumbsUp=UNKNOWN");
    expect(noRx).toContain("eyes=UNKNOWN");
    expect(noRx).not.toContain("thumbsUp=false");

    const noConv = buildVerdictLine(judgeBotReview({ ...base, issueComments: null }));
    expect(noConv).toContain("summaryCompleted=UNKNOWN");
    expect(noConv).not.toContain("summaryCompleted=false");
  });

  test("ACCEPT: a face that WAS read still prints a real boolean", () => {
    const line = buildVerdictLine(judgeBotReview(byName("accept-thumbsup-for-head-sha").faces));
    expect(line).toContain("thumbsUp=true");
    expect(line).not.toContain("UNKNOWN");
  });

  test("every arm's line names the vendor and the state", () => {
    for (const f of FIXTURES) {
      const line = buildVerdictLine(judgeBotReview(f.faces));
      expect(line).toContain(`vendor=${CODEX_VENDOR}`);
      expect(line).toMatch(
        /state=(clean|findings|stale|unbound|blocked|incomplete|absent|unavailable)/,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. CLI surface — it has to be runnable, with no bypass
 * ------------------------------------------------------------------ */

describe("CLI", () => {
  const fetcher = (name: string) => () => byName(name).faces;

  test("--pr <n> prints the verdict line and exits 0 only when clean", () => {
    const out: string[] = [];
    const code = main(["--pr", "6097", "--repo", "ArcBlock/arc"], {
      fetchFaces: fetcher("accept-thumbsup-for-head-sha"),
      log: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("botFindings=0");
  });

  test("a PR with findings exits non-zero", () => {
    const out: string[] = [];
    const code = main(["--pr", "6011"], {
      fetchFaces: fetcher("reject-completed-with-inline-findings"),
      log: (s) => out.push(s),
    });
    expect(code).not.toBe(0);
    expect(out.join("\n")).toContain("botFindings=3");
  });

  test("a fetch failure is fail-closed (exit 2), not a green", () => {
    const out: string[] = [];
    const code = main(["--pr", "6011"], {
      fetchFaces: fetcher("reject-inline-fetch-unavailable"),
      log: (s) => out.push(s),
    });
    expect(code).toBe(2);
  });

  test("missing --pr is a usage error, not a pass", () => {
    const out: string[] = [];
    const code = main([], {
      fetchFaces: fetcher("accept-thumbsup-for-head-sha"),
      log: (s) => out.push(s),
    });
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/--pr/);
  });

  /**
   * P3a. `--repo` with no value used to parse OK with `repo === undefined`,
   * and `gh` then silently resolved whatever repo the shell was in — a verdict
   * about a DIFFERENT PR, printed as if it were this one.
   */
  describe("a flag with a missing value is a usage error, never a silent default", () => {
    for (const argv of [["--pr", "6070", "--repo"], ["--pr", "6070", "--vendor"], ["--pr"]]) {
      test(`REJECT: ${JSON.stringify(argv)}`, () => {
        expect(parseArgs(argv).ok).toBe(false);
      });
    }
    test("ACCEPT: the same flags WITH values still parse", () => {
      const a = parseArgs(["--pr", "6070", "--repo", "ArcBlock/arc", "--vendor", "cursor[bot]"]);
      expect(a.ok).toBe(true);
    });
  });

  describe("argument validation is fail-closed (shell-injection surface)", () => {
    test("ACCEPT: real slugs and real bot logins are allowed", () => {
      expect(parseArgs(["--pr", "6070", "--repo", "ArcBlock/arc"]).ok).toBe(true);
      const b = parseArgs(["--pr", "6070", "--vendor", "cursor[bot]"]);
      expect(b.ok).toBe(true);
      expect(b.ok && b.vendor).toBe("cursor[bot]");
      expect(parseArgs(["--pr", "1", "--repo", "some-org.x/repo_name.js"]).ok).toBe(true);
    });

    for (const bad of [
      "a/b$(touch /tmp/pwned)",
      "a/b`id`",
      'a/b"; id; "',
      "a/b\nid",
      "not-a-slug",
      "a/b/c",
    ]) {
      test(`REJECT: --repo ${JSON.stringify(bad)}`, () => {
        expect(parseArgs(["--pr", "1", "--repo", bad]).ok).toBe(false);
      });
    }

    for (const bad of ["x$(id)", "x`id`", "x;id", "x y"]) {
      test(`REJECT: --vendor ${JSON.stringify(bad)}`, () => {
        expect(parseArgs(["--pr", "1", "--vendor", bad]).ok).toBe(false);
      });
    }
  });

  test("REJECT: there is no flag that turns a not-clean verdict into clean", () => {
    const src = readFileSync(fileURLToPath(new URL("./bot-clean.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/--force|--assume-clean|--skip/);
    expect(parseArgs(["--pr", "1", "--treat-completed-summary-as-clean"]).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 7. SKILL.md must WIRE the judge in, not merely mention it (#3142)
 * ------------------------------------------------------------------ */

describe("pr-review SKILL.md wires the judge into Step 0.4", () => {
  const text = readFileSync(SKILL, "utf8");

  test("Step 0.4 invokes bot-clean.ts with --pr", () => {
    expect(text).toMatch(/bot-clean\.ts[\s\S]{0,200}--pr/);
  });

  /**
   * P3c — the #5620 pin, ported from
   * `epic-conductor/scripts/assert-no-live-children.test.ts`. A doc that tells
   * a fleet runner to `bun .claude/plugins/...` runs arc's vendored copy, not
   * the installed plugin, in every OTHER repo that consumes this skill.
   */
  test("REJECT: the invocation does not use the vendored-in-arc relative plugin path", () => {
    expect(text).not.toMatch(/bun\s+["']?\.claude\/plugins\/agentloop[^\n]*bot-clean\.ts/);
  });

  test("ACCEPT: the invocation resolves through AGENTLOOP_ROOT", () => {
    expect(text).toMatch(/\$\{AGENTLOOP_ROOT:-[^\n]*\}\/skills\/pr-review\/scripts\/bot-clean\.ts/);
  });

  test("the doc states outright that `Completed` is NOT evidence of clean", () => {
    expect(text).toMatch(/Completed[\s\S]{0,200}(不是|never|不算)/);
  });

  test("the doc names 👍 as the authoritative no-findings signal", () => {
    expect(text).toMatch(/👍[\s\S]{0,300}(reaction|权威|authoritative)/);
  });

  test("the doc requires the count to be recorded, including zero", () => {
    expect(text).toMatch(/botFindings=/);
    expect(text).toMatch(/UNAVAILABLE/);
  });

  test("the doc routes every non-clean state, including the new ones", () => {
    for (const s of [
      "stale",
      "unbound",
      "blocked",
      "running",
      "incomplete",
      "absent",
      "unavailable",
    ]) {
      expect(text).toContain(`\`${s}\``);
    }
  });

  test("the doc tells the agent to enumerate vendors rather than assume one", () => {
    expect(text).toMatch(/vendorsSeen/);
  });

  test("REJECT: the doc offers no bypass for this judge", () => {
    expect(text).not.toMatch(/skip bot-clean|bot-clean\.ts.*--force/i);
  });

  test("the old byte-identical wording is gone — `👍 / 无 inline finding` alone no longer stands", () => {
    expect(text).not.toMatch(/👍 \/ 无 inline finding → 记「bot clean」/);
  });
});

/* ------------------------------------------------------------------ *
 * 8. P3d — the reason strings must state the mechanism CORRECTLY
 * ------------------------------------------------------------------ */

describe("the reason strings do not assert a mechanism that is not true", () => {
  /**
   * The first draft said the #6011 summary "landed 4 minutes BEFORE its own
   * findings". Its `created_at` is 09:05:51Z, but Codex EDITS the comment in
   * place — the body today carries `<relative-time datetime="…09:09:40Z">`,
   * i.e. AFTER the 09:09:37Z findings. The conclusion (Completed coexists with
   * findings) survives; the stated mechanism did not.
   */
  test("no reason string claims the summary predates the findings", () => {
    for (const f of FIXTURES) {
      expect(judgeBotReview(f.faces).reason).not.toMatch(
        /BEFORE its own findings|4 minutes BEFORE/,
      );
    }
  });

  test("the #6011 fixture really does carry a body timestamp AFTER its findings", () => {
    const f = byName("reject-completed-with-inline-findings");
    const summary = vendorComments(f).find((c) => c.body.includes(SUMMARY_MARKER));
    expect(summary?.created_at).toBe("2026-09-06T09:05:51Z");
    expect(summary?.body).toMatch(/datetime="2026-09-06T09:09:4/);
    expect((f.faces.inlineComments ?? [])[0]?.created_at).toBe("2026-09-06T09:09:37Z");
  });
});
