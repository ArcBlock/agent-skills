#!/usr/bin/env bun
/**
 * agentloop — shared report kernel (repo-agnostic, NOT an orchestrator).
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
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CheckResult {
  /** stable id, e.g. "build" / "types" (semantic) */
  check: string;
  /** human title for the report table */
  title: string;
  pass: boolean;
  /** hard gate? false = warn-only */
  blocking: boolean;
  /**
   * check was intentionally not run (e.g. gated off by `when`). `true`, or the
   * reason string — a reason renders in the report row so a SKIP is never a
   * silent hole (issue #2734).
   */
  skipped?: boolean | string;
  /**
   * measured by the engine, never hand-filled — this is the determinism gate.
   * Optional because a skipped check has no duration to measure; renderers MUST
   * degrade rather than assume it (see `dur`).
   */
  durationMs?: number;
  /**
   * numeric/string stats parsed from the tool output (errors, passed, …).
   * Optional for the same reason as `durationMs` — a skip parses no output.
   */
  stats?: Record<string, number | string>;
  /** failure output tail, detailed enough for an agent to fix directly */
  rawTail?: string;
  /** complete tool output — always captured, collapsed in report for full log access */
  rawFull?: string;
  /**
   * Path to the on-disk full log (#5223). When set, the report's Full Logs
   * section points here instead of inlining tens of kilobytes of tool output.
   */
  logPath?: string;
}

/** Monotonic within one process — enough to keep concurrent `run()`s apart. */
let pgidFileSeq = 0;

const NO_OUTPUT_TIMEOUT_MARKER = "[agentloop: no-output watchdog]";

function newPgidFile(): string {
  pgidFileSeq += 1;
  return join(tmpdir(), `agentloop-pgid-${process.pid}-${pgidFileSeq}`);
}

function newOutputFile(): string {
  pgidFileSeq += 1;
  return join(tmpdir(), `agentloop-output-${process.pid}-${pgidFileSeq}.log`);
}

/**
 * Wrap `cmd` so it runs as a bash JOB in its own process group, and publish that
 * group's id to `pgidFile` for `reapGroup`.
 *
 * Why not `spawnSync({ detached: true })` — the obvious answer? Because it is not
 * honored everywhere: under bun (the runtime these scripts declare in their
 * shebang) the child keeps the CALLER's pgid. `kill(-childPid)` then either hits
 * ESRCH or, worse, signals whatever unrelated group happens to own that id — and
 * the caller's own shell is in the group we would have aimed at. Verified by
 * reading `ps -o pgid` of the spawned child.
 *
 * `set -m` (job control) makes bash give each background job a fresh process
 * group whose pgid == the job's pid, which bash hands us as `$!`. Every
 * descendant inherits it unless it calls setsid itself, so one `kill -- -pgid`
 * takes down the tree. `wait` propagates the job's exit status, so the wrapper is
 * transparent to callers.
 *
 * Monitor mode goes back OFF once the job exists (the group is already assigned
 * and does not move): while it is on, bash writes `[1]+ Done  { … }` job-status
 * lines into the captured output, and every check here parses that output.
 */
