#!/usr/bin/env bun
/**
 * Tests for the repo-agnostic sticky-gate primitive (issue #1096). Hermetic: the
 * `runner` is injected, so no `gh`/network is touched. Exercised here against the
 * verification marker; the arc-specific e2e-gate wiring is tested separately in
 * `.claude/verify/merge-gate.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { HTML_DECODE_JQ, MARKER_PREFIX, shQuote } from "./comment.ts";
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

  it("blocks when result is TIMEOUT (#3170 — a watchdog kill is still unverified, not a pass)", () => {
    const r = requireStickyGate(
      "1",
      HEAD,
      MARKER_PREFIX,
      "verification",
      HINT,
      withComment(sticky(MARKER_PREFIX, HEAD, "TIMEOUT")),
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

  it("passes on an MCP-escaped marker comment (#4283 — `gh` 403'd, agent fell back to mcp__github__add_issue_comment)", () => {
    // What actually lands on GitHub when the MCP tool posts the sticky comment: the
    // marker's `<`/`>` arrive HTML-escaped. `comment.body` here is intentionally the
    // *raw* (still-escaped) text — exactly what `gh api .../comments` returns — to
    // prove the TS-side decode (not just the jq select) is what makes this parse.
    const escaped = sticky(MARKER_PREFIX, HEAD, "PASS")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    expect(escaped.startsWith(MARKER_PREFIX)).toBe(false); // sanity: really escaped
    const r = requireStickyGate(
      "1",
      HEAD,
      MARKER_PREFIX,
      "verification",
      HINT,
      withComment(escaped),
    );
    expect(r).toEqual({ ok: true, sha: HEAD, result: "PASS" });
  });

  describe("comment-selection jq filters (#4283, real jq execution — no gh/network)", () => {
    // Runs the ACTUAL filters `requireStickyGate` sends to `gh api --jq` / `gh pr view
    // --jq` against a crafted comment array via a real local `jq` binary — proves the
    // server-side select() itself (not just the TS-side parse above) matches an
    // MCP-escaped body, the same way the real REST/GraphQL responses would be filtered.
    const runRestFilter = (bodies: string[], prefix: string): string => {
      const filter = `[.[] | select((.body // "" | ${HTML_DECODE_JQ})|startswith("${prefix}"))][-1] // empty`;
      const comments = bodies.map((body) => ({ body }));
      const proc = Bun.spawnSync(["jq", filter], {
        stdin: Buffer.from(JSON.stringify(comments)),
        stdout: "pipe",
      });
      return proc.stdout.toString("utf8").trim();
    };
    const runGraphqlFallbackFilter = (bodies: string[], prefix: string): string => {
      const filter = `[.comments[] | select((.body // "" | ${HTML_DECODE_JQ})|startswith("${prefix}"))] | last // empty`;
      const proc = Bun.spawnSync(["jq", filter], {
        stdin: Buffer.from(JSON.stringify({ comments: bodies.map((body) => ({ body })) })),
        stdout: "pipe",
      });
      return proc.stdout.toString("utf8").trim();
    };

    it("REST filter accepts an MCP-escaped marker", () => {
      const escaped = sticky(MARKER_PREFIX, HEAD, "PASS")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const out = runRestFilter([escaped], MARKER_PREFIX);
      expect(JSON.parse(out).body).toBe(escaped);
    });

    it("REST filter still accepts an unescaped (`gh`-posted) marker — no regression", () => {
      const plain = sticky(MARKER_PREFIX, HEAD, "PASS");
      const out = runRestFilter([plain], MARKER_PREFIX);
      expect(JSON.parse(out).body).toBe(plain);
    });

    it("GraphQL fallback filter accepts an MCP-escaped marker", () => {
      const escaped = sticky(MARKER_PREFIX, HEAD, "PASS")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const out = runGraphqlFallbackFilter([escaped], MARKER_PREFIX);
      expect(JSON.parse(out).body).toBe(escaped);
    });
  });

  describe("real bash -c shell-embedding (accept-path for the actual gh command string)", () => {
    // The suites above prove the jq LOGIC is correct by invoking `jq` with the filter
    // as its own argv element — that bypasses shell parsing entirely and cannot catch
    // a broken shell EMBEDDING of the filter. `requireStickyGate`/`postOnce` instead
    // build a single string and hand it to `bash -c` (see `report.ts`'s `run()`), the
    // same way this test does. `HTML_DECODE_JQ`'s `&#39;` -> `'` mapping puts a literal
    // single quote inside the filter text; naively wrapping that in `--jq '...'` breaks
    // bash's quoting ("unexpected EOF while looking for matching `"'`") and both real
    // callers degraded silently: `requireStickyGate` read the syntax-error stderr as
    // "could not fetch comments" (gate.ts's `commentsResult.code !== 0` branch — failed
    // closed, but for the wrong reason), while `postOnce`'s upsert lookup read it as a
    // non-numeric id and fell through to POST, duplicating the sticky comment on every
    // run instead of patching it in place. Reproduces the exact string shape from
    // `requireStickyGate` (REST + GraphQL-fallback) and `postOnce`, executed the same
    // way production does — `bash -c <the constructed string>` — against a local `jq`
    // fed a canned comments array via stdin (no `gh`/network).
    const bashRun = (cmd: string): { code: number; out: string } => {
      const proc = Bun.spawnSync(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
      return {
        code: proc.exitCode ?? 1,
        out: `${proc.stdout.toString("utf8")}${proc.stderr.toString("utf8")}`,
      };
    };

    it("requireStickyGate's REST command string parses and matches under bash -c", () => {
      const body = sticky(MARKER_PREFIX, HEAD, "PASS");
      const filter = `[.[] | select((.body // "" | ${HTML_DECODE_JQ})|startswith("${MARKER_PREFIX}"))][-1] // empty`;
      const stdin = JSON.stringify([{ body }]);
      const cmd = `echo ${shQuote(stdin)} | jq ${shQuote(filter)}`;
      const r = bashRun(cmd);
      expect(r.out).not.toContain("unexpected EOF");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).body).toBe(body);
    });

    it("requireStickyGate's GraphQL-fallback command string parses and matches under bash -c", () => {
      const body = sticky(MARKER_PREFIX, HEAD, "PASS");
      const filter = `[.comments[] | select((.body // "" | ${HTML_DECODE_JQ})|startswith("${MARKER_PREFIX}"))] | last // empty`;
      const stdin = JSON.stringify({ comments: [{ body }] });
      const cmd = `echo ${shQuote(stdin)} | jq ${shQuote(filter)}`;
      const r = bashRun(cmd);
      expect(r.out).not.toContain("unexpected EOF");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).body).toBe(body);
    });

    it("postOnce's lookup command string parses and returns a numeric id under bash -c", () => {
      const body = sticky(MARKER_PREFIX, HEAD, "PASS");
      const firstLineTest =
        `(.body // "" | split("\\n") | map(select(length > 0)) | (.[0] // "") | ${HTML_DECODE_JQ}) | ` +
        `test("^${MARKER_PREFIX}")`;
      const filter = `[.[] | select(${firstLineTest})][-1].id // empty`;
      const stdin = JSON.stringify([{ id: 42, body }]);
      const cmd = `echo ${shQuote(stdin)} | jq ${shQuote(filter)}`;
      const r = bashRun(cmd);
      expect(r.out).not.toContain("unexpected EOF");
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe("42");
    });

    it("shQuote round-trips a string containing single quotes through bash -c", () => {
      const tricky = `it's a "test" with 'nested' quotes`;
      const r = bashRun(`echo ${shQuote(tricky)}`);
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe(tricky);
    });
  });
});
