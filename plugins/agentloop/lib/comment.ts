#!/usr/bin/env bun
/**
 * comment — deliver a verification report to a PR as ONE atomic step with the
 * gate run. Upsert-by-marker sticky comment so re-running on each push edits one
 * comment instead of spamming new ones.
 *
 * Repo-agnostic: the only repo-shaped input is the git remote, resolved via
 * `git remote get-url origin`. `parseOwnerRepoFromGitUrl` is inlined here (it was
 * borrowed from a sibling arc skill in the ancestor) so the engine has no
 * cross-skill import.
 *
 * This is I/O (not pure render), so it lives OUTSIDE report.ts.
 */
import { run, stripAnsi, tail, trimFullLogsSection } from "./report.ts";

/**
 * Resolve `owner/repo` from a git remote URL. Handles GitHub SSH/HTTPS and the
 * cloud-session git-proxy form (`…/git/<owner>/<repo>`). Returns null when
 * unresolvable so callers degrade instead of throwing.
 */
export function parseOwnerRepoFromGitUrl(url: string): string | null {
  const trimmed = url.trim();
  const github = trimmed.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (github) return `${github[1]}/${github[2]}`;
  const proxy = trimmed.match(/\/git\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return proxy ? `${proxy[1]}/${proxy[2]}` : null;
}

/**
 * Resolve `owner/repo` for the `GH_REPO` env so `gh api`'s `{owner}/{repo}`
 * placeholder never depends on gh's own remote auto-detection — that fails in
 * cloud-session sandboxes whose origin is a git-proxy URL gh doesn't recognize.
 * Empty (not thrown) when unresolvable so callers keep working with a real remote.
 */
export function resolveGhRepoEnv(runner = run): Record<string, string> {
  const { code, out } = runner("git remote get-url origin 2>/dev/null");
  if (code !== 0) return {};
  const repo = parseOwnerRepoFromGitUrl(out);
  return repo ? { GH_REPO: repo } : {};
}

/**
 * Undo the HTML-entity escaping GitHub's `mcp__github__add_issue_comment` tool
 * applies to comment bodies (`<` `>` `&` `'` `"`) — the `gh` CLI path posts
 * bodies verbatim, but a session blocked from `gh` (e.g. a 403'd proxy) falls
 * back to MCP, and every literal `<!-- marker` prefix then arrives as
 * `&lt;!-- marker`. Any code that matches a marker literally against the raw
 * body must decode through this first, or an MCP-posted gate/verdict comment
 * becomes invisible to it (#4283 — merge-gate read "no verification comment
 * found on PR" against a PR that actually had one, MCP-escaped).
 * `&amp;` decodes last so a (hypothetical) double-escaped `&amp;lt;` isn't
 * mangled by the earlier `&lt;` pass.
 */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * jq expression fragment (assumes a string is piped in) applying the same
 * decode as `decodeHtmlEntities` — for filters that must match a marker
 * prefix server-side, inside `gh api --jq`, before the body ever reaches TS.
 * Built via `JSON.stringify` (not hand-escaped) so jq's JSON-compatible string
 * syntax is correct by construction, including the embedded `"` for `&quot;`.
 */
export const HTML_DECODE_JQ = (
  [
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&#39;", "'"],
    ["&amp;", "&"],
  ] as const
)
  .map(([from, to]) => `gsub(${JSON.stringify(from)};${JSON.stringify(to)})`)
  .join(" | ");

/**
 * Escape a string for safe embedding as a single-quoted POSIX shell argument
 * (`'...'`). Required for any `--jq` filter built from `HTML_DECODE_JQ` — its
 * `&#39;` → `'` mapping embeds a literal single quote in the filter text, which
 * breaks a naively single-quoted shell argument (`--jq '...'''...'`) with an
 * "unexpected EOF" parse error, silently degrading every caller: `gate.ts`'s
 * `requireStickyGate` read it as "could not fetch comments" (failing the merge
 * gate closed, at least safely), while `postOnce`'s upsert lookup below read the
 * error text as a non-numeric id and fell through to POST — duplicating the
 * sticky comment on every run instead of patching it in place. Neither failure
 * mode surfaced in the hermetic unit tests because they inject a mock `runner`
 * that never touches a real shell (see `gate.test.ts`'s `withComment`).
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Stable prefix used to find existing verification-report comments (upsert key).
 * Full marker line is dynamic: <!-- verification-report sha=<sha> result=<PASS|FAIL> -->
 * Matching on the prefix ensures a comment written with an older sha is still
 * found and updated (no duplicate comments across pushes).
 */
export const MARKER_PREFIX = "<!-- verification-report";

/**
 * `BLOCKED` (issue #3010): distinct from `FAIL` — the gate RAN but its required evidence
 * could not be durably published (e.g. an asset upload failed, or evidence exists only
 * as a local file path never posted anywhere readable). `requireStickyGate` already
 * rejects anything outside {PASS, NA}, so `BLOCKED` fails closed for free — it exists so
 * reports can say WHY a gate is red (upload/publish failure) instead of conflating it
 * with a technical assertion failure. Never derive `BLOCKED` by hand — it must come from
 * a structural check (e.g. "is this URL a local path or an unreachable host") the same
 * way PASS/FAIL are derived from measured outcomes, not hand-filled.
 */
/**
 * `TIMEOUT` (issue #3170, follow-up to #2880/#3166): distinct from `FAIL` — the gate
 * RAN but a watchdog killed it before any check observed a real failure (a cold
 * turbo test-cache + wide affected surface can legitimately exceed the budget with
 * zero test failures). Without this, a genuine "nothing was verified" reads
 * identically to "a test broke" in the marker, so neither a human nor an agent can
 * tell them apart without opening the rawTail. `requireStickyGate` already rejects
 * anything outside {PASS, NA}, so `TIMEOUT` fails closed for free — same shape as
 * `BLOCKED` above. Never derive it by hand — it must come from `deriveResult()`
 * (report.ts), which requires every blocking failure to be a structurally-measured
 * timeout with zero observed failures; any real failure always dominates to `FAIL`.
 */
/**
 * `PARTIAL` (issue #5067): distinct from `PASS` — every check that RAN passed, but the
 * run was scoped by `--only`/`--skip`, so the gate's coverage was never established. It
 * is emitted for a green partial run only (a red partial stays `FAIL`/`TIMEOUT`, because
 * a red is already a red and `FAIL` carries the #3062 diagnostic semantics). Like
 * `BLOCKED` and `TIMEOUT` above, it fails closed for free: `requireStickyGate` accepts
 * only {PASS, NA}, `--deliver-cached` exits non-zero on anything else, and
 * `tools/pre-push.sh` compares the `.result` file against PASS/NA. Never derive it by
 * hand — the scenario runner derives it from a structural fact (were `--only`/`--skip`
 * present?), never from judgement.
 */
export type VerifyResult = "PASS" | "FAIL" | "NA" | "BLOCKED" | "TIMEOUT" | "PARTIAL";

/** Build a dynamic marker encoding sha + result (parsed by a merge-gate). */
export function makeMarker(sha: string, result: VerifyResult, prefix = MARKER_PREFIX): string {
  return `${prefix} sha=${sha} result=${result} -->`;
}

export interface CommentArgs {
  /** was --comment / --comment=<n> / --comment-dry-run / --dry-run present? */
  post: boolean;
  /** explicit PR number from the flag (if given) */
  pr?: string;
  /** dry-run: resolve + render but print instead of calling gh */
  dryRun: boolean;
}

/**
 * Parse the comment flags out of argv. Accepts:
 *   --comment / --comment <pr#> / --comment=<pr#>
 *   --comment-dry-run [<pr#>]
 *   --dry-run [<pr#>]        — canonical alias of --comment-dry-run. For the
 *                              verification gate the comment is the only outward
 *                              write, so bare --dry-run unambiguously means "don't
 *                              post the report, print it" (the plugin's dry-run
 *                              contract). Checks always run either way.
 */
export function parseCommentArgs(argv: string[]): CommentArgs {
  let post = false;
  let dryRun = false;
  let pr: string | undefined;
  const isDry = (a: string) => a === "--comment-dry-run" || a === "--dry-run";
  const isDryEq = (a: string) => a.startsWith("--comment-dry-run=") || a.startsWith("--dry-run=");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--comment" || isDry(a)) {
      post = true;
      if (isDry(a)) dryRun = true;
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) pr = next;
    } else if (a.startsWith("--comment=") || isDryEq(a)) {
      post = true;
      if (isDryEq(a)) dryRun = true;
      const v = a.slice(a.indexOf("=") + 1);
      if (/^\d+$/.test(v)) pr = v;
    }
  }
  return { post, pr, dryRun };
}

