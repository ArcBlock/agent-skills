#!/usr/bin/env bun
/**
 * scenario — the repo-agnostic verification runner.
 *
 * This is `pre-pr.ts`'s orchestration with the check list lifted out into a
 * parameter. A consuming repo supplies a `ScenarioConfig` (see
 * `.claude/verify/config.ts`) listing its checks; this runner decides base/sha,
 * runs them (honoring `when` gates and `--only`/`--skip`), renders one
 * deterministic report, delivers it to the PR, caches a PASS, and exits with the
 * gate code. It knows nothing about pnpm/turbo/arc paths.
 *
 * Flags (same contract as the arc ancestor, plus --only/--skip):
 *   --json                 machine-readable
 *   --comment [<pr#>]      upsert the report onto the PR (one step with the gate)
 *   --comment-dry-run      resolve + render, print instead of posting
 *   --dry-run              alias of --comment-dry-run (checks run either way; the
 *                          comment is the only outward write — see README contract)
 *   --na "<reason>"        write an N/A exemption (docs/native PRs)
 *   --deliver-cached       post the cached report without re-running
 *   --retry-failed         explicitly retry a cached FAIL/TIMEOUT full gate
 *   --only a,b,c           run only these check ids (unknown id → hard error)
 *   --skip x,y             run all but these check ids
 *
 * Coverage is part of the record, not just identity (#5067): every cached and
 * published record carries `fullScenario` + the executed check ids, and a GREEN
 * scoped run is stamped `PARTIAL` rather than `PASS` so no consumer can read it
 * as a gate token. The report itself is still written — it is the diagnostic
 * artifact (PR #3062) — it just stops being currency.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type CommentArgs,
  deliverComment,
  MARKER_PREFIX,
  parseCommentArgs,
  type RunMeta,
  shQuote,
  stickyBody,
  type VerifyResult,
} from "./comment.ts";
import { deriveRunClass, envGapIdentity, isFailureClass } from "./failure-class.ts";
import {
  type CheckResult,
  deriveResult,
  type FailureClass,
  head,
  isSkipped,
  mergeBase,
  renderReport,
  run,
  tail,
} from "./report.ts";

/**
 * This gate's true wall clock, for the timing history.
 *
 * `process.uptime()` rather than a timestamp captured at the top of
 * `runScenario`: the expensive parts of a round happen BEFORE the runner is
 * reached — the repo's entry script opens its ownership gate, and a full
 * scenario can then sit in the shared broker's single-flight queue waiting for
 * another checkout's lease. Measuring from process start is the only reading
 * that includes them, and it is what a human means by "how long did the gate
 * take". Rounded to ms so a rendered value never carries false precision.
 */
const gateWallMs = (): number => Math.round(process.uptime() * 1000);

/** Context handed to every check's `run`/`when`. */
export interface RunContext {
  /** affected-detection base (merge-base of the base branch and HEAD) */
  base: string;
  /** HEAD sha */
  sha: string;
  /** newline-joined `git diff --name-only base..HEAD` output */
  changedFiles: string;
}

/** One check: either an inline command (via `cmd()`) or an imported logic check. */
export interface CheckSpec {
  /** stable id — the `--only`/`--skip` handle */
  id: string;
  /** report-table title for command-checks (`cmd()`); logic-checks carry their
   * own title on the CheckResult they return, so it is optional here. */
  title?: string;
  /** hard gate? false = warn-only. Default true. */
  blocking?: boolean;
  /** run it; must return a CheckResult (measure its own duration). */
  run: (ctx: RunContext) => CheckResult;
  /** gate: when it returns false the check is omitted (e.g. skills-only checks). */
  when?: (ctx: RunContext) => boolean;
}

export interface ScenarioConfig {
  /** report title, e.g. "pre-pr" / "pre-merge" */
  scenario: string;
  /** affected base branch (default origin/main) */
  baseBranch?: string;
  /** the check list — repo-supplied */
  checks: CheckSpec[];
  /**
   * Environment facts this repo's checks depend on (#5386). Each is probed once
   * per run and joins the evidence identity, so a verdict produced without a
   * capability is never served to a host that has it — nor the reverse, which is
   * the dangerous direction: a green banked because a check COULD NOT run, reused
   * where it would really have run.
   *
   * Optional, and omitting it costs nothing: a repo that declares none behaves
   * exactly as before, and a gap one of its checks REPORTS (`stats.envGap` /
   * `failure.class = "ENV_GAP"`) is still recorded on the published record, so an
   * undeclared environment dependency fails closed instead of poisoning the broker.
   */
  capabilities?: readonly CapabilityProbe[];
  /** optional provenance header line(s); repo computes it (arc: agent-identity.sh) */
  identity?: (label: string) => string;
  /**
   * Override how the affected-detection base is computed. Default is
   * merge-base(baseBranch, HEAD) (pre-pr). pre-merge overrides this to the
   * `origin/main` TIP so it catches breakage from siblings merged since the PR
   * opened (issue #655).
   */
  resolveBase?: () => string;
  /**
   * After the first blocking failure, remaining checks whose id is in this
   * list are recorded as SKIP instead of running (#5223). Cheap tail checks
   * omitted from the list still run so the report stays useful. Daily/release
   * scenarios leave this empty — they are the thorough catch net.
   */
  failFastSkip?: readonly string[];
  /**
   * ATTRIBUTION of a foreign red (arc#5534, shape ruled in arc#5593).
   *
   * Called ONLY on a full scenario whose derived verdict is not PASS. If the
   * repo can prove — by machine, never by assertion — that EVERY blocking
   * failure belongs to something other than this change, then this run's own
   * code WAS verified and the correct AGGREGATE verdict is `PASS`.
   *
   * Two properties are contractual:
   *
   *   1. It never touches a `CheckResult`. The failing rows stay `pass: false,
   *      blocking: true` and keep rendering red. Only the aggregate flips, so
   *      "this PR is mergeable" and "the repo has a foreign red" are both still
   *      legible in one report. That combination is intentional.
   *   2. It changes what PRODUCES a PASS, never what ACCEPTS one. The merge
   *      gate's accept set (`requireStickyGate`) is still exactly `{PASS, NA}`.
   *
   * Repos that supply no hook are unaffected: no hook, no attribution.
   */
  attribution?: (req: AttributionRequest) => AttributionOutcome;
  /**
   * Does this argv carry an attribution CLAIM?
   *
   * A cached red is normally reused rather than re-run (single-flight, #5060).
   * That is right while the question has not changed — but an attribution claim
   * asks a DIFFERENT question of the same commit ("is every one of those reds
   * foreign?"), and the cached artifact holds only a rendered report, not the
   * `CheckResult[]` the adjudicator needs. Without this, the documented
   * `--blocked-by` command is a silent no-op: it re-delivers the cached FAIL and
   * the hook above never runs (PR #5598 review, P2-a).
   *
   * So a claim forces the same one real retry `--retry-failed` does.
   */
  attributionClaimed?: (argv: string[]) => boolean;
}

/**
 * Must this run re-execute a cached red instead of reusing it?
 *
 * Exported so "the documented command actually reaches the gate" is testable
 * against a repo's REAL config rather than asserted in prose.
 */
export function resolveRetryFailed(argv: string[], config: ScenarioConfig): boolean {
  return argv.includes("--retry-failed") || (config.attributionClaimed?.(argv) ?? false);
}

/** What a repo's attribution hook is given. */
export interface AttributionRequest {
  /** the scenario's argv, so the repo can read its own claim flags */
  argv: string[];
  /** the results as measured — the hook must treat these as read-only */
  results: CheckResult[];
  base: string;
  sha: string;
}

/** What a repo's attribution hook returns. */
export interface AttributionOutcome {
  /** true = the AGGREGATE verdict becomes PASS; the check rows are untouched */
  attributed: boolean;
  /** markdown appended to the report — the visible half of the decision */
  notice?: string;
}

/**
 * Apply a repo's attribution hook to an already-derived verdict.
 *
 * Exported and pure so the accept path is testable without running a scenario:
 * "attribute nothing, ever" satisfies every rejection assertion, so the test
 * that matters is the one proving a FAIL really does become a PASS here.
 */
export function applyAttribution(
  derived: "PASS" | "FAIL" | "TIMEOUT",
  hook: ScenarioConfig["attribution"],
  req: AttributionRequest,
  eligible: boolean,
): { derived: "PASS" | "FAIL" | "TIMEOUT"; attributed: boolean; notice?: string } {
  if (!hook || !eligible || derived === "PASS") return { derived, attributed: false };
  const outcome = hook(req);
  return {
    derived: outcome.attributed ? "PASS" : derived,
    attributed: outcome.attributed,
    notice: outcome.notice,
  };
}

/**
 * Build a command-check: run a shell command, pass = exit 0. This is the
 * "command-checks are pure config" path — no per-check file needed. `parse`
 * pulls stats (counts) out of the tool output for the report table.
 */
export function cmd(spec: {
  id: string;
  title: string;
  blocking?: boolean;
  command: string;
  env?: Record<string, string>;
  parse?: (out: string) => Record<string, number | string>;
}): CheckSpec {
  const blocking = spec.blocking ?? true;
  return {
    id: spec.id,
    title: spec.title,
    blocking,
    run: () => {
      const { code, out, ms } = run(spec.command, spec.env ?? {});
      return {
        check: spec.id,
        title: spec.title,
        pass: code === 0,
        blocking,
        durationMs: ms,
        stats: spec.parse ? spec.parse(out) : {},
        rawTail: code === 0 ? undefined : tail(out),
        rawFull: out,
      };
    },
  };
}

/** Parse `--only a,b` / `--skip x,y` into id sets. */
function parseSelect(argv: string[], flag: string): Set<string> | undefined {
  const set = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | undefined;
    if (a === flag) v = argv[i + 1];
    else if (a.startsWith(`${flag}=`)) v = a.slice(flag.length + 1);
    if (v)
      for (const id of v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean))
        set.add(id);
  }
  return set.size ? set : undefined;
}

interface NaRefusal {
  sourceFiles: string[];
  testReaders: Array<{ changedFile: string; testFile: string }>;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|py)$/i;
const TEST_FILE =
  /(?:^|\/)(?:__tests__\/[^/]+\.(?:[cm]?[jt]s|[jt]sx|py)|[^/]+(?:\.|_)(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx|py)|test_[^/]+\.py)$/i;
const FILE_READERS = ["readFile", "readFileSync", "readTextFile", "readJson", "Bun.file", "open"];
const DIRECTORY_READERS = ["readdir", "readdirSync", "opendir", "opendirSync"];

interface StaticCall {
  name: string;
  args: string[];
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function matchingDelimiter(source: string, open: number, left = "(", right = ")"): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === left) depth++;
    else if (char === right && --depth === 0) return i;
  }
  return -1;
}

