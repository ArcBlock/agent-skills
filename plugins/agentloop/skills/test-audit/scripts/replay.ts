#!/usr/bin/env bun
/**
 * test-audit replay — calibrate the diff rules against REAL merged history.
 *
 *   bun replay.ts [--limit 200] [--rule <id>] [--verbose]
 *
 * ## Why this exists
 *
 * A diff rule's only honest metrics are: does it catch real defects, how often
 * does it fire on legitimate work, and what does it cost. None of those can be
 * answered by fixtures — fixtures prove the rule does what its author meant,
 * not that what its author meant is useful on this repo's actual commits.
 *
 * Replay walks commits that touched test files, feeds each one's (parent, head)
 * pair through the same code path the PR gate uses, and reports what the gate
 * WOULD have done. Every `block` it reports on a commit that shipped fine is a
 * false positive you would have paid for; the total wall-clock is the tax the
 * gate adds to every PR.
 *
 * Run this BEFORE turning a rule's severity to `block` in a repo's adapter, and
 * re-run it when a rule changes. A rule that blocks a meaningful fraction of
 * legitimate history is not ready, no matter how clean its fixtures are.
 */
import type { Adapter } from "./adapter.ts";
import { loadAdapter } from "./audit.ts";
import { scanDiffFile } from "./diff.ts";
import type { Finding } from "./rules.ts";

function git(args: string[], cwd: string): { out: string; ok: boolean } {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  return { out: new TextDecoder().decode(r.stdout), ok: r.exitCode === 0 };
}

function show(cwd: string, rev: string, file: string): string | null {
  const r = git(["show", `${rev}:${file}`], cwd);
  return r.ok ? r.out : null;
}

export interface CommitResult {
  sha: string;
  subject: string;
  changedTestFiles: number;
  findings: Finding[];
}

export function replay(adapter: Adapter, limit: number): CommitResult[] {
  const log = git(
    ["log", "--no-merges", `-n${limit}`, "--format=%H%x00%s", "--", "*.test.ts", "*.test.tsx"],
    adapter.root,
  ).out;

  const results: CommitResult[] = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha = "", subject = ""] = line.split("\0");
    const files = git(
      ["diff", "--name-only", `${sha}^`, sha, "--", "*.test.ts", "*.test.tsx"],
      adapter.root,
    )
      .out.split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((f) => !(adapter.excludes ?? []).some((x) => f.includes(x)));

    const findings: Finding[] = [];
    for (const file of files) {
      findings.push(
        ...scanDiffFile(
          file,
          show(adapter.root, `${sha}^`, file),
          show(adapter.root, sha, file),
          adapter,
        ),
      );
    }
    results.push({ sha, subject, changedTestFiles: files.length, findings });
  }
  return results;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const limit = Number(value("limit") ?? 200);
  const onlyRule = value("rule");
  const verbose = argv.includes("--verbose");

  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).out.trim();
  const adapter = await loadAdapter(root, value("config"));

  const t0 = Date.now();
  let results = replay(adapter, limit);
  const elapsed = Date.now() - t0;

  if (onlyRule) {
    results = results.map((r) => ({
      ...r,
      findings: r.findings.filter((f) => f.rule === onlyRule),
    }));
  }

  const withFiles = results.filter((r) => r.changedTestFiles > 0);
  const blocked = results.filter((r) => r.findings.some((f) => f.severity === "block"));
  const flagged = results.filter((r) => r.findings.length > 0);
  const byRule = new Map<string, number>();
  for (const r of results)
    for (const f of r.findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);

  console.log(`test-audit replay — ${results.length} commits touching test files`);
  console.log(`  commits with ≥1 finding : ${flagged.length}`);
  console.log(
    `  commits the gate WOULD BLOCK: ${blocked.length}  (${((blocked.length / Math.max(withFiles.length, 1)) * 100).toFixed(1)}% of test-touching commits)`,
  );
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`    ${rule}: ${n}`);
  console.log(
    `  cost: ${elapsed}ms total, ${(elapsed / Math.max(results.length, 1)).toFixed(1)}ms per commit`,
  );

  if (verbose) {
    console.log("");
    for (const r of flagged) {
      console.log(`── ${r.sha.slice(0, 9)}  ${r.subject}`);
      for (const f of r.findings) {
        console.log(`   [${f.severity}] ${f.rule}  ${f.file}:${f.line}`);
        console.log(`      ${f.message}`);
        console.log(`      witness: ${f.witness}`);
      }
    }
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
