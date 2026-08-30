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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type CommentArgs,
  deliverComment,
  MARKER_PREFIX,
  parseCommentArgs,
  type RunMeta,
  stickyBody,
  type VerifyResult,
} from "./comment.ts";
import {
  type CheckResult,
  deriveResult,
  exitCode,
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
  /**
   * Explicit PR number from `--comment <pr#>` / `--comment=<pr#>`, when given.
   * A check that needs the PR the run is FOR (e.g. to fetch its body) must use
   * this rather than shelling out to `gh pr view` on the current branch — that
   * falls back to branch-name lookup, which is undefined in a detached-HEAD
   * worktree and silently wrong when HEAD sits on a shared checkout that isn't
   * the PR's branch (aside#1002: both cases delivered a false FAIL that
   * overwrote a correct sticky PASS on the PR).
   */
  pr?: string;
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
): string {
  const naBody = `## Verification Report — \`${scenario}\` N/A\n\n**Reason**: ${reason}\n\n*This PR is exempt from automated TS verification.*\n\n<sub>Exemption written by the agentloop verification engine via \`--na\`.</sub>`;
  // Identity header (#1347/#1776), same placement as renderReport's normal path —
  // prepended into the report body so it lands after the sticky marker line,
  // keeping the marker on line 1 for merge-gate.ts's startswith lookup.
  const report = identity ? `${identity}\n\n${naBody}` : naBody;
  // An exemption is a statement about the WHOLE scenario ("no TS to run here"), not a
  // scoped subset — so it is full coverage over an empty executed set (#5067).
  writeLocalCache(sha, scenario, base, { report, result: "NA", coverage: FULL_COVERAGE([]) });
  return report;
}

interface ScenarioLease {
  path: string;
  /** Shared leases own a SHA-scoped broker record, local ones only a worktree lock. */
  shared?: { dir: string; sha: string; scenario: string; base: string };
}

/**
 * Bumped 1 → 2 for #5067's coverage fields. Every reader already rejects a record whose
 * `schemaVersion` is not the one it expects, so the bump makes pre-#5067 records — which
 * cannot say what they covered — expire instead of being read as full gates by default.
 */
const EVIDENCE_SCHEMA_VERSION = 2;

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
  sourceWorktree: string;
  sourceHead: string;
  sourceClean: true;
  completedAt: string;
}

