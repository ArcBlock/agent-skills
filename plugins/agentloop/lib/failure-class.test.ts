#!/usr/bin/env bun
/**
 * Judge for the criteria ladder (`failure-class.ts`), arc#5612 / taxonomy §4.2.
 *
 * The acceptance core is §7.1's BIDIRECTIONAL mutation pairs. A classifier that
 * answers `UNKNOWN` — or `CODE` — for everything satisfies every "it did not
 * crash" test, so every pair below asserts a MUST-be AND a MUST-NOT-be, and
 * asserts the `reason`, not only the class: two classes that agree on the class
 * and disagree on the reason are two different next steps.
 */
import { describe, expect, test } from "bun:test";
import {
  actorFor,
  assertLadderIsTotalOrder,
  CLASS_OF_REASON,
  CRITERIA_LADDER,
  classifyFailure,
  classifyFailureRung,
  explainLadder,
  FAILURE_ACTORS,
  FAILURE_REASONS,
  type LadderRung,
  type LadderSignals,
} from "./failure-class.ts";
import type { FailureClass } from "./report.ts";

/** A real assertion failure: something named went red, nothing else fired. */
const REAL_FAILURE: LadderSignals = { observedTestFailures: true };

describe("the ladder is a TOTAL ORDER with R0 at the floor (§4.2 / §4.3)", () => {
  test("ACCEPT — the shipped ladder is well-formed", () => {
    expect(assertLadderIsTotalOrder(CRITERIA_LADDER)).toEqual([]);
  });

  test("rungs are numbered 1..N with no gaps, no duplicate ids", () => {
    expect(CRITERIA_LADDER.map((r) => r.rung)).toEqual(CRITERIA_LADDER.map((_, i) => i + 1));
    expect(new Set(CRITERIA_LADDER.map((r) => r.id)).size).toBe(CRITERIA_LADDER.length);
  });

  test("exactly one fallback rung, and it is LAST", () => {
    const fallbacks = CRITERIA_LADDER.filter((r) => r.fallback === true);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.id).toBe("R0");
    expect(CRITERIA_LADDER[CRITERIA_LADDER.length - 1]!.id).toBe("R0");
    expect(fallbacks[0]!.classes).toEqual(["CODE"]);
  });

  // REJECT arms — without these, `assertLadderIsTotalOrder` returning `[]`
  // for everything would look exactly like the shipped ladder being correct.
  test("REJECT — R0 hoisted above a named rung is reported", () => {
    const r0 = CRITERIA_LADDER.find((r) => r.fallback)!;
    const named = CRITERIA_LADDER.find((r) => !r.fallback)!;
    const bad: LadderRung[] = [
      { ...r0, rung: 1 },
      { ...named, rung: 2 },
    ];
    const problems = assertLadderIsTotalOrder(bad);
    expect(problems.join("\n")).toContain("not last");
  });

  test("REJECT — two fallbacks, or none, is reported", () => {
    const named = CRITERIA_LADDER.filter((r) => !r.fallback).slice(0, 2);
    expect(
      assertLadderIsTotalOrder(named.map((r, i) => ({ ...r, rung: i + 1 }))).join("\n"),
    ).toContain("exactly 1 fallback");
    const r0 = CRITERIA_LADDER.find((r) => r.fallback)!;
    expect(
      assertLadderIsTotalOrder([
        { ...r0, id: "R0-a", rung: 1 },
        { ...r0, id: "R0-b", rung: 2 },
      ]).join("\n"),
    ).toContain("exactly 1 fallback");
  });

  test("REJECT — misnumbered rungs and duplicate ids are reported", () => {
    const [a, b] = CRITERIA_LADDER;
    expect(assertLadderIsTotalOrder([{ ...a!, rung: 7 }]).join("\n")).toContain(
      "not a total order",
    );
    expect(
      assertLadderIsTotalOrder([
        { ...a!, rung: 1 },
        { ...b!, id: a!.id, rung: 2 },
      ]).join("\n"),
    ).toContain("duplicate rung id");
  });

  test("REJECT — a rung claiming a reason outside its own class is reported", () => {
    const bad: LadderRung[] = [
      { rung: 1, id: "liar", classes: ["CONTENTION"], why: "x", claim: () => "budget-exhausted" },
      { ...CRITERIA_LADDER[CRITERIA_LADDER.length - 1]!, rung: 2 },
    ];
    expect(assertLadderIsTotalOrder(bad).join("\n")).toContain("not in class CONTENTION");
  });

  test("every named rung outranks R0 EVEN WHEN R0's own companion signal is present", () => {
    // §4.3: the draft R0 ("whatever else is also true, it is CODE") made
    // CONTENTION and PREEXISTING unreachable, because both of their criteria
    // REQUIRE a named failure. This is that repair, rung by rung.
    for (const rung of CRITERIA_LADDER.filter((r) => !r.fallback)) {
      const signals = SIGNALS_FIRING[rung.id];
      expect(signals, `no firing signal fixture for rung ${rung.id}`).toBeDefined();
      const withR0Companion = { ...signals!, observedTestFailures: true };
      expect(classifyFailureRung(withR0Companion).id).toBe(rung.id);
      expect(rung.classes).toContain(classifyFailure(withR0Companion).class);
    }
  });
});

