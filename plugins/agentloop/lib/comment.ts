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
import { run, tail, trimFullLogsSection } from "./report.ts";

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
export type VerifyResult = "PASS" | "FAIL" | "NA" | "BLOCKED" | "TIMEOUT";

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
  if (args.dryRun) {
    console.error(
      `\n[dry-run] would upsert to PR #${pr}:\n${stickyBody(report, sha, result, markerPrefix)}`,
    );
    return { posted: true, reason: "dry-run" };
  }
  const res = postComment(pr, report, sha, result, runner, markerPrefix);
  if (!res.ok) {
    console.error(`❌ --comment: failed to post the report to PR #${pr}. Report NOT posted.`);
    if (res.out.trim()) {
      console.error(`--- gh output (last 2KB) ---\n${tail(res.out, 30).slice(-2000)}`);
    }
    return { posted: false, reason: "post-failed" };
  }
  console.error(`✅ report posted to PR #${pr}`);
  return { posted: true };
}
