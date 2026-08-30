#!/usr/bin/env bun
/**
 * Mirror PR-body issue declarations onto the referenced issues as an advisory
 * claim. This closes the coordination gap where work folded into another PR is
 * invisible to issue sweepers until the implementation is already complete.
 */
import { run } from "./report.ts";
import { shQuote } from "./shell.ts";

const CLAIM_LABEL = "agent:processing";
const CLAIM_MARKER_PREFIX = "<!-- linked-issue-claim";

export interface LinkedIssueClaimResult {
  issues: string[];
  claimed: string[];
  ok: boolean;
}

/** Extract unique same-repository declarations in their first-seen order. */
export function extractLinkedIssueNumbers(body: string): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const declarations = /(?:^|[\s(])(?:Part\s+of|Fixes|Closes)\s+#(\d+)\b/gi;
  for (const match of body.matchAll(declarations)) {
    const issue = match[1];
    if (!seen.has(issue)) {
      seen.add(issue);
      issues.push(issue);
    }
  }
  return issues;
}

function claimMarker(pr: string): string {
  return `${CLAIM_MARKER_PREFIX} pr=${pr} -->`;
}

function claimBody(pr: string): string {
  return `${claimMarker(pr)}\n🔒 Work on this issue is claimed by PR #${pr}.`;
}

/**
 * Add the advisory label once and upsert one marker-keyed comment per PR.
 * An empty declaration set is a successful, zero-I/O no-op: this is the
 * load-bearing reject side of the contract, not an error or a broad sweep.
 */
export function claimLinkedIssues(
  pr: string,
  body: string,
  runner = run,
  env: Record<string, string> = {},
): LinkedIssueClaimResult {
  const issues = extractLinkedIssueNumbers(body);
  if (!issues.length) return { issues, claimed: [], ok: true };

  const claimed: string[] = [];
  for (const issue of issues) {
    const labelled = runner(
      `gh api repos/{owner}/{repo}/issues/${issue} --jq ${shQuote(
        `[.labels[].name] | index(${JSON.stringify(CLAIM_LABEL)}) != null`,
      )}`,
      env,
    );
    if (labelled.code !== 0) continue;
    if (labelled.out.trim() !== "true") {
      const added = runner(
        `gh api -X POST repos/{owner}/{repo}/issues/${issue}/labels --input -`,
        env,
        JSON.stringify({ labels: [CLAIM_LABEL] }),
      );
      if (added.code !== 0) continue;
    }

    const marker = claimMarker(pr);
    const existing = runner(
      `gh api --paginate repos/{owner}/{repo}/issues/${issue}/comments --jq ${shQuote(
        `[.[] | select((.body // "") | startswith(${JSON.stringify(marker)}))][-1].id // empty`,
      )}`,
      env,
    );
    if (existing.code !== 0) continue;
    const rawId = existing.out.trim();
    const id = /^\d+$/.test(rawId) ? rawId : undefined;
    const payload = JSON.stringify({ body: claimBody(pr) });
    const posted = id
      ? runner(`gh api -X PATCH repos/{owner}/{repo}/issues/comments/${id} --input -`, env, payload)
      : runner(
          `gh api -X POST repos/{owner}/{repo}/issues/${issue}/comments --input -`,
          env,
          payload,
        );
    if (posted.code === 0) claimed.push(issue);
  }
  return { issues, claimed, ok: claimed.length === issues.length };
}
