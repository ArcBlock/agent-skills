#!/usr/bin/env bun
/**
 * Tests for the repo-agnostic sticky-gate primitive (issue #1096). Hermetic: the
 * `runner` is injected, so no `gh`/network is touched. Exercised here against the
 * verification marker; the arc-specific e2e-gate wiring is tested separately in
 * `.claude/verify/merge-gate.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { MARKER_PREFIX } from "./comment.ts";
import { requireStickyGate } from "./gate.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const HINT = "re-run the gate";

/** Build a runner that returns one sticky comment body for the jq lookup. */
const withComment = (body: string) => () => ({ code: 0, out: JSON.stringify({ body }), ms: 0 });
const sticky = (prefix: string, sha: string, result: string) =>
  `${prefix} sha=${sha} result=${result} -->\n## report\n…`;

describe("requireStickyGate", () => {
  it("passes when a PASS comment matches HEAD", () => {
    const r = requireStickyGate(
      "1",
      HEAD,
      MARKER_PREFIX,
      "verification",
      HINT,
      withComment(sticky(MARKER_PREFIX, HEAD, "PASS")),
    );
    expect(r).toEqual({ ok: true, sha: HEAD, result: "PASS" });
  });

  it("passes on NA (docs/native exemption)", () => {
    const r = requireStickyGate(
      "1",
      HEAD,
      MARKER_PREFIX,
      "verification",
      HINT,
      withComment(sticky(MARKER_PREFIX, HEAD, "NA")),
    );
    expect(r.ok).toBe(true);
  });

  it("blocks when result is FAIL", () => {
    const r = requireStickyGate(
      "1",
      HEAD,
      MARKER_PREFIX,
      "verification",
      HINT,
      withComment(sticky(MARKER_PREFIX, HEAD, "FAIL")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("must be PASS or NA");
  });

  it("blocks on sha mismatch (new commits pushed after last run)", () => {
    const r = requireStickyGate(
      "1",
      HEAD,
      MARKER_PREFIX,
      "verification",
      HINT,
      withComment(sticky(MARKER_PREFIX, OTHER, "PASS")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("sha mismatch");
  });

  it("blocks when no comment exists", () => {
    const r = requireStickyGate("1", HEAD, MARKER_PREFIX, "verification", HINT, () => ({
      code: 0,
      out: "",
      ms: 0,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no verification comment");
  });

  it("blocks (surfacing the hint) when gh errors", () => {
    const r = requireStickyGate("1", HEAD, MARKER_PREFIX, "verification", HINT, () => ({
      code: 1,
      out: "403",
      ms: 0,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("could not fetch");
  });

  it("falls back to `gh pr view` (GraphQL) when the REST comments fetch 503s", () => {
    // Simulates the observed failure mode: `issues/<n>/comments` (REST) 503s
    // while `gh pr view --json comments` (GraphQL) keeps working.
    const r = requireStickyGate("1", HEAD, MARKER_PREFIX, "verification", HINT, (cmd) =>
      cmd.includes("gh pr view")
        ? { code: 0, out: JSON.stringify({ body: sticky(MARKER_PREFIX, HEAD, "PASS") }), ms: 0 }
        : { code: 1, out: "<!DOCTYPE html>", ms: 0 },
    );
    expect(r).toEqual({ ok: true, sha: HEAD, result: "PASS" });
  });
});