function wrapInOwnGroup(
  cmd: string,
  pgidFile: string,
  noOutputTimeoutMs?: number,
  outputFile?: string,
): string {
  if (noOutputTimeoutMs === undefined || outputFile === undefined) {
    return [
      "set -m",
      "{",
      cmd,
      "} &",
      "__agentloop_job=$!",
      "set +m",
      `printf %s "$__agentloop_job" > ${JSON.stringify(pgidFile)}`,
      'wait "$__agentloop_job"',
    ].join("\n");
  }

  // bash on stock macOS has no millisecond clock or portable timeout(1). This
  // is deliberately a coarse, conservative watchdog: it observes only a
  // command's own stdout/stderr growth and lets an active package keep its
  // normal overall timeout. The command still owns one process group, so the
  // watchdog never reaps an unrelated worker.
  const noOutputTimeoutSeconds = Math.max(1, Math.ceil(noOutputTimeoutMs / 1000));
  return [
    "set -m",
    `__agentloop_log=${JSON.stringify(outputFile)}`,
    "{",
    cmd,
    '} > "$__agentloop_log" 2>&1 &',
    "__agentloop_job=$!",
    "set +m",
    `printf %s "$__agentloop_job" > ${JSON.stringify(pgidFile)}`,
    "__agentloop_last_size=-1",
    "__agentloop_last_change=$(date +%s)",
    "__agentloop_stalled=0",
    'while kill -0 "$__agentloop_job" 2>/dev/null; do',
    '  __agentloop_size=$(wc -c < "$__agentloop_log" | tr -d " ")',
    '  if [ "$__agentloop_size" != "$__agentloop_last_size" ]; then',
    "    __agentloop_last_size=$__agentloop_size",
    "    __agentloop_last_change=$(date +%s)",
    "  fi",
    "  __agentloop_now=$(date +%s)",
    `  if [ $((__agentloop_now - __agentloop_last_change)) -ge ${noOutputTimeoutSeconds} ]; then`,
    '    kill -KILL -- "-$__agentloop_job" 2>/dev/null || true',
    "    __agentloop_stalled=1",
    "    break",
    "  fi",
    "  sleep 1",
    "done",
    'wait "$__agentloop_job"',
    "__agentloop_status=$?",
    'if [ "$__agentloop_stalled" -eq 1 ]; then',
    `  printf '\\n${NO_OUTPUT_TIMEOUT_MARKER}\\n' >> "$__agentloop_log"`,
    "fi",
    'cat "$__agentloop_log"',
    'rm -f "$__agentloop_log"',
    'if [ "$__agentloop_stalled" -eq 1 ]; then exit 124; fi',
    'exit "$__agentloop_status"',
  ].join("\n");
}

/**
 * Kill the process group `wrapInOwnGroup` created, then drop the pgid file.
 * Only fires when the run actually timed out: on a normal exit the job is already
 * gone, and signalling a recycled pid would be the very bug this guards against.
 */
function reapGroup(pgidFile: string, timedOut: boolean): void {
  try {
    if (timedOut) {
      const pgid = Number.parseInt(readFileSync(pgidFile, "utf8").trim(), 10);
      // > 1 rejects both a failed parse (NaN) and pgid 1/0, which would mean
      // "every process I am allowed to signal".
      if (Number.isFinite(pgid) && pgid > 1) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          /* ESRCH — the group already drained, which is the good case */
        }
      }
    }
  } catch {
    /* no pgid file: bash died before writing it — nothing identified to reap */
  }
  rmSync(pgidFile, { force: true });
}

/**
 * Strip ANSI/CSI SGR sequences from captured command output.
 *
 * `gh api --jq` wraps JSON in color codes (`\x1b[1;38m{…\x1b[m`) when the
 * parent session has `FORCE_COLOR` — Node then ignores `NO_COLOR`, and
 * `JSON.parse` of that stdout fails as `could not parse … comment JSON`
 * even though a valid sticky exists (arc#4591). Idempotent on plain text.
 */
export function stripAnsi(s: string): string {
  // ESC assembled at runtime — a regex literal `\u001B` trips biome's
  // noControlCharactersInRegex, and this is the byte `gh` actually emits.
  return s.replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
}

/**
 * Env handed to every `run()` child. `FORCE_COLOR` wins over `NO_COLOR` in
 * Node and is enough for `gh` to color `--jq` JSON; unset it and force
 * `GH_NO_COLOR=1` so parsed stdout is machine-readable (arc#4591). Callers
 * can still override `GH_NO_COLOR` via the `env` argument.
 */
export function childEnv(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    GH_NO_COLOR: env.GH_NO_COLOR ?? "1",
  };
  delete merged.FORCE_COLOR;
  return merged;
}

/**
 * Run a shell command, capture combined stdout+stderr, measure wall time.
 *
 * `timeoutMs`, when given, uses spawnSync's native `timeout`/`killSignal`
 * options — no shell `timeout`/`gtimeout` binary dependency (that approach
 * exits 127 on stock macOS, issue #1296). A killed process reports as
 * `code: 124` (matching the `timeout(1)` convention already used by
 * check-native.ts) with `timedOut: true`, instead of hanging the caller
 * forever (issue #1922: an affected-test run against a slow package could
 * block pre-pr.ts indefinitely with no report ever produced).
 *
 * spawnSync's own timeout kill only reaches the DIRECT child (the `bash -c`), so
 * every grandchild survives and reparents to init — a timed-out `turbo run test`
 * left the whole turbo + test-runner tree (and any daemons those tests spawned)
 * running forever, once per timed-out sweep round. `wrapInOwnGroup`/`reapGroup`
 * close that leak on the timeout path.
 */