/** Comment body: dynamic marker + report (marker encodes sha+result). */
export function stickyBody(
  report: string,
  sha: string,
  result: VerifyResult,
  prefix = MARKER_PREFIX,
): string {
  return `${makeMarker(sha, result, prefix)}\n${report}`;
}

/**
 * Resolve the target PR: explicit flag value, else the open PR for the current
 * branch (`gh pr view`). Undefined if neither resolves.
 */
export function resolvePr(explicit: string | undefined, runner = run): string | undefined {
  if (explicit) return explicit;
  // `gh pr view` (no args) resolves by current branch and is NOT limited to
  // open PRs — when a deterministic branch name is reused across slices
  // (issue-sweep's dedup discipline: `claude/issue-<N>`) and this runs before
  // `gh pr create` for the new slice, it falls back to the OLD merged/closed
  // PR for that branch name, silently overwriting its sticky comment with a
  // report for an unrelated commit (real incident: PR #1733, 2026-07-16).
  const { code, out } = runner(
    "gh pr view --json number,state --jq 'select(.state == \"OPEN\") | .number' 2>/dev/null",
  );
  const n = out.trim();
  return code === 0 && /^\d+$/.test(n) ? n : undefined;
}

export interface PostCommentResult {
  ok: boolean;
  /** stdout+stderr of the create/PATCH call, for diagnostics. */
  out: string;
}