interface CachedEvidence {
  report: string;
  result: VerifyResult;
  coverage: EvidenceCoverage;
  /** worktree that produced it, when known (shared broker records carry it). */
  sourceWorktree?: string;
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
function sharedRoot(): string | undefined {
  const override = process.env.AGENTLOOP_VERIFICATION_STATE_DIR?.trim();
  if (override) return resolve(override);
  const common = gitCommonDir();
  return common ? resolve(common, "agentloop", "verification") : undefined;
}

function sharedDir(root: string, sha: string, scenario: string, base: string): string {
  return resolve(root, sha, safeScenario(scenario), safeScenario(base));
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
      mkdirSync(path);
      writeFileSync(
        `${path}/owner.json`,
        `${JSON.stringify({ pid: process.pid, scenario, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return { path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readOwnerPid(path);
      // `mkdir` makes the lock visible before its owner metadata is written.
      // Treat a missing or malformed owner record as an active, ambiguous lock:
      // another runner may be between those two operations. Reclaiming it here
      // would admit duplicate gates precisely during the acquisition race.
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
      // this scenario's own lock directory, then retry its atomic mkdir once.
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
): CachedEvidence | undefined {
  const metadataPath = `${dir}/metadata.json`;
  const reportPath = `${dir}/report.md`;
  const resultPath = `${dir}/result`;
  if (!existsSync(metadataPath) || !existsSync(reportPath) || !existsSync(resultPath))
    return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<SharedEvidence>;
    const result = readFileSync(resultPath, "utf8").trim() as VerifyResult;
    if (
      metadata.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      metadata.scenario !== scenario ||
      metadata.sha !== sha ||
      metadata.base !== base ||
      metadata.sourceHead !== sha ||
      metadata.sourceClean !== true ||
      metadata.result !== result ||
      !isCoverage(metadata) ||
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
      sourceWorktree:
        typeof metadata.sourceWorktree === "string" ? metadata.sourceWorktree : undefined,
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
    })}\n`,
  );
}

function readLocalCache(sha: string, scenario: string, base: string): CachedEvidence | undefined {
  const reportFile = `.verify/${sha}.md`;
  const resultFile = `.verify/${sha}.result`;
  const metadataFile = `.verify/${sha}.metadata.json`;
  if (!existsSync(reportFile) || !existsSync(resultFile) || !existsSync(metadataFile))
    return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as Partial<SharedEvidence>;
    const result = readFileSync(resultFile, "utf8").trim() as VerifyResult;
    if (
      metadata.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      metadata.sha !== sha ||
      metadata.scenario !== scenario ||
      metadata.base !== base ||
      !isCoverage(metadata) ||
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
): ScenarioLease | CachedEvidence | undefined {
  const dir = sharedDir(root, sha, scenario, base);
  const lock = `${dir}/lease.lock`;
  const deadline = Date.now() + sharedWaitMs();
  mkdirSync(dir, { recursive: true });

  for (;;) {
    const cached = readSharedEvidence(dir, sha, scenario, base);
    if (cached) return cached;
    try {
      mkdirSync(lock);
      writeFileSync(
        `${lock}/owner.json`,
        `${JSON.stringify({ pid: process.pid, scenario, sha, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      // A completed writer may have released immediately before our mkdir.
      // Re-check while holding the lock; if so we only reuse it and do not run.
      const completed = readSharedEvidence(dir, sha, scenario, base);
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
          `❌ ${scenario}@${sha.slice(0, 9)} has incomplete shared verification evidence; refusing to overwrite it with a duplicate gate.`,
        );
        return undefined;
      }
      return { path: lock, shared: { dir, sha, scenario, base } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readOwnerPid(lock);
      // mkdir precedes owner.json.  A missing/malformed owner is ambiguous and
      // therefore fail-closed: deleting it would reopen the duplicate-gate race.
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
): ScenarioLease | CachedEvidence | undefined {
  const dir = sharedDir(root, sha, scenario, base);
  const lock = `${dir}/lease.lock`;
  const deadline = Date.now() + sharedWaitMs();
  mkdirSync(dir, { recursive: true });

  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(
        `${lock}/owner.json`,
        `${JSON.stringify({ pid: process.pid, scenario, sha, retryFailed: true, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      const cached = readSharedEvidence(dir, sha, scenario, base);
      if (!cached) {
        if (hasPartialSharedEvidence(dir)) {
          rmSync(lock, { recursive: true, force: true });
          console.error(
            `❌ ${scenario}@${sha.slice(0, 9)} has incomplete shared verification evidence; refusing retry overwrite.`,
          );
          return undefined;
        }
        return { path: lock, shared: { dir, sha, scenario, base } };
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
      return { path: lock, shared: { dir, sha, scenario, base } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
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

function publishSharedEvidence(lease: ScenarioLease | undefined, cached: CachedEvidence): void {
  if (!lease?.shared) return;
  const { dir, sha, scenario, base } = lease.shared;
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
    sourceWorktree: process.cwd(),
    sourceHead: sha,
    sourceClean: true,
    completedAt: new Date().toISOString(),
  };
  // Metadata is the commit point: consumers ignore partial report/result files
  // until this SHA-, scenario-, and clean-state-bound record appears.
  writeAtomic(`${dir}/metadata.json`, `${JSON.stringify(metadata)}\n`);
}

/**
 * #5060, second half: the broker single-flights on (sha, scenario, base), so a delivered
 * report may be ANOTHER checkout's run — the `reused shared evidence` line says so on
 * stderr, where nobody reading the PR will ever see it. The merge gate is fail-closed on
 * the sha either way; this is about what a human reads, so the report itself says whose
 * run it is rather than implying it was produced by the run that delivered it.
 *
 * #5223: same-checkout reuse must also be a different color from "this invocation
 * actually ran". Silent same-checkout reuse is how an agent burns three full
 * wall-clock waits thinking it re-ran. Cross-checkout still names the other tree;
 * same-checkout names both cache locations so deleting one is not enough.
 */
function provenanceNotice(cached: CachedEvidence): string {
  const from = cached.sourceWorktree;
  if (from && from !== process.cwd()) {
    return `> ℹ **Reused evidence** — produced by another checkout (\`${from}\`) for this same commit, not by the run that delivered it.\n\n`;
  }
  return (
    "> ℹ **Reused evidence** — produced by an earlier run for this same commit, not by this invocation. " +
    "To force a real re-run, delete both `.verify/<sha>.*` and `.git/agentloop/verification/<sha>`.\n\n"
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
  const only = parseSelect(argv, "--only");
  const skip = parseSelect(argv, "--skip");
  const retryFailed = argv.includes("--retry-failed");
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
    const report = writeNa(config.scenario, reason, sha, base, identity);
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
    let cached = readLocalCache(sha, config.scenario, base);
    // #5067: `--deliver-cached` used to validate IDENTITY only (HEAD + scenario +
    // resolved base), which is why it could not stop a `--only` PASS from satisfying
    // the push gate. A partial record stays on disk and stays readable — it is just no
    // longer a token. Set aside, not discarded, so the refusal can name what did run.
    const partial = cached && !cached.coverage.fullScenario ? cached : undefined;
    if (partial) cached = undefined;
    if (!cached) {
      const root = sharedRoot();
      const shared = root
        ? readSharedEvidence(
            sharedDir(root, sha, config.scenario, base),
            sha,
            config.scenario,
            base,
          )
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
    const reused = provenanceNotice(cached);
    if (reused) console.error(reused.trimEnd());
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
    );
    if (!admission) process.exit(3);
    if ("report" in admission && !(retryFailed && ["FAIL", "TIMEOUT"].includes(admission.result))) {
      writeLocalCache(shaForBroker, config.scenario, baseForBroker, admission);
      console.error(
        `ℹ reused shared ${config.scenario} evidence for ${shaForBroker.slice(0, 9)}; no duplicate gate started.`,
      );
      const reused = provenanceNotice(admission);
      if (reused) console.error(reused.trimEnd());
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
      );
      if (!retry) process.exit(3);
      if ("report" in retry) {
        writeLocalCache(shaForBroker, config.scenario, baseForBroker, retry);
        console.error(
          `ℹ retry target completed while waiting; reused shared ${config.scenario} evidence for ${shaForBroker.slice(0, 9)}.`,
        );
        const reused = provenanceNotice(retry);
        if (reused) console.error(reused.trimEnd());
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
  const ctx: RunContext = { base, sha, changedFiles, pr: commentArgs.pr };

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
    const ran = persistCheckLog(sha, c.run(ctx));
    results.push(ran);
    if (!isSkipped(ran) && ran.blocking && !ran.pass) blockingFailed = true;
  }

  const coverage: EvidenceCoverage = { fullScenario, checks: selected.map((c) => c.id) };
  const derived = deriveResult(results);
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
  const notice = fullScenario
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
  const report = renderReport(results, {
    scenario: config.scenario,
    base,
    sha,
    identity,
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
    writeLocalCache(sha, config.scenario, base, { report, result, coverage });
  }
  // A shared record is only committed for an unscoped, clean checkout.  A
  // partial `--only` run can never satisfy the full merge gate, and a dirty
  // tree can never prove the commit named by its HEAD.
  if (fullScenario && cleanAtAdmission && cleanAtCompletion) {
    publishSharedEvidence(lease, { report, result, coverage });
  }

  finalExit(exitCode(results), commentArgs.post, delivery.posted);
}