export function run(
  cmd: string,
  env: Record<string, string> = {},
  input?: string,
  timeoutMs?: number,
  opts: { noOutputTimeoutMs?: number } = {},
): { code: number; out: string; ms: number; timedOut?: boolean; noOutputTimedOut?: boolean } {
  const start = Date.now();
  const pgidFile = timeoutMs === undefined ? undefined : newPgidFile();
  const outputFile = pgidFile && opts.noOutputTimeoutMs !== undefined ? newOutputFile() : undefined;
  const r = spawnSync(
    "bash",
    ["-c", pgidFile ? wrapInOwnGroup(cmd, pgidFile, opts.noOutputTimeoutMs, outputFile) : cmd],
    {
      encoding: "utf8",
      env: childEnv(env),
      maxBuffer: 128 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" as const }),
    },
  );
  const ms = Date.now() - start;
  let out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // A native spawn timeout kills the shell before it can replay its redirected
  // output. Preserve that partial evidence before deleting the private temp
  // file so a timeout is still diagnosable rather than an empty red row.
  if (outputFile) {
    try {
      const captured = readFileSync(outputFile, "utf8");
      if (captured) out = `${captured}${out}`;
    } catch {
      // The normal wrapper path already replayed and removed the file.
    }
    rmSync(outputFile, { force: true });
  }
  out = stripAnsi(out);
  const nativeTimedOut = (r.error as (Error & { code?: string }) | undefined)?.code === "ETIMEDOUT";
  const noOutputTimedOut = out.includes(NO_OUTPUT_TIMEOUT_MARKER);
  const timedOut = nativeTimedOut || noOutputTimedOut;
  // The no-output wrapper already killed AND waited for its job group while it
  // still owned that exact PGID. Reaping it again here could hit a recycled
  // group. Only a native spawn timeout kills this outer shell before its
  // wrapper can perform that owned cleanup.
  if (pgidFile) reapGroup(pgidFile, nativeTimedOut);
  return {
    code: timedOut ? 124 : typeof r.status === "number" ? r.status : 1,
    out,
    ms,
    ...(timedOut ? { timedOut: true } : {}),
    ...(noOutputTimedOut ? { noOutputTimedOut: true } : {}),
  };
}

export function tail(s: string, n = 50): string {
  return s.trimEnd().split("\n").slice(-n).join("\n");
}

/** First capture group of `re` in `s` as a number, or undefined. */
export function num(re: RegExp, s: string): number | undefined {
  const m = s.match(re);
  return m ? Number(m[1]) : undefined;
}

/**
 * Sum of the first capture group across every match of `re` in `s`, or undefined
 * if there are no matches. `re` must carry the `g` flag. Use this (not `num`) when
 * the summary line repeats once per concurrent task — e.g. bun test prints its own
 * "N pass / M fail" per package, and turbo interleaves them — so a single `num()`
 * match only reflects whichever task's line happened to appear first in the
 * interleaved stream, not the true total (arc#2080).
 */
export function sumNum(re: RegExp, s: string): number | undefined {
  const matches = [...s.matchAll(re)];
  if (matches.length === 0) return undefined;
  return matches.reduce((total, m) => total + Number(m[1]), 0);
}

/** affected-detection base: merge-base of `origin/<branch>` and HEAD. */
export function mergeBase(branch = "origin/main"): string {
  return run(`git merge-base ${branch} HEAD`).out.trim() || branch;
}

export function head(): string {
  return run("git rev-parse HEAD").out.trim();
}

/**
 * Was the check skipped? `skipped` carries a reason string, so plain truthiness
 * is wrong: an empty reason (`skipped: ""` — a check that computed its reason
 * and came up blank) would silently render as PASS. Anything other than
 * absent/`false` means skipped.
 */
export function isSkipped(r: CheckResult): boolean {
  return r.skipped !== undefined && r.skipped !== false;
}

/** all blocking, non-skipped checks passed */
export function passed(results: CheckResult[]): boolean {
  return results.every((r) => isSkipped(r) || r.pass || !r.blocking);
}

export function exitCode(results: CheckResult[]): number {
  return passed(results) ? 0 : 1;
}

