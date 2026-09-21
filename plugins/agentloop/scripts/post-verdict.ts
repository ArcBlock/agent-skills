#!/usr/bin/env bun
/**
 * post-verdict — upsert the canonical pr-review verdict comment.
 *
 * ## Why this is a script and not a `jq` line in SKILL.md
 *
 * pr-review Step 6 used to tell agents:
 *
 *   --jq '[.[]|select(.body|contains("<!-- pr-review-verdict -->"))]|last|.id'
 *
 * That unanchored substring match is the same class of bug #3576 retired for
 * verification sticky. On ArcBlock/aside#1514 it PATCHed a demo comment that
 * only *quoted* the marker in a table cell (id 5628844029), destroying the
 * author's proof that first-line anchoring works. A lookup living as an inline
 * shell snippet has no test, and a successful PATCH of the wrong comment exits
 * 0 — same colour as a correct upsert.
 *
 * `postOnce` already anchors to the first non-empty line and is parameterized
 * on `markerPrefix`. This script is the one call site the skill uses.
 *
 *   bun post-verdict.ts --pr <n> --body-file draft.md
 *
 * The body MUST open with `<!-- pr-review-verdict -->` on its first non-empty
 * line. Exit 2 if it doesn't — we refuse to POST a comment the next lookup
 * cannot find, and we refuse to aim a PATCH at a quote.
 */
import { readFileSync } from "node:fs";
import {
  decodeHtmlEntities,
  type PostCommentResult,
  postOnce,
  VERDICT_MARKER_PREFIX,
} from "../lib/comment.ts";
import { run } from "../lib/report.ts";

const USAGE = "usage: bun post-verdict.ts --pr <n> --body-file <path>";

export interface ParsedArgs {
  ok: true;
  pr: string;
  bodyFile: string;
}
export interface ParsedArgsFail {
  ok: false;
  error: string;
}

export function parseArgs(argv: string[]): ParsedArgs | ParsedArgsFail {
  let pr: string | undefined;
  let bodyFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | undefined => argv[++i];
    if (a === "--pr" || a === "--body-file") {
      const v = value();
      if (v === undefined) return { ok: false, error: `${a} needs a value. ${USAGE}` };
      if (a === "--pr") pr = v;
      else bodyFile = v;
    } else return { ok: false, error: `unknown argument ${JSON.stringify(a)}. ${USAGE}` };
  }
  if (pr === undefined || bodyFile === undefined) return { ok: false, error: USAGE };
  if (!/^\d+$/.test(pr)) return { ok: false, error: `not a PR number: ${pr}` };
  return { ok: true, pr, bodyFile };
}

function firstNonEmptyLine(body: string): string {
  return body.split("\n").find((l) => l.trim().length > 0) ?? "";
}

export function verdictBodyOpensWithMarker(body: string): boolean {
  return decodeHtmlEntities(firstNonEmptyLine(body)).startsWith(VERDICT_MARKER_PREFIX);
}

export function postVerdict(pr: string, body: string, runner: typeof run = run): PostCommentResult {
  if (!verdictBodyOpensWithMarker(body)) {
    return {
      ok: false,
      out:
        "verdict body must open with <!-- pr-review-verdict --> on the first non-empty line " +
        "(arc#6404: a quote of the marker is not a verdict; refusing to upsert)",
    };
  }
  return postOnce(pr, body, runner, VERDICT_MARKER_PREFIX);
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`✗ ${args.error}`);
    process.exit(64);
  }
  let body: string;
  try {
    body = readFileSync(args.bodyFile, "utf8");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`✗ cannot read --body-file ${args.bodyFile}: ${why}`);
    process.exit(2);
  }
  if (!verdictBodyOpensWithMarker(body)) {
    console.error(
      "✗ verdict body must open with <!-- pr-review-verdict --> on the first non-empty line",
    );
    process.exit(2);
  }
  const res = postVerdict(args.pr, body, run);
  if (!res.ok) {
    console.error(`✗ post-verdict failed: ${res.out}`);
    process.exit(1);
  }
  process.stdout.write(res.out.endsWith("\n") ? res.out : `${res.out}\n`);
}
