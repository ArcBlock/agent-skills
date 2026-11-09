#!/usr/bin/env bun
/**
 * verdict — render a pr-review verdict comment the host merger can read
 * (agent-factory#157 follow-up).
 *
 * The merger (`packages/aos-factory/src/work-adhoc-merge.ts`) auto-merges an
 * ad-hoc PR only on ONE canonical line per comment, matched as a whole line
 * outside code fences:
 *
 *   <!-- pr-review-verdict v1 head=<40-hex> lens=correctness|security verdict=<V> -->
 *
 * in a comment that was never edited, by a writer, whose identity line names a
 * review skill (`pr-review` / `review`) distinct from the PR author's. Any later
 * writer comment that is not itself a canonical MERGE at the head stales it.
 *
 * So a verdict is always a NEW comment (never a PATCH — see `postOnce`), and the
 * line is rendered here, never typed by hand. The legacy first line
 * `<!-- pr-review-verdict -->` stays: status readers (pr-sweep Step 1,
 * factory-epic-status) find the review by it.
 *
 * CLI (prints the comment body to stdout; post it with `gh pr comment --body-file`):
 *   bun lib/verdict.ts --head <40-hex> [--lens correctness|security] \
 *     --verdict MERGE|COMMENT|BLOCK|SUPERSEDE|CLOSE --identity "<header>" \
 *     --body-file <evidence.md> [--held]
 */
import { readFileSync } from "node:fs";

/** Same text as the merger's `CANONICAL_RE` (a test pins the two together). */
export const CANONICAL_VERDICT_RE =
  /^<!-- pr-review-verdict v1 head=([0-9a-f]{40}) lens=(correctness|security) verdict=(MERGE|COMMENT|BLOCK|SUPERSEDE|CLOSE) -->$/;

/** First line of every verdict comment; status readers locate the review by it. */
export const LEGACY_VERDICT_MARKER = "<!-- pr-review-verdict -->";

export const REVIEW_LENSES = ["correctness", "security"] as const;
export const REVIEW_VERDICTS = ["MERGE", "COMMENT", "BLOCK", "SUPERSEDE", "CLOSE"] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface CanonicalVerdict {
  head: string;
  lens: ReviewLens;
  verdict: ReviewVerdict;
}

const IDENTITY_RE = /^\s*>\s*🤖\s*AI Agent\b.*?\s@\s(.*)$/u;
const REVIEW_SKILLS = ["pr-review", "review"];

/** The canonical v1 line. Throws on anything the merger would not parse. */
export function canonicalVerdictLine(v: CanonicalVerdict): string {
  if (!/^[0-9a-f]{40}$/.test(v.head)) {
    throw new Error(`head must be the full 40-char lowercase hex sha, got "${v.head}"`);
  }
  if (!REVIEW_LENSES.includes(v.lens)) throw new Error(`unknown lens "${v.lens}"`);
  if (!REVIEW_VERDICTS.includes(v.verdict)) throw new Error(`unknown verdict "${v.verdict}"`);
  return `<!-- pr-review-verdict v1 head=${v.head} lens=${v.lens} verdict=${v.verdict} -->`;
}

export interface VerdictComment extends CanonicalVerdict {
  /** One line from `agent-identity.sh --header … --skill pr-review`. */
  identity: string;
  /** Evidence markdown (claim table, tests, findings). */
  body: string;
  /** `agent:hold` is on: readers see `MERGE (held)`; the canonical line stays `MERGE`. */
  held?: boolean;
}

/**
 * The whole verdict comment:
 *   <!-- pr-review-verdict -->
 *   <identity line>
 *   <canonical v1 line>
 *   HEAD <sha>
 *   Verdict: <VERDICT>[ (held)]
 *
 *   <evidence>
 */
export function renderVerdictComment(c: VerdictComment): string {
  const identity = c.identity.trim();
  const id = identity.includes("\n") ? null : IDENTITY_RE.exec(identity);
  const skill = id?.[1]
    ?.split("·")
    .map((p) => p.trim())
    .find((p) => p.startsWith("skill:"))
    ?.slice("skill:".length)
    .trim();
  if (!skill || !REVIEW_SKILLS.includes(skill)) {
    throw new Error(
      `identity must be one "> 🤖 AI Agent … @ … · skill:pr-review" line (review skill), got "${c.identity}"`,
    );
  }
  const line = canonicalVerdictLine(c);
  const body = c.body.replace(/\r\n?/g, "\n");
  if (body.includes("<!-- pr-review-verdict v1")) {
    throw new Error(
      "evidence must not carry a canonical verdict line: two in one comment and the merger reads none",
    );
  }
  const shown = c.held && c.verdict === "MERGE" ? "MERGE (held)" : c.verdict;
  return [
    LEGACY_VERDICT_MARKER,
    identity,
    line,
    `HEAD ${c.head}`,
    `Verdict: ${shown}`,
    "",
    body,
  ].join("\n");
}

export interface VerdictCliArgs extends CanonicalVerdict {
  identity: string;
  bodyFile: string;
  held: boolean;
}

export function parseVerdictCliArgs(argv: string[]): VerdictCliArgs {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const need = (name: string) => {
    const v = flag(name);
    if (v === undefined || v.startsWith("--")) throw new Error(`missing --${name}`);
    return v;
  };
  return {
    head: need("head"),
    lens: (flag("lens") ?? "correctness") as ReviewLens,
    verdict: need("verdict") as ReviewVerdict,
    identity: need("identity"),
    bodyFile: need("body-file"),
    held: argv.includes("--held"),
  };
}

if (import.meta.main) {
  try {
    const a = parseVerdictCliArgs(process.argv.slice(2));
    const body = readFileSync(a.bodyFile, "utf8");
    process.stdout.write(`${renderVerdictComment({ ...a, body })}\n`);
  } catch (err) {
    console.error(`verdict: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