/**
 * The overall sticky-marker result (issue #3170, follow-up to #2880/#3166):
 * `"PASS"` when every blocking check passed; otherwise `"TIMEOUT"` only when
 * EVERY non-skipped blocking failure is a watchdog kill with zero observed
 * failures (`stats.timedOut === "true"` and `(stats.failed ?? 0) === 0`, both
 * structurally measured by the check itself — never hand-filled); any other
 * failure — including a single real test failure alongside a timed-out check —
 * dominates to `"FAIL"`. Return type is a plain string union (not `VerifyResult`
 * from comment.ts) to avoid a circular import; the values are a structural
 * subset so callers can assign it directly.
 */
export function deriveResult(results: CheckResult[]): "PASS" | "FAIL" | "TIMEOUT" {
  if (passed(results)) return "PASS";
  const failing = results.filter((r) => !isSkipped(r) && r.blocking && !r.pass);
  const isTimeoutNoFail = (r: CheckResult): boolean => {
    const failedCount = r.stats?.failed === undefined ? 0 : Number(r.stats.failed);
    return String(r.stats?.timedOut) === "true" && failedCount === 0;
  };
  return failing.length > 0 && failing.every(isTimeoutNoFail) ? "TIMEOUT" : "FAIL";
}

/** Emit one result as JSON (used when a check is run standalone). */
export function emit(result: CheckResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function icon(r: CheckResult): string {
  if (isSkipped(r)) return "⊘ SKIP";
  if (r.pass) return "✅ PASS";
  return r.blocking ? "❌ FAIL" : "⚠️ WARN";
}

/** Longest skip reason rendered in a table cell — the report has a comment budget. */
const REASON_CAP = 200;

/**
 * Make a value safe for a markdown table cell: `|` would open a phantom column
 * and a newline would end the row, so both are neutralized. Reason text comes
 * from check authors (shell commands, URLs), so it is not trusted to be inert.
 */
function cell(s: string): string {
  const flat = s.replace(/\s+/g, " ").replaceAll("|", "\\|").trim();
  return flat.length > REASON_CAP ? `${flat.slice(0, REASON_CAP)}…` : flat;
}

/**
 * Stats cell. Total by construction: a check that carries no `stats` (every
 * skip path) must not be able to take down the whole report — this kernel is
 * the shared collection point for EVERY check, including ones written in a
 * consuming repo (issue #2734).
 *
 * A skip with a reason string shows the reason here, so `⊘ SKIP` always says
 * why rather than leaving a bare `—`.
 */
function statsStr(r: CheckResult): string {
  const e = Object.entries(r.stats ?? {});
  if (e.length) return cell(e.map(([k, v]) => `${k}=${v}`).join(" "));
  const reason = typeof r.skipped === "string" ? r.skipped : isSkipped(r) ? r.rawTail : undefined;
  return cell(reason ?? "") || "—";
}

/**
 * Duration cell. Non-finite input (absent, null, NaN) reads as 0 rather than
 * printing `NaNs` into the report — a garbled number in the one artifact that
 * is supposed to be measured, not hand-filled, is worse than a zero.
 */
const dur = (ms: number | undefined): string =>
  `${(Number.isFinite(ms) ? (ms as number) / 1000 : 0).toFixed(1)}s`;

/**
 * Render a deterministic markdown report — suitable for a PR/issue comment.
 *
 * `opts.notice` is an optional block rendered immediately under the H2 heading,
 * before the results table. It exists so a caller can state a fact ABOUT THE RUN
 * that the results table structurally cannot show — currently a partial
 * (`--only`/`--skip`) selection, whose green rows would otherwise read exactly
 * like a full gate's (issue #5067). Omitting it leaves the report byte-identical
 * to the pre-#5067 output.
 */
export function renderReport(
  results: CheckResult[],
  opts: { scenario: string; base?: string; sha?: string; identity?: string; notice?: string },
): string {
  const ok = passed(results);
  const total = results.reduce((a, r) => a + (r.durationMs ?? 0), 0);
  const rows = results
    .map((r) => `| ${r.title} | ${icon(r)} | ${statsStr(r)} | ${dur(r.durationMs)} |`)
    .join("\n");

  const failures = results.filter((r) => !r.pass && !isSkipped(r) && r.rawTail);
  const failBlock = failures.length
    ? `\n\n### Failures\n${failures
        .map(
          (r) =>
            `\n<details><summary>${r.title} ${icon(r)}</summary>\n\n\`\`\`\n${r.rawTail}\n\`\`\`\n</details>`,
        )
        .join("\n")}`
    : "";

  // Notes: passing checks that carry a rawTail warning (cache hits, zero tests)
  const notes = results.filter((r) => r.pass && !isSkipped(r) && r.rawTail);
  const notesBlock = notes.length
    ? `\n\n### Notes\n${notes.map((r) => `\n- **${r.title}**: ${r.rawTail}`).join("")}`
    : "";

  // Full logs. Prefer an on-disk path (#5223) so the PR comment stays a table
  // plus failure tails, not 40+ KB of inlined turbo output. Fall back to a
  // clipped <details> body only when a check has rawFull and no logPath —
  // that's the renderer unit-test / pre-persist shape, not the live gate.
  const withLogs = results.filter((r) => !isSkipped(r) && (r.logPath || r.rawFull));
  const LOG_BUDGET = 45000;
  const inlined = withLogs.filter((r) => !r.logPath && r.rawFull);
  const per = inlined.length ? Math.max(2000, Math.floor(LOG_BUDGET / inlined.length)) : 0;
  const clip = (s: string): string =>
    s.length > per ? `…(truncated — last ${per} of ${s.length} chars)…\n${s.slice(-per)}` : s;
  const logsBlock = withLogs.length
    ? `\n\n### Full Logs\n${withLogs
        .map((r) =>
          r.logPath
            ? `\n- **${r.title}**: \`${r.logPath}\``
            : `\n<details><summary>${r.title} — output</summary>\n\n\`\`\`\n${clip(r.rawFull ?? "")}\n\`\`\`\n</details>`,
        )
        .join("\n")}`
    : "";

  const shaStr = opts.sha ? ` sha \`${opts.sha.slice(0, 9)}\`` : "";
  // Identity header passed in by the scenario layer (not computed here) so the
  // engine stays repo-agnostic; still injected deterministically so an agent
  // cannot forget provenance.
  const identity = opts.identity?.trim();
  const notice = opts.notice?.trim();
  return `${identity ? `${identity}\n\n` : ""}## Verification Report — \`${opts.scenario}\`${
    opts.base ? ` (affected base \`${opts.base.slice(0, 9)}\`)` : ""
  }${shaStr}
