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
 *   --only a,b,c           run only these check ids (unknown id → hard error)
 *   --skip x,y             run all but these check ids
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type CommentArgs,
  deliverComment,
  parseCommentArgs,
  stickyBody,
  type VerifyResult,
} from "./comment.ts";
import {
  type CheckResult,
  deriveResult,
  exitCode,
  head,
  mergeBase,
  renderReport,
  run,
  tail,
} from "./report.ts";

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
  /** optional provenance header line(s); repo computes it (arc: agent-identity.sh) */
  identity?: (label: string) => string;
  /**
   * Override how the affected-detection base is computed. Default is
   * merge-base(baseBranch, HEAD) (pre-pr). pre-merge overrides this to the
   * `origin/main` TIP so it catches breakage from siblings merged since the PR
   * opened (issue #655).
   */
  resolveBase?: () => string;
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
  writeLocalCache(sha, scenario, base, { report, result: "NA" });
  return report;
}

interface ScenarioLease {
  path: string;
  /** Shared leases own a SHA-scoped broker record, local ones only a worktree lock. */
  shared?: { dir: string; sha: string; scenario: string; base: string };
}

interface SharedEvidence {
  schemaVersion: 1;
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
      metadata.schemaVersion !== 1 ||
      metadata.scenario !== scenario ||
      metadata.sha !== sha ||
      metadata.base !== base ||
      metadata.sourceHead !== sha ||
      metadata.sourceClean !== true ||
      metadata.result !== result ||
      !["PASS", "NA", "FAIL", "TIMEOUT"].includes(result)
    ) {
      return undefined;
    }
    return { report: readFileSync(reportPath, "utf8"), result };
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
    `${JSON.stringify({ schemaVersion: 1, sha, scenario, base })}\n`,
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
      metadata.schemaVersion !== 1 ||
      metadata.sha !== sha ||
      metadata.scenario !== scenario ||
      metadata.base !== base ||
      !["PASS", "NA", "FAIL", "TIMEOUT"].includes(result)
    ) {
      return undefined;
    }
    return { report: readFileSync(reportFile, "utf8"), result };
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

function publishSharedEvidence(lease: ScenarioLease | undefined, cached: CachedEvidence): void {
  if (!lease?.shared) return;
  const { dir, sha, scenario, base } = lease.shared;
  writeAtomic(`${dir}/report.md`, cached.report);
  writeAtomic(`${dir}/result`, `${cached.result}\n`);
  const metadata: SharedEvidence = {
    schemaVersion: 1,
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
  const commentArgs: CommentArgs = parseCommentArgs(argv);
  const identity = config.identity?.("Verification") ?? "";
  const only = parseSelect(argv, "--only");
  const skip = parseSelect(argv, "--skip");
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
    const report = writeNa(config.scenario, reason, sha, base, identity);
    console.log(`✅ N/A exemption written to .verify/${sha.slice(0, 9)}.md`);
    const na = commentArgs.post ? deliverComment(commentArgs, report, sha, "NA") : { posted: true };
    if (!commentArgs.post) console.log(stickyBody(report, sha, "NA"));
    finalExit(0, commentArgs.post, na.posted);
  }

  // --deliver-cached: post the cached report for HEAD without re-running.
  if (argv.includes("--deliver-cached")) {
    const sha = head();
    const base = config.resolveBase ? config.resolveBase() : mergeBase(config.baseBranch);
    let cached = readLocalCache(sha, config.scenario, base);
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
      console.error(
        `--deliver-cached: no current ${config.scenario} cache for ${sha.slice(0, 9)} at base ${base.slice(0, 9)}. Run the scenario first.`,
      );
      process.exit(1);
    }
    const delivery = deliverComment(commentArgs, cached.report, sha, cached.result);
    // Diagnostics are reusable, but only PASS/NA are gate tokens.
    finalExit(
      cached.result === "PASS" || cached.result === "NA" ? 0 : 1,
      commentArgs.post,
      delivery.posted,
    );
  }

  const fullScenario = !only && !skip;
  const shaForBroker = head();
  // The base is verification input, not just report decoration. In particular
  // pre-merge resolves origin/main at execution time, so a sibling merge must
  // create a new verification identity even while the PR head stays unchanged.
  const baseForBroker = config.resolveBase ? config.resolveBase() : mergeBase(config.baseBranch);
  const cleanAtAdmission = cleanForEvidence();
  const root = fullScenario && cleanAtAdmission ? sharedRoot() : undefined;
  if (root) {
    const admission = acquireSharedScenarioLease(
      root,
      shaForBroker,
      config.scenario,
      baseForBroker,
    );
    if (!admission) process.exit(3);
    if ("report" in admission) {
      writeLocalCache(shaForBroker, config.scenario, baseForBroker, admission);
      console.error(
        `ℹ reused shared ${config.scenario} evidence for ${shaForBroker.slice(0, 9)}; no duplicate gate started.`,
      );
      const cached = deliverComment(commentArgs, admission.report, shaForBroker, admission.result);
      finalExit(
        admission.result === "PASS" || admission.result === "NA" ? 0 : 1,
        commentArgs.post,
        cached.posted,
      );
    }
    lease = admission;
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

  const results: CheckResult[] = selected.map((c) => c.run(ctx));

  const result: VerifyResult = deriveResult(results);
  const ok = result === "PASS";
  const report = renderReport(results, { scenario: config.scenario, base, sha, identity });

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ scenario: config.scenario, base, sha, results }, null, 2));
  } else {
    // Plain stdout carries the upsert marker so a gh-less agent can paste it via
    // MCP and a later run can still find/upsert it.
    console.log(stickyBody(report, sha, result));
  }
  const delivery = deliverComment(commentArgs, report, sha, result);

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
  if (ok ? cleanAtCompletion : true) {
    mkdirSync(".verify", { recursive: true });
    writeLocalCache(sha, config.scenario, base, { report, result });
  }
  // A shared record is only committed for an unscoped, clean checkout.  A
  // partial `--only` run can never satisfy the full merge gate, and a dirty
  // tree can never prove the commit named by its HEAD.
  if (fullScenario && cleanAtCompletion) {
    publishSharedEvidence(lease, { report, result });
  }

  finalExit(exitCode(results), commentArgs.post, delivery.posted);
}
