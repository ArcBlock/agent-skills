/**
 * Issue drafting: grouping, dedup identity, and the confidence disclosure.
 *
 * The confidence line has a test because it was silently lost once. It was
 * written, used to file real issues, and then destroyed by a `git reset --hard`
 * over uncommitted work — and nothing noticed, because no test asserted the
 * drafts carried it. The issues on GitHub kept the text; the code that produces
 * it did not. That is the same shape this whole tool exists to catch: a
 * capability that disappears without turning anything red.
 */
import { describe, expect, test } from "bun:test";
import { type Adapter, BUN_VITEST_DIALECT } from "../scripts/adapter.ts";
import { DIFF_RULES } from "../scripts/diff.ts";
import { CONFIDENCE, draftIssues } from "../scripts/issues.ts";
import type { Finding } from "../scripts/rules.ts";
import { STATIC_RULES } from "../scripts/rules.ts";

const adapter: Adapter = {
  root: "/repo",
  testGlobs: ["**/*.test.ts"],
  runTests: (f) => `bun test ${f.join(" ")}`,
  testsForSource: (_s, all) => all,
  dialect: BUN_VITEST_DIALECT,
  rules: {},
  baseline: "baseline.json",
};

const finding = (rule: string, file: string, line: number): Finding => ({
  rule,
  severity: "warn",
  file,
  line,
  message: `${rule} at ${file}:${line}`,
  witness: "machine-checkable evidence",
  key: `${rule}-${file}-${line}`,
});

const ALL_RULE_IDS = [...STATIC_RULES.map((r) => r.id), ...DIFF_RULES.map((r) => r.id)];

describe("every rule discloses its measured confidence in the issue body", () => {
  test("a rule cannot be registered without a confidence statement", () => {
    // The map is the contract, so it is checked against the rule registry
    // rather than against a length heuristic — `only` and `test-disabled` are
    // legitimately terse ("构造性判定，无误报。") because there is nothing more
    // to say about a constructive check.
    expect(ALL_RULE_IDS.filter((id) => !CONFIDENCE[id])).toEqual([]);
  });

  for (const rule of ALL_RULE_IDS) {
    test(`${rule} — its draft carries that exact statement`, () => {
      // Three sites so the group clears MIN_GROUP and gets its own draft.
      const findings = [1, 2, 3].map((n) => finding(rule, `packages/core/test/a${n}.test.ts`, n));
      const [draft] = draftIssues(findings, adapter);

      expect(draft).toBeDefined();
      expect(draft!.body).toContain(CONFIDENCE[rule]!);
    });
  }

  test("the recall-tuned rule warns against batch-fixing, by name", () => {
    // `no-assertions` runs at 76.5% precision on purpose. An agent handed that
    // list without the warning will "fix" the accept-path tests in it.
    const findings = [1, 2, 3].map((n) =>
      finding("no-assertions", `packages/core/test/a${n}.test.ts`, n),
    );
    const [draft] = draftIssues(findings, adapter);
    expect(draft!.body).toContain("76.5%");
    expect(draft!.body).toContain("不要整批修");
  });
});

describe("draft identity and grouping", () => {
  test("the dedup marker is the key, and it is not the title", () => {
    const findings = [1, 2, 3].map((n) => finding("only", `packages/core/test/a${n}.test.ts`, n));
    const [draft] = draftIssues(findings, adapter);
    expect(draft!.body).toContain(`<!-- test-audit-key: ${draft!.key} -->`);
    // Titles carry a live count, so they cannot be the identity: fixing one
    // site changes the title and a title-keyed upsert would file a duplicate.
    expect(draft!.title).toContain("3");
    expect(draft!.key).not.toContain("3 处");
  });

  test("a long tail of one-off groups rolls into one draft per rule", () => {
    const findings = ["core", "aos", "arc", "logger", "session"].map((p, i) =>
      finding("empty-catch", `packages/${p}/test/x.test.ts`, i + 1),
    );
    const drafts = draftIssues(findings, adapter);
    // Five packages, one site each — one roll-up, not five issues.
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.key).toBe("empty-catch/<scattered>");
    expect(drafts[0]!.findings.length).toBe(5);
  });

  test("a group big enough to be worth a sitting gets its own draft", () => {
    const findings = [
      ...[1, 2, 3].map((n) => finding("catch-swallow", `packages/core/test/a${n}.test.ts`, n)),
      finding("catch-swallow", "packages/aos/test/b.test.ts", 1),
    ];
    const drafts = draftIssues(findings, adapter);
    const keys = drafts.map((d) => d.key).sort();
    expect(keys).toEqual(["catch-swallow/<scattered>", "catch-swallow/packages/core"]);
  });

  test("every draft carries the four blocks a work item needs", () => {
    const findings = [1, 2, 3].map((n) =>
      finding("catch-swallow", `packages/core/test/a${n}.test.ts`, n),
    );
    const [draft] = draftIssues(findings, adapter);
    for (const block of ["## 问题", "## 证据", "## 方案", "## 验收"]) {
      expect(draft!.body).toContain(block);
    }
    // Every site is listed — a summary that drops sites is not evidence.
    for (const n of [1, 2, 3])
      expect(draft!.body).toContain(`packages/core/test/a${n}.test.ts:${n}`);
  });
});