${notice ? `\n${notice}\n` : ""}
| Check | Result | Stats | Duration |
|-------|--------|-------|----------|
${rows}

**Overall: ${ok ? "✅ PASS" : "❌ FAIL"}** (${dur(total)} total)${failBlock}${notesBlock}${logsBlock}

<sub>Generated by the \`agentloop\` verification engine — numbers measured by the scripts, not hand-filled.</sub>`;
}

/**
 * Strip the "### Full Logs" appendix from an already-rendered report, replacing
 * it with a short note. LOG_BUDGET (above) caps that section at ~45KB to stay
 * under GitHub's own 65536-char comment limit, but this environment's outbound
 * proxy enforces a separate, much tighter "comment-filter work budget" on `gh`
 * calls that a 45KB body can still exceed — HTTP 403 `Request body exhausted
 * the comment-filter work budget`, even for an otherwise-PASSING report with
 * no failures to show (issue #1922: a fully-green pre-pr report for PR #615
 * was rejected at ~43KB, then accepted at ~4.5KB with only this section cut).
 * `postComment` retries once with this trimmed body on that specific error so
 * a large-but-legitimate report still lands instead of failing to post at all.
 */
export function trimFullLogsSection(report: string, sha?: string): string {
  const start = report.indexOf("\n\n### Full Logs\n");
  if (start === -1) return report;
  const subStart = report.indexOf("\n\n<sub>Generated by", start);
  const rest = subStart === -1 ? "" : report.slice(subStart);
  // Name the actual file when the caller knows the sha — this pointer is the only
  // route left to the dropped output, so it should not make the reader guess.
  const cacheRef = `\`.verify/${sha ?? "<sha>"}.md\``;
  return `${report.slice(0, start)}\n\n### Full Logs\n\nOmitted — the full report exceeded this environment's PR-comment size gate (issue #1922). Full output is in the ${cacheRef} cache on the machine that generated this report.${rest}`;
}
