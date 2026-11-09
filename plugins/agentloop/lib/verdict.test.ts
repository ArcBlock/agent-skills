#!/usr/bin/env bun
/**
 * pr-review verdict comment (agent-factory#157 follow-up).
 *
 * The host merger auto-merges an ad-hoc PR only on ONE exact canonical line per
 * comment, outside code fences, in a comment that was never edited, headed by a
 * review-skill identity line. These tests pin what pr-review renders against that
 * grammar — and, when the merger source is in the same checkout, against the
 * merger's own regexes, so the two cannot drift silently.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_VERDICT_RE,
  canonicalVerdictLine,
  LEGACY_VERDICT_MARKER,
  parseVerdictCliArgs,
  renderVerdictComment,
} from "./verdict.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const IDENTITY =
  "> 🤖 AI Agent PR Review @ host · runner:r · agentloop@0.47.2 · skill:pr-review · engine:claude";

const canonicalLines = (body: string) =>
  body.split("\n").filter((l) => /^<!-- pr-review-verdict v1 /.test(l));

describe("canonicalVerdictLine", () => {
  it("accept: renders the exact v1 grammar for every lens and verdict", () => {
    expect(canonicalVerdictLine({ head: HEAD, lens: "correctness", verdict: "MERGE" })).toBe(
      `<!-- pr-review-verdict v1 head=${HEAD} lens=correctness verdict=MERGE -->`,
    );
    for (const lens of ["correctness", "security"] as const) {
      for (const verdict of ["MERGE", "COMMENT", "BLOCK", "SUPERSEDE", "CLOSE"] as const) {
        const line = canonicalVerdictLine({ head: HEAD, lens, verdict });
        expect(CANONICAL_VERDICT_RE.exec(line)?.slice(1)).toEqual([HEAD, lens, verdict]);
      }
    }
  });

  it("reject: a short, uppercase or non-hex head is refused (the merger needs the full 40-hex sha)", () => {
    for (const head of [HEAD.slice(0, 12), HEAD.toUpperCase(), `${HEAD.slice(0, 39)}g`, ""]) {
      expect(() => canonicalVerdictLine({ head, lens: "correctness", verdict: "MERGE" })).toThrow(
        /40/,
      );
    }
  });

  it("reject: an unknown lens or verdict is refused", () => {
    expect(() =>
      canonicalVerdictLine({ head: HEAD, lens: "perf" as never, verdict: "MERGE" }),
    ).toThrow(/lens/);
    expect(() =>
      canonicalVerdictLine({ head: HEAD, lens: "correctness", verdict: "APPROVE" as never }),
    ).toThrow(/verdict/);
  });
});

describe("renderVerdictComment", () => {
  const base = {
    identity: IDENTITY,
    head: HEAD,
    lens: "correctness" as const,
    verdict: "MERGE" as const,
    body: "## Claims\n\n| claim | evidence |\n|---|---|\n| x | a.ts:1 |",
  };

  it("accept: legacy marker first, then identity, exactly one canonical line, HEAD and Verdict lines, then the evidence", () => {
    const out = renderVerdictComment(base);
    const lines = out.split("\n");
    expect(lines[0]).toBe(LEGACY_VERDICT_MARKER);
    expect(lines[1]).toBe(IDENTITY);
    expect(lines[2]).toBe(canonicalVerdictLine(base));
    expect(lines[3]).toBe(`HEAD ${HEAD}`);
    expect(lines[4]).toBe("Verdict: MERGE");
    expect(out).toContain(base.body);
    expect(canonicalLines(out)).toHaveLength(1);
  });

  it("accept: held MERGE keeps verdict=MERGE on the canonical line and says (held) for readers", () => {
    const out = renderVerdictComment({ ...base, held: true });
    expect(canonicalLines(out)).toEqual([canonicalVerdictLine(base)]);
    expect(out.split("\n")[4]).toBe("Verdict: MERGE (held)");
  });

  it("accept: security lens and non-MERGE verdicts render their own canonical line", () => {
    const out = renderVerdictComment({ ...base, lens: "security", verdict: "BLOCK" });
    expect(canonicalLines(out)).toEqual([
      `<!-- pr-review-verdict v1 head=${HEAD} lens=security verdict=BLOCK -->`,
    ]);
    expect(out.split("\n")[4]).toBe("Verdict: BLOCK");
  });

  it("accept: CRLF evidence is normalized to LF", () => {
    const out = renderVerdictComment({ ...base, body: "a\r\nb\rc" });
    expect(out).not.toContain("\r");
    expect(out.endsWith("a\nb\nc")).toBe(true);
  });

  it("reject: identity that is not a review skill (the merger would ignore the MERGE)", () => {
    for (const identity of [
      "> 🤖 AI Agent implementation @ host · runner:r · skill:manual · engine:claude",
      "> 🤖 AI Agent PR Review @ host · runner:r · engine:claude",
      "AI Agent PR Review @ host · skill:pr-review",
      "",
    ]) {
      expect(() => renderVerdictComment({ ...base, identity })).toThrow(/identity/);
    }
  });

  it("accept: skill:review identity is a review skill too", () => {
    const identity = IDENTITY.replace("skill:pr-review", "skill:review");
    expect(renderVerdictComment({ ...base, identity }).split("\n")[1]).toBe(identity);
  });

  it("reject: evidence that carries its own canonical line (two lines → the merger reads none)", () => {
    const body = `quoted:\n${canonicalVerdictLine({ ...base, verdict: "BLOCK" })}`;
    expect(() => renderVerdictComment({ ...base, body })).toThrow(/canonical/);
  });

  it("reject: a multi-line identity (only one header line is allowed)", () => {
    expect(() => renderVerdictComment({ ...base, identity: `${IDENTITY}\nextra` })).toThrow(
      /identity/,
    );
  });
});

describe("parseVerdictCliArgs", () => {
  it("accept: reads every flag; lens defaults to correctness", () => {
    expect(
      parseVerdictCliArgs([
        "--head",
        HEAD,
        "--verdict",
        "MERGE",
        "--identity",
        IDENTITY,
        "--body-file",
        "draft.md",
      ]),
    ).toEqual({
      head: HEAD,
      lens: "correctness",
      verdict: "MERGE",
      identity: IDENTITY,
      bodyFile: "draft.md",
      held: false,
    });
    expect(
      parseVerdictCliArgs([
        "--head",
        HEAD,
        "--lens",
        "security",
        "--verdict",
        "BLOCK",
        "--identity",
        IDENTITY,
        "--body-file",
        "d.md",
        "--held",
      ]),
    ).toMatchObject({ lens: "security", verdict: "BLOCK", held: true });
  });

  it("reject: a missing required flag names it", () => {
    expect(() => parseVerdictCliArgs(["--head", HEAD, "--verdict", "MERGE"])).toThrow(/identity/);
    expect(() => parseVerdictCliArgs(["--verdict", "MERGE", "--identity", IDENTITY])).toThrow(
      /head/,
    );
  });
});

/**
 * Contract with the merger (packages/aos-factory/src/work-adhoc-merge.ts). Present
 * in ArcBlock/agent-factory; absent in the published marketplace mirror, where the
 * merger is not shipped and this block is skipped.
 */
