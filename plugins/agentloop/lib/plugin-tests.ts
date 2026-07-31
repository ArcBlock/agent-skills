#!/usr/bin/env bun
/**
 * plugin-tests — run a Claude-Code plugin's OWN test suite as a verification check.
 *
 * Why this exists (issue #2643): a plugin checked into `.claude/plugins/<name>/`
 * is not a workspace package, so turbo's affected-detection finds nothing for it.
 * A PR touching only plugin sources therefore got `Type check tasks=0` + a
 * stats-less `Tests ✅` and an **Overall PASS with zero tests run** — a red plugin
 * suite could ride into `main` behind a green gate. The gate's whole value is that
 * the numbers are measured, not asserted; here it was measuring nothing.
 *
 * Generic by construction (plugin CLAUDE.md's generic/per-repo split): nothing
 * here knows about arc, agentloop, or which directories a given plugin uses. It
 * derives the plugin roots from the diff, discovers each one's test directories
 * from the files actually on disk, and runs `bun test <dirs>` from the plugin
 * root — the same command the plugin's own CLAUDE.md prescribes as its self-test
 * discipline. The consuming repo supplies only the wiring (which scenarios get
 * the check, and its `when` gate) in `.claude/verify/config.ts`.
 */
import { type CheckResult, run, tail } from "./report.ts";

/** Directory prefix a plugin checkout lives under, relative to the repo root. */
const PLUGIN_PREFIX = ".claude/plugins/";

export interface PluginTestsOptions {
  /** newline-joined `git diff --name-only base..HEAD` output */
  changedFiles: string;
  /** repo root; defaults to the current git toplevel */
  repoRoot?: string;
  /** injectable command runner (tests substitute a fake; default is report.run) */
  exec?: (cmd: string, cwd: string) => { code: number; out: string };
  /** per-plugin timeout in ms (default 10 min) */
  timeoutMs?: number;
}

/** Per-plugin outcome, exported for tests and for callers that want the detail. */
export interface PluginTestRun {
  /** plugin directory relative to the repo root, e.g. `.claude/plugins/agentloop` */
  plugin: string;
  /** test directories handed to `bun test`, relative to the plugin root */
  dirs: string[];
  code: number;
  pass: number;
  fail: number;
  out: string;
}

/**
 * Plugin roots touched by the diff: `.claude/plugins/<name>/…` → `.claude/plugins/<name>`.
 * A change to `.claude/plugins/README.md` (no plugin segment) matches nothing —
 * it belongs to no plugin, so there is no suite to run for it.
 */
export function touchedPluginRoots(changedFiles: string): string[] {
  const roots = new Set<string>();
  for (const line of changedFiles.split("\n")) {
    const file = line.trim();
    if (!file.startsWith(PLUGIN_PREFIX)) continue;
    const rest = file.slice(PLUGIN_PREFIX.length);
    const name = rest.split("/")[0];
    if (!name || !rest.includes("/")) continue;
    roots.add(`${PLUGIN_PREFIX}${name}`);
  }
  return [...roots].sort();
}

/**
 * Collapse discovered test directories to a minimal set: drop any directory that
 * is already covered by an ancestor, because `bun test <dir>` recurses. Without
 * this, `skills/x/test` and `skills/x/test/golden` would both be passed and every
 * test under the nested one would run — and be counted — twice.
 */
export function minimalDirs(dirs: string[]): string[] {
  const sorted = [...new Set(dirs)].sort();
  const kept: string[] = [];
  for (const dir of sorted) {
    if (kept.some((k) => dir === k || dir.startsWith(`${k}/`))) continue;
    kept.push(dir);
  }
  return kept;
}

/** Directories under `root` that directly contain at least one `*.test.ts`. */
export function discoverTestDirs(
  root: string,
  exec: (cmd: string, cwd: string) => { code: number; out: string },
): string[] {
  const { out } = exec(
    `find . -name '*.test.ts' -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`,
    root,
  );
  const dirs = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((f) => {
      const rel = f.replace(/^\.\//, "");
      const slash = rel.lastIndexOf("/");
      return slash === -1 ? "." : rel.slice(0, slash);
    });
  return minimalDirs(dirs);
}

/**
 * `bun test` summary counts. Both lines are always emitted by bun (` 334 pass` /
 * ` 0 fail`), but a crashed run (e.g. a syntax error in a test file) prints
 * neither — so a missing count is reported as -1 rather than silently 0, which
 * would read as "nothing failed".
 */
export function parseBunCounts(out: string): { pass: number; fail: number } {
  const pass = out.match(/^\s*(\d+)\s+pass\s*$/m);
  const fail = out.match(/^\s*(\d+)\s+fail\s*$/m);
  return {
    pass: pass ? Number(pass[1]) : -1,
    fail: fail ? Number(fail[1]) : -1,
  };
}

export function runPluginTests(opts: PluginTestsOptions): PluginTestRun[] {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const exec =
    opts.exec ??
    ((cmd: string, cwd: string) => {
      const r = run(`cd ${JSON.stringify(cwd)} && ${cmd}`, {}, undefined, timeoutMs);
      return { code: r.code, out: r.out };
    });
  const repoRoot = opts.repoRoot ?? run("git rev-parse --show-toplevel").out.trim();

  const results: PluginTestRun[] = [];
  for (const plugin of touchedPluginRoots(opts.changedFiles)) {
    const abs = `${repoRoot}/${plugin}`;
    const dirs = discoverTestDirs(abs, exec);
    if (dirs.length === 0) {
      // No suite at all. Not a pass to be proud of, but not a failure either —
      // report it explicitly (code 0, pass -1) so the stats show `no tests`
      // instead of a fake green count.
      results.push({ plugin, dirs, code: 0, pass: -1, fail: -1, out: "" });
      continue;
    }
    const cmd = `bun test ${dirs.map((d) => JSON.stringify(d)).join(" ")} 2>&1`;
    const { code, out } = exec(cmd, abs);
    results.push({ plugin, dirs, code, ...parseBunCounts(out), out });
  }
  return results;
}

export function checkPluginTests(opts: PluginTestsOptions): CheckResult {
  const start = Date.now();
  const runs = runPluginTests(opts);

  if (runs.length === 0) {
    return {
      check: "plugin-tests",
      title: "Plugin tests",
      pass: true,
      blocking: true,
      skipped: true,
      durationMs: Date.now() - start,
      stats: {},
    };
  }

  const stats: Record<string, number | string> = {};
  const failures: string[] = [];
  let totalPass = 0;
  let totalFail = 0;

  for (const r of runs) {
    const name = r.plugin.slice(PLUGIN_PREFIX.length);
    if (r.dirs.length === 0) {
      stats[name] = "no tests";
      continue;
    }
    if (r.pass >= 0) totalPass += r.pass;
    if (r.fail > 0) totalFail += r.fail;
    stats[name] = r.code === 0 ? `${r.pass} pass` : `${r.pass} pass / ${r.fail} fail`;
    if (r.code !== 0) {
      failures.push(
        `=== ${r.plugin} — bun test ${r.dirs.join(" ")} FAILED (exit ${r.code}) ===\n${tail(r.out, 60)}`,
      );
    }
  }
  stats.pass = totalPass;
  stats.fail = totalFail;

  return {
    check: "plugin-tests",
    title: "Plugin tests",
    pass: failures.length === 0,
    blocking: true,
    durationMs: Date.now() - start,
    stats,
    rawTail: failures.length > 0 ? failures.join("\n\n") : undefined,
    rawFull: runs.map((r) => `=== ${r.plugin} ===\n${r.out}`).join("\n\n"),
  };
}