/** One minimal signal set per named rung — the only thing that makes it fire. */
const SIGNALS_FIRING: Record<string, LadderSignals> = {
  "escaped-fixture-veto": { escapedFixture: ["  escaped pid=4242 bun test"] },
  "named-failure-in-diff": { namedFailureInDiff: true },
  "contention-signature": { contentionSignature: "owner-ledger-hook-timeouts" },
  "capability-probe-gap": { envGap: "dns-localhost-subdomain-missing" },
  "budget-exhausted": { budgetExhausted: true },
  "toolchain-version-mismatch": {
    toolchainMismatch: { tool: "bun", measured: "1.3.11", declared: ">=1.3.14" },
  },
  "recorded-on-base-or-prior-green": { recordedRedOnBase: true },
};

describe("precedence between adjacent rungs is the ladder's, not the caller's", () => {
  test("every rung beats every rung below it, pairwise", () => {
    const named = CRITERIA_LADDER.filter((r) => !r.fallback);
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        const both = { ...SIGNALS_FIRING[named[j]!.id], ...SIGNALS_FIRING[named[i]!.id] };
        expect(classifyFailureRung(both).id, `${named[i]!.id} must outrank ${named[j]!.id}`).toBe(
          named[i]!.id,
        );
      }
    }
  });
});