const MERGER = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "aos-factory",
  "src",
  "work-adhoc-merge.ts",
);
describe.skipIf(!existsSync(MERGER))("contract with the host merger's grammar", () => {
  const src = existsSync(MERGER) ? readFileSync(MERGER, "utf8") : "";
  const literal = (name: string): RegExp => {
    const m = new RegExp(`const ${name} =\\s*/(.+?)/([a-z]*);`, "s").exec(src);
    if (!m) throw new Error(`${name} not found in ${MERGER}`);
    return new RegExp(m[1]!, m[2]);
  };

  it("the canonical regex is the merger's, byte for byte", () => {
    expect(CANONICAL_VERDICT_RE.source).toBe(literal("CANONICAL_RE").source);
  });

  it("every rendered comment yields exactly one merger-parsable line and a merger-parsable review identity", () => {
    const canonical = literal("CANONICAL_RE");
    const identityRe = literal("IDENTITY_RE");
    for (const lens of ["correctness", "security"] as const) {
      for (const verdict of ["MERGE", "BLOCK"] as const) {
        const out = renderVerdictComment({
          identity: IDENTITY,
          head: HEAD,
          lens,
          verdict,
          body: "```\nnot a marker\n```",
        });
        const hits = out
          .split("\n")
          .map((l) => canonical.exec(l))
          .filter((m) => m !== null);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.slice(1)).toEqual([HEAD, lens, verdict]);
        const id = out.split("\n").find((l) => identityRe.test(l));
        expect(id).toBe(IDENTITY);
      }
    }
  });
});
