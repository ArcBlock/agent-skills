#!/usr/bin/env bun
/**
 * gate — the repo-agnostic sticky-comment merge-gate primitive (extracted from
 * arc's merge-gate.ts, issue #1096 + #1447).
 *
 * `requireStickyGate` enforces ONE marker-keyed gate against a PR's current HEAD:
 * a sticky comment with the given marker prefix must exist, its `sha=` must match
 * the PR HEAD, and its `result=` must be PASS or NA. It is prefix-parameterized so
 * a repo can wire multiple gates (arc wires verification + e2e-gate) on top of it.
 *
 * The repo-specific wiring (which gates are required, when, how the PR/HEAD are
 * resolved) lives in the consuming repo (arc: `.claude/verify/merge-gate.ts`).
 */
import { decodeHtmlEntities, HTML_DECODE_JQ, shQuote } from "./comment.ts";
import { run, stripAnsi } from "./report.ts";

type Runner = (cmd: string) => { code: number; out: string; ms: number };

export interface GatePass {
  ok: true;
  sha: string;
  result: string;
}
export interface GateFail {
  ok: false;
  reason: string;
  detail?: string;
}

/**
 * Enforce ONE sticky-comment gate: find the latest comment whose body starts with
 * `prefix`, parse `sha=`/`result=` off its marker line, and require sha==prHead
 * and result ∈ {PASS, NA}. Injectable `runner` keeps it unit-testable.
 *
 * `startswith` (not substring) — the gate scripts prepend the marker to line 1, so
 * an exact-prefix match avoids matching a narrative comment that merely quotes it.
 *
 * Matches against the HTML-entity-decoded body (`decodeHtmlEntities` / `HTML_DECODE_JQ`
 * from `./comment.ts`) so a marker delivered via the `mcp__github__add_issue_comment`
 * fallback — which escapes `<`/`>`/`&`/quotes — is recognized the same as one delivered
 * via `gh` (unescaped). Before this, an MCP-posted gate comment read as "no comment
 * found" here even though it existed (#4283).
 */
export function requireStickyGate(
  pr: string,
  prHead: string,
  prefix: string,
  label: string,
  rerunHint: string,
  runner: Runner = run,
): GatePass | GateFail {
  // Decode HTML entities before the startswith test — a sticky comment posted via the
  // MCP fallback (blocked `gh`, #4283) arrives with its marker escaped to `&lt;!-- ...`,
  // which never literally starts with `prefix`, so an unconditional decode-then-match is
  // safe (a `gh`-posted, unescaped body decodes to itself — no entities to touch).
  let commentsResult = runner(
    `gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" ` +
      `--jq ${shQuote(`[.[] | select((.body // "" | ${HTML_DECODE_JQ})|startswith("${prefix}"))][-1] // empty`)} 2>/dev/null`,
  );
  if (commentsResult.code !== 0 || !commentsResult.out.trim()) {
    // Fall back to `gh pr view --json comments` (GraphQL) — observed in
    // practice: `issues/<n>/comments` (REST) intermittently 503s while
    // `gh pr view --json` keeps working. Only trust this fallback's own
    // exit code, not the REST attempt's, so a REST 503 doesn't mask a
    // genuine "no comment" result from the fallback.
    const fallback = runner(
      `gh pr view ${pr} --json comments ` +
        `--jq ${shQuote(`[.comments[] | select((.body // "" | ${HTML_DECODE_JQ})|startswith("${prefix}"))] | last // empty`)} 2>/dev/null`,
    );
    if (fallback.code === 0) commentsResult = fallback;
  }
  if (commentsResult.code !== 0) {
    return {
      ok: false,
      reason: `could not fetch comments for PR #${pr}`,
      detail: commentsResult.out.trim(),
    };
  }
  // Strip CSI before parse — injectable test runners (and a `gh` that still
  // colored despite GH_NO_COLOR) can return `\x1b[1;38m{…`. Colored JSON is
  // what produced `could not parse … comment JSON` under FORCE_COLOR (#4591).
  const raw = stripAnsi(commentsResult.out).trim();
  if (!raw || raw === "null") {
    return { ok: false, reason: `no ${label} comment found on PR`, detail: `Run: ${rerunHint}` };
  }

  let comment: { body: string };
  try {
    comment = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: `could not parse ${label} comment JSON`,
      detail: raw.slice(0, 200),
    };
  }

  // The jq filter only *selected* on the decoded body — the returned JSON still carries
  // the raw (possibly MCP-escaped) text, so decode again before parsing sha=/result=.
  const markerLine = decodeHtmlEntities(comment.body).split("\n")[0] ?? "";
  const shaMatch = markerLine.match(/sha=([0-9a-f]+)/);
  const resultMatch = markerLine.match(/result=([A-Z]+)/);
  if (!shaMatch)
    return { ok: false, reason: `${label} comment has no sha= in its marker`, detail: markerLine };
  if (!resultMatch)
    return {
      ok: false,
      reason: `${label} comment has no result= in its marker`,
      detail: markerLine,
    };

  const commentSha = shaMatch[1];
  const commentResult = resultMatch[1];

  if (commentResult !== "PASS" && commentResult !== "NA") {
    return {
      ok: false,
      reason: `${label} result is ${commentResult} — must be PASS or NA before merging`,
      detail: `Re-run: ${rerunHint}`,
    };
  }
  // Both SHAs are full 40-char (makeMarker + headRefOid).
  if (prHead !== commentSha) {
    return {
      ok: false,
      reason: `${label} sha mismatch — comment has ${commentSha.slice(0, 9)} but PR HEAD is ${prHead.slice(0, 9)}`,
      detail: `New commits were pushed after the last ${label} run. Re-run: ${rerunHint}`,
    };
  }
  return { ok: true, sha: commentSha, result: commentResult };
}
