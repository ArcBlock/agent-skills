/**
 * The criteria ladder — `docs/architecture/verification-result-taxonomy.md` §4.2,
 * as executable code (arc#5612 · epic #5560 · W1.1b).
 *
 * ## What this module is, and what it deliberately is NOT
 *
 * It is an ORDERING, not a judge. Every rung above the fallback is fed by a
 * criterion some OTHER piece of code already decided — a probe that ran, a
 * signature a parser matched, a version comparison that read two numbers. This
 * module never re-derives any of that. arc's four existing classifiers
 * (`escapedFixtureEvidence` / `classifyOwnerLedgerContention` /
 * `reclassifyLocalhostDnsGap` / the `isTimeoutNoFail` expression, all in
 * `.claude/verify/checks/check-tests.ts`) are probe-backed and action-bearing;
 * §3.2's conclusion is that they are MORE advanced than the 12-class draft, and
 * that the job here is to make them speak one vocabulary, not to re-judge them.
 * Any change in one of their predicates is a regression, not a refinement.
 *
 * ## Why a TOTAL ORDER and not "they're mutually exclusive anyway"
 *
 * Today rungs 3 and 4 cannot both fire (`hookContention` demands the failing
 * package be exactly `@aigne/afs-code-agents#test`; the dns gap demands every
 * failing file be on its whitelist), and rung 5 is disjoint from both by
 * `failed === 0`. That disjointness is a property of TODAY'S predicates, not a
 * structural guarantee. Written as a total order, the next criterion anyone adds
 * still yields a deterministic class instead of depending on which `if` came
 * first in the file.
 *
 * ## R0 is the FLOOR, not the ceiling (§4.3 — the taxonomy's own key revision)
 *
 * The draft rule read "whatever else is also true in the same run, it's `CODE`".
 * That wording made two table rows unreachable: `classifyOwnerLedgerContention`
 * REQUIRES a `(fail)` block to match at all (it counts named failing tests), and
 * `PREEXISTING`'s criterion is "this NAMED failure reproduces on base" — so both
 * always carry the very signal the draft R0 claimed for `CODE`. Under the draft,
 * `CONTENTION` and `PREEXISTING` were dead classes and the M3b / M6b accept arms
 * were structurally unsatisfiable.
 *
 * So R0 is the LAST rung and is reached only when nothing named claimed the
 * evidence. It answers "this evidence is unclaimed — whose is it?", never
 * "nobody may claim it". {@link assertLadderIsTotalOrder} is evaluated at module
 * load, so a ladder that reorders R0 above a named rung, or grows a second
 * fallback, fails at import time in every consumer rather than in one test.
 *
 * This does not become #5493's forbidden "retry once and let it through",
 * because the guards are structural and live elsewhere: every rung above R0 is
 * narrow and probe-backed, the escaped-fixture veto sits at rung 1 above all of
 * them, and R2 forbids any of this from changing the gate's colour — a class
 * only changes the SENTENCE a consumer prints.
 */

import type { CheckFailure, FailureClass } from "./report.ts";

/**
 * Who has to act on this red. Per taxonomy §2.4 the actor is a property of the
 * REASON, not of the class: it is what forced `BUDGET` (a knob the red-holding
 * agent turns) out of `ENV_GAP` (a host capability that agent cannot install).
 */
export type FailureActor = "red-holding-agent" | "gate-maintainer" | "human";

/**
 * The closed reason vocabulary of §3.3. The three `CONTENTION` owner-ledger
 * entries are the literal members of `DegradedRetrySignature`
 * (`check-tests.ts`), copied so the wiring is an identity mapping rather than a
 * translation table that can drift.
 */
export const FAILURE_REASONS = {
  CODE: ["observed-test-failures", "nonzero-exit", "escaped-fixture"],
  BUDGET: ["budget-exhausted"],
  ENV_GAP: ["dns-localhost-subdomain-missing", "upstream-unreachable", "disk-exhausted"],
  TOOLCHAIN: ["bun-below-declared-engines", "package-manager-mismatch"],
  CONTENTION: [
    "owner-ledger-hook-timeouts",
    "owner-ledger-mixed-bun-timeout",
    "owner-ledger-watchdog-timeout",
    "killed-by-signal",
    "same-sha-prior-green",
  ],
  PREEXISTING: ["recorded-red-on-base"],
  UNKNOWN: ["no-check-result-produced"],
} as const satisfies Record<FailureClass, readonly string[]>;