describe("§7.1 mutation pairs — bidirectional, and on the REASON", () => {
  // M1a — #5556 run 5: the watchdog killed the run, nothing was observed red.
  test("M1a  watchdog kill with failed=0 ⇒ BUDGET/budget-exhausted, never CODE/ENV_GAP/UNKNOWN", () => {
    const f = classifyFailure({ budgetExhausted: true, observedTestFailures: false });
    expect(f).toEqual({ class: "BUDGET", reason: "budget-exhausted" });
    expect(f.class).not.toBe("CODE");
    expect(f.class).not.toBe("ENV_GAP");
    expect(f.class).not.toBe("UNKNOWN");
  });

  // M1b — the other direction: a real assertion failure is CODE, full stop.
  test("M1b  a real assertion failure ⇒ CODE/observed-test-failures, never a flake class", () => {
    const f = classifyFailure(REAL_FAILURE);
    expect(f).toEqual({ class: "CODE", reason: "observed-test-failures" });
    for (const flake of ["BUDGET", "ENV_GAP", "CONTENTION", "PREEXISTING", "UNKNOWN"] as const) {
      expect(f.class).not.toBe(flake);
    }
  });

  // M2a — timedOut AND failed>=1: `isTimeoutNoFail` is false, so rung 5 never
  // fires and R0 takes it. Replicates report.ts's existing TIMEOUT derivation.
  test("M2a  timedOut with failed>=1 ⇒ CODE (rung 5 did not fire), never BUDGET", () => {
    const f = classifyFailure({ budgetExhausted: false, observedTestFailures: true });
    expect(f).toEqual({ class: "CODE", reason: "observed-test-failures" });
    expect(f.class).not.toBe("BUDGET");
    expect(classifyFailureRung({ budgetExhausted: false, observedTestFailures: true }).id).toBe(
      "R0",
    );
  });

  // M2b — the DNS probe PASSED, so no env-gap signal is produced at all.
  test("M2b  probe passed + a failed fetch ⇒ CODE, never ENV_GAP", () => {
    const f = classifyFailure({ envGap: undefined, observedTestFailures: true });
    expect(f).toEqual({ class: "CODE", reason: "observed-test-failures" });
    expect(f.class).not.toBe("ENV_GAP");
  });

  // M3a — coexistence was the #5081 bug: a leak and a contention signature in
  // one run. Rung 1 vetoes.
  test("M3a  escaped fixture AND a contention signature ⇒ CODE/escaped-fixture, never CONTENTION", () => {
    const f = classifyFailure({
      escapedFixture: ["  escaped pid=4242 bun test"],
      contentionSignature: "owner-ledger-hook-timeouts",
      observedTestFailures: true,
    });
    expect(f).toEqual({ class: "CODE", reason: "escaped-fixture" });
    expect(f.class).not.toBe("CONTENTION");
  });

  // M3b — THE accept arm that the draft R0 made unsatisfiable (§4.3). The
  // contention criterion cannot fire without named failures, so if named
  // failures forced CODE this row could never exist.
  test("M3b  contention signature, no escape, WITH named failures ⇒ CONTENTION, never CODE", () => {
    for (const sig of FAILURE_REASONS.CONTENTION.slice(0, 3)) {
      const f = classifyFailure({
        contentionSignature: sig,
        escapedFixture: [],
        observedTestFailures: true,
      });
      expect(f).toEqual({ class: "CONTENTION", reason: sig });
      expect(f.class).not.toBe("CODE");
    }
  });

  // M4a — nothing named claimed it. R0 answers, and it is CODE, not UNKNOWN.
  test("M4a  non-zero exit, nothing on the ladder claims it ⇒ CODE/nonzero-exit, never UNKNOWN", () => {
    const f = classifyFailure({ observedTestFailures: false });
    expect(f).toEqual({ class: "CODE", reason: "nonzero-exit" });
    expect(f.class).not.toBe("UNKNOWN");
  });

  test("M4a′ UNKNOWN is not reachable from ANY signal combination (R3)", () => {
    // Exhaustive over the boolean/enumerable signal space the ladder reads.
    const opts: LadderSignals[] = [];
    for (const escapedFixture of [undefined, [], ["  escaped pid=1 x"]] as const)
      for (const namedFailureInDiff of [undefined, false, true] as const)
        for (const contentionSignature of [undefined, "owner-ledger-watchdog-timeout"] as const)
          for (const envGap of [undefined, "disk-exhausted"] as const)
            for (const budgetExhausted of [undefined, false, true] as const)
              for (const recordedRedOnBase of [undefined, true] as const)
                for (const sameShaPriorGreen of [undefined, true] as const)
                  for (const observedTestFailures of [undefined, false, true] as const)
                    opts.push({
                      escapedFixture,
                      namedFailureInDiff,
                      contentionSignature,
                      envGap,
                      budgetExhausted,
                      recordedRedOnBase,
                      sameShaPriorGreen,
                      observedTestFailures,
                    });
    expect(opts.length).toBeGreaterThan(500);
    for (const s of opts) {
      const f = classifyFailure(s);
      expect(f.class).not.toBe("UNKNOWN");
      expect(CLASS_OF_REASON[f.reason as keyof typeof CLASS_OF_REASON]).toBe(f.class);
    }
  });

  // M4b's accept arm lives in scenario.ts (`runCheckGuarded`, W1.1a): UNKNOWN is
  // synthesised where there IS no CheckResult, which is unobservable from here.
  test("M4b  UNKNOWN is deliberately absent from the ladder (§5.4)", () => {
    expect(CRITERIA_LADDER.flatMap((r) => r.classes)).not.toContain("UNKNOWN" as FailureClass);
    expect(FAILURE_ACTORS["no-check-result-produced"]).toBe("human");
  });

  // M6a — R4: the failure is in the diff, so PREEXISTING is unavailable even
  // though the base record exists.
  test("M6a  named failure IN the diff + a base record ⇒ CODE, never PREEXISTING", () => {
    const f = classifyFailure({
      namedFailureInDiff: true,
      recordedRedOnBase: true,
      observedTestFailures: true,
    });
    expect(f).toEqual({ class: "CODE", reason: "observed-test-failures" });
    expect(f.class).not.toBe("PREEXISTING");
  });

  // M6b — the accept arm, likewise only satisfiable once R0 gave way.
  test("M6b  named failure NOT in the diff + a base record ⇒ PREEXISTING/recorded-red-on-base", () => {
    const f = classifyFailure({
      namedFailureInDiff: false,
      recordedRedOnBase: true,
      observedTestFailures: true,
    });
    expect(f).toEqual({ class: "PREEXISTING", reason: "recorded-red-on-base" });
    expect(f.class).not.toBe("CODE");
  });

  test("R4 also removes CONTENTION / ENV_GAP / BUDGET, not only PREEXISTING", () => {
    const f = classifyFailure({
      namedFailureInDiff: true,
      contentionSignature: "owner-ledger-hook-timeouts",
      envGap: "dns-localhost-subdomain-missing",
      budgetExhausted: true,
      recordedRedOnBase: true,
      observedTestFailures: true,
    });
    expect(f.class).toBe("CODE");
  });
});

describe("the reason vocabulary is closed and per-reason actors are exhaustive (§3.3)", () => {
  test("every reason has an actor, and every actor key is a declared reason", () => {
    const declared = Object.values(FAILURE_REASONS).flat() as string[];
    expect(Object.keys(FAILURE_ACTORS).sort()).toEqual([...declared].sort());
  });

  test("ENV_GAP reasons route to the gate maintainer; BUDGET to the red-holding agent (§2.4)", () => {
    for (const r of FAILURE_REASONS.ENV_GAP) expect(FAILURE_ACTORS[r]).toBe("gate-maintainer");
    expect(FAILURE_ACTORS["budget-exhausted"]).toBe("red-holding-agent");
    expect(actorFor({ class: "ENV_GAP", reason: "disk-exhausted" })).toBe("gate-maintainer");
    expect(actorFor({ class: "UNKNOWN", reason: "no-check-result-produced" })).toBe("human");
  });

  test("every FailureClass has at least one reason", () => {
    for (const [cls, reasons] of Object.entries(FAILURE_REASONS)) {
      expect(reasons.length, `class ${cls} has no reason`).toBeGreaterThan(0);
    }
  });

  test("explainLadder() renders every rung and marks R0", () => {
    const text = explainLadder();
    for (const r of CRITERIA_LADDER) expect(text).toContain(r.id);
    expect(text).toContain("[R0 fallback]");
  });
});
