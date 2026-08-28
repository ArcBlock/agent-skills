/**
 * The auditor's own accept-path gate.
 *
 * A test-quality rule that flags EVERYTHING satisfies every reject-only test it
 * will ever be given — "flags the bad fixture" and "flags correct code too" are
 * the same colour on a reject-only suite. That is the repo's accept-path 铁律,
 * and this file points it at the auditor itself.
 *
 * Three contracts, enforced for EVERY registered rule (no opt-out — a rule
 * missing a fixture fails here, so it cannot be registered without one):
 *
 *   1. REJECT — `fixtures/<id>/bad.fixture.ts` is flagged by that rule.
 *   2. ACCEPT — `fixtures/<id>/good.fixture.ts` is flagged by NO rule.
 *   3. FALSIFIABILITY — the bad fixture is GREEN when the real runner executes
 *      it. This is the demonstration that the flagged shape is a defect the
 *      runner cannot see, and it is the check the predecessor skill lacked: its
 *      P0 rule flagged 43 sites as "vacuous pass" on a premise nobody had ever
 *      run. Measured on bun 1.3.14, that premise was false — bun settles
 *      floating expect-promises and fails the test. A rule whose bad fixture
 *      goes RED here is not describing a defect the runner misses; it is
 *      describing something the suite already catches, and it must be demoted
 *      to advisory rather than shipped as a gate.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Adapter, BUN_VITEST_DIALECT } from "../scripts/adapter.ts";
import { DIFF_RULES, scanDiffFile } from "../scripts/diff.ts";
import { parse, STATIC_RULES, scanFile } from "../scripts/rules.ts";

const SKILL_ROOT = join(import.meta.dir, "..");

const testAdapter: Adapter = {
  root: SKILL_ROOT,
  testGlobs: ["**/*.test.ts"],
  runTests: (files) => `bun test ${files.map((f) => `./${f}`).join(" ")}`,
  testsForSource: (_source, all) => all,
  dialect: BUN_VITEST_DIALECT,
  rules: {},
  baseline: "baseline.json",
};

function scanFixture(rel: string) {
  const abs = join(SKILL_ROOT, rel);
  return scanFile(parse(abs, readFileSync(abs, "utf8")), rel, testAdapter);
}

describe("every registered rule ships an accept/reject fixture pair", () => {
  for (const rule of STATIC_RULES) {
    const bad = `fixtures/${rule.id}/bad.fixture.ts`;
    const good = `fixtures/${rule.id}/good.fixture.ts`;

    test(`${rule.id} — fixtures exist`, () => {
      expect(existsSync(join(SKILL_ROOT, bad))).toBe(true);
      expect(existsSync(join(SKILL_ROOT, good))).toBe(true);
    });

    test(`${rule.id} — REJECT: flags its bad fixture`, () => {
      const hits = scanFixture(bad).filter((f) => f.rule === rule.id);
      expect(hits.length).toBeGreaterThan(0);
      // A finding with no evidence cannot be audited later; require the witness.
      for (const h of hits) expect(h.witness.length).toBeGreaterThan(0);
    });

    test(`${rule.id} — ACCEPT: its good fixture is clean under EVERY rule`, () => {
      const hits = scanFixture(good);
      expect(hits.map((f) => `${f.rule}@${f.line}: ${f.message}`)).toEqual([]);
    });
  }
});

describe("falsifiability — each bad fixture is a defect the runner cannot see", () => {
  for (const rule of STATIC_RULES) {
    test(`${rule.id} — bad fixture runs GREEN`, () => {
      const rel = `./fixtures/${rule.id}/bad.fixture.ts`;
      const r = spawnSync("bun", ["test", rel], { cwd: SKILL_ROOT, encoding: "utf8" });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect({ rule: rule.id, status: r.status, sawFail: /\b[1-9]\d* fail\b/.test(out) }).toEqual({
        rule: rule.id,
        status: 0,
        sawFail: false,
      });
    });
  }
});

describe("every diff rule ships a before / bad-after / good-after triple", () => {
  const read = (rel: string) => readFileSync(join(SKILL_ROOT, rel), "utf8");

  for (const rule of DIFF_RULES) {
    const before = `fixtures/${rule.id}/before.fixture.ts`;
    const bad = `fixtures/${rule.id}/bad-after.fixture.ts`;
    const good = `fixtures/${rule.id}/good-after.fixture.ts`;

    test(`${rule.id} — fixtures exist`, () => {
      for (const f of [before, bad, good]) expect(existsSync(join(SKILL_ROOT, f))).toBe(true);
    });

    test(`${rule.id} — REJECT: flags the weakening change`, () => {
      const hits = scanDiffFile("subject.test.ts", read(before), read(bad), testAdapter).filter(
        (f) => f.rule === rule.id,
      );
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect(h.witness.length).toBeGreaterThan(0);
    });

    test(`${rule.id} — ACCEPT: an equivalent-or-better change is clean under EVERY diff rule`, () => {
      const hits = scanDiffFile("subject.test.ts", read(before), read(good), testAdapter);
      expect(hits.map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
    });

    test(`${rule.id} — a file added or deleted wholesale is not a weakening`, () => {
      expect(scanDiffFile("subject.test.ts", null, read(bad), testAdapter)).toEqual([]);
      expect(scanDiffFile("subject.test.ts", read(before), null, testAdapter)).toEqual([]);
    });
  }
});

describe("rule metadata is complete", () => {
  test("ids are unique and every rule states what it detects", () => {
    const ids = STATIC_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of STATIC_RULES) {
      expect(r.what.length).toBeGreaterThan(10);
      expect(["block", "warn", "off"]).toContain(r.defaultSeverity);
    }
  });
});

describe("finding keys are stable under line drift", () => {
  test("inserting a leading comment does not change the key", () => {
    const rel = "fixtures/catch-swallow/bad.fixture.ts";
    const src = readFileSync(join(SKILL_ROOT, rel), "utf8");
    const before = scanFile(parse(rel, src), rel, testAdapter).filter(
      (f) => f.rule === "catch-swallow",
    );
    const shifted = `// a newly added comment\n// and another\n${src}`;
    const after = scanFile(parse(rel, shifted), rel, testAdapter).filter(
      (f) => f.rule === "catch-swallow",
    );

    expect(before.length).toBe(1);
    expect(after.length).toBe(1);
    expect(after[0]!.line).toBe(before[0]!.line + 2); // line really did move
    expect(after[0]!.key).toBe(before[0]!.key); // key did not
  });
});