export type FailureReason = (typeof FAILURE_REASONS)[FailureClass][number];

/** Reasons that name the `*.localhost` / upstream / disk env gaps. */
export type EnvGapReason = (typeof FAILURE_REASONS)["ENV_GAP"][number];

/** The three `DegradedRetrySignature` members plus the two generic ones. */
export type ContentionReason = (typeof FAILURE_REASONS)["CONTENTION"][number];

/**
 * The capability id whose PRESENCE means "this host does not have this gap".
 *
 * ## Why this table exists at all (arc#5612 review, P2-2)
 *
 * The same environment gap had grown TWO spellings — `stats.envGap`'s
 * `"dns-localhost-subdomain"` (the pre-taxonomy channel, written by
 * `applyLocalhostDnsGap`) and `failure.reason`'s
 * `"dns-localhost-subdomain-missing"` (this vocabulary). `observedEnvGaps()`
 * unioned them, so a repo that declared the probe cleared one identity and was
 * nagged forever about the other. Two spellings of one fact, inside the epic
 * whose entire subject is two spellings of one fact.
 *
 * ## Why the CAPABILITY id is canonical and not the taxonomy reason
 *
 * The consumer is `undeclaredEnvGaps()`, which subtracts the set of capabilities
 * a host DECLARES IT HAS. `dns-localhost-subdomain` is a capability;
 * `dns-localhost-subdomain-missing` is the ABSENCE of one, and no host can
 * declare an absence as something it has. Normalising the other way would have
 * moved the unclearable notice rather than removed it.
 *
 * The token is also the machine's, not the vocabulary's: it is what
 * `scripts/agent-capabilities.sh` prints, and a `CapabilityProbe.id` is the same
 * string. Taking the identity from the probe's own output keeps it on the
 * substrate `oversight-discipline.md` calls unforgeable, one layer below the
 * words we chose to describe it. `failure.reason` is untouched — §2.1's class
 * table and §3.3's reason column are exactly as written; only the ENV-GAP
 * IDENTITY (a different axis) is normalised.
 *
 * ## `null` is a statement, not a hole
 *
 * `null` means NO probe emits a tag for this gap yet, so the reason is its own
 * identity until one ships. The alternative — inventing a plausible id like
 * `disk-space` that nothing probes — is a guessed equivalence, and a guessed
 * equivalence is the same colour as a measured one. The canonical probe emits
 * exactly `native-ios` / `native-android` / `gh-cli` / `dns-localhost-subdomain`;
 * that list is the whole basis for this table.
 *
 * Exhaustive by TYPE: adding an `ENV_GAP` reason without deciding its identity
 * does not compile.
 */
export const ENV_GAP_CAPABILITY: Readonly<Record<EnvGapReason, string | null>> = {
  "dns-localhost-subdomain-missing": "dns-localhost-subdomain",
  // #5386's shape. No capability probe emits an upstream tag today, so this
  // stays its own identity; ship a probe and put its id here.
  "upstream-unreachable": null,
  // Likewise: no disk probe exists. Not guessing one.
  "disk-exhausted": null,
};

/**
 * The identity an observed env gap is counted under, whichever spelling reported
 * it. Unmapped reasons pass through VERBATIM — never prefix-matched, never
 * trimmed to a stem. A repo may coin its own `ENV_GAP` reason, and folding it
 * into a neighbour by string surgery would be exactly the guessed equivalence
 * {@link ENV_GAP_CAPABILITY} refuses to make.
 */
export function envGapIdentity(reason: string): string {
  const mapped = (ENV_GAP_CAPABILITY as Readonly<Record<string, string | null | undefined>>)[
    reason
  ];
  return mapped ?? reason;
}

/**
 * §3.3's per-reason actor column. Exhaustive by construction: the key type is
 * the reason union, so adding a reason without an actor is a type error.
 */