/** The outbound proxy enforces a "comment-filter work budget" on `gh api` comment
 *  calls, independent of GitHub's 65536-char limit — a report well under that limit
 *  can still be rejected with HTTP 403 `Request body exhausted the comment-filter
 *  work budget` (#1922). `postComment` retries once with the Full Logs appendix
 *  stripped when it sees this exact error. */
function isCommentFilterBudgetError(out: string): boolean {
  return /comment-filter work budget/i.test(out);
}

/**
 * Upsert `body` onto issue/PR number `pr` as a marker-keyed sticky comment (works
 * for either — GitHub's REST API treats issue and PR comments identically). Matches
 * on `markerPrefix` (not the full dynamic marker) so a comment written with a prior
 * sha is found and updated, not duplicated. Exported so non-verification callers
 * (e.g. scripts/team-report.ts's `--post-issue`) can reuse the same upsert-by-
 * marker-prefix dance instead of re-implementing the lookup+PATCH/POST.
 *
 * The lookup requires the marker to open the comment's **first non-empty line**
 * (`stickyBody` always writes it there) — a comment that merely *mentions* or
 * quotes the marker text somewhere in its prose does NOT match. Before #3576 this
 * was a plain substring `test()` anywhere in the body: a pr-review verdict comment
 * that quoted the marker to explain a cached report got matched and overwritten by
 * the next `postOnce` upsert, destroying the verdict. This intentionally narrows
 * #1246's old accommodation (a hand-written header pushing the real marker to line
 * 2 no longer upserts, it now posts a duplicate) — that trade was made explicitly
 * on #3576, see the issue for both incidents.
 */
