/**
 * Pure TS predicates for issue-sweep Step 2 filter logic.
 * These are extracted from the SKILL.md prose so they can be unit-tested
 * without LLM calls — the "驱动层" (L1 Option B) of the golden-scenario harness.
 *
 * See: .claude/plugins/agentloop/skills/issue-sweep/SKILL.md Step 2
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

/**
 * Strip fenced and inline code before matching prose markers. Without this, a
 * marker word inside a snippet is a false positive: a live sweep classified an
 * issue as "deferred" because the YAML key `cancel-in-progress: false` in a code
 * block matched the `in-progress` pattern.
 */
export function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * Agent/script-authored markers. NOT just `🤖`: the presence board's heartbeat
 * opens with `> 📡` and is written by a script under a HUMAN account — a
 * 🤖-only predicate reads it as fresh human input EVERY round (live-sweep finding).
 * The identity-line suffix (`runner:… · skills@…`, CLAUDE.md #1347) is the
 * third signal, per SKILL.md's own broader rule.
 */
// A `##`-header opener counts too: not every repo writes the blockquote form. did's
// agent comments open `## 🤖 pr-review` (measured: 10 of 14 on ArcBlock/did#22), which a
// blockquote-only predicate reads as fresh human input every round.
const AGENT_BLOCKQUOTE = /^(?:#{1,6}\s*)?(?:>\s*)?(🤖|📡)/;
const IDENTITY_LINE = /runner:[^\s·]+\s*·\s*skills@|@\s+\S+\s*·\s*runner:/;

/** AI/agent-authored comment (per SKILL.md Step 2's broader rule, not a bare startswith). */
export function isAiAgentComment(body: string): boolean {
  const trimmed = body.trimStart();
  const lines = trimmed.split("\n");
  // A `> 🤖`/`> 📡` blockquote opener within the first ~3 lines (an optional
  // `@ <hostname>` line may precede it).
  if (lines.slice(0, 3).some((l) => AGENT_BLOCKQUOTE.test(l.trimStart()))) return true;
  // Or the machine-generated identity line anywhere (scripts append it at the end).
  if (IDENTITY_LINE.test(trimmed)) return true;
  return false;
}

/**
 * Non-terminal AI comment patterns — the deferred/queued patterns that MUST be
 * re-processed rather than skipped (per SKILL.md Step 2 non-terminal rule).
 */
const NON_TERMINAL_PATTERNS =
  /排队中|本轮未做|留开放|不在.{0,8}范围|非单\s*PR|多.?phase.*(留开放|不在)|candidate-queued|queued|in-progress|稍后|will\s+do|TODO/i;

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
  return NON_TERMINAL_PATTERNS.test(stripCode(body));
}

/**
 * Returns true if the AI comment is in a terminal state (done, waiting for
 * human-required action, or security gate).
 *
 * Does NOT defer to the deferral regex any more: terminal WINS. Ordering was
 * inverted — a live sweep re-picked a terminal security escalation because its
 * wording tripped the deferral patterns, which were evaluated first.
 */
export function isTerminalAiComment(body: string): boolean {
  return TERMINAL_INDICATORS.test(stripCode(body));
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

  // Last comment is AI. TERMINAL FIRST: a real unlock condition (PR opened, issue
  // closed, human gate, security escalation) beats an incidental deferral word —
  // the old order re-picked terminal verdicts whose prose merely tripped the
  // deferral regex.
  if (isTerminalAiComment(last.body)) return false;

  // Genuinely deferred/queued work → keep (re-process this run)
  if (isNonTerminalAiComment(last.body)) return true;

  // Neither marker → treat as terminal (skip); an agent comment with no deferral
  // marker is a finished verdict.
  return false;
}

/**
 * Decode the HTML entities that some comment bodies carry for HTML markers. A live
 * sweep found real bodies with `&lt;!-- test-sweep-report --&gt;` (an instance of the
 * known double-escape bug) — marker-keyed logic silently MISSES those, so decode first.
 * `&amp;` must be decoded last so `&amp;lt;` doesn't turn into `<`.
 */
export function decodeMarkerEntities(body: string): string {
  return body
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Extract sweep-trace markers from comment bodies.
 * Format: <!-- sweep-trace: {...} --> (also matches the HTML-escaped form).
 */
export function extractSweepTraces(
  body: string,
): Array<{ ver: number; issue?: number; pr?: number; gate: string; val: string; run: string }> {
  const decoded = decodeMarkerEntities(body);
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
    const match = pattern.exec(decoded);
    if (match === null) break;
    try {
      results.push(JSON.parse(match[1]!));
    } catch {
      // malformed trace — skip
    }
  }
  return results;
}
