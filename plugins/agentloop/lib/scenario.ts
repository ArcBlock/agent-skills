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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type CommentArgs,
  deliverComment,
  parseCommentArgs,
  stickyBody,
  type VerifyResult,
} from "./comment.ts";
import {
  type CheckResult,
  exitCode,
  head,
  mergeBase,
  passed,
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

function writeNa(scenario: string, reason: string, sha: string, identity: string): string {
  const naBody = `## Verification Report — \`${scenario}\` N/A\n\n**Reason**: ${reason}\n\n*This PR is exempt from automated TS verification.*\n\n<sub>Exemption written by the agentloop verification engine via \`--na\`.</sub>`;
  // Identity header (#1347/#1776), same placement as renderReport's normal path —
  // prepended into the report body so it lands after the sticky marker line,
  // keeping the marker on line 1 for merge-gate.ts's startswith lookup.
  const report = identity ? `${identity}\n\n${naBody}` : naBody;
  mkdirSync(".verify", { recursive: true });
  writeFileSync(`.verify/${sha}.md`, report, "utf8");
  writeFileSync(`.verify/${sha}.result`, "NA", "utf8");
  return report;
}

/**
 * Run a scenario end-to-end and exit the process with the gate code. This is the
 * single entrypoint a repo's thin scenario script (e.g. `.claude/verify/pre-pr.ts`)
 * calls: `runScenario(config, process.argv)`.
 */
export function runScenario(config: ScenarioConfig, argv: string[]): never {
  const commentArgs: CommentArgs = parseCommentArgs(argv);
  const identity = config.identity?.("Verification") ?? "";

  // Exit code that also surfaces a DELIVERY failure. A gate that verified fine but whose
  // report was requested (--comment/--post) and never posted must not exit 0 — a caller
  // checking only the exit code would read "verified but report never delivered" as full
  // success. Verify-failure codes always dominate (the verify result is the primary signal).
  const finalExit = (verifyCode: number, post: boolean, delivered: boolean): never => {
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
    const reason = argv[naIdx + 1] ?? "no reason given";
    const sha = head();
    const report = writeNa(config.scenario, reason, sha, identity);
    console.log(`✅ N/A exemption written to .verify/${sha.slice(0, 9)}.md`);
    const na = commentArgs.post ? deliverComment(commentArgs, report, sha, "NA") : { posted: true };
    if (!commentArgs.post) console.log(stickyBody(report, sha, "NA"));
    finalExit(0, commentArgs.post, na.posted);
  }

  // --deliver-cached: post the cached report for HEAD without re-running.
  if (argv.includes("--deliver-cached")) {
    const sha = head();
    const reportFile = `.verify/${sha}.md`;
    const resultFile = `.verify/${sha}.result`;
    if (!existsSync(reportFile)) {
      console.error(`--deliver-cached: no cache at ${reportFile}. Run the scenario first.`);
      process.exit(1);
    }
    const report = readFileSync(reportFile, "utf8");
    const result: VerifyResult = existsSync(resultFile)
      ? (readFileSync(resultFile, "utf8").trim() as VerifyResult)
      : "PASS";
    const cached = deliverComment(commentArgs, report, sha, result);
    finalExit(0, commentArgs.post, cached.posted);
  }

  const base = config.resolveBase ? config.resolveBase() : mergeBase(config.baseBranch);
  const sha = head();
  const changedFiles = run(`git diff --name-only ${base}..HEAD 2>/dev/null`).out;
  const ctx: RunContext = { base, sha, changedFiles };

  // Select checks: --only / --skip by id, then `when` gates.
  const only = parseSelect(argv, "--only");
  const skip = parseSelect(argv, "--skip");
  const known = new Set(config.checks.map((c) => c.id));
  // Unknown --only/--skip id is almost always a typo. Fail LOUD — never silently
  // run zero (or the wrong) checks. This is the silent-scope-reduction class.
  for (const id of [...(only ?? []), ...(skip ?? [])]) {
    if (!known.has(id)) {
      console.error(
        `❌ unknown check id "${id}" in --only/--skip. Known: ${[...known].join(", ")}`,
      );
      process.exit(2);
    }
  }

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
    process.exit(2);
  }

  const results: CheckResult[] = selected.map((c) => c.run(ctx));

  const ok = passed(results);
  const result: VerifyResult = ok ? "PASS" : "FAIL";
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
  if (ok) {
    const dirty = run("git status --porcelain").out.trim();
    if (!dirty) {
      mkdirSync(".verify", { recursive: true });
      writeFileSync(`.verify/${sha}.md`, report, "utf8");
      writeFileSync(`.verify/${sha}.result`, "PASS", "utf8");
    }
  }

  finalExit(exitCode(results), commentArgs.post, delivery.posted);
}