export function postOnce(
  pr: string,
  body: string,
  runner: typeof run,
  markerPrefix: string,
): PostCommentResult {
  const payload = JSON.stringify({ body });
  const ghRepoEnv = resolveGhRepoEnv(runner);
  // Decode HTML entities on the extracted first line before testing — an MCP-posted
  // sticky comment (marker escaped to `&lt;!-- ...`) must still be found, or the next
  // `gh`-posted run can't PATCH it and spams a duplicate instead (#4283).
  const firstLineTest =
    `(.body // "" | split("\\n") | map(select(length > 0)) | (.[0] // "") | ${HTML_DECODE_JQ}) | ` +
    `test("^${markerPrefix}")`;
  const found = runner(
    `gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" ` +
      `--jq ${shQuote(`[.[] | select(${firstLineTest})][-1].id // empty`)}`,
    ghRepoEnv,
  );
  // Trust the lookup only when the call succeeded AND it looks like a numeric id
  // — otherwise fall back to POST instead of PATCHing a bogus target (error text
  // must never be mistaken for an id).
  const rawId = found.out.trim();
  const id = found.code === 0 && /^\d+$/.test(rawId) ? rawId : undefined;
  const res = id
    ? runner(
        `gh api -X PATCH "repos/{owner}/{repo}/issues/comments/${id}" --input -`,
        ghRepoEnv,
        payload,
      )
    : runner(
        `gh api -X POST "repos/{owner}/{repo}/issues/${pr}/comments" --input -`,
        ghRepoEnv,
        payload,
      );
  return { ok: res.code === 0, out: res.out };
}

/**
 * Upsert the report onto PR `pr` as a marker-keyed sticky comment. Matches on
 * MARKER_PREFIX (not the full dynamic marker) so a comment written with a prior
 * sha is found and updated, not duplicated. `runner` injectable for tests. Retries
 * once with the Full Logs section stripped on a comment-filter work-budget 403.
 */
export function postComment(
  pr: string,
  report: string,
  sha: string,
  result: VerifyResult,
  runner = run,
  markerPrefix = MARKER_PREFIX,
): PostCommentResult {
  const first = postOnce(pr, stickyBody(report, sha, result, markerPrefix), runner, markerPrefix);
  if (first.ok || !isCommentFilterBudgetError(first.out)) return first;
  const trimmedReport = trimFullLogsSection(report, sha);
  if (trimmedReport === report) return first; // nothing to trim — retrying repeats the same body
  return postOnce(pr, stickyBody(trimmedReport, sha, result, markerPrefix), runner, markerPrefix);
}

/**
 * How a report's sha relates to the PR it is about to be delivered to (issue #5060).
 *
 *   head     the sha IS the PR's head — the normal delivery
 *   behind   an older commit on the PR's branch (ancestor of its head) — deliverable,
 *            but the report is NOT a statement about the current head
 *   ahead    a descendant of the PR's recorded head — the ordinary pre-push case, where
 *            the hook delivers before the ref update makes the new head visible
 *   branch   no ancestry either way, but this checkout sits on the PR's own head branch —
 *            a local rebase / force-push in flight; still this PR's work
 *   foreign  none of the above: the report is about work that is not this PR's
 *   unknown  the PR's head could not be read, so attribution is impossible
 */
export type PrShaRelation = "head" | "behind" | "ahead" | "branch" | "foreign" | "unknown";

export interface PrShaAttribution {
  relation: PrShaRelation;
  /** the PR head oid as GitHub currently records it (absent iff `unknown`) */
  prHead?: string;
  /** the PR's head branch name */
  prBranch?: string;
  /** best-effort local branch name(s) carrying `sha` */
  shaBranch?: string;
  /** one sentence naming BOTH sides — used verbatim in the refusal message */
  detail: string;
}

const short = (sha: string): string => sha.slice(0, 9);

/** Best-effort local branch name(s) containing `sha`, for naming the other side. */
function branchesContaining(sha: string, runner: typeof run): string | undefined {
  const r = runner(`git branch --contains ${sha} --format='%(refname:short)' 2>/dev/null`);
  if (r.code !== 0) return undefined;
  const names = stripAnsi(r.out)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("("));
  return names.length ? names.join(", ") : undefined;
}

/**
 * Decide whether `sha` belongs to PR `pr` (issue #5060).
 *
 * `--comment <PR#>` used to write the sticky comment wherever it was pointed: on
 * 2026-08-25 PR #5049's sticky was overwritten with sha `4edf808af`, a commit on
 * `factory/5018-independent-substrate`, and a human had to re-deliver the real one by
 * hand. The merge gate is fail-closed on its own SHA match, so this is about the half a
 * HUMAN reads — a foreign red reads as "this PR failed", and a foreign green is worse.
 *
 * Relatedness is deliberately generous in three directions, because the accept path is
 * the one an over-tightening breaks: an ancestor (an older commit on the branch), a
 * descendant (the pre-push hook delivers BEFORE the ref update, so GitHub still shows
 * the old head), and same-branch-no-ancestry (a local rebase not yet force-pushed) are
 * all this PR's work. Only "no relationship at all" is refused.
 *
 * `unknown` (the PR head could not be read) is refused too, and that costs nothing in
 * practice: every path that reads the head is the same `gh` that would have to post the
 * comment, so a lookup that cannot run belongs to a delivery that could not have landed.
 */
