/**
 * Pure TS predicates for issue-sweep Step 2 filter logic.
 * These are extracted from the SKILL.md prose so they can be unit-tested
 * without LLM calls — the "驱动层" (L1 Option B) of the golden-scenario harness.
 *
 * See: .claude/plugins/loop-engineering/skills/issue-sweep/SKILL.md Step 2
 *      ArcBlock/arc#1207 (L1 golden-scenario eval harness)
 *      ArcBlock/arc#1211 (L0/L1/L2/L3 framework discussion)
 */

export interface Comment {
  body: string;
  /** ISO-8601 creation timestamp */
  created_at?: string;
}

export interface Issue {
  number: number;
  labels?: string[];
  body?: string;
  comments: Comment[];
}

/** AI/agent comments start with `> 🤖 AI Agent` (per SKILL.md Step 2). */
export function isAiAgentComment(body: string): boolean {
  // Allow optional `@ <hostname>` line before the `> 🤖 AI Agent` marker
  const trimmed = body.trimStart();
  if (trimmed.startsWith("> 🤖 AI Agent")) return true;
  // Handle `@ vm\n\n> 🤖 AI Agent` format (CLAUDE.md hostname convention)
  const lines = trimmed.split("\n");
  if (lines[0]?.startsWith("@ ") && lines.some((l) => l.startsWith("> 🤖 AI Agent"))) return true;
  return false;
}

/**
 * Non-terminal AI comment patterns — the deferred/queued patterns that MUST be
 * re-processed rather than skipped (per SKILL.md Step 2 non-terminal rule).
 */
const NON_TERMINAL_PATTERNS =
  /排队|本轮未做|留开放|不在本轮|不在.{0,8}范围|非单\s*PR|多.?phase.*(留开放|不在)|candidate-queued|queued|in-progress|稍后|will\s+do|TODO/i;

/**
 * Terminal AI comment indicators — a last AI comment is terminal only when it
 * has REAL unlock conditions: done→PR, closed, or explicit human-gate verdict.
 */
const TERMINAL_INDICATORS =
  /PR\s*#\d+|pull\/\d+|issues\/\d+|needs-human-confirm|needs-design|security-sensitive|not-verifiable-here|已关闭|已合并|已完成|✅\s*(完成|done|closed)/i;

/**
 * Returns true if the AI comment indicates unfinished/deferred work that must
 * be re-picked up this run (not a terminal state).
 */
export function isNonTerminalAiComment(body: string): boolean {
  if (NON_TERMINAL_PATTERNS.test(body)) return true;
  // If it doesn't have a terminal indicator either, lean towards non-terminal
  // only when it's clearly "I will do X later" phrasing
  return false;
}

/**
 * Returns true if the AI comment is in a terminal state (done, waiting for
 * human-required action, or security gate).
 */
export function isTerminalAiComment(body: string): boolean {
  if (isNonTerminalAiComment(body)) return false;
  return TERMINAL_INDICATORS.test(body);
}

/**
 * Core Step 2 predicate: should this issue be kept in the processing set?
 *
 * Keep if:
 * 1. Zero comments AND no AI comment in body → body-only issue, unprocessed
 * 2. Last comment is a human comment (not AI)
 * 3. Last AI comment is non-terminal (deferred work pattern)
 *
 * Skip if:
 * - Last comment is a terminal AI comment
 */
export function shouldProcess(issue: Issue): boolean {
  const comments = issue.comments;

  // No comments — check if body itself has an AI agent response
  if (comments.length === 0) {
    const body = issue.body ?? "";
    return !isAiAgentComment(body);
  }

  const last = comments[comments.length - 1];
  if (!last) return false;

  // Last comment is human → keep
  if (!isAiAgentComment(last.body)) return true;

  // Last comment is AI — non-terminal deferred work → keep (re-process this run)
  if (isNonTerminalAiComment(last.body)) return true;

  // Last comment is terminal AI → skip
  return false;
}

/**
 * Extract sweep-trace markers from comment bodies.
 * Format: <!-- sweep-trace: {...} -->
 */
export function extractSweepTraces(
  body: string,
): Array<{ ver: number; issue?: number; pr?: number; gate: string; val: string; run: string }> {
  const pattern = /<!--\s*sweep-trace:\s*(\{[^}]+\})\s*-->/g;
  const results: Array<{
    ver: number;
    issue?: number;
    pr?: number;
    gate: string;
    val: string;
    run: string;
  }> = [];
  for (;;) {
    const match = pattern.exec(body);
    if (match === null) break;
    try {
      results.push(JSON.parse(match[1]!));
    } catch {
      // malformed trace — skip
    }
  }
  return results;
}