export const FAILURE_ACTORS: Readonly<Record<FailureReason, FailureActor>> = {
  "observed-test-failures": "red-holding-agent",
  "nonzero-exit": "red-holding-agent",
  "escaped-fixture": "red-holding-agent",
  "budget-exhausted": "red-holding-agent",
  "dns-localhost-subdomain-missing": "gate-maintainer",
  "upstream-unreachable": "gate-maintainer",
  "disk-exhausted": "gate-maintainer",
  "bun-below-declared-engines": "red-holding-agent",
  "package-manager-mismatch": "red-holding-agent",
  "owner-ledger-hook-timeouts": "red-holding-agent",
  "owner-ledger-mixed-bun-timeout": "red-holding-agent",
  "owner-ledger-watchdog-timeout": "red-holding-agent",
  "killed-by-signal": "red-holding-agent",
  "same-sha-prior-green": "red-holding-agent",
  "recorded-red-on-base": "red-holding-agent",
  "no-check-result-produced": "human",
};

/** The class a reason belongs to. Derived from {@link FAILURE_REASONS}. */
export const CLASS_OF_REASON: Readonly<Record<FailureReason, FailureClass>> = Object.fromEntries(
  Object.entries(FAILURE_REASONS).flatMap(([cls, reasons]) =>
    (reasons as readonly string[]).map((r) => [r, cls as FailureClass]),
  ),
) as Record<FailureReason, FailureClass>;

/**
 * Everything the ladder is allowed to look at — all of it ALREADY DECIDED by a
 * named criterion elsewhere. There is no raw log here on purpose: a field that
 * took a log would invite this module to grow a predicate of its own, and the
 * whole point of W1.1b is that the predicates stay where they are.
 *
 * Every field is optional and its absence means "this criterion did not fire /
 * is not available on this host". Absence therefore falls THROUGH to R0, which
 * is exactly R1 ("criterion absent ⇒ `CODE`, never some other class").
 */
export interface LadderSignals {
  /**
   * Rung 1 — the lines {@link escapedFixtureEvidence} found. A leak is an
   * independent hard failure: "never contention, never an env gap, and never
   * retryable" (#5081). Non-empty vetoes every rung below.
   */
  escapedFixture?: readonly string[];
  /**
   * Rung 2 — R4. True when a NAMED failure's file is inside the three-point
   * diff. `PREEXISTING` / `CONTENTION` / `ENV_GAP` / `BUDGET` are unavailable
   * then, by construction rather than by remembering to check.
   */
  namedFailureInDiff?: boolean;
  /** Rung 3 — `classifyOwnerLedgerContention().signature`, verbatim. */
  contentionSignature?: ContentionReason;
  /** Rung 3 — terminated by a signal rather than by exhausting its budget. */
  killedBySignal?: boolean;
  /**
   * Rung 4 — set ONLY when a capability probe reported the gap. The caller
   * passes the reason its own probe names; it never re-runs the probe here.
   */
  envGap?: EnvGapReason;
  /** Rung 5 — `timedOut === true && (fail ?? 0) === 0`, verbatim. */
  budgetExhausted?: boolean;
  /** Rung 6 — set only when measured ≠ declared; both numbers are readable. */
  toolchainMismatch?: { tool: string; measured: string; declared: string };
  /** Rung 7 — the named failure reproduced on merge-base with zero changes. */
  recordedRedOnBase?: boolean;
  /** Rung 7 — the same `(sha, check)` has a recorded green (§7.4: one-shot). */
  sameShaPriorGreen?: boolean;
  /**
   * Picks R0's reason: `stats.failed >= 1` ⇒ `observed-test-failures`, a bare
   * non-zero exit with nothing parsed ⇒ `nonzero-exit`. It never decides the
   * CLASS — that is the whole of §4.3.
   */
  observedTestFailures?: boolean;
}

