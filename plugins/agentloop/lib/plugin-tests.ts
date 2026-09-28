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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SuiteReader, scopeTestsToDiff } from "./diff-test-scope.ts";
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
  /**
   * L1 (daily / catch-net) runs every test file. L0 scopes to the tests that
   * read the diff and falls back to the whole tree when a changed file has
   * no static reader. Default is the L0 scope.
   */
  full?: boolean;
  /** Named tests that read a class of file the static scan cannot see. */
  suiteReaders?: readonly SuiteReader[];
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
  /** `files` = the readers of this diff; `tree` = the whole plugin suite. */
  scope: "files" | "tree";
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

/** Test files under `root`, relative to the plugin root. Same find as {@link discoverTestDirs}. */
export function listTestFiles(
  root: string,
  exec: (cmd: string, cwd: string) => { code: number; out: string },
): string[] {
  const { out } = exec(
    `find . -name '*.test.ts' -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`,
    root,
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^\.\//, ""))
    .sort();
}

/**
 * A file that must not share a `bun test` process with the rest of the plugin
 * suite (arc#6090). Same declaration shape as arc's `@test-shards:solo` so a
 * plugin file can use either tag; `@plugin-tests:isolated` is the generic name.
 */
export function isIsolatedTestSource(source: string): boolean {
  return /^[ \t]*(?:\/\/[ \t]*|\*[ \t]*)?@(?:plugin-tests:isolated|test-shards:solo)[ \t]+\S/m.test(
    source,
  );
}

export function partitionIsolatedTestFiles(
  pluginAbs: string,
  files: string[],
): { packed: string[]; isolated: string[] } {
  const packed: string[] = [];
  const isolated: string[] = [];
  for (const file of files) {
    let source = "";
    try {
      source = readFileSync(join(pluginAbs, file), "utf8");
    } catch {
      packed.push(file);
      continue;
    }
    if (isIsolatedTestSource(source)) isolated.push(file);
    else packed.push(file);
  }
  return { packed, isolated };
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
      // No suite at all. Visible in stats as `no tests` (not a fake 0 fail),
      // and NON-green at the CheckResult layer (arc#6439 / 度量正控):
      // 「这个 plugin 的测试全过了」与「这个 plugin 一个测试都没有」must not
      // share a colour. code non-zero so callers that only look at exit see it.
      results.push({
        plugin,
        dirs,
        code: 1,
        pass: -1,
        fail: -1,
        out: "no *.test.ts discovered under this plugin tree",
        scope: "tree",
      });
      continue;
    }
    const files = listTestFiles(abs, exec);
    const changed = opts.changedFiles
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${plugin}/`))
      .map((line) => line.slice(plugin.length + 1));
    let runFiles = files;
    let scope: "files" | "tree" = "tree";
    if (!opts.full) {
      const tests = files.map((path) => {
        let source = "";
        try {
          source = readFileSync(join(abs, path), "utf8");
        } catch {
          source = "";
        }
        return { path, source };
      });
      const picked = scopeTestsToDiff({
        changed,
        tests,
        root: abs,
        suiteReaders: opts.suiteReaders,
      });
      if (picked.mode === "scoped") {
        runFiles = picked.files;
        scope = "files";
      }
    }
    const { packed, isolated } = partitionIsolatedTestFiles(abs, runFiles);
    // Packed files share one `bun test`. Isolated files each get their own
    // process so a spawn-heavy suite cannot 30s-timeout its neighbours
    // (arc#6090). Passing explicit files (not dirs) keeps bun from pulling
    // an isolated file back into the packed run.
    const chunks: string[][] = [];
    if (packed.length > 0) chunks.push(packed);
    for (const file of isolated) chunks.push([file]);
    let code = 0;
    let out = "";
    let pass = 0;
    let fail = 0;
    let sawCrash = false;
    for (const chunk of chunks) {
      const cmd = `bun test ${chunk.map((f) => JSON.stringify(f)).join(" ")} 2>&1`;
      const r = exec(cmd, abs);
      if (r.code !== 0) code = r.code;
      out += (out && !out.endsWith("\n") ? "\n" : "") + r.out;
      const counts = parseBunCounts(r.out);
      if (counts.pass < 0 || counts.fail < 0) sawCrash = true;
      else {
        pass += counts.pass;
        fail += counts.fail;
      }
    }
    results.push({
      plugin,
      dirs,
      code,
      pass: sawCrash ? -1 : pass,
      fail: sawCrash ? -1 : fail,
      out,
      scope,
    });
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
    // 度量正控 — empty suite must be NON-green. Anchor is the guard expression
    // `r.dirs.length === 0` (PC-weak-anchor). Stats still say `no tests` so the
    // report distinguishes 「没有套件」 from 「0 个失败」.
    if (r.dirs.length === 0) {
      stats[name] = "no tests";
      failures.push(
        `=== ${r.plugin} — no test suite discovered (*.test.ts) ===\n` +
          `touched plugin has zero *.test.ts under it — empty suite is not a pass ` +
          `(arc#6439 / #2643: pass:-1 must not render green).`,
      );
      continue;
    }
    if (r.pass >= 0) totalPass += r.pass;
    if (r.fail > 0) totalFail += r.fail;
    stats[name] = r.code === 0 ? `${r.pass} pass` : `${r.pass} pass / ${r.fail} fail`;
    if (r.scope === "files" && r.code === 0 && r.pass === 0) {
      failures.push(
        `=== ${r.plugin} — scoped run counted 0 passes ===\n` +
          `a file selection that executed nothing is not a pass`,
      );
    }
    if (r.code !== 0) {
      failures.push(
        `=== ${r.plugin} — bun test ${r.dirs.join(" ")} FAILED (exit ${r.code}) ===\n${tail(r.out, 60)}`,
      );
    }
  }
  stats.pass = totalPass;
  stats.fail = totalFail;
  stats.scope = runs.every((r) => r.scope === "files") ? "files" : "tree";

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
