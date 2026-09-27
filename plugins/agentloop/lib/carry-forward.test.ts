import { describe, expect, test } from "bun:test";
import {
  type CarryDeltaFile,
  type CarryDonorRecord,
  carryForwardNotice,
  parseNameStatusZ,
  planCarryForward,
} from "./carry-forward.ts";

const PASS: CarryDonorRecord = { result: "PASS", fullScenario: true };
const donors = (m: Record<string, CarryDonorRecord>) => (sha: string) => m[sha];
const docOnly: CarryDeltaFile[] = [{ status: "M", path: "docs/guides/x.md" }];
const acceptAll = () => undefined;

describe("planCarryForward", () => {
  test("ACCEPT: nearest verified ancestor PASSED and the judge accepts the delta", () => {
    const plan = planCarryForward({
      ancestors: ["c3", "c2", "c1"],
      recordFor: donors({ c2: PASS }),
      deltaFor: () => docOnly,
      judge: acceptAll,
    });
    expect(plan).toEqual({ kind: "carry", donor: "c2", files: docOnly });
  });

  test("no verified ancestor at all → nothing to carry (not a refusal: there was never a candidate)", () => {
    const plan = planCarryForward({
      ancestors: ["c2", "c1"],
      recordFor: () => undefined,
      deltaFor: () => docOnly,
      judge: acceptAll,
    });
    expect(plan).toEqual({ kind: "none" });
  });

  test("REJECT: the NEAREST record decides — an older PASS never launders a newer FAIL", () => {
    const plan = planCarryForward({
      ancestors: ["c3", "c2", "c1"],
      recordFor: donors({ c3: { result: "FAIL", fullScenario: true }, c1: PASS }),
      deltaFor: () => docOnly,
      judge: acceptAll,
    });
    expect(plan.kind).toBe("refused");
    expect(plan.kind === "refused" && plan.reason).toContain("c3");
  });

  test("REJECT: a PARTIAL (--only) PASS is not a donor", () => {
    const plan = planCarryForward({
      ancestors: ["c1"],
      recordFor: donors({ c1: { result: "PASS", fullScenario: false } }),
      deltaFor: () => docOnly,
      judge: acceptAll,
    });
    expect(plan.kind).toBe("refused");
  });

  test("REJECT: an NA exemption is not a donor — it never ran a check", () => {
    const plan = planCarryForward({
      ancestors: ["c1"],
      recordFor: donors({ c1: { result: "NA", fullScenario: true } }),
      deltaFor: () => docOnly,
      judge: acceptAll,
    });
    expect(plan.kind).toBe("refused");
  });

  test("REJECT: the judge's reason is carried out verbatim", () => {
    const plan = planCarryForward({
      ancestors: ["c1"],
      recordFor: donors({ c1: PASS }),
      deltaFor: () => [{ status: "M", path: "packages/core/src/afs.ts" }],
      judge: (d) => `build input: ${d.files[0]?.path}`,
    });
    expect(plan).toEqual({
      kind: "refused",
      reason: "build input: packages/core/src/afs.ts",
      donor: "c1",
    });
  });

  test("REJECT: an undiffable donor is refused, never assumed empty", () => {
    const plan = planCarryForward({
      ancestors: ["c1"],
      recordFor: donors({ c1: PASS }),
      deltaFor: () => undefined,
      judge: acceptAll,
    });
    expect(plan.kind).toBe("refused");
  });

  test("ACCEPT-arm guard: the judge actually sees the delta (a judge that accepts nothing refuses every carry)", () => {
    const seen: string[] = [];
    planCarryForward({
      ancestors: ["c1"],
      recordFor: donors({ c1: PASS }),
      deltaFor: () => docOnly,
      judge: (d) => {
        seen.push(...d.files.map((f) => f.path));
        return undefined;
      },
    });
    expect(seen).toEqual(["docs/guides/x.md"]);
  });
});

describe("parseNameStatusZ", () => {
  test("M/A/D rows, NUL-separated", () => {
    expect(parseNameStatusZ("M\0docs/a.md\0A\0b.ts\0D\0c.md\0")).toEqual([
      { status: "M", path: "docs/a.md" },
      { status: "A", path: "b.ts" },
      { status: "D", path: "c.md" },
    ]);
  });

  test("a rename keeps both sides, status R", () => {
    expect(parseNameStatusZ("R100\0old.md\0new.md\0")).toEqual([
      { status: "R", path: "old.md" },
      { status: "R", path: "new.md" },
    ]);
  });
});

describe("carryForwardNotice — the audit trail", () => {
  test("names the donor, the head, every delta file, and how to force a real run", () => {
    const n = carryForwardNotice({
      scenario: "pre-pr",
      sha: "abcdef1234567890",
      donor: "0123456789abcdef",
      files: [
        { status: "M", path: "docs/a.md" },
        { status: "M", path: "packages/example/README.md" },
      ],
      carried: ["tests"],
    });
    expect(n).toContain("Carried-forward evidence");
    expect(n).toContain("0123456789ab");
    expect(n).toContain("abcdef123456");
    expect(n).toContain("docs/a.md");
    expect(n).toContain("packages/example/README.md");
    expect(n).toContain("--no-carry-forward");
    // Review P1 on #7065: only the named checks were carried — the notice must
    // say so, and must not claim "no check ran" / "no check reads".
    expect(n).toContain("`tests`");
    expect(n).toMatch(/every other check ran/i);
    expect(n).not.toMatch(/no check ran/i);
    expect(n).not.toMatch(/no check or test reads/i);
  });

  test("a long delta is bounded but its size is stated", () => {
    const files = Array.from({ length: 40 }, (_, i) => ({ status: "M", path: `docs/f${i}.md` }));
    const n = carryForwardNotice({
      scenario: "pre-pr",
      sha: "a".repeat(40),
      donor: "b".repeat(40),
      files,
      carried: ["tests"],
    });
    expect(n).toContain("40 file(s)");
    expect(n).not.toContain("docs/f39.md");
  });
});