export interface LadderRung {
  /** 1-based position in the total order. */
  rung: number;
  /** Stable id, quotable in a report or an issue. */
  id: string;
  /**
   * Every class this rung may hand out. Usually one; rung 7 has two because
   * §4.2 puts "reproduces on base" and "this (sha, check) already went green"
   * on the SAME rung with different answers. The class actually returned is
   * always {@link CLASS_OF_REASON} of the claimed reason — derived, never
   * stated twice — so a rung cannot declare one class and return another.
   */
  classes: readonly FailureClass[];
  /** Exactly one rung carries this, and it must be the last one. */
  fallback?: true;
  /** One line saying what this rung reads. Rendered by `explainLadder()`. */
  why: string;
  /** The reason this rung claims the evidence with, or `undefined` to pass. */
  claim(s: LadderSignals): FailureReason | undefined;
}

const r0Reason = (s: LadderSignals): FailureReason =>
  s.observedTestFailures ? "observed-test-failures" : "nonzero-exit";

/**
 * §4.2's ladder, in order. Read top to bottom; first claim wins.
 *
 * Rung 6 has no producer in arc today (nothing in `.claude/verify/checks/`
 * compares a measured tool version against `package.json`'s `engines`). It is
 * on the ladder anyway because the ORDER is the deliverable: leaving a hole
 * would mean the next producer has to decide its own precedence, which is the
 * fifth vocabulary this epic exists to prevent. Its accept arm is exercised
 * against the ladder directly, which is where the ordering lives.
 */
export const CRITERIA_LADDER: readonly LadderRung[] = [
  {
    rung: 1,
    id: "escaped-fixture-veto",
    classes: ["CODE"],
    why: "escapedFixtureEvidence() found leak lines — an independent hard failure (#5081)",
    claim: (s) => ((s.escapedFixture?.length ?? 0) > 0 ? "escaped-fixture" : undefined),
  },
  {
    rung: 2,
    id: "named-failure-in-diff",
    classes: ["CODE"],
    why: "R4 — a named failure's file is inside the three-point diff",
    claim: (s) => (s.namedFailureInDiff === true ? r0Reason(s) : undefined),
  },
  {
    rung: 3,
    id: "contention-signature",
    classes: ["CONTENTION"],
    why: "a named contention signature, or termination by signal rather than by budget",
    claim: (s) =>
      s.contentionSignature ?? (s.killedBySignal === true ? "killed-by-signal" : undefined),
  },
  {
    rung: 4,
    id: "capability-probe-gap",
    classes: ["ENV_GAP"],
    why: "a capability probe reported this host is missing something the agent cannot install",
    claim: (s) => s.envGap,
  },
  {
    rung: 5,
    id: "budget-exhausted",
    classes: ["BUDGET"],
    why: "timedOut === true && (fail ?? 0) === 0 — killed by the watchdog with nothing observed red",
    claim: (s) => (s.budgetExhausted === true ? "budget-exhausted" : undefined),
  },
  {
    rung: 6,
    id: "toolchain-version-mismatch",
    classes: ["TOOLCHAIN"],
    why: "measured tool version ≠ the version this repo declares; both numbers are readable",
    claim: (s) => (s.toolchainMismatch ? "bun-below-declared-engines" : undefined),
  },
  {
    rung: 7,
    id: "recorded-on-base-or-prior-green",
    classes: ["PREEXISTING", "CONTENTION"],
    why: "the named failure reproduces on merge-base unchanged, or this (sha, check) has a recorded green",
    claim: (s) =>
      s.recordedRedOnBase === true
        ? "recorded-red-on-base"
        : s.sameShaPriorGreen === true
          ? "same-sha-prior-green"
          : undefined,
  },
  {
    rung: 8,
    id: "R0",
    classes: ["CODE"],
    fallback: true,
    why: "R0 — no named criterion claimed this evidence",
    claim: (s) => r0Reason(s),
  },
];

/**
 * Structural problems with a ladder, as sentences. Empty = well-formed.
 *
 * These are the invariants that make "named criteria outrank R0" a property of
 * the DATA rather than a claim in a comment: exactly one fallback, and it is
 * last. Everything else here keeps the total order total.
 */
