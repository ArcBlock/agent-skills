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
import { run } from "./report.ts";

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
 */
export function requireStickyGate(
  pr: string,
  prHead: string,
  prefix: string,
  label: string,
  rerunHint: string,
  runner: Runner = run,
): GatePass | GateFail {
  let commentsResult = runner(
    `gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" ` +
      `--jq '[.[] | select(.body|startswith("${prefix}"))][-1] // empty' 2>/dev/null`,
  );
  if (commentsResult.code !== 0 || !commentsResult.out.trim()) {
    // Fall back to `gh pr view --json comments` (GraphQL) — observed in
    // practice: `issues/<n>/comments` (REST) intermittently 503s while
    // `gh pr view --json` keeps working. Only trust this fallback's own
    // exit code, not the REST attempt's, so a REST 503 doesn't mask a
    // genuine "no comment" result from the fallback.
    const fallback = runner(
      `gh pr view ${pr} --json comments ` +
        `--jq '[.comments[] | select(.body|startswith("${prefix}"))] | last // empty' 2>/dev/null`,
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
  const raw = commentsResult.out.trim();
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

  const markerLine = comment.body.split("\n")[0] ?? "";
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
