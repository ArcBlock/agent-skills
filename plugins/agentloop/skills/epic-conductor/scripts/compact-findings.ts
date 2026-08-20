/**
 * Compact the raw finding pile (independent pr-review verdict + bot P1/High + stale
 * inline comments) into the list a fixer is actually allowed to see, BEFORE epic-conductor
 * §5 dispatches one.
 *
 * Why this exists: conductor §5 used to hand fixers the raw pile verbatim. Nothing checked
 * whether a finding still held against the CURRENT PR HEAD, so fixers chased already-fixed
 * defects, two bots reporting the same line produced two fix attempts, and "fix A satisfies
 * finding 1 but creates finding 2" caused ping-pong. This module is the missing layer:
 * dedupe + staleness judged against the current code, output as an explicit per-finding list
 * (never a bare count — see `assertNotSummaryOnly`).
 *
 * Failure-mode bias (stated by the issue this implements, ArcBlock/arc#4316): compact must
 * never wrongly discard a still-valid finding ("不确定就保留" — uncertain stays). Losing a
 * real P1 silently is worse than keeping a stale one an extra round.
 *
 * See: .claude/plugins/agentloop/skills/epic-conductor/SKILL.md §5
 *      ArcBlock/arc#4316 (this issue) / #4315 (research parent)
 */

export type Severity = "P1" | "P2" | "High" | "Medium" | "Low" | string;

export interface RawFinding {
  /** Stable identifier: the review-comment id (GitHub numeric id as string) or an
   * agent-assigned key. Used as the `duplicate-of` target and for output identity. */
  id: string;
  severity: Severity;
  path: string;
  line: number;
  description: string;
  /** Same GitHub review thread as another finding shares this — used to catch a
   * finding restated across replies in one thread (SKILL.md A3's "同一 comment thread
   * 的重复表述" case), which does not always land on the exact same path:line. */
  threadId?: string;
  /** The code content the finding was raised against (a short line window, as it looked
   * at review time). Absent when the caller couldn't recover it (e.g. GitHub API gave no
   * diff hunk) — staleness is then UNDECIDABLE, not "probably fixed" (see A2 vs R2). */
  expectedSnippet?: string;
}

/** What the current PR HEAD actually contains at a finding's `path:line`, gathered by the
 * (impure) CLI wrapper via `git show`/`fs.readFile` — never by this module. `snippet` is
 * `undefined` when the file or line no longer exists at HEAD. */
export interface CurrentSnippet {
  path: string;
  line: number;
  snippet: string | undefined;
}

export type CompactStatus = "still-valid" | "stale" | "duplicate";

export interface CompactedFinding extends RawFinding {
  status: CompactStatus;
  /** Set only when status === "duplicate": the id of the finding this one collapsed into. */
  duplicateOf?: string;
}

function normalize(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim();
}

function dedupeKey(f: RawFinding): string {
  return f.threadId ? `thread:${f.threadId}` : `loc:${f.path}:${f.line}`;
}

/**
 * Judge one non-duplicate finding as still-valid or stale against the current code.
 * Uncertain in EITHER direction (no expected snippet to compare, or the current file/line
 * is unreadable) resolves to still-valid — compact's only allowed failure mode is
 * under-killing (SKILL.md: "不确定就保留").
 */
function judgeStaleness(finding: RawFinding, current: string | undefined): CompactStatus {
  if (finding.expectedSnippet === undefined || current === undefined) return "still-valid";
  return normalize(current).includes(normalize(finding.expectedSnippet)) ? "still-valid" : "stale";
}

/**
 * Pure compaction: dedupe by (threadId ?? path:line), keeping the first-seen finding as
 * canonical; judge every surviving finding's staleness against `currentSnippets`. No I/O —
 * the CLI wrapper (`main()` below) is the only impure boundary.
 */
export function compactFindings(
  findings: RawFinding[],
  currentSnippets: CurrentSnippet[],
): CompactedFinding[] {
  const snippetByLoc = new Map(currentSnippets.map((s) => [`${s.path}:${s.line}`, s.snippet]));
  const canonicalIdByKey = new Map<string, string>();
  const out: CompactedFinding[] = [];

  for (const f of findings) {
    const key = dedupeKey(f);
    const canonicalId = canonicalIdByKey.get(key);
    if (canonicalId !== undefined) {
      out.push({ ...f, status: "duplicate", duplicateOf: canonicalId });
      continue;
    }
    canonicalIdByKey.set(key, f.id);
    const current = snippetByLoc.get(`${f.path}:${f.line}`);
    out.push({ ...f, status: judgeStaleness(f, current) });
  }
  return out;
}

/** Findings the fixer brief is actually allowed to contain — duplicates and stale entries
 * are dropped here, never earlier (so the full compacted list stays inspectable/auditable). */
export function fixerBrief(compacted: CompactedFinding[]): CompactedFinding[] {
  return compacted.filter((f) => f.status === "still-valid");
}

const REQUIRED_FIELDS: Array<keyof CompactedFinding> = [
  "id",
  "severity",
  "path",
  "line",
  "description",
  "status",
];

/**
 * Reject a summary-only ("3 findings, 2 stale") stand-in for the real per-finding list
 * (SKILL.md R1). A conforming output is a JSON array where every element carries every
 * required field — anything else (an object, a count, a partial record) is invalid.
 */
export function validateCompactOutput(value: unknown): value is CompactedFinding[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      REQUIRED_FIELDS.every((field) => field in (item as Record<string, unknown>)),
  );
}

async function readCurrentSnippet(
  path: string,
  line: number,
  contextLines: number,
): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "show", `HEAD:${path}`], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return undefined; // file doesn't exist at HEAD (deleted/renamed)
  const lines = out.split("\n");
  const start = Math.max(0, line - 1 - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  if (line - 1 >= lines.length || line < 1) return undefined; // line no longer in range
  return lines.slice(start, end).join("\n");
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("usage: compact-findings.ts <raw-findings.json> [--context N]");
    process.exit(1);
  }
  const contextIdx = process.argv.indexOf("--context");
  const contextLines = contextIdx !== -1 ? Number(process.argv[contextIdx + 1]) : 2;

  const raw: RawFinding[] = JSON.parse(await Bun.file(inputPath).text());
  const currentSnippets: CurrentSnippet[] = [];
  for (const f of raw) {
    currentSnippets.push({
      path: f.path,
      line: f.line,
      snippet: await readCurrentSnippet(f.path, f.line, contextLines),
    });
  }

  const compacted = compactFindings(raw, currentSnippets);
  if (!validateCompactOutput(compacted)) {
    console.error(
      "compact-findings: produced output failed validateCompactOutput() — refusing to emit a summary-only result",
    );
    process.exit(1);
  }
  console.log(JSON.stringify(compacted, null, 2));
}

if (import.meta.main) {
  await main();
}