export function assertLadderIsTotalOrder(ladder: readonly LadderRung[]): string[] {
  const problems: string[] = [];
  if (ladder.length === 0) return ["ladder is empty — every failure would be UNCLASSIFIED"];
  ladder.forEach((rung, i) => {
    if (rung.rung !== i + 1) {
      problems.push(
        `rung ${rung.id} is at index ${i} but numbered ${rung.rung} — not a total order`,
      );
    }
  });
  const ids = ladder.map((r) => r.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) problems.push(`duplicate rung id(s): ${[...new Set(dupes)].join(", ")}`);
  const fallbacks = ladder.filter((r) => r.fallback === true);
  if (fallbacks.length !== 1) {
    problems.push(
      `expected exactly 1 fallback rung, found ${fallbacks.length} — R0 is the floor, and a ladder with none (or two) has no defined answer for unclaimed evidence`,
    );
  }
  const last = ladder[ladder.length - 1];
  if (fallbacks.length === 1 && last?.fallback !== true) {
    problems.push(
      `the fallback rung is \`${fallbacks[0]!.id}\` at position ${fallbacks[0]!.rung}, not last (${ladder.length}) — R0 above a named rung makes CONTENTION / PREEXISTING unreachable (§4.3)`,
    );
  }
  for (const rung of ladder) {
    if (rung.classes.length === 0) {
      problems.push(`rung ${rung.id} declares no class`);
      continue;
    }
    const allowed: readonly string[] = rung.classes.flatMap((c) => [...FAILURE_REASONS[c]]);
    // Probe the rung with a maximal signal set: whatever it claims there must
    // still belong to its own class.
    const claimed = rung.claim({
      escapedFixture: ["x"],
      namedFailureInDiff: true,
      contentionSignature: "owner-ledger-hook-timeouts",
      killedBySignal: true,
      envGap: "dns-localhost-subdomain-missing",
      budgetExhausted: true,
      toolchainMismatch: { tool: "bun", measured: "1.3.11", declared: ">=1.3.14" },
      recordedRedOnBase: true,
      sameShaPriorGreen: true,
      observedTestFailures: true,
    });
    if (claimed !== undefined && !allowed.includes(claimed)) {
      problems.push(
        `rung ${rung.id} claims reason \`${claimed}\`, which is not in class ${rung.classes.join(" | ")}`,
      );
    }
  }
  return problems;
}

// Build-time (import-time) enforcement, not a test-only assertion: a ladder
// edit that subordinates a named rung to R0 must break every consumer at once.
{
  const problems = assertLadderIsTotalOrder(CRITERIA_LADDER);
  if (problems.length > 0) {
    throw new Error(
      `CRITERIA_LADDER is malformed (taxonomy §4.2):\n  - ${problems.join("\n  - ")}`,
    );
  }
}

/**
 * Walk the ladder and return the class + reason for a red.
 *
 * Deterministic and total: the last rung claims unconditionally, so this never
 * returns `undefined` and never returns `UNKNOWN`. `UNKNOWN` is not on the
 * ladder at all — it is synthesised by the runner when no `CheckResult` was
 * produced (`runCheckGuarded`, scenario.ts), which is a state no check-level
 * classifier can observe from inside itself (§5.4).
 */
export function classifyFailure(signals: LadderSignals): CheckFailure {
  for (const rung of CRITERIA_LADDER) {
    const reason = rung.claim(signals);
    if (reason !== undefined) return { class: CLASS_OF_REASON[reason], reason };
  }
  // Unreachable while the fallback invariant above holds; fail closed loudly
  // rather than inventing a class.
  throw new Error("CRITERIA_LADDER claimed nothing — the fallback rung is missing");
}

/** Which rung claimed, for reports and tests that assert the ORDER, not just the class. */
export function classifyFailureRung(signals: LadderSignals): LadderRung {
  for (const rung of CRITERIA_LADDER) {
    if (rung.claim(signals) !== undefined) return rung;
  }
  throw new Error("CRITERIA_LADDER claimed nothing — the fallback rung is missing");
}

/** The actor who must act on a failure, per §3.3 / §6. */
export function actorFor(failure: CheckFailure): FailureActor {
  return FAILURE_ACTORS[failure.reason as FailureReason] ?? "human";
}

/** The ladder as text, for a report or an issue comment. */
export function explainLadder(): string {
  return CRITERIA_LADDER.map(
    (r) =>
      `${r.rung}. ${r.id} → ${r.classes.join(" | ")}${r.fallback ? "  [R0 fallback]" : ""}\n     ${r.why}`,
  ).join("\n");
}