export function attributeShaToPr(pr: string, sha: string, runner = run): PrShaAttribution {
  const view = runner(`gh pr view ${pr} --json headRefOid,headRefName 2>/dev/null`);
  let prHead: string | undefined;
  let prBranch: string | undefined;
  if (view.code === 0) {
    try {
      const parsed = JSON.parse(stripAnsi(view.out).trim()) as {
        headRefOid?: unknown;
        headRefName?: unknown;
      };
      if (typeof parsed.headRefOid === "string" && /^[0-9a-f]{7,40}$/.test(parsed.headRefOid))
        prHead = parsed.headRefOid;
      if (typeof parsed.headRefName === "string" && parsed.headRefName.trim())
        prBranch = parsed.headRefName.trim();
    } catch {
      // Unparseable payload → attribution impossible; handled as `unknown` below.
    }
  }
  const shaBranch = branchesContaining(sha, runner);
  if (!prHead) {
    return {
      relation: "unknown",
      prBranch,
      shaBranch,
      detail:
        `could not read PR #${pr}'s head commit from GitHub, so report sha ${short(sha)}` +
        `${shaBranch ? ` (on ${shaBranch})` : ""} cannot be attributed to it`,
    };
  }
  const both =
    `report sha ${short(sha)}${shaBranch ? ` (on ${shaBranch})` : ""} vs ` +
    `PR #${pr} head ${short(prHead)}${prBranch ? ` (on ${prBranch})` : ""}`;
  const at = (relation: PrShaRelation): PrShaAttribution => ({
    relation,
    prHead,
    prBranch,
    shaBranch,
    detail: both,
  });
  if (prHead === sha) return at("head");
  // `--is-ancestor` is reflexive, so the equality case above must be settled first.
  const isAncestor = (a: string, b: string): boolean =>
    runner(`git merge-base --is-ancestor ${a} ${b} 2>/dev/null`).code === 0;
  if (isAncestor(sha, prHead)) return at("behind");
  if (isAncestor(prHead, sha)) return at("ahead");
  const current = runner("git rev-parse --abbrev-ref HEAD 2>/dev/null");
  const currentBranch = current.code === 0 ? stripAnsi(current.out).trim() : "";
  if (prBranch && currentBranch && currentBranch === prBranch) return at("branch");
  return at("foreign");
}

/**
 * Banner for the third state: a real report for a real commit on this PR's branch that
 * is NOT its head. Delivering it silently would let a green from an earlier commit read
 * as a gate for the current one; refusing it outright would throw away a legitimate
 * report. So it is delivered, labelled.
 */
export function notHeadNotice(pr: string, sha: string, prHead: string): string {
  return (
    `> ⚠️ **NOT THE PR HEAD** — this report is for \`${short(sha)}\`, but PR #${pr}'s head is ` +
    `\`${short(prHead)}\`. It describes an earlier commit on this branch and does **not** ` +
    `verify the current head.`
  );
}

/**
 * Read back the sha in the marker of the sticky comment GitHub actually holds.
 * `undefined` = could not be read (no claim either way).
 *
 * This is the manual ritual #5060 exists to retire: every competent runner that night
 * ended up pulling the posted comment back and diffing its `sha=` against
 * `git rev-parse HEAD`. Doing it here means nobody has to remember.
 */