function staticCalls(source: string, names: readonly string[]): StaticCall[] {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?<![\\w])(${escaped})\\s*\\(`, "g");
  const calls: StaticCall[] = [];
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("(");
    const close = matchingDelimiter(source, open);
    if (close !== -1)
      calls.push({ name: match[1], args: splitTopLevel(source.slice(open + 1, close)) });
  }
  return calls;
}

function withoutComments(source: string): string {
  let result = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += char;
    } else if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      result += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
    } else {
      result += char;
    }
  }
  return result;
}

function literal(expression: string): string | undefined {
  const value = expression.trim();
  const quote = value[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || value.at(-1) !== quote) return undefined;
  const inner = value.slice(1, -1);
  if (quote === "`" && inner.includes("${")) return undefined;
  return inner.replace(/\\([\\'"`])/g, "$1");
}

function evaluatePath(
  expression: string,
  bindings: ReadonlyMap<string, string>,
  testDir: string,
  repoRoot: string,
): string | undefined {
  const value = expression.trim().replace(/\s+as\s+[^,]+$/, "");
  const text = literal(value);
  if (text !== undefined) return text;
  if (value === "import.meta.dir" || value === "__dirname") return testDir;
  if (/^(?:process\.cwd|Bun\.cwd)\(\)$/.test(value)) return repoRoot;
  if (bindings.has(value)) return bindings.get(value);

  const call = /^(?:(?:path|posix)\.)?(join|resolve)\s*\(([\s\S]*)\)$/.exec(value);
  if (!call) return undefined;
  const args = splitTopLevel(call[2]).map((arg) => evaluatePath(arg, bindings, testDir, repoRoot));
  if (!args.length || args.some((arg) => arg === undefined)) return undefined;
  const values = args as string[];
  return call[1] === "resolve" ? resolve(...values) : join(...values);
}

function pathBindings(source: string, testDir: string, repoRoot: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const assignments = [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g)];
  for (let pass = 0; pass < assignments.length; pass++) {
    let changed = false;
    for (const assignment of assignments) {
      if (bindings.has(assignment[1])) continue;
      const value = evaluatePath(assignment[2], bindings, testDir, repoRoot);
      if (value !== undefined) {
        bindings.set(assignment[1], value);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return bindings;
}

function absoluteCandidate(value: string, repoRoot: string): string {
  return resolve(repoRoot, value);
}

function matchesRead(
  changed: string,
  candidate: string,
  directory: boolean,
  repoRoot: string,
): boolean {
  const target = absoluteCandidate(changed, repoRoot);
  const readPath = absoluteCandidate(candidate, repoRoot);
  return directory ? dirname(target) === readPath : target === readPath;
}

function helperReaders(
  source: string,
): Array<{ name: string; params: string[]; expression: string }> {
  const helpers: Array<{ name: string; params: string[]; expression: string }> = [];
  const functionPattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)[^{]*\{/g;
  for (const match of source.matchAll(functionPattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    if (close === -1) continue;
    const call = staticCalls(source.slice(open + 1, close), FILE_READERS)[0];
    if (call?.args[0]) {
      helpers.push({
        name: match[1],
        params: splitTopLevel(match[2]).map((param) => param.replace(/\??\s*:.*/, "").trim()),
        expression: call.args[0],
      });
    }
  }
  const arrowPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*=>\s*([^;]+);/g;
  for (const match of source.matchAll(arrowPattern)) {
    const call = staticCalls(match[3], FILE_READERS)[0];
    if (call?.args[0]) {
      helpers.push({
        name: match[1],
        params: splitTopLevel(match[2]).map((param) => param.replace(/\??\s*:.*/, "").trim()),
        expression: call.args[0],
      });
    }
  }
  return helpers;
}

/**
 * Conservative static proof that a runnable test reads a changed path.
 * Reader arguments are resolved relative to the test and repository instead
 * of unioning unrelated strings from the whole file. Non-recursive directory
 * readers cover direct children; small wrapper functions resolve at call sites.
 */
export function testReadsPath(
  testSource: string,
  changedFile: string,
  testFile = "test.ts",
  repoRoot = process.cwd(),
): boolean {
  const code = withoutComments(testSource);
  const testDir = dirname(resolve(repoRoot, testFile));
  const bindings = pathBindings(code, testDir, repoRoot);
  for (const call of staticCalls(code, FILE_READERS)) {
    const candidate = call.args[0] && evaluatePath(call.args[0], bindings, testDir, repoRoot);
    if (candidate && matchesRead(changedFile, candidate, false, repoRoot)) return true;
  }
  for (const call of staticCalls(code, DIRECTORY_READERS)) {
    const candidate = call.args[0] && evaluatePath(call.args[0], bindings, testDir, repoRoot);
    if (candidate && matchesRead(changedFile, candidate, true, repoRoot)) return true;
  }
  for (const helper of helperReaders(code)) {
    for (const call of staticCalls(code, [helper.name])) {
      const local = new Map(bindings);
      helper.params.forEach((param, index) => {
        const value =
          call.args[index] && evaluatePath(call.args[index], bindings, testDir, repoRoot);
        if (value !== undefined) local.set(param, value);
      });
      const candidate = evaluatePath(helper.expression, local, testDir, repoRoot);
      if (candidate && matchesRead(changedFile, candidate, false, repoRoot)) return true;
    }
  }
  return false;
}

export function isStaticTestFile(path: string): boolean {
  return TEST_FILE.test(path.replaceAll("\\", "/"));
}

function gitOutput(root: string | undefined, args: string[]): { code: number; out: string } {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return { code: result.status ?? 1, out: result.stdout ?? "" };
}

function changedPaths(root: string, base: string): string[] | undefined {
  const result = gitOutput(root, [
    "diff",
    "--name-status",
    "-z",
    "--diff-filter=ACDMRT",
    `${base}..HEAD`,
  ]);
  if (result.code !== 0) return undefined;
  const fields = result.out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    const first = fields[i++];
    if (!status || !first) break;
    paths.push(first);
    if (/^[RC]/.test(status)) {
      const second = fields[i++];
      if (second) paths.push(second);
    }
  }
  return [...new Set(paths)];
}

/** Refuse `--na` unless the diff contains no JS/TS/Python source and no test-read files. */
function naRefusal(base: string): NaRefusal | undefined {
  const top = gitOutput(undefined, ["rev-parse", "--show-toplevel"]);
  const root = top.out.trim();
  if (top.code !== 0 || !root) {
    return { sourceFiles: ["<unable to inspect diff>"], testReaders: [] };
  }
  const changedFiles = changedPaths(root, base);
  if (!changedFiles) return { sourceFiles: ["<unable to inspect diff>"], testReaders: [] };
  const sourceFiles = changedFiles.filter((path) => SOURCE_FILE.test(path));

  const listed = gitOutput(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
  const testReaders: NaRefusal["testReaders"] = [];
  if (listed.code !== 0) {
    return { sourceFiles: [...sourceFiles, "<unable to enumerate tests>"], testReaders };
  }
  const tests = listed.out.split("\0").filter(isStaticTestFile);
  for (const testFile of tests) {
    let source: string;
    try {
      source = readFileSync(resolve(root, testFile), "utf8");
    } catch {
      continue;
    }
    for (const changedFile of changedFiles) {
      if (testReadsPath(source, changedFile, testFile, root)) {
        testReaders.push({ changedFile, testFile });
      }
    }
  }

  return sourceFiles.length || testReaders.length ? { sourceFiles, testReaders } : undefined;
}

function printNaRefusal(refusal: NaRefusal): void {
  console.error("❌ --na refused: this diff has verifiable work; no exemption cache was written.");
  for (const path of refusal.sourceFiles) {
    console.error(`  source file: ${path}`);
  }
  for (const { changedFile, testFile } of refusal.testReaders) {
    console.error(`  test reads changed file: ${testFile} → ${changedFile}`);
  }
  if (refusal.testReaders.length) {
    console.error("  Run the named tests and then run the full verification scenario.");
  }
}

function writeNa(
  scenario: string,
  reason: string,
  sha: string,
  base: string,
  identity: string,
  location: EvidenceLocation,
  capabilities: CapabilitySet,
): string {
  const naBody = `## Verification Report — \`${scenario}\` N/A\n\n${originNotice(location, scenario, base)}\n\n**Reason**: ${reason}\n\n*This PR is exempt from automated TS verification.*\n\n<sub>Exemption written by the agentloop verification engine via \`--na\`.</sub>`;
  // Identity header (#1347/#1776), same placement as renderReport's normal path —
  // prepended into the report body so it lands after the sticky marker line,
  // keeping the marker on line 1 for merge-gate.ts's startswith lookup.
  const report = identity ? `${identity}\n\n${naBody}` : naBody;
  // An exemption is a statement about the WHOLE scenario ("no TS to run here"), not a
  // scoped subset — so it is full coverage over an empty executed set (#5067).
  writeLocalCache(sha, scenario, base, {
    report,
    result: "NA",
    coverage: FULL_COVERAGE([]),
    location,
    capabilities,
    envGaps: [],
  });
  return report;
}

interface ScenarioLease {
  path: string;
  /**
   * Shared leases own a broker record, local ones only a worktree lock. `dir` is the
   * LOCATION-scoped record slot; the lock itself lives one level up, in the coordination
   * directory, so single-flight still spans every location (#5339).
   */
  shared?: {
    /** the identity's coordination directory; the record slot is derived at publish
     *  time, because the capability vector a record answers for is only fully known
     *  once the checks have reported what the environment did to them (#5386). */
    coordination: string;
    sha: string;
    scenario: string;
    base: string;
    location: EvidenceLocation;
    /** the PROBED vector this lease was admitted under; the publish slot is the same
     *  one the next reader will compute, which is what keeps the broker on (#5386). */
    capabilities: CapabilitySet;
  };
}

/**
 * Bumped 1 → 2 for #5067's coverage fields, 2 → 3 for #5339's production location,
 * 3 → 4 for #5386's environment capabilities. Every reader already rejects a record
 * whose `schemaVersion` is not the one it expects, so the bump makes older records —
 * which cannot say what they covered, where they were produced, or what the host
 * could do while they were produced — expire instead of being read as full gates by
 * default.
 *
 * Accuracy about what this bump does and does not do: a pre-#5386 record is already
 * refused twice over without it — `locationId` is a 3-input digest now, so every
 * schema-3 record is orphaned in a slot no reader computes, and `capabilityDrift`
 * refuses a record that states no vector. The bump is record-shape hygiene and a
 * uniform expiry, not the thing that closes the dangerous direction. It is not free:
 * every banked record is invalidated, so each fleet runner re-runs its full gate once
 * on the release that carries it.
 */
const EVIDENCE_SCHEMA_VERSION = 4;

/**
 * What a verification record actually covered (#5067).
 *
 * The old metadata was `{schemaVersion, sha, scenario, base}` — pure IDENTITY, no
 * coverage — so a two-check `--only` PASS and a full-gate PASS were byte-indistinguishable
 * to `pre-push` and `--deliver-cached`.
 */
interface EvidenceCoverage {
  /** true only for an unscoped run: no `--only`, no `--skip` */
  fullScenario: boolean;
  /** the check ids that actually executed, in run order */
  checks: string[];
}

interface SharedEvidence extends EvidenceCoverage {
  schemaVersion: number;
  scenario: string;
  sha: string;
  /** Resolved affected-detection base; pre-merge's origin/main tip is dynamic. */
  base: string;
  result: VerifyResult;
  /** WHERE this record was produced (#5339) — written by the producer, never inferred. */
  location: EvidenceLocation;
  /** WITH WHAT it was produced (#5386) — the PROBED environment vector. Keyed. */
  capabilities: CapabilitySet;
  /** Environment gaps the checks reported. Disclosure only — never keyed (see
   *  {@link observedEnvGaps} for why an after-the-fact input cannot be an identity). */
  envGaps: string[];
  /** taxonomy class of the run's failure (#5626). Disclosure, never keyed. */
  failureClass?: FailureClass;
  /**
   * Per-check non-PASS outcomes (#5573 / taxonomy §7.2). Disclosure, never keyed.
   * Always written (including `[]`) so "counted zero failing checks" and "old
   * record that never counted" stay different colours. The rate ceiling's
   * per-check 1% cap needs to know WHICH check died; a run-level class cannot
   * say.
   */
  checkFailures?: Array<{ check: string; class: FailureClass }>;
  sourceHead: string;
  sourceClean: true;
  completedAt: string;
}

export interface CachedEvidence {
  report: string;
  result: VerifyResult;
  coverage: EvidenceCoverage;
  /** the location that produced it — part of the key, not decoration (#5339). */
  location: EvidenceLocation;
  /** the probed environment vector it answers for — part of the key too (#5386). */
  capabilities: CapabilitySet;
  /** env gaps its checks reported; disclosed to every reader, never part of the key. */
  envGaps: string[];
  /**
   * The taxonomy class this run's failure carries (#5626 / §2.5), or absent when
   * nothing failed. A SIDE CHANNEL: `result` is untouched, no new `VerifyResult`
   * value exists, and `requireStickyGate`'s accept set is still exactly
   * `{PASS, NA}` (R2(a)). It only changes the next step a consumer PRINTS.
   *
   * Not part of the evidence key. A class is a property of the answer, not of the
   * question, so keying on it would split the slot for one sha in two and make a
   * reader unable to find its own record.
   */
  failureClass?: FailureClass;
  /**
   * Per-check non-PASS outcomes (#5573). Same disclosure rules as `failureClass`:
   * never keyed. Always an array (possibly empty) on records this version writes.
   */
  checkFailures?: Array<{ check: string; class: FailureClass }>;
}

/** An unscoped run of every check the config declares. */
const FULL_COVERAGE = (checks: string[]): EvidenceCoverage => ({ fullScenario: true, checks });

function isCoverage(m: Partial<SharedEvidence>): boolean {
  return typeof m.fullScenario === "boolean" && Array.isArray(m.checks);
}

function safeScenario(scenario: string): string {
  return scenario.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function localLeasePath(scenario: string): string {
  return `.verify/.leases/${safeScenario(scenario)}.lock`;
}

function gitCommonDir(): string | undefined {
  const common = run("git rev-parse --git-common-dir 2>/dev/null");
  if (common.code !== 0) return undefined;
  const path = common.out.trim();
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Verification is a repository resource, not a worktree resource.  A linked
 * worktree has its own `.verify/`, but all linked worktrees share this git
 * common directory.  The override makes isolated tests possible without
 * writing state into the real checkout's `.git` directory.
 */
export function sharedRoot(): string | undefined {
  const override = process.env.AGENTLOOP_VERIFICATION_STATE_DIR?.trim();
  if (override) return resolve(override);
  const common = gitCommonDir();
  return common ? resolve(common, "agentloop", "verification") : undefined;
}

/**
 * The single-flight COORDINATION directory for one verification identity. Keyed on
 * (sha, scenario, base) only — deliberately NOT on location — so two checkouts still
 * never run the same expensive gate concurrently (#4800/#5060).
 */
function sharedDir(root: string, sha: string, scenario: string, base: string): string {
  return resolve(root, sha, safeScenario(scenario), safeScenario(base));
}

/**
 * Where a verification record was produced (#5339).
 *
 * Evidence used to be keyed by (sha, scenario, base) ALONE, so a verdict produced in one
 * tree silently became this SHA's verdict in every tree sharing the git common dir: a
 * poisoned or flaky red stuck to the commit everywhere, and the one honest response —
 * re-verify from a different, clean location — was exactly what the cache made impossible.
 *
 * So location is part of the KEY and part of the ARTIFACT, written by the side that knows
 * the answer (the producer) rather than inferred by a consumer from its environment
 * (epic #5328). The distinction that matters is same-location vs cross-location reuse, not
 * cache vs no cache: same location still reuses (#5223's benefit), a different location
 * gets its own slot and therefore a real run.
 */
interface EvidenceLocation {
  /** worktree root that ran the checks (git toplevel; cwd when git cannot say). */
  worktree: string;
  /** the clone every linked worktree shares, or `unknown` when git cannot say (#5140). */
  hostClone: string;
}

/** #5140: a field we could not determine is explicitly unknown, never omitted. */
const UNKNOWN_FIELD = "unknown";

function evidenceLocation(): EvidenceLocation {
  const top = run("git rev-parse --show-toplevel 2>/dev/null");
  const worktree = top.code === 0 && top.out.trim() ? resolve(top.out.trim()) : process.cwd();
  return { worktree, hostClone: gitCommonDir() ?? UNKNOWN_FIELD };
}

function parseLocation(value: unknown): EvidenceLocation | undefined {
  const candidate = value as Partial<EvidenceLocation> | undefined;
  if (
    !candidate ||
    typeof candidate.worktree !== "string" ||
    typeof candidate.hostClone !== "string"
  )
    return undefined;
  return { worktree: candidate.worktree, hostClone: candidate.hostClone };
}

function sameLocation(a: EvidenceLocation | undefined, b: EvidenceLocation): boolean {
  return a !== undefined && a.worktree === b.worktree && a.hostClone === b.hostClone;
}

/**
 * WHAT THE HOST COULD DO while the checks ran (#5386).
 *
 * `location` (#5339) answers "where"; it does not answer "with what". At least one
 * check's ANSWER depends on an environment fact that is neither the sha, the base,
 * nor the tree — in the reported case, whether this host can reach the upstream it
 * mirrors. That input was outside the identity, so one identity had two different
 * correct answers and the broker could not tell them apart: it served "I cannot
 * reach it here" to a checkout that could, as "this PR is broken".
 *
 * `yes`/`no` are a probe's answer; `unknown` is a probe that could not answer (it
 * threw). `unknown` is a state, not an error: a probe that cannot answer must not
 * silently switch the broker off — "reuse nothing, ever" passes every reject test
 * here while destroying the whole point (#5223).
 */
export type CapabilityState = "yes" | "no" | "unknown";

/** The environment vector one record answers for: capability id → state. */
export type CapabilitySet = Readonly<Record<string, CapabilityState>>;

/**
 * One environment fact a check's answer depends on, declared by the consuming repo
 * next to its check list. Declaring it is what buys reuse back: an environment input
 * nobody declared and nobody observed cannot be in the identity, and the honest
 * response to that is a real run, not a reused verdict.
 */
export interface CapabilityProbe {
  /** stable id, e.g. `upstream-reachable` / `dns-localhost-subdomain` */
  id: string;
  /** true = this host HAS it. Throwing means "could not determine" (`unknown`). */
  probe: () => boolean;
}

/** Run each declared probe once. A throwing probe is `unknown`, never fatal. */
export function probeCapabilities(probes: readonly CapabilityProbe[] | undefined): CapabilitySet {
  const set: Record<string, CapabilityState> = {};
  for (const { id, probe } of probes ?? []) {
    try {
      set[id] = probe() ? "yes" : "no";
    } catch (e) {
      console.error(
        `⚠ capability probe "${id}" threw; recording it as unknown: ${e instanceof Error ? e.message : String(e)}`,
      );
      set[id] = "unknown";
    }
  }
  return set;
}

/**
 * A record's disclosed env gaps, or `undefined` when it cannot state them.
 *
 * FAIL-CLOSED, and that is the whole point of the field: degrading a malformed list to
 * "no gaps" would let one shape change silently switch the entire disclosure off, and a
 * switched-off disclosure looks exactly like a clean run. An unreadable disclosure makes
 * the whole record unreadable instead, which costs one honest re-run and says so.
 */
function parseEnvGaps(value: unknown, where: string): string[] | undefined {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  console.error(
    `⚠ ${where}: environment-gap disclosure is unreadable (${JSON.stringify(value)}); refusing the record rather than reading it as gap-free.`,
  );
  return undefined;
}

/**
 * A record's stated taxonomy class, or `undefined` when it states none (#5626).
 *
 * Deliberately NOT fail-closed, unlike {@link parseEnvGaps} one function up. The
 * asymmetry is the point: env-gap disclosure decides whether a record may be
 * REUSED, so a shape change that silently reads as "gap-free" would launder a
 * colour. A class decides only which sentence a consumer prints, and dropping it
 * degrades to the pre-taxonomy behaviour every old record already has. Refusing a
 * whole record over an unrecognised class would make a future vocabulary
 * extension retroactively destroy today's evidence, which trades a real cost for
 * no safety.
 */
function parseFailureClass(value: unknown): FailureClass | undefined {
  return typeof value === "string" && isFailureClass(value) ? value : undefined;
}

/**
 * Non-PASS, non-skip checks and the class each one carries. R0: a red with no
 * named class is CODE. The ENTRY exists because `pass === false`, not because
 * the classifier spoke — that is the rate ceiling's denominator substrate.
 */
export function checkFailuresOf(
  results: readonly CheckResult[],
): Array<{ check: string; class: FailureClass }> {
  const out: Array<{ check: string; class: FailureClass }> = [];
  for (const r of results) {
    if (isSkipped(r) || r.pass) continue;
    out.push({
      check: r.check,
      class: r.failure?.class && isFailureClass(r.failure.class) ? r.failure.class : "CODE",
    });
  }
  return out;
}

const CAPABILITY_STATES: readonly string[] = ["yes", "no", "unknown"];

/** Parse a record's stated vector; `undefined` when it states none (or states nonsense). */
function parseCapabilities(value: unknown): CapabilitySet | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, state]) => typeof state !== "string" || !CAPABILITY_STATES.includes(state)))
    return undefined;
  return Object.fromEntries(entries) as CapabilitySet;
}

/** Stable rendering of a vector — the digest input, so slot ids never depend on key order. */
export function canonicalCapabilities(set: CapabilitySet): string {
  return Object.keys(set)
    .sort()
    .map((id) => `${id}=${set[id]}`)
    .join(";");
}

/**
 * Every environment input on which a record and this host disagree, named.
 *
 * Empty ⇒ the record answers for this environment. Non-empty ⇒ it does not, and
 * each entry says WHICH input differed and which way round — a refusal that cannot
 * say that is indistinguishable from a broken comparator.
 *
 * A record that states no vector at all (pre-#5386, or corrupt) is refused with its
 * own reason: it cannot say what environment it answers for, which IS the bug.
 */
export function capabilityDrift(recorded: unknown, current: CapabilitySet): string[] {
  const stated = parseCapabilities(recorded);
  if (!stated)
    return ["the record states no environment capabilities, so it cannot answer for this host"];
  const ids = [...new Set([...Object.keys(stated), ...Object.keys(current)])].sort();
  const drift: string[] = [];
  for (const id of ids) {
    const there = stated[id] ?? "absent";
    const here = current[id] ?? "absent";
    if (there !== here) drift.push(`${id}: recorded ${there}, here ${here}`);
  }
  return drift;
}

/**
 * Environment gaps a check REPORTED during this run, however it said so.
 *
 * DISCLOSURE, deliberately NOT part of the key — and the reason is structural, not a
 * preference. A reader must compute the identity BEFORE it runs anything; an observed
 * gap is only knowable AFTER. Key on it and the admission slot a reader computes can
 * never be the slot a gapped run publishes into, so such a host re-runs the full gate
 * every single time and can never read back its own artifact. That is the over-fix
 * #5386 itself warns about, and no formulation avoids it: only a fact that can be
 * PROBED ahead of the run is eligible to be an identity input.
 *
 * So an undeclared environment dependency is made LOUD rather than keyed — the record
 * carries it, the report says it, the reuse notice repeats it, and the remedy is one
 * `capabilities` declaration. Guessing which other stats keys imply an environment
 * dependency would put an inferred fact where a measured one belongs, which is the
 * disease this epic exists to treat.
 *
 * Both spellings are read because both exist — `stats.envGap` predates the taxonomy
 * (`applyLocalhostDnsGap`), `failure.class = "ENV_GAP"` is the vocabulary of
 * `docs/architecture/verification-result-taxonomy.md` §2.1 — but they are NOT
 * unioned. Reading both and counting both reports ONE gap under TWO ids, so
 * declaring the capability clears one identity and the notice never clears
 * (arc#5612 review, P2-2). {@link envGapIdentity} normalises them onto the
 * CAPABILITY id, which is both the token this function's consumer
 * ({@link undeclaredEnvGaps}) subtracts and the token the probe itself prints.
 * The mapping is an explicit, exhaustive table — never a prefix match, because a
 * guessed equivalence and a measured one are the same colour.
 */
export function observedEnvGaps(results: readonly CheckResult[]): string[] {
  const ids = new Set<string>();
  for (const r of results) {
    const stat = r.stats?.envGap;
    if (typeof stat === "string" && stat.trim()) ids.add(envGapIdentity(stat.trim()));
    if (r.failure?.class === "ENV_GAP" && r.failure.reason.trim())
      ids.add(envGapIdentity(r.failure.reason.trim()));
  }
  return [...ids].sort();
}

/** Observed gaps this repo never declared as capabilities — the loud residual. */
export function undeclaredEnvGaps(gaps: readonly string[], declared: CapabilitySet): string[] {
  return gaps.filter((id) => !(id in declared));
}

/**
 * One directory segment per (location, capability vector). The hash makes it unique
 * and path-safe; the leading basename keeps the store browsable, which is half the
 * point of recording provenance.
 *
 * Capabilities are in the SLOT, not only in the metadata, for the same reason #5339
 * put location there: a reader that finds an evidence-shaped record it must refuse
 * cannot tell "different environment" from "corrupt record", and the corrupt branch
 * fails closed by refusing admission entirely. A different environment gets its own
 * empty slot and therefore a real run — the honest outcome, with no hard block.
 */
function locationId(location: EvidenceLocation, capabilities: CapabilitySet): string {
  const digest = createHash("sha256")
    .update(`${location.hostClone}\n${location.worktree}\n${canonicalCapabilities(capabilities)}`)
    .digest("hex")
    .slice(0, 12);
  // `.`/`..` would be a path segment, not a name — collapse them before they become one.
  const name = safeScenario(basename(location.worktree)).replace(/^\.+$/, "");
  return `${name || "root"}-${digest}`;
}

/** The RECORD directory: one slot per producing environment, so records never overwrite each other. */
function evidenceDir(
  coordination: string,
  location: EvidenceLocation,
  capabilities: CapabilitySet,
): string {
  return resolve(coordination, "by-location", locationId(location, capabilities));
}

/** A complete record for this same identity produced by some OTHER environment. */
interface SiblingRecord {
  location: EvidenceLocation;
  result: string;
  /** `undefined` when the record states none — see {@link capabilityDrift}. */
  capabilities: CapabilitySet | undefined;
}

/**
 * Complete records for this same identity produced at OTHER locations. #5325 had two
 * different verdicts alive for one PR with nothing on the page saying so; a report that
 * knows a sibling record exists says so instead of implying its own answer is the only one.
 */
function otherLocationRecords(
  coordination: string,
  self: EvidenceLocation,
  capabilities: CapabilitySet,
): SiblingRecord[] {
  const byLocation = resolve(coordination, "by-location");
  let slots: string[];
  try {
    slots = readdirSync(byLocation);
  } catch {
    return [];
  }
  const mine = locationId(self, capabilities);
  const found: SiblingRecord[] = [];
  for (const slot of slots) {
    if (slot === mine) continue;
    try {
      const metadata = JSON.parse(
        readFileSync(`${byLocation}/${slot}/metadata.json`, "utf8"),
      ) as Partial<SharedEvidence>;
      const location = parseLocation(metadata.location);
      // A record written by another schema version is not a comparable verdict — it
      // is an expired slot, and reporting it as a live sibling would manufacture a
      // divergence that does not exist.
      if (metadata.schemaVersion !== EVIDENCE_SCHEMA_VERSION) continue;
      if (location && typeof metadata.result === "string")
        found.push({
          location,
          result: metadata.result,
          capabilities: parseCapabilities(metadata.capabilities),
        });
    } catch {
      // A crashed or half-written sibling is not a fact worth reporting.
    }
  }
  return found;
}

function readOwnerPid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(`${path}/owner.json`, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && parsed.pid > 1 ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** POSIX rename onto an existing directory; treat as "already held". */
function isLeaseHeldError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR";
}

function renameErrnoName(errno: number): string {
  switch (errno) {
    case 17:
      return "EEXIST";
    case 21:
      return "EISDIR";
    case 39:
    case 66:
      return "ENOTEMPTY";
    default:
      return "EEXIST";
  }
}

function renameHeldError(code: string, dest: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: exclusive rename '${dest}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = "rename";
  err.path = dest;
  return err;
}

/**
 * `rename(2)` replaces an empty destination directory. Exclusive rename
 * (Darwin `RENAME_EXCL` / Linux `RENAME_NOREPLACE`) fails instead, so a
 * mixed-version peer between mkdir and owner.json — or a lock emptied
 * during `rmSync` — cannot be stolen (Codex P1 on #5361).
 */
function loadExclusiveRename(): ((from: string, to: string) => void) | undefined {
  try {
    const ffi = createRequire(import.meta.url)("bun:ffi") as {
      dlopen: (
        path: string,
        symbols: Record<string, { args: unknown[]; returns: unknown }>,
      ) => { symbols: Record<string, (...args: never[]) => unknown> };
      FFIType: { ptr: unknown; i32: unknown; u32: unknown };
      ptr: (buf: Uint8Array) => number;
      read: { i32: (p: number) => number };
    };
    const { dlopen, FFIType, ptr, read } = ffi;
    if (process.platform === "darwin") {
      const lib = dlopen("/usr/lib/libSystem.B.dylib", {
        renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        __error: { args: [], returns: FFIType.ptr },
      });
      const RENAME_EXCL = 0x00000004;
      return (from, to) => {
        const fromBuf = Buffer.from(`${from}\0`);
        const toBuf = Buffer.from(`${to}\0`);
        const rc = lib.symbols.renamex_np(ptr(fromBuf), ptr(toBuf), RENAME_EXCL) as number;
        if (rc === 0) return;
        throw renameHeldError(renameErrnoName(read.i32(lib.symbols.__error() as number)), to);
      };
    }
    if (process.platform === "linux") {
      const lib = dlopen("libc.so.6", {
        renameat2: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
      const AT_FDCWD = -100;
      const RENAME_NOREPLACE = 1;
      return (from, to) => {
        const fromBuf = Buffer.from(`${from}\0`);
        const toBuf = Buffer.from(`${to}\0`);
        const rc = lib.symbols.renameat2(
          AT_FDCWD,
          ptr(fromBuf),
          AT_FDCWD,
          ptr(toBuf),
          RENAME_NOREPLACE,
        ) as number;
        if (rc === 0) return;
        throw renameHeldError(
          renameErrnoName(read.i32(lib.symbols.__errno_location() as number)),
          to,
        );
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const exclusiveRename = loadExclusiveRename();

/**
 * Atomically publish `from/` onto `to/` only if `to` does not exist — including
 * as an empty directory. Plain `renameSync` is not exclusive on POSIX.
 */
function renameNoReplace(from: string, to: string): void {
  if (exclusiveRename) {
    exclusiveRename(from, to);
    return;
  }
  if (existsSync(to)) throw renameHeldError("EEXIST", to);
  renameSync(from, to);
}

/**
 * Create `lock/` already containing owner.json. Once the lock directory is
 * visible it has an owner, so `owner === undefined` is a corrupt lease again
 * rather than the mkdir→write race (#5361). Dest must not already exist
 * (empty leftover included) — `rename(2)` would replace an empty dir.
 */
function createLeaseLock(lock: string, owner: Record<string, unknown>): void {
  mkdirSync(dirname(lock), { recursive: true });
  const tmp = mkdtempSync(join(dirname(lock), `${basename(lock)}.tmp-`));
  try {
    writeFileSync(join(tmp, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
    renameNoReplace(tmp, lock);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/**
 * One verification scenario may own its check process trees at a time. This
 * prevents a caller-side timeout/retry from turning one expensive gate into
 * multiple concurrent turbo runs. A lease is recovered only after its owner
 * pid is gone; ambiguity stays fail-closed and never signals that pid.
 */
function acquireLocalScenarioLease(scenario: string): ScenarioLease | undefined {
  const path = localLeasePath(scenario);
  mkdirSync(".verify/.leases", { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      createLeaseLock(path, {
        pid: process.pid,
        scenario,
        startedAt: new Date().toISOString(),
      });
      return { path };
    } catch (err) {
      if (!isLeaseHeldError(err)) throw err;
      const owner = readOwnerPid(path);
      // Lock creation is atomic (temp dir + rename), so a missing/malformed
      // owner is a corrupt lease, not the mkdir→write window. Reclaiming it
      // would admit duplicate gates if another owner is still using it.
      if (owner === undefined) {
        console.error(
          `❌ ${scenario} has an unreadable verification lease; refusing duplicate gate admission.`,
        );
        return undefined;
      }
      if (processIsAlive(owner)) {
        console.error(
          `❌ ${scenario} is already running (owner pid ${owner}); refusing duplicate gate admission.`,
        );
        return undefined;
      }
      // A crashed owner leaves no process to coordinate with. Reclaim only
      // this scenario's own lock directory, then retry its atomic create once.
      rmSync(path, { recursive: true, force: true });
    }
  }
  console.error(`❌ unable to acquire ${scenario} verification lease.`);
  return undefined;
}

function releaseScenarioLease(lease: ScenarioLease | undefined): void {
  if (lease) rmSync(lease.path, { recursive: true, force: true });
}

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function readSharedEvidence(
  dir: string,
  sha: string,
  scenario: string,
  base: string,
  location: EvidenceLocation,
  capabilities: CapabilitySet,
): CachedEvidence | undefined {
  const metadataPath = `${dir}/metadata.json`;
  const reportPath = `${dir}/report.md`;
  const resultPath = `${dir}/result`;
  if (!existsSync(metadataPath) || !existsSync(reportPath) || !existsSync(resultPath))
    return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<SharedEvidence>;
    const result = readFileSync(resultPath, "utf8").trim() as VerifyResult;
    const producedAt = parseLocation(metadata.location);
    const disclosed = parseEnvGaps(metadata.envGaps, metadataPath);
    if (
      // A record that cannot state what its checks reported about the environment is
      // not readable evidence — fail closed rather than read it as gap-free (#5386).
      disclosed === undefined ||
      metadata.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      metadata.scenario !== scenario ||
      metadata.sha !== sha ||
      metadata.base !== base ||
      metadata.sourceHead !== sha ||
      metadata.sourceClean !== true ||
      metadata.result !== result ||
      !isCoverage(metadata) ||
      // #5339: a record only answers for the location that produced it. The slot is
      // already location-keyed; re-checking the producer's own statement here means a
      // record misfiled into another location's slot still cannot be reused as its own.
      !sameLocation(producedAt, location) ||
      // #5386, the same argument one axis over: the slot is capability-keyed, and
      // re-checking the producer's own statement here means a record misfiled into
      // another environment's slot still cannot be reused as its own.
      capabilityDrift(metadata.capabilities, capabilities).length > 0 ||
      // Only a full run is ever published here; a record claiming otherwise is not
      // shared evidence and must not be reused as one (#5067).
      metadata.fullScenario !== true ||
      !["PASS", "NA", "FAIL", "TIMEOUT"].includes(result)
    ) {
      return undefined;
    }
    return {
      report: readFileSync(reportPath, "utf8"),
      result,
      coverage: FULL_COVERAGE(metadata.checks as string[]),
      location: producedAt as EvidenceLocation,
      capabilities: parseCapabilities(metadata.capabilities) as CapabilitySet,
      envGaps: disclosed,
      failureClass: parseFailureClass(metadata.failureClass),
      checkFailures: metadata.checkFailures,
    };
  } catch {
    return undefined;
  }
}

function hasPartialSharedEvidence(dir: string): boolean {
  return ["metadata.json", "report.md", "result"].some((name) => existsSync(`${dir}/${name}`));
}

function writeLocalCache(
  sha: string,
  scenario: string,
  base: string,
  cached: CachedEvidence,
): void {
  mkdirSync(".verify", { recursive: true });
  writeFileSync(`.verify/${sha}.md`, cached.report, "utf8");
  writeFileSync(`.verify/${sha}.result`, cached.result, "utf8");
  // #5626 — the class, beside the result and never inside it. Written and REMOVED
  // in the same breath: a leftover `.class` from an earlier run on this same sha
  // would have a consumer print a next step for a verdict that no longer exists,
  // which is worse than printing none. Absence is the documented fallback signal,
  // so it has to mean "this run had no class", not "some run once did".
  const classFile = `.verify/${sha}.class`;
  if (cached.failureClass) writeFileSync(classFile, `${cached.failureClass}\n`, "utf8");
  else rmSync(classFile, { force: true });
  writeAtomic(
    `.verify/${sha}.metadata.json`,
    `${JSON.stringify({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      sha,
      scenario,
      base,
      // #5067: coverage, not just identity. Without these two fields a consumer cannot
      // tell a full PASS from a `--only a,b` PASS, and `pre-push` accepted both.
      fullScenario: cached.coverage.fullScenario,
      checks: cached.coverage.checks,
      // #5339: and WHERE it was produced, so this artifact answers for a place too.
      location: cached.location,
      // #5386: and WITH WHAT — the probed environment this answer belongs to, plus the
      // env gaps its checks reported (disclosure, not key).
      capabilities: cached.capabilities,
      envGaps: cached.envGaps,
      // #5626: …and WHAT KIND of red, so a reused record still knows its next step.
      // `undefined` drops out of JSON, which is exactly the "no class" encoding.
      failureClass: cached.failureClass,
      // #5573: per-check non-PASS outcomes. Always an array so [] (counted
      // zero) and a missing field (never counted) stay distinguishable.
      checkFailures: cached.checkFailures ?? [],
    })}\n`,
  );
}

function readLocalCache(
  sha: string,
  scenario: string,
  base: string,
  location: EvidenceLocation,
  capabilities: CapabilitySet,
): CachedEvidence | undefined {
  const reportFile = `.verify/${sha}.md`;
  const resultFile = `.verify/${sha}.result`;
  const metadataFile = `.verify/${sha}.metadata.json`;
  if (!existsSync(reportFile) || !existsSync(resultFile) || !existsSync(metadataFile))
    return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as Partial<SharedEvidence>;
    const result = readFileSync(resultFile, "utf8").trim() as VerifyResult;
    const producedAt = parseLocation(metadata.location);
    const disclosed = parseEnvGaps(metadata.envGaps, metadataFile);
    if (
      disclosed === undefined ||
      metadata.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      metadata.sha !== sha ||
      metadata.scenario !== scenario ||
      metadata.base !== base ||
      !isCoverage(metadata) ||
      // A `.verify/` copied into another tree is another location's answer (#5339).
      !sameLocation(producedAt, location) ||
      // …and a `.verify/` written before this host gained (or lost) a capability is
      // another environment's answer (#5386). The local cache is a single file, not
      // a per-environment slot, so this predicate is the only thing standing between
      // an offline verdict and the online run that reads it back.
      capabilityDrift(metadata.capabilities, capabilities).length > 0 ||
      !["PASS", "NA", "FAIL", "TIMEOUT", "PARTIAL"].includes(result)
    ) {
      return undefined;
    }
    return {
      report: readFileSync(reportFile, "utf8"),
      result,
      coverage: {
        fullScenario: metadata.fullScenario as boolean,
        checks: metadata.checks as string[],
      },
      location: producedAt as EvidenceLocation,
      capabilities: parseCapabilities(metadata.capabilities) as CapabilitySet,
      envGaps: disclosed,
      failureClass: parseFailureClass(metadata.failureClass),
      checkFailures: metadata.checkFailures,
    };
  } catch {
    return undefined;
  }
}

function sharedWaitMs(): number {
  const value = Number(process.env.AGENTLOOP_VERIFICATION_WAIT_MS ?? "900000");
  return Number.isFinite(value) && value >= 0 ? value : 900_000;
}

/**
 * Join the repository-global, SHA-scoped single-flight broker.  A runner can
 * either own the expensive work, reuse completed evidence, or wait for the
 * known live owner.  It never starts a second check tree for the same key.
 */
function acquireSharedScenarioLease(
  root: string,
  sha: string,
  scenario: string,
  base: string,
  location: EvidenceLocation,
  capabilities: CapabilitySet,
): ScenarioLease | CachedEvidence | undefined {
  const coordination = sharedDir(root, sha, scenario, base);
  const dir = evidenceDir(coordination, location, capabilities);
  const lock = `${coordination}/lease.lock`;
  const deadline = Date.now() + sharedWaitMs();
  mkdirSync(dir, { recursive: true });

  for (;;) {
    const cached = readSharedEvidence(dir, sha, scenario, base, location, capabilities);
    if (cached) return cached;
    try {
      createLeaseLock(lock, {
        pid: process.pid,
        scenario,
        sha,
        startedAt: new Date().toISOString(),
      });
      // A completed writer may have released immediately before our create.
      // Re-check while holding the lock; if so we only reuse it and do not run.
      const completed = readSharedEvidence(dir, sha, scenario, base, location, capabilities);
      if (completed) {
        rmSync(lock, { recursive: true, force: true });
        return completed;
      }
      // A crashed publisher may have left report/result without the atomic
      // metadata commit, or a corrupt metadata file.  It is evidence-shaped
      // but untrustworthy; replacing it with a fresh run would turn ambiguity
      // into a false green. Preserve it and require explicit repair instead.
      if (hasPartialSharedEvidence(dir)) {
        rmSync(lock, { recursive: true, force: true });
        console.error(
          `❌ ${scenario}@${sha.slice(0, 9)} has unreadable shared verification evidence; refusing to overwrite it with a duplicate gate.`,
        );
        // #5339: name the resolved record, because it is not under this worktree's `.git`
        // and this message is the only thing that knows where it actually is.
        console.error(`   Inspect or remove: ${dir}`);
        return undefined;
      }
      return { path: lock, shared: { coordination, sha, scenario, base, location, capabilities } };
    } catch (err) {
      if (!isLeaseHeldError(err)) throw err;
      const owner = readOwnerPid(lock);
      // Lock creation is atomic, so a missing/malformed owner is corrupt, not
      // a racer between mkdir and write. Deleting it would reopen the race.
      if (owner === undefined) {
        console.error(
          `❌ ${scenario}@${sha.slice(0, 9)} has an unreadable shared verification lease; refusing duplicate gate admission.`,
        );
        return undefined;
      }
      if (!processIsAlive(owner)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        console.error(
          `❌ ${scenario}@${sha.slice(0, 9)} is still running (owner pid ${owner}); timed out waiting without starting a duplicate gate.`,
        );
        return undefined;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * Explicitly retry terminal failed shared evidence without weakening the
 * single-flight rule. The old triplet is archived under the same SHA so the
 * retry remains auditable; metadata moves first, making new readers wait on
 * this lease instead of reusing the result being retried.
 */
function acquireFailedEvidenceRetryLease(
  root: string,
  sha: string,
  scenario: string,
  base: string,
  location: EvidenceLocation,
  capabilities: CapabilitySet,
): ScenarioLease | CachedEvidence | undefined {
  const coordination = sharedDir(root, sha, scenario, base);
  const dir = evidenceDir(coordination, location, capabilities);
  const lock = `${coordination}/lease.lock`;
  const deadline = Date.now() + sharedWaitMs();
  mkdirSync(dir, { recursive: true });

  for (;;) {
    try {
      createLeaseLock(lock, {
        pid: process.pid,
        scenario,
        sha,
        retryFailed: true,
        startedAt: new Date().toISOString(),
      });
      const cached = readSharedEvidence(dir, sha, scenario, base, location, capabilities);
      if (!cached) {
        if (hasPartialSharedEvidence(dir)) {
          rmSync(lock, { recursive: true, force: true });
          console.error(
            `❌ ${scenario}@${sha.slice(0, 9)} has unreadable shared verification evidence; refusing retry overwrite.`,
          );
          console.error(`   Inspect or remove: ${dir}`);
          return undefined;
        }
        return {
          path: lock,
          shared: { coordination, sha, scenario, base, location, capabilities },
        };
      }
      if (cached.result === "PASS" || cached.result === "NA") {
        rmSync(lock, { recursive: true, force: true });
        return cached;
      }

      const archive = `${dir}/retries/${Date.now()}-${process.pid}`;
      mkdirSync(archive, { recursive: true });
      for (const name of ["metadata.json", "report.md", "result"]) {
        const source = `${dir}/${name}`;
        if (existsSync(source)) renameSync(source, `${archive}/${name}`);
      }
      return { path: lock, shared: { coordination, sha, scenario, base, location, capabilities } };
    } catch (err) {
      if (!isLeaseHeldError(err)) throw err;
      const owner = readOwnerPid(lock);
      if (owner === undefined) {
        console.error(
          `❌ ${scenario}@${sha.slice(0, 9)} has an unreadable shared verification lease; refusing retry admission.`,
        );
        return undefined;
      }
      if (!processIsAlive(owner)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        console.error(
          `❌ ${scenario}@${sha.slice(0, 9)} is still running (owner pid ${owner}); timed out waiting without starting a duplicate retry.`,
        );
        return undefined;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * Commit the record into the slot this lease was ADMITTED under — the same slot the
 * next reader at this location will compute.
 *
 * That identity has to be fixed before the checks run, not after (#5386). Publishing
 * into a slot derived from anything discovered DURING the run would leave the
 * admission slot permanently empty, so every run on such a host re-runs the whole
 * gate and can never read back its own artifact. Everything learned during the run
 * that bears on the environment travels as disclosure on the record instead.
 */
function publishSharedEvidence(lease: ScenarioLease | undefined, cached: CachedEvidence): void {
  if (!lease?.shared) return;
  const { coordination, sha, scenario, base, location, capabilities } = lease.shared;
  const dir = evidenceDir(coordination, location, capabilities);
  mkdirSync(dir, { recursive: true });
  writeAtomic(`${dir}/report.md`, cached.report);
  writeAtomic(`${dir}/result`, `${cached.result}\n`);
  const metadata: SharedEvidence = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    fullScenario: cached.coverage.fullScenario,
    checks: cached.coverage.checks,
    scenario,
    sha,
    base,
    result: cached.result,
    location,
    // The SAME value the slot digest was taken from, by construction rather than by
    // coincidence (Codex P2 on #5600). If the stated vector and the slot's digest could
    // ever disagree, the record would be evidence-shaped and permanently unreadable —
    // which is the one input `acquireSharedScenarioLease` fails closed on, refusing
    // admission entirely. One source, so they cannot drift apart.
    capabilities,
    envGaps: cached.envGaps,
    // #5626: travels with the record so a reader in another tree inherits the
    // next step, not just the colour. Never keyed — see `CachedEvidence`.
    failureClass: cached.failureClass,
    // #5573: per-check non-PASS list. Always written, including `[]`.
    checkFailures: cached.checkFailures ?? [],
    sourceHead: sha,
    sourceClean: true,
    completedAt: new Date().toISOString(),
  };
  // Metadata is the commit point: consumers ignore partial report/result files
  // until this SHA-, scenario-, and clean-state-bound record appears.
  writeAtomic(`${dir}/metadata.json`, `${JSON.stringify(metadata)}\n`);
}

/**
 * #5223: reuse must be a different color from "this invocation actually ran". Silent reuse
 * is how an agent burns three full wall-clock waits believing it re-ran.
 *
 * #5339: and the way out must be followable. This used to print a LITERAL
 * `.git/agentloop/verification/<sha>` — wrong twice over for the factory, where every agent
 * works in a linked worktree whose `.git` is a FILE: the record lives in the git COMMON
 * dir, at a path this notice is the only thing in a position to know. So it prints the
 * resolved record path, not a template. Reuse is now always same-location (a different
 * location gets its own slot and therefore a real run), hence the single branch.
 */
export function provenanceNotice(
  cached: CachedEvidence,
  sha: string,
  record: string | undefined,
): string {
  const at = cached.location;
  // `record` is a resolved filesystem path, and paths may legally contain `'`. This line
  // is offered for PASTING, so a raw interpolation is not a cosmetic bug: a legitimate
  // apostrophe breaks the command, and a hostile path closes the quote and appends a
  // second one — to an `rm -rf`. `shQuote` is the same POSIX escape the comment layer
  // already relies on; ordinary paths come out byte-identical to the old string.
  const force = record ? `rm -rf .verify/${sha}.* ${shQuote(record)}` : `rm -rf .verify/${sha}.*`;
  // #5386: "same location" is not the whole identity — the environment the host could
  // offer is the other half, and a reader deciding whether to trust a reused verdict
  // needs to see which one it answers for.
  const caps = canonicalCapabilities(cached.capabilities);
  // …and if an environment gap decided part of that verdict, the line that hands it to
  // you is the right place to say so: "the check ran and passed" and "the check could
  // not run here" are otherwise the same colour on a reused report (#5386 / #5371).
  const gaps = cached.envGaps.length
    ? `> ⚠️ That run reported environment gap(s): \`${cached.envGaps.join("`, `")}\` — part of its answer was decided by what the host could not do.\n`
    : "";
  return (
    "> ℹ **Reused evidence** — produced by an earlier run at this same location, under the " +
    "same declared capabilities, for this same commit — not by the invocation that " +
    "delivered it.\n" +
    `> Produced at tree \`${at.worktree}\` · host clone \`${at.hostClone}\`` +
    `${caps ? ` · environment \`${caps}\`` : ""}.\n` +
    `> Shared record: \`${record ?? UNKNOWN_FIELD}\`\n` +
    `${gaps}> Force a real re-run here: \`${force}\`\n\n`
  );
}

/** The production conditions this artifact carries with it (epic #5328; accept 1 of #5339). */
function originNotice(location: EvidenceLocation, scenario: string, base: string): string {
  return `> 📍 **Produced at** — tree \`${location.worktree}\` · host clone \`${location.hostClone}\` · scenario \`${scenario}\` · base \`${base}\``;
}

/** Say out loud that this sha has more than one answer, rather than shipping one of them (#5325). */
function divergenceNotice(others: SiblingRecord[]): string | undefined {
  if (!others.length) return undefined;
  const list = others.map((o) => `tree \`${o.location.worktree}\` → **${o.result}**`).join("; ");
  return `> ⚠️ **Independent evidence for this commit exists elsewhere** — ${list}. This report is this location's own run; they are separate facts about the same sha, not one verdict.`;
}

/**
 * An environment gap this run hit that nobody declared as a capability (#5386).
 *
 * It is NOT in the identity — it could not be, it was only knowable once the checks
 * had run. So the honest thing is to say so on the report: this verdict was shaped by
 * something the evidence key does not distinguish, and one `capabilities` declaration
 * makes it distinguishable. Silence here is the same colour as no gap at all, which is
 * the failure mode the taxonomy is named after.
 */
function undeclaredEnvGapNotice(gaps: string[]): string | undefined {
  if (!gaps.length) return undefined;
  return (
    `> ⚠️ **Environment gap outside the evidence key** — this run reported \`${gaps.join("`, `")}\`, ` +
    "which this repo does not declare in `capabilities`. Part of this verdict was decided by what " +
    "the host could not do, and evidence for this commit is NOT keyed on it: a host that CAN do it " +
    "may reuse this answer. Declare a probe for it to close that."
  );
}

/**
 * Why this run is NOT reusing a record that sits right next to it (#5386).
 *
 * Without this line the fix is invisible where it matters most: an agent that expected
 * a cache hit sees a full re-run and no reason for it, which is the same screen as a
 * broker that quietly stopped working. Naming the differing input — and both its
 * states — is what separates "this record answers a different question" from "the
 * comparison is broken".
 */
function capabilityDriftNotice(
  siblings: SiblingRecord[],
  self: EvidenceLocation,
  capabilities: CapabilitySet,
): string | undefined {
  const drifted = siblings
    .filter((s) => sameLocation(s.location, self))
    .flatMap((s) =>
      capabilityDrift(s.capabilities, capabilities).map((d) => `${d} (was ${s.result})`),
    );
  if (!drifted.length) return undefined;
  return (
    "> ℹ **Not reused — environment capability differs.** A record for this commit was " +
    `produced at this same tree under a different environment: ${drifted.join("; ")}. ` +
    "Its answer depended on an input this host does not share, so it is not this host's answer."
  );
}

/** Write a check's full tool output next to the report so the markdown stays a table (#5223). */
function persistCheckLog(sha: string, r: CheckResult): CheckResult {
  if (!r.rawFull) return r;
  mkdirSync(".verify", { recursive: true });
  const logPath = `.verify/${sha}.${r.check}.log`;
  writeFileSync(logPath, r.rawFull);
  return { ...r, logPath };
}

/**
 * Run one check and ALWAYS return a `CheckResult` — the carrying surface for
 * `UNKNOWN` (#5591; `docs/architecture/verification-result-taxonomy.md` §5.4).
 *
 * ## Why this exists
 *
 * `UNKNOWN`'s criterion is "no `CheckResult` was produced at all". Before this
 * wrapper, `c.run(ctx)` was called bare: a check that threw took the whole
 * process down, so no result was produced — and `failure.class` is a field
 * INSIDE `CheckResult`. The class was self-referential and unreachable. Every
 * other class could be assigned; this one could not exist.
 *
 * ## Three decisions, each load-bearing
 *
 * 1. **The class is preserved, not flattened into the boolean.** The repo
 *    already has this wrapper's shape at `scripts/nightly-test.ts:1435-1442`,
 *    and it is an instance of the very bug this taxonomy exists to fix: its
 *    catch writes `pass = false`, so "the step threw" and "the step failed"
 *    become one indistinguishable red. A synthesized result carries
 *    `failure.class = "UNKNOWN"` so a consumer can tell a broken CHECK from a
 *    broken REPO — different actor (a human, not the agent holding the red),
 *    different next step (stop and escalate, not edit files and re-run).
 *
 * 2. **`UNKNOWN` lives at CHECK level, not run level.** A run-level UNKNOWN
 *    cannot say WHICH check died, and the per-check sub-ceiling in §7.2 needs
 *    that attribution.
 *
 * 3. **It is RED, and it does not RE-COLOUR the check.** The synthesized result
 *    keeps the spec's own `blocking` (`c.blocking ?? true`) rather than forcing
 *    `true`. Promoting a warn-only check would mean one buggy warn-only check
 *    turns the gate red for everyone — a new flake surface on a gate whose
 *    standing disease is flake. "A warn-only check threw" is real signal, but
 *    its home is the UNKNOWN-rate ceiling (taxonomy §7.2), not the gate colour.
 *    In the other direction nothing here softens anything: no `pass: true`, no
 *    `blocking: false` written by this function, no `skipped` — the three
 *    shapes `passed()` tolerates (taxonomy R2). A check that did not declare
 *    itself warn-only stays blocking, so the default path is RED. And no
 *    `stats.timedOut` is fabricated, so `deriveResult` reads FAIL, never
 *    TIMEOUT (§2.5).
 */
export function runCheckGuarded(c: CheckSpec, ctx: RunContext): CheckResult {
  const startedAt = Date.now();
  try {
    return c.run(ctx);
  } catch (e) {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const message = `check \`${c.id}\` threw instead of returning a CheckResult:\n${detail}`;
    console.error(`❌ ${message}`);
    return {
      check: c.id,
      title: c.title ?? c.id,
      pass: false,
      // The SPEC's declared blocking-ness, not a hardcoded `true`. `CheckSpec`
      // carries it (`blocking?: boolean` — "hard gate? false = warn-only.
      // Default true"), `cmd()` propagates it, and the sibling synthesis for a
      // never-run check a few lines below uses exactly this expression.
      blocking: c.blocking ?? true,
      durationMs: Date.now() - startedAt,
      failure: { class: "UNKNOWN", reason: "no-check-result-produced" },
      rawTail: message,
      rawFull: message,
    };
  }
}

function cleanForEvidence(): boolean {
  const dirty = run("git status --porcelain")
    .out.split("\n")
    .filter(
      (line) => !line.slice(3).startsWith(".verify/") && !/^\?\? FACTORY_TASK\.md$/.test(line),
    )
    .join("\n")
    .trim();
  return !dirty;
}

/**
 * Run a scenario end-to-end and exit the process with the gate code. This is the
 * single entrypoint a repo's thin scenario script (e.g. `.claude/verify/pre-pr.ts`)
 * calls: `runScenario(config, process.argv)`.
 */
export function runScenario(config: ScenarioConfig, argv: string[]): never {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        `Usage: ${config.scenario} [--json] [--comment [<pr#>]] [--comment-dry-run]`,
        "       [--na <reason>] [--deliver-cached] [--retry-failed] [--only a,b] [--skip x,y]",
      ].join("\n"),
    );
    process.exit(0);
  }

  const commentArgs: CommentArgs = parseCommentArgs(argv);

  /**
   * Every delivery goes through here so no exit path can forget to record its
   * round. There are five of them (NA, --deliver-cached, two reused-evidence
   * exits, and the normal completion), and a per-call-site argument list would
   * make "this round was not recorded" a silent omission rather than a type
   * error — the reused-evidence paths are precisely the ones most likely to be
   * skipped by hand, and precisely the ones worth seeing in a duration series.
   */
  const deliver = (
    report: string,
    sha: string,
    result: VerifyResult,
    meta: Omit<RunMeta, "scenario">,
  ) =>
    deliverComment(commentArgs, report, sha, result, run, MARKER_PREFIX, {
      scenario: config.scenario,
      ...meta,
    });
  const identity = config.identity?.("Verification") ?? "";
  // Resolved once, up front: every artifact this invocation writes or reads is scoped to
  // the place that produced it (#5339).
  const here = evidenceLocation();
  // …and WITH WHAT (#5386). Probed once per invocation, before any record is read or
  // written, because it is an identity input: an answer produced under one environment
  // is not an answer for another, in either direction.
  const declaredCapabilities = probeCapabilities(config.capabilities);
  const only = parseSelect(argv, "--only");
  const skip = parseSelect(argv, "--skip");
  const retryFailed = resolveRetryFailed(argv, config);
  if (retryFailed && (argv.includes("--deliver-cached") || argv.includes("--na"))) {
    console.error("❌ --retry-failed cannot be combined with --deliver-cached or --na.");
    process.exit(2);
  }
  const known = new Set(config.checks.map((c) => c.id));
  // Validate before broker admission. A typo must not wait behind (or own) a
  // real gate only to discover it selected nothing.
  for (const id of [...(only ?? []), ...(skip ?? [])]) {
    if (!known.has(id)) {
      console.error(
        `❌ unknown check id "${id}" in --only/--skip. Known: ${[...known].join(", ")}`,
      );
      process.exit(2);
    }
  }

  let lease: ScenarioLease | undefined;

  // Exit code that also surfaces a DELIVERY failure. A gate that verified fine but whose
  // report was requested (--comment/--post) and never posted must not exit 0 — a caller
  // checking only the exit code would read "verified but report never delivered" as full
  // success. Verify-failure codes always dominate (the verify result is the primary signal).
  const finalExit = (verifyCode: number, post: boolean, delivered: boolean): never => {
    releaseScenarioLease(lease);
    if (verifyCode === 0 && post && !delivered) {
      console.error(
        "❌ verification PASSED but the report was NOT delivered — exiting 4 (not 0) so this isn't read as fully successful.",
      );
      process.exit(4);
    }
    process.exit(verifyCode);
  };

  // --na <reason>: write exemption + optionally deliver, then exit.
  const naIdx = argv.indexOf("--na");
  if (naIdx !== -1) {
    lease = acquireLocalScenarioLease(config.scenario);
    if (!lease) process.exit(3);
    const reason = argv[naIdx + 1] ?? "no reason given";
    const sha = head();
    const base = config.resolveBase ? config.resolveBase() : mergeBase(config.baseBranch);
    const refusal = naRefusal(base);
    if (refusal) {
      printNaRefusal(refusal);
      finalExit(2, false, false);
    }
    const report = writeNa(
      config.scenario,
      reason,
      sha,
      base,
      identity,
      here,
      declaredCapabilities,
    );
    console.log(`✅ N/A exemption written to .verify/${sha.slice(0, 9)}.md`);
    const na = commentArgs.post
      ? deliver(report, sha, "NA", { wallMs: gateWallMs(), checksMs: null })
      : { posted: true };
    if (!commentArgs.post) console.log(stickyBody(report, sha, "NA"));
    finalExit(0, commentArgs.post, na.posted);
  }

  // --deliver-cached: post the cached report for HEAD without re-running.
  if (argv.includes("--deliver-cached")) {
    const sha = head();
    const base = config.resolveBase ? config.resolveBase() : mergeBase(config.baseBranch);
    let cached = readLocalCache(sha, config.scenario, base, here, declaredCapabilities);
    // #5067: `--deliver-cached` used to validate IDENTITY only (HEAD + scenario +
    // resolved base), which is why it could not stop a `--only` PASS from satisfying
    // the push gate. A partial record stays on disk and stays readable — it is just no
    // longer a token. Set aside, not discarded, so the refusal can name what did run.
    const partial = cached && !cached.coverage.fullScenario ? cached : undefined;
    if (partial) cached = undefined;
    const root = sharedRoot();
    const record = root
      ? evidenceDir(sharedDir(root, sha, config.scenario, base), here, declaredCapabilities)
      : undefined;
    if (!cached) {
      const shared = record
        ? readSharedEvidence(record, sha, config.scenario, base, here, declaredCapabilities)
        : undefined;
      if (shared) {
        writeLocalCache(sha, config.scenario, base, shared);
        cached = shared;
      }
    }
    if (!cached) {
      if (partial) {
        console.error(
          `--deliver-cached: the cached ${config.scenario} record for ${sha.slice(0, 9)} is a PARTIAL verification — it ran only: ${partial.coverage.checks.join(", ")}.`,
        );
        console.error(
          `  It is a diagnostic artifact (still readable at .verify/${sha}.md), not a gate token. Run the full scenario: bun .claude/verify/${config.scenario}.ts`,
        );
      } else {
        console.error(
          `--deliver-cached: no current ${config.scenario} cache for ${sha.slice(0, 9)} at base ${base.slice(0, 9)}. Run the scenario first.`,
        );
      }
      process.exit(1);
    }
    const reused = provenanceNotice(cached, sha, record);
    console.error(reused.trimEnd());
    const delivery = deliver(`${reused}${cached.report}`, sha, cached.result, {
      wallMs: gateWallMs(),
      checksMs: null,
      reused: true,
    });
    // Diagnostics are reusable, but only PASS/NA are gate tokens.
    finalExit(
      cached.result === "PASS" || cached.result === "NA" ? 0 : 1,
      commentArgs.post,
      delivery.posted,
    );
  }

  const fullScenario = !only && !skip;
  if (retryFailed && !fullScenario) {
    console.error(
      "❌ --retry-failed requires a full scenario; do not combine it with --only or --skip.",
    );
    process.exit(2);
  }
  const shaForBroker = head();
  // The base is verification input, not just report decoration. In particular
  // pre-merge resolves origin/main at execution time, so a sibling merge must
  // create a new verification identity even while the PR head stays unchanged.
  const baseForBroker = config.resolveBase ? config.resolveBase() : mergeBase(config.baseBranch);
  const cleanAtAdmission = cleanForEvidence();
  const brokerRoot = fullScenario ? sharedRoot() : undefined;
  const brokerCoordination = brokerRoot
    ? sharedDir(brokerRoot, shaForBroker, config.scenario, baseForBroker)
    : undefined;
  const brokerRecord = brokerCoordination
    ? evidenceDir(brokerCoordination, here, declaredCapabilities)
    : undefined;
  // Full gates coordinate through one repository-global broker before deciding
  // whether this checkout may execute.  In particular, a dirty worktree must
  // never fall back to its local lease: an existence check on the shared lock
  // has a TOCTOU window, and two dirty linked worktrees would otherwise each
  // acquire their own local lock and duplicate the expensive gate.
  if (brokerRoot) {
    const admission = acquireSharedScenarioLease(
      brokerRoot,
      shaForBroker,
      config.scenario,
      baseForBroker,
      here,
      declaredCapabilities,
    );
    if (!admission) process.exit(3);
    if ("report" in admission && !(retryFailed && ["FAIL", "TIMEOUT"].includes(admission.result))) {
      writeLocalCache(shaForBroker, config.scenario, baseForBroker, admission);
      console.error(
        `ℹ reused shared ${config.scenario} evidence for ${shaForBroker.slice(0, 9)}; no duplicate gate started.`,
      );
      // A cached red is a verdict, not a fact of nature: #5339 watched one flake become
      // this sha's permanent answer because nothing on screen said the retry existed.
      if (admission.result === "FAIL" || admission.result === "TIMEOUT") {
        console.error(
          `ℹ that cached verdict is ${admission.result}. It is NOT re-run automatically (single-flight, #5060) — pass --retry-failed to force one real retry here.`,
        );
      }
      const reused = provenanceNotice(admission, shaForBroker, brokerRecord);
      console.error(reused.trimEnd());
      const cached = deliver(`${reused}${admission.report}`, shaForBroker, admission.result, {
        wallMs: gateWallMs(),
        checksMs: null,
        reused: true,
      });
      finalExit(
        admission.result === "PASS" || admission.result === "NA" ? 0 : 1,
        commentArgs.post,
        cached.posted,
      );
    }
    if ("report" in admission) {
      const retry = acquireFailedEvidenceRetryLease(
        brokerRoot,
        shaForBroker,
        config.scenario,
        baseForBroker,
        here,
        declaredCapabilities,
      );
      if (!retry) process.exit(3);
      if ("report" in retry) {
        writeLocalCache(shaForBroker, config.scenario, baseForBroker, retry);
        console.error(
          `ℹ retry target completed while waiting; reused shared ${config.scenario} evidence for ${shaForBroker.slice(0, 9)}.`,
        );
        const reused = provenanceNotice(retry, shaForBroker, brokerRecord);
        console.error(reused.trimEnd());
        const cached = deliver(`${reused}${retry.report}`, shaForBroker, retry.result, {
          wallMs: gateWallMs(),
          checksMs: null,
          reused: true,
        });
        finalExit(
          retry.result === "PASS" || retry.result === "NA" ? 0 : 1,
          commentArgs.post,
          cached.posted,
        );
      }
      lease = retry;
      console.error(
        `ℹ retrying cached ${admission.result} evidence for ${config.scenario}@${shaForBroker.slice(0, 9)} under a new shared lease.`,
      );
    } else {
      lease = admission;
    }
    // Dirty worktrees cannot publish evidence for their HEAD.  They still hold
    // the shared coordination lease while validating their own changes, which
    // preserves the established dirty-worktree workflow without reopening the
    // TOCTOU path to a private, concurrent local lease.
    if (!cleanAtAdmission) {
      console.error(
        `ℹ ${config.scenario}@${shaForBroker.slice(0, 9)} is dirty; running under the shared coordination lease without publishing reusable evidence.`,
      );
    }
  } else {
    lease = acquireLocalScenarioLease(config.scenario);
    if (!lease) process.exit(3);
  }

  const base = baseForBroker;
  const sha = head();
  const changedFiles = run(`git diff --name-only ${base}..HEAD 2>/dev/null`).out;
  const ctx: RunContext = { base, sha, changedFiles };

  const selected: CheckSpec[] = [];
  const gatedOff: string[] = [];
  for (const c of config.checks) {
    if (only && !only.has(c.id)) continue;
    if (skip?.has(c.id)) continue;
    // Naming a check in --only is an explicit request → bypass its `when` gate.
    // (A full, unscoped run still honors `when`, e.g. skills-only checks.)
    const explicit = only?.has(c.id) ?? false;
    if (!explicit && c.when && !c.when(ctx)) {
      gatedOff.push(c.id);
      continue;
    }
    selected.push(c);
  }
  if (gatedOff.length) console.error(`ℹ gated off by \`when\`: ${gatedOff.join(", ")}`);
  // An empty run means the gate verifies nothing — that must never pass silently.
  if (!selected.length) {
    console.error(
      "❌ no checks selected to run (empty --only, over-broad --skip, or all gated off).",
    );
    releaseScenarioLease(lease);
    process.exit(2);
  }

  const skipAfterFail = new Set(config.failFastSkip ?? []);
  const results: CheckResult[] = [];
  let blockingFailed = false;
  for (const c of selected) {
    if (blockingFailed && skipAfterFail.has(c.id)) {
      mkdirSync(".verify", { recursive: true });
      const logPath = `.verify/${sha}.${c.id}.log`;
      writeFileSync(logPath, "skipped after a blocking failure; this check did not run.\n");
      results.push({
        check: c.id,
        title: c.title ?? c.id,
        pass: true,
        blocking: c.blocking ?? true,
        skipped: "fail-fast: skipped after a blocking failure (#5223)",
        durationMs: 0,
        logPath,
      });
      console.error(`ℹ fail-fast: skipping ${c.id}`);
      continue;
    }
    // Guarded, not bare: a check that throws must yield a check-level UNKNOWN
    // rather than taking the whole run down with no CheckResult at all (#5591).
    const ran = persistCheckLog(sha, runCheckGuarded(c, ctx));
    results.push(ran);
    if (!isSkipped(ran) && ran.blocking && !ran.pass) blockingFailed = true;
  }

  const coverage: EvidenceCoverage = { fullScenario, checks: selected.map((c) => c.id) };
  // Disclosure, not key (#5386) — see `observedEnvGaps`. The identity was fixed before
  // the checks ran; what they reported about the environment travels ON the record.
  const envGaps = observedEnvGaps(results);
  const undeclaredGaps = undeclaredEnvGaps(envGaps, declaredCapabilities);
  // #5626 — the run's class, on the SAME footing as `envGaps`: derived from what the
  // checks reported, disclosed on the record, and read by no gate. It is computed
  // BEFORE attribution on purpose. `applyAttribution` changes the aggregate verdict
  // while leaving every red row red (§5.3), so the classes present are a statement
  // about the checks, not about the verdict the run ended up with — which is exactly
  // what makes the `ENV_GAP` + `PASS` pair expressible at all (§2.5).
  const failureClass = deriveRunClass(results);
  const checkFailures = checkFailuresOf(results);
  // arc#5534 / #5593 — ATTRIBUTION, not exemption. A red that is provably not
  // this change's own never made this change unverified, so the aggregate
  // verdict it should have had all along is PASS. `results` is NOT modified:
  // the foreign rows stay red in the table, and the notice below says so.
  // Restricted to a full scenario — a `--only` run cannot be a gate anyway, so
  // paying for a merge-base reproduction there would buy nothing.
  const attribution = applyAttribution(
    deriveResult(results),
    config.attribution,
    { argv, results, base, sha },
    fullScenario,
  );
  const derived = attribution.derived;
  const ok = derived === "PASS";
  // #5067 — DECISION, and why.
  //
  // The issue offered two fixes: (a) record coverage in the metadata and teach every
  // gate-token consumer to require it, or (b) stop writing PASS for a partial run. This
  // does BOTH, because they answer different halves.
  //
  // (a) alone leaves `.verify/<sha>.result` reading `PASS` for a two-check run. Any
  // consumer that reads only that file still launders it — `tools/pre-push.sh` literally
  // does (`[ "$RESULT" != "PASS" ]`), and so would every consumer written next year by
  // someone who never heard of the coverage field. A same-colored artifact with a
  // correction stored elsewhere is the exact shape of the bug being fixed.
  //
  // (b) alone throws away WHICH checks ran, so a refusal cannot say what it refused and
  // the diagnostic artifact (arm 3 / PR #3062) cannot describe itself.
  //
  // So: coverage lives in the metadata AND a green partial run is stamped `PARTIAL`.
  // `PARTIAL` fails closed for free in every existing consumer — `requireStickyGate`
  // accepts only {PASS, NA}, `--deliver-cached` exits non-zero on anything else,
  // pre-push compares against PASS/NA — exactly the property `BLOCKED`/`TIMEOUT` already
  // rely on. Only a GREEN partial is demoted: a red partial stays FAIL/TIMEOUT, which is
  // already non-green and carries the diagnostic semantics #3062 depends on.
  //
  // The exit code is deliberately NOT touched: `--only` is the sanctioned way to debug
  // one failing check, and making that exit non-zero would break the workflow that
  // pushes people toward it. What changes is only that its PASS stops being a token.
  const result: VerifyResult = fullScenario || derived !== "PASS" ? derived : "PARTIAL";
  const partialNotice = fullScenario
    ? undefined
    : `> ⚠️ **PARTIAL VERIFICATION — NOT A GATE.** ${selected.length} of ${config.checks.length} checks ran (\`${coverage.checks.join("`, `")}\`). ` +
      "The rest were never executed, so this report cannot satisfy the pre-push or merge gate. It is a diagnostic artifact.";
  // Measured ONCE and shared by the report line and the history row, so the two
  // can never disagree. Taken here rather than after delivery on purpose: the
  // gate's work ends when the report exists — posting the comment is what
  // happens to the result afterwards, and folding `gh` latency into "how long
  // did verification take" would make the number unusable for comparing rounds.
  const wallMs = gateWallMs();
  const checksMs = results.reduce((a, r) => a + (r.durationMs ?? 0), 0);
  // Read AFTER the checks ran: a sibling location may have published while this gate was
  // running, and this report should state what was true where and when it was produced.
  const siblings = brokerCoordination
    ? otherLocationRecords(brokerCoordination, here, declaredCapabilities)
    : [];
  const elsewhere = divergenceNotice(siblings.filter((s) => !sameLocation(s.location, here)));
  const envDrift = capabilityDriftNotice(siblings, here, declaredCapabilities);
  if (envDrift) console.error(envDrift);
  const undeclared = undeclaredEnvGapNotice(undeclaredGaps);
  if (undeclared) console.error(undeclared);
  const notice =
    [partialNotice, envDrift, undeclared, elsewhere, attribution.notice]
      .filter(Boolean)
      .join("\n\n") || undefined;
  const report = renderReport(results, {
    scenario: config.scenario,
    base,
    sha,
    identity,
    origin: originNotice(here, config.scenario, base),
    notice,
    wallMs,
  });

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ scenario: config.scenario, base, sha, results }, null, 2));
  } else {
    // Plain stdout carries the upsert marker so a gh-less agent can paste it via
    // MCP and a later run can still find/upsert it.
    console.log(stickyBody(report, sha, result));
  }
  const delivery = deliver(report, sha, result, { wallMs, checksMs });

  // Cache a PASS for the pre-push gate — only when the tree is clean, so the
  // cached sha matches exactly what was verified.
  //
  // A FAIL is cached too, and unconditionally: it is a DIAGNOSTIC artifact, not a
  // gate token (`.result` says FAIL, and every consumer — pre-push, merge-gate,
  // --deliver-cached — requires PASS/NA). Without it the failure output could be
  // lost outright: when a report is too big for the PR comment, `postComment`
  // strips the Full Logs section and points the reader at this very file
  // (`trimFullLogsSection`), which under the old PASS-only rule was never written
  // on the one run that needed it. Real loss, arc PR #3062.
  // The runner's own lease/report artifacts live under `.verify/`; they must
  // not make an otherwise clean commit ineligible for a same-SHA PASS cache.
  const cleanAtCompletion = cleanForEvidence();
  if (ok ? cleanAtAdmission && cleanAtCompletion : true) {
    mkdirSync(".verify", { recursive: true });
    // A partial run still lands here — deliberately. It is the diagnostic artifact, and
    // deleting it to fix #5067 would re-run the real log loss of PR #3062. What stops it
    // being a gate is its `result` (PARTIAL) and its coverage metadata, not its absence.
    writeLocalCache(sha, config.scenario, base, {
      report,
      result,
      coverage,
      location: here,
      capabilities: declaredCapabilities,
      envGaps,
      failureClass,
      checkFailures,
    });
  }
  // A shared record is only committed for an unscoped, clean checkout.  A
  // partial `--only` run can never satisfy the full merge gate, and a dirty
  // tree can never prove the commit named by its HEAD.
  //
  // …and neither can a run an environment gap helped decide (#5386). Disclosure alone
  // was not enough: the notice is prose, while `requireStickyGate` parses `result=`
  // (`gate.ts:115`), so a host that HAS the capability would inherit — and the merge
  // gate, `pre-push` and `--deliver-cached` would all accept — a green this gate never
  // measured there. A gate must not report a colour it did not measure.
  //
  // This is a PUBLISH-time decision, not an identity input, so it does not contradict
  // "an identity must be computable before the run": the answer is known exactly when
  // it is needed. The in-file precedent is the dirty tree a few lines above — run under
  // the shared lease, publish nothing reusable.
  //
  // The price is real and one-sided: a gapped host loses reuse and re-runs every time.
  // A host missing a capability its own checks need is by definition an unhealthy host,
  // and losing reuse there is the cheaper half of the trade. The LOCAL cache above is
  // deliberately still written — that is this host's own answer for its own push gate,
  // and withholding it is what livelocked `pre-push` (#5600 round 1).
  const publishable = fullScenario && cleanAtAdmission && cleanAtCompletion;
  if (publishable && envGaps.length) {
    console.error(
      `ℹ ${config.scenario}@${sha.slice(0, 9)} reported environment gap(s) ${envGaps.join(", ")}; ` +
        "running under the shared coordination lease without publishing reusable evidence. " +
        "Declare them in `capabilities` to make this answer reusable within that environment.",
    );
  }
  if (publishable && !envGaps.length) {
    publishSharedEvidence(lease, {
      report,
      result,
      coverage,
      location: here,
      capabilities: declaredCapabilities,
      envGaps,
      failureClass,
      checkFailures,
    });
  }

  // `ok`, not `exitCode(results)`: the two are identical for every run that is
  // not attributed (`deriveResult` returns PASS exactly when `passed()` does),
  // and an attributed run must exit 0 or the PASS it just produced would be
  // contradicted one line later.
  finalExit(ok ? 0 : 1, commentArgs.post, delivery.posted);
}
