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
  /**
   * Set ONLY on a sha mismatch, and only then: the sticky that was found, its
   * `sha=`/`result=` read off the marker by this function.
   *
   * Structured because the caller must not re-derive it from `reason`'s prose —
   * the one consumer (`carryForwardStickyGate`) decides whether evidence at
   * `commentSha` still covers the current head, and a regex over a human
   * sentence is not a fact source. Absent on every other failure, which is what
   * makes "stale" mechanically distinguishable from "missing"/"FAIL".
   */
  stale?: { commentSha: string; commentResult: string };
}

export interface StickyGateOpts {
  /** Default `{PASS, NA}`. A door that cannot take the docs/native exemption passes `{PASS}`. */
  accept?: readonly string[];
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
  opts?: StickyGateOpts,
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
  // Bind the CAPTURED GROUPS (not the match objects) so the two values are typed
  // `string` from here down. The guards below are the same two reachable checks as
  // before — a marker line with no `sha=` still returns "has no sha= in its marker" —
  // they just narrow as well, which keeps the `stale` payload and the success return
  // free of `string | undefined` instead of adding to the typecheck ratchet's debt.
  const commentSha = markerLine.match(/sha=([0-9a-f]+)/)?.[1];
  const commentResult = markerLine.match(/result=([A-Z]+)/)?.[1];
  if (commentSha === undefined)
    return { ok: false, reason: `${label} comment has no sha= in its marker`, detail: markerLine };
  if (commentResult === undefined)
    return {
      ok: false,
      reason: `${label} comment has no result= in its marker`,
      detail: markerLine,
    };

  const accept = opts?.accept ?? ["PASS", "NA"];

  if (!accept.includes(commentResult)) {
    return {
      ok: false,
      reason: `${label} result is ${commentResult} — must be ${accept.join(" or ")} before merging`,
      detail: `Re-run: ${rerunHint}`,
    };
  }
  // Both SHAs are full 40-char (makeMarker + headRefOid).
  if (prHead !== commentSha) {
    return {
      ok: false,
      reason: `${label} sha mismatch — comment has ${commentSha.slice(0, 9)} but PR HEAD is ${prHead.slice(0, 9)}`,
      detail: `New commits were pushed after the last ${label} run. Re-run: ${rerunHint}`,
      stale: { commentSha, commentResult },
    };
  }
  return { ok: true, sha: commentSha, result: commentResult };
}

export interface DeltaOk {
  ok: true;
  files: string[];
  /**
   * The two commits point at the SAME tree — not merely "the diff printed nothing".
   *
   * This is what separates a real no-op (a `--amend` that only rewrote the commit
   * message, a rebase that replayed cleanly) from a broken enumerator that returns
   * `[]` because it was asked the wrong question. Without it, an empty `files` has
   * to be refused (a silent `[]` is how a blind instrument reads as "all clear"),
   * which forces a full re-run for a commit that provably changed no content.
   */
  identicalTrees: boolean;
}

export interface CarryForwardOpts {
  /** Files changed between two shas. `ok:false` ⇒ we cannot decide ⇒ stay stale. */
  delta: (fromSha: string, toSha: string) => DeltaOk | { ok: false; reason: string };
  /**
   * True when NOTHING in `files` could change what this evidence proved.
   *
   * This is the repo's knowledge, not the plugin's: only the consuming repo knows
   * which paths are inputs to the thing the gate booted/measured. It must be
   * conservative — returning true for a file that CAN affect the subject carries
   * evidence onto a state it never observed, which is worse than re-running.
   */
  unaffected: (files: readonly string[]) => boolean;
  /** Results whose evidence may be carried at all. Default `{PASS}`. */
  carryable?: readonly string[];
}

export type CarryForward =
  | { carried: true; result: string; fromSha: string; deltaFiles: number }
  | { carried: false; why: string };

/**
 * Decide whether a STALE sticky still covers the current head.
 *
 * ## Why this exists
 *
 * Every gate here is sha-keyed, so **any** push invalidates **all** of them —
 * including evidence the push provably cannot affect. Combined with each gate's
 * remediation being "produce the evidence again", that makes a loop whose cost is
 * `O(fixes × evidence cost)`: each fix stale-dates the evidence that found it.
 * Measured on arc#6251/#6255: a docs-only follow-up commit re-demanded a full
 * data-plane boot (3 blocklets × 2 runtimes, ~20 probes) that could not have
 * changed by one byte.
 *
 * The key is not "did the sha change" but **"did the subject change"**. `unaffected`
 * is that question, asked of the delta only.
 *
 * ## What keeps this honest
 *
 * Four fail-closed conditions, each of which makes a wrong carry impossible rather
 * than unlikely:
 *
 * 1. Only a `stale` failure is carryable. "No comment", "FAIL", "unparseable" are
 *    NOT staleness — they are absence or a verdict, and neither improves with age.
 * 2. Only a carryable result (default `PASS`). A carried `NA`/`BLOCKED` would be
 *    laundering a non-answer into an answer.
 * 3. The delta must be COMPUTABLE. `ok:false` (sha not local, git failed) ⇒ stale.
 *    "I could not check" must never read as "nothing changed" — that is the same
 *    same-color failure this repo keeps paying for.
 * 4. An EMPTY delta is refused UNLESS the two commits point at the same tree.
 *    A silent `[]` is exactly how a broken enumerator reads as "all clear", so it
 *    cannot be a free pass on its own. But `identicalTrees` is a positive fact, not
 *    an absence: a `--amend` that only rewrote the commit message, or a clean
 *    rebase replay, provably changed no content, and forcing a full re-run there
 *    would be the very over-invalidation this function exists to stop. So the
 *    discriminator is "the trees are equal", never "the diff printed nothing".
 */
export function carryForwardStickyGate(
  gate: GateFail,
  prHead: string,
  opts: CarryForwardOpts,
): CarryForward {
  if (!gate.stale)
    return { carried: false, why: "not a stale sticky (missing / FAIL / unparseable)" };
  const carryable = opts.carryable ?? ["PASS"];
  if (!carryable.includes(gate.stale.commentResult)) {
    return { carried: false, why: `result ${gate.stale.commentResult} is not carryable` };
  }
  const d = opts.delta(gate.stale.commentSha, prHead);
  if (!d.ok) return { carried: false, why: `cannot compute the delta (${d.reason})` };
  if (d.files.length === 0 && !d.identicalTrees) {
    return {
      carried: false,
      why: "delta between two different shas came back EMPTY without equal trees — not trusted",
    };
  }
  if (!opts.unaffected(d.files)) {
    return { carried: false, why: "the delta touches the surface this evidence covers" };
  }
  return {
    carried: true,
    result: gate.stale.commentResult,
    fromSha: gate.stale.commentSha,
    deltaFiles: d.files.length,
  };
}
