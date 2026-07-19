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
 * Stable prefix used to find existing verification-report comments (upsert key).
 * Full marker line is dynamic: <!-- verification-report sha=<sha> result=<PASS|FAIL> -->
 * Matching on the prefix ensures a comment written with an older sha is still
 * found and updated (no duplicate comments across pushes).
 */
export const MARKER_PREFIX = "<!-- verification-report";

export type VerifyResult = "PASS" | "FAIL" | "NA";

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
 */
export function postOnce(
  pr: string,
  body: string,
  runner: typeof run,
  markerPrefix: string,
): PostCommentResult {
  const payload = JSON.stringify({ body });
  const ghRepoEnv = resolveGhRepoEnv(runner);
  const found = runner(
    `gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" ` +
      `--jq '[.[] | select(.body|test("${markerPrefix}"))][-1].id // empty'`,
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
  const trimmedReport = trimFullLogsSection(report);
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
