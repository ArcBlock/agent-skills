#!/usr/bin/env bun
/**
 * loop-engineering — shared report kernel (repo-agnostic, NOT an orchestrator).
 *
 * Holds ONLY the data contract (`CheckResult`) + deterministic helpers (run a
 * command, time it, capture output, render markdown). It does NOT decide which
 * checks run and knows nothing about pnpm/turbo/arc paths — that lives in each
 * repo's scenario config (see `.claude/verify/config.ts` in the consuming repo),
 * which the generic `runScenario()` (scenario.ts) executes.
 *
 * Difference vs the arc-local ancestor this was extracted from: `identityHeader`
 * is gone. Provenance headers are repo-specific (arc shells out to
 * `scripts/agent-identity.sh`), so the engine takes an already-rendered identity
 * string via `renderReport(..., { identity })` instead of shelling out itself.
 */

import { spawnSync } from "node:child_process";

export interface CheckResult {
  /** stable id, e.g. "build" / "types" (semantic) */
  check: string;
  /** human title for the report table */
  title: string;
  pass: boolean;
  /** hard gate? false = warn-only */
  blocking: boolean;
  /** check was intentionally not run (e.g. gated off by `when`) */
  skipped?: boolean;
  /** measured by the engine, never hand-filled — this is the determinism gate */
  durationMs: number;
  /** numeric/string stats parsed from the tool output (errors, passed, …) */
  stats: Record<string, number | string>;
  /** failure output tail, detailed enough for an agent to fix directly */
  rawTail?: string;
  /** complete tool output — always captured, collapsed in report for full log access */
  rawFull?: string;
}

/** Run a shell command, capture combined stdout+stderr, measure wall time. */
export function run(
  cmd: string,
  env: Record<string, string> = {},
  input?: string,
): { code: number; out: string; ms: number } {
  const start = Date.now();
  const r = spawnSync("bash", ["-c", cmd], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 128 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  const ms = Date.now() - start;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { code: typeof r.status === "number" ? r.status : 1, out, ms };
}

export function tail(s: string, n = 50): string {
  return s.trimEnd().split("\n").slice(-n).join("\n");
}

/** First capture group of `re` in `s` as a number, or undefined. */
export function num(re: RegExp, s: string): number | undefined {
  const m = s.match(re);
  return m ? Number(m[1]) : undefined;
}

/** affected-detection base: merge-base of `origin/<branch>` and HEAD. */
export function mergeBase(branch = "origin/main"): string {
  return run(`git merge-base ${branch} HEAD`).out.trim() || branch;
}

export function head(): string {
  return run("git rev-parse HEAD").out.trim();
}

/** all blocking, non-skipped checks passed */
export function passed(results: CheckResult[]): boolean {
  return results.every((r) => r.skipped || r.pass || !r.blocking);
}

export function exitCode(results: CheckResult[]): number {
  return passed(results) ? 0 : 1;
}

/** Emit one result as JSON (used when a check is run standalone). */
export function emit(result: CheckResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function icon(r: CheckResult): string {
  if (r.skipped) return "⊘ SKIP";
  if (r.pass) return "✅ PASS";
  return r.blocking ? "❌ FAIL" : "⚠️ WARN";
}

function statsStr(r: CheckResult): string {
  const e = Object.entries(r.stats);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(" ") : "—";
}

const dur = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Render a deterministic markdown report — suitable for a PR/issue comment. */
export function renderReport(
  results: CheckResult[],
  opts: { scenario: string; base?: string; sha?: string; identity?: string },
): string {
  const ok = passed(results);
  const total = results.reduce((a, r) => a + r.durationMs, 0);
  const rows = results
    .map((r) => `| ${r.title} | ${icon(r)} | ${statsStr(r)} | ${dur(r.durationMs)} |`)
    .join("\n");

  const failures = results.filter((r) => !r.pass && !r.skipped && r.rawTail);
  const failBlock = failures.length
    ? `\n\n### Failures\n${failures
        .map(
          (r) =>
            `\n<details><summary>${r.title} ${icon(r)}</summary>\n\n\`\`\`\n${r.rawTail}\n\`\`\`\n</details>`,
        )
        .join("\n")}`
    : "";

  // Notes: passing checks that carry a rawTail warning (cache hits, zero tests)
  const notes = results.filter((r) => r.pass && !r.skipped && r.rawTail);
  const notesBlock = notes.length
    ? `\n\n### Notes\n${notes.map((r) => `\n- **${r.title}**: ${r.rawTail}`).join("")}`
    : "";

  // Full logs — collapsed, capped so the report stays under GitHub's 65536-char
  // comment limit. Keep the TAIL of each log (where errors land); note truncation.
  const withLogs = results.filter((r) => !r.skipped && r.rawFull);
  const LOG_BUDGET = 45000;
  const per = withLogs.length ? Math.max(2000, Math.floor(LOG_BUDGET / withLogs.length)) : 0;
  const clip = (s: string): string =>
    s.length > per ? `…(truncated — last ${per} of ${s.length} chars)…\n${s.slice(-per)}` : s;
  const logsBlock = withLogs.length
    ? `\n\n### Full Logs\n${withLogs
        .map(
          (r) =>
            `\n<details><summary>${r.title} — output</summary>\n\n\`\`\`\n${clip(r.rawFull ?? "")}\n\`\`\`\n</details>`,
        )
        .join("\n")}`
    : "";

  const shaStr = opts.sha ? ` sha \`${opts.sha.slice(0, 9)}\`` : "";
  // Identity header passed in by the scenario layer (not computed here) so the
  // engine stays repo-agnostic; still injected deterministically so an agent
  // cannot forget provenance.
  const identity = opts.identity?.trim();
  return `${identity ? `${identity}\n\n` : ""}## Verification Report — \`${opts.scenario}\`${
    opts.base ? ` (affected base \`${opts.base.slice(0, 9)}\`)` : ""
  }${shaStr}

| Check | Result | Stats | Duration |
|-------|--------|-------|----------|
${rows}

**Overall: ${ok ? "✅ PASS" : "❌ FAIL"}** (${dur(total)} total)${failBlock}${notesBlock}${logsBlock}

<sub>Generated by the \`loop-engineering\` verification engine — numbers measured by the scripts, not hand-filled.</sub>`;
}