export function readDeliveredSha(
  pr: string,
  runner = run,
  markerPrefix = MARKER_PREFIX,
): string | undefined {
  const firstLineTest =
    `(.body // "" | split("\\n") | map(select(length > 0)) | (.[0] // "") | ${HTML_DECODE_JQ}) | ` +
    `test("^${markerPrefix}")`;
  const found = runner(
    `gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" ` +
      `--jq ${shQuote(`[.[] | select(${firstLineTest})][-1].body // empty`)} 2>/dev/null`,
    resolveGhRepoEnv(runner),
  );
  if (found.code !== 0) return undefined;
  const first = decodeHtmlEntities(stripAnsi(found.out))
    .split("\n")
    .find((l) => l.trim().length > 0);
  return first?.match(/sha=([0-9a-f]+)/)?.[1];
}

/**
 * The one call the scenario runner makes after rendering. Honors --comment /
 * --comment-dry-run; no-ops when neither is present. Prints a loud line on any
 * failure so a requested post that didn't land can't pass silently — but never
 * changes the gate's exit code (PASS/FAIL is authoritative).
 */
export function deliverComment(
  args: CommentArgs,
  report: string,
  sha: string,
  result: VerifyResult,
  runner = run,
  markerPrefix = MARKER_PREFIX,
): { posted: boolean; reason?: string } {
  if (!args.post) return { posted: false };
  const pr = resolvePr(args.pr, runner);
  if (!pr) {
    console.error(
      "❌ --comment requested but no PR resolved (pass `--comment <pr#>` or run on a branch with an open PR). Report NOT posted.",
    );
    return { posted: false, reason: "no-pr" };
  }

  // #5060: the sticky is the only visible face of "last verification result", and it is
  // upserted in place — a delivery aimed at the wrong PR does not add noise, it DESTROYS
  // the record that was there. Attribute before writing; refuse rather than overwrite.
  const attribution = attributeShaToPr(pr, sha, runner);
  if (attribution.relation === "foreign" || attribution.relation === "unknown") {
    console.error(
      `❌ --comment: refusing to deliver to PR #${pr} — ${attribution.detail}. Report NOT posted.`,
    );
    console.error(
      attribution.relation === "foreign"
        ? "  This report is about work that does not belong to that PR; delivering it would overwrite that PR's sticky comment."
        : "  Attribution could not be established, and an unattributable report must not overwrite a PR's sticky comment.",
    );
    return {
      posted: false,
      reason: attribution.relation === "foreign" ? "pr-sha-foreign" : "pr-sha-unverified",
    };
  }
  // Third state: a genuine report for a genuine commit on this PR's branch that is not
  // its head. Deliverable — but never silently, or its green reads as a head gate.
  const body =
    attribution.relation === "behind" && attribution.prHead
      ? `${notHeadNotice(pr, sha, attribution.prHead)}\n\n${report}`
      : report;

  if (args.dryRun) {
    console.error(
      `\n[dry-run] would upsert to PR #${pr}:\n${stickyBody(body, sha, result, markerPrefix)}`,
    );
    return { posted: true, reason: "dry-run" };
  }
  const res = postComment(pr, body, sha, result, runner, markerPrefix);
  if (!res.ok) {
    console.error(`❌ --comment: failed to post the report to PR #${pr}. Report NOT posted.`);
    if (res.out.trim()) {
      console.error(`--- gh output (last 2KB) ---\n${tail(res.out, 30).slice(-2000)}`);
    }
    return { posted: false, reason: "post-failed" };
  }

  // Read back what GitHub actually holds (#5060). Asymmetric on purpose: POSITIVE
  // evidence of a different sha means our report is not the one on the PR and the
  // delivery failed; ABSENCE of evidence (the read-back call itself did not run) only
  // warns, because a flaky read must not turn a landed report into a failed gate.
  const delivered = readDeliveredSha(pr, runner, markerPrefix);
  if (delivered === undefined) {
    console.error(
      `⚠️ --comment: posted to PR #${pr} but could not read the comment back to confirm its sha.`,
    );
  } else if (delivered !== sha) {
    console.error(
      `❌ --comment: PR #${pr}'s sticky comment holds sha ${short(delivered)}, not the ${short(sha)} just posted — another runner overwrote it. Report NOT delivered.`,
    );
    return { posted: false, reason: "readback-mismatch" };
  }
  console.error(
    `✅ report posted to PR #${pr}${attribution.relation === "behind" ? " (marked NOT-HEAD)" : ""}`,
  );
  return { posted: true };
}
