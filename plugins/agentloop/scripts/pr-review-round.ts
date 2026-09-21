#!/usr/bin/env bun
/**
 * pr-review-round — how many review rounds a PR has actually had.
 *
 * Reads the `round` field out of the `sweep-trace` line that every pr-review verdict
 * comment carries (see pr-review/SKILL.md § sweep-trace), and prints one integer.
 *
 * ## Why this is a script and not a `jq` line in a skill
 *
 * `land`'s "at most 3 review rounds" is a rule enforced by COUNTING, and its own doc
 * says so. A count that lives as an inline shell snippet inside a prose instruction
 * has no test: a typo in the filter, a schema drift in the trace, or a `gh` hiccup all
 * yield the same `0` as a genuinely first-round PR — and `0` is the answer that says
 * "keep going". **A miscounted cap and an unenforced cap are the same color.** That is
 * the exact failure mode the repo's measurement discipline is about, so the counter
 * gets a real implementation, real fail-closed behavior, and real tests.
 *
 * ## Fail-closed
 *
 * "I could not read the PR" is NOT "round 0". A read failure exits non-zero with the
 * reason, so the caller stops instead of silently believing the cap is not reached.
 * Only a successful read that finds no trace prints `0`.
 *
 *   bun .claude/plugins/agentloop/scripts/pr-review-round.ts --pr 6255
 *   bun .claude/plugins/agentloop/scripts/pr-review-round.ts --pr 6255 --json
 */
import { run } from "../lib/report.ts";

/** A `round` we are willing to believe: a non-negative safe integer. */
function validRound(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * The highest `round` across every sweep-trace in these comment bodies.
 *
 * MAX, not last: the canonical verdict is upserted, but a repo may also carry
 * per-runner traces, and a lower number arriving later must never walk the count
 * backwards — that would hand the cap a way to be evaded by posting again.
 *
 * A malformed trace is skipped rather than treated as 0, and reported separately so
 * "no rounds yet" and "the traces are unreadable" do not print the same number.
 */
export function roundsFromComments(bodies: readonly string[]): {
  round: number;
  traces: number;
  malformed: number;
} {
  let round = 0;
  let traces = 0;
  let malformed = 0;
  for (const body of bodies) {
    for (const m of body.matchAll(/<!--\s*sweep-trace:\s*(\{.*?\})\s*-->/gs)) {
      traces++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(m[1] ?? "");
      } catch {
        malformed++;
        continue;
      }
      const r = (parsed as { round?: unknown; gate?: unknown }).round;
      // Only verdict traces carry rounds; other gates reuse the same envelope.
      if (r === undefined) continue;
      if (!validRound(r)) {
        malformed++;
        continue;
      }
      if (r > round) round = r;
    }
  }
  return { round, traces, malformed };
}

export interface RoundLookup {
  ok: true;
  round: number;
  traces: number;
  malformed: number;
}
export interface RoundLookupFail {
  ok: false;
  reason: string;
}

export function prReviewRound(
  pr: string,
  runner: (cmd: string) => { code: number; out: string } = (c) => run(c),
): RoundLookup | RoundLookupFail {
  if (!/^\d+$/.test(pr)) return { ok: false, reason: `not a PR number: ${pr}` };
  /**
   * `--paginate` over the REST comments endpoint, NOT `gh pr view --json comments`.
   *
   * That GraphQL projection returns only the first page. On a PR with more comments
   * than fit one page, the ones it drops are precisely the newest — and since round
   * numbers only grow, the newest comment is where the highest round lives. The
   * count would come back LOW, and a low count is the answer that says "you may run
   * another round": the 3-round cap would quietly stop binding on exactly the busy
   * PRs it exists for. Same endpoint and flag `requireStickyGate` already uses.
   */
  const r = runner(
    `gh api --paginate "repos/{owner}/{repo}/issues/${pr}/comments" --jq '.[].body | @json'`,
  );
  if (r.code !== 0) {
    return { ok: false, reason: `gh exited ${r.code} — cannot read PR #${pr}'s comments` };
  }
  /**
   * One JSON-quoted string PER LINE, not one array.
   *
   * `gh --jq` is raw-output (like `jq -r`). `.[].body` therefore prints the body
   * text itself — a comment that contains newlines occupies several lines, and
   * `JSON.parse` of the first line fail-closes every PR that has a real comment
   * (#6334). `| @json` is the token that escapes those newlines so one body is
   * still exactly one line.
   *
   * With `--paginate`, gh applies `--jq` to each page and concatenates the results,
   * so an array filter (`[.[].body]`) emits `[...][...]` — several JSON documents
   * back to back, which `JSON.parse` rejects. Emitting one value per line survives
   * concatenation.
   */
  const bodies: string[] = [];
  for (const line of r.out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      // Transport is not delivering what we asked for. Fail closed: a dropped body
      // silently lowers the round, and a lower round is the permissive answer.
      return { ok: false, reason: "gh returned a line that is not a JSON string" };
    }
    if (typeof parsed !== "string") {
      return { ok: false, reason: "gh returned a non-string comment body" };
    }
    bodies.push(parsed);
  }
  return { ok: true, ...roundsFromComments(bodies) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const pr = argv[argv.indexOf("--pr") + 1];
  if (!argv.includes("--pr") || !pr) {
    console.error("usage: pr-review-round.ts --pr <n> [--json]");
    process.exit(64);
  }
  const res = prReviewRound(pr);
  if (!res.ok) {
    console.error(`✗ ${res.reason}`);
    console.error("  「读不到」不是「第 0 轮」—— 停下来，不要当成还没审过。");
    process.exit(2);
  }
  console.log(argv.includes("--json") ? JSON.stringify(res) : String(res.round));
}
