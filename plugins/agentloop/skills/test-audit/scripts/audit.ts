#!/usr/bin/env bun
/**
 * test-audit CLI.
 *
 *   bun audit.ts scan [--json] [--rule <id>] [--write-baseline]
 *
 * `scan` walks the adapter's test globs, runs every enabled static rule, and
 * reports findings split into NEW (absent from the baseline) and KNOWN. Only
 * NEW findings can fail the run: a repo adopting this on an existing tree needs
 * a floor, or the gate is unadoptable and gets switched off — which is the
 * failure mode that leaves you with a check nobody reads.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Adapter } from "./adapter.ts";
import { scanDiffFile } from "./diff.ts";
import { draftIssues, publishIssues } from "./issues.ts";
import { type Finding, parse, scanFile } from "./rules.ts";

function git(args: string[], cwd?: string): { out: string; ok: boolean } {
  const r = Bun.spawnSync(["git", ...args], cwd ? { cwd } : {});
  return { out: new TextDecoder().decode(r.stdout), ok: r.exitCode === 0 };
}

function repoRoot(): string {
  return git(["rev-parse", "--show-toplevel"]).out.trim();
}

/** Test files touched between `base` and the working tree, with both versions. */
function changedTestFiles(
  adapter: Adapter,
  base: string,
): { file: string; before: string | null; after: string | null }[] {
  const names = git(["diff", "--name-only", base, "--"], adapter.root)
    .out.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const excludes = [...(adapter.excludes ?? []), "node_modules/", "/dist/"];
  const out: { file: string; before: string | null; after: string | null }[] = [];
  for (const file of names) {
    if (!/\.test\.tsx?$/.test(file)) continue;
    if (excludes.some((x) => file.includes(x))) continue;
    const shown = git(["show", `${base}:${file}`], adapter.root);
    const before = shown.ok ? shown.out : null;
    let after: string | null = null;
    try {
      after = readFileSync(join(adapter.root, file), "utf8");
    } catch {
      after = null;
    }
    out.push({ file, before, after });
  }
  return out;
}

export async function loadAdapter(root: string, configPath?: string): Promise<Adapter> {
  const rel = configPath ?? ".claude/test-audit.config.ts";
  const abs = isAbsolute(rel) ? rel : join(root, rel);
  if (!existsSync(abs)) throw new Error(`test-audit: no adapter config at ${abs}`);
  const mod = await import(abs);
  const adapter = (mod.default ?? mod.adapter) as Adapter;
  if (!adapter) throw new Error(`test-audit: ${abs} has no default export`);
  return { ...adapter, root };
}

/**
 * Enumerate test files by asking GIT what the source files are.
 *
 * ## Why not a filesystem glob with an exclude list
 *
 * That was the first implementation, and it silently lost a file. Its
 * `ALWAYS_EXCLUDED` carried `"/build/"` to skip build output, which also
 * matched `runtimes/node/test/build/readonly-tree-manifest.test.ts` — 11 KB of
 * tracked, live test source in a directory that happens to be called `build`.
 * The scan reported "3369 test files scanned" and looked healthy.
 *
 * That is the exact failure this whole tool exists to catch, one level up: a
 * check whose COVERAGE quietly shrinks reports the same green as one that is
 * working, and its own output cannot tell you which. The predecessor skill died
 * of it (five hardcoded directories, blind to 25% of the tree); repeating it
 * with a substring blacklist would have been the same bug in a new costume.
 *
 * `git ls-files` removes the guesswork: build output, `node_modules` and every
 * other generated tree are gitignored, so they are excluded BY CONSTRUCTION
 * rather than by a list someone has to keep correct. `--others
 * --exclude-standard` adds files that are new but not ignored, so a test
 * written and not yet staged is still audited.
 *
 * `adapter.excludes` still applies, but it is now for genuine repo policy
 * (nested checkouts, the auditor's own fixtures) rather than for re-deriving
 * what `.gitignore` already knows.
 */
export function collectTestFiles(adapter: Adapter): string[] {
  const tracked = git(["ls-files", "-z", ...adapter.testGlobs], adapter.root);
  const untracked = git(
    ["ls-files", "-z", "--others", "--exclude-standard", ...adapter.testGlobs],
    adapter.root,
  );
  const excludes = adapter.excludes ?? [];
  const seen = new Set<string>();
  for (const blob of [tracked.out, untracked.out]) {
    for (const f of blob.split("\0")) {
      if (!f) continue;
      if (excludes.some((x) => f.includes(x))) continue;
      seen.add(f);
    }
  }
  return [...seen].sort();
}

export function scanTree(adapter: Adapter, files: string[]): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    const abs = join(adapter.root, file);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    out.push(...scanFile(parse(abs, text), file, adapter));
  }
  return out;
}

/**
 * Static findings this diff INTRODUCED into a file — not the ones it inherited.
 *
 * Some static rules matter enough to gate on (`.only` disables a whole file),
 * but the diff tier alone would miss them: they are properties of the file, not
 * of the change. Running the static rules over changed files naively is the
 * wrong fix — it makes anyone who touches a file inherit every pre-existing
 * finding in it, which is the same "taxes honest work" failure the blocking set
 * is measured to avoid.
 *
 * So: scan both revisions, report only keys that are new. Keys are
 * content-derived (see `findingKey`), so an untouched violation keeps its key
 * across the diff and stays silent.
 */
function newStaticFindings(
  c: { file: string; before: string | null; after: string | null },
  adapter: Adapter,
): Finding[] {
  if (c.after === null) return [];
  const after = scanFile(parse(c.file, c.after), c.file, adapter);
  if (c.before === null) return after;
  const had = new Set(scanFile(parse(c.file, c.before), c.file, adapter).map((f) => f.key));
  return after.filter((f) => !had.has(f.key));
}

function readBaseline(adapter: Adapter): Set<string> {
  const abs = join(adapter.root, adapter.baseline);
  if (!existsSync(abs)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as { keys?: string[] };
    return new Set(parsed.keys ?? []);
  } catch {
    return new Set();
  }
}

function render(nu: Finding[], known: Finding[], total: number): string {
  const lines: string[] = [];
  lines.push(`test-audit — ${total} test files scanned`);
  lines.push(`  NEW:   ${nu.length}`);
  lines.push(`  KNOWN: ${known.length} (in baseline)`);
  if (nu.length) {
    lines.push("");
    const byRule = new Map<string, Finding[]>();
    for (const f of nu) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    for (const [rule, fs] of [...byRule].sort()) {
      lines.push(`── ${rule} (${fs.length}, ${fs[0]!.severity})`);
      for (const f of fs.slice(0, 20)) {
        lines.push(`   ${f.file}:${f.line}`);
        lines.push(`     ${f.message}`);
        lines.push(`     witness: ${f.witness}`);
      }
      if (fs.length > 20) lines.push(`   … ${fs.length - 20} more`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "scan";
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (cmd !== "scan" && cmd !== "diff" && cmd !== "issues") {
    console.error(`test-audit: unknown command ${cmd} (expected: scan | diff | issues)`);
    return 2;
  }

  const root = repoRoot();
  const adapter = await loadAdapter(root, value("config"));

  // `diff` is the PR-facing mode: it answers "did this change weaken the
  // suite?", which a tree scan structurally cannot see. No baseline applies —
  // every finding here was introduced by the diff under review.
  if (cmd === "diff") {
    const base = value("base") ?? "origin/main";
    const changed = changedTestFiles(adapter, base);
    const findings = changed.flatMap((c) => [
      ...scanDiffFile(c.file, c.before, c.after, adapter),
      ...newStaticFindings(c, adapter),
    ]);
    if (flag("json")) {
      console.log(JSON.stringify({ base, changedTestFiles: changed.length, findings }, null, 2));
    } else if (findings.length === 0) {
      console.log(`test-audit diff — ${changed.length} changed test file(s) vs ${base}: clean`);
    } else {
      console.log(`test-audit diff — ${changed.length} changed test file(s) vs ${base}\n`);
      for (const f of findings) {
        console.log(`── ${f.rule} (${f.severity})  ${f.file}:${f.line}`);
        console.log(`   ${f.message}`);
        console.log(`   witness: ${f.witness}`);
      }
    }
    return findings.some((f) => f.severity === "block") ? 1 : 0;
  }

  const files = collectTestFiles(adapter);
  let findings = scanTree(adapter, files);

  // `issues` groups a sweep into one draft per (rule × owning unit) and PRINTS
  // them. It never writes to GitHub: creating issues is a side effect on a
  // shared surface, and it stays an explicit act by whoever is running this.
  if (cmd === "issues") {
    const onlyRuleI = value("rule");
    const scoped = onlyRuleI ? findings.filter((f) => f.rule === onlyRuleI) : findings;
    const drafts = draftIssues(scoped, adapter);
    if (flag("json")) {
      console.log(JSON.stringify({ scanned: files.length, drafts }, null, 2));
      return 0;
    }
    console.log(
      `test-audit issues — ${scoped.length} findings across ${files.length} test files → ${drafts.length} draft(s)\n`,
    );
    for (const d of drafts) {
      console.log(`${"=".repeat(72)}\n${d.title}\n${"=".repeat(72)}\n${d.body}\n`);
    }
    if (!flag("create")) {
      console.log(
        `\n${drafts.length} draft(s) printed. Nothing was created.\n` +
          `Add --create --repo <owner/name> to upsert them (keyed on the test-audit-key marker,\n` +
          `so a re-run edits the existing issue instead of filing a duplicate).`,
      );
      return 0;
    }

    const repo = value("repo");
    if (!repo) {
      console.error("test-audit: --create requires --repo <owner/name>");
      return 2;
    }
    console.log(`\nupserting ${drafts.length} issue(s) into ${repo} …`);
    let failed = 0;
    for (const p of publishIssues(drafts, repo)) {
      if (p.action === "failed") failed++;
      const where = p.issue ? `#${p.issue}` : "";
      console.log(
        `  ${p.action.padEnd(8)} ${where.padEnd(7)} ${p.key}${p.detail ? ` — ${p.detail}` : ""}`,
      );
    }
    return failed > 0 ? 1 : 0;
  }

  const onlyRule = value("rule");
  if (onlyRule) findings = findings.filter((f) => f.rule === onlyRule);

  if (flag("write-baseline")) {
    const abs = join(adapter.root, adapter.baseline);
    const keys = [...new Set(findings.map((f) => f.key))].sort();
    writeFileSync(abs, `${JSON.stringify({ keys }, null, 2)}\n`);
    console.log(`test-audit: wrote ${keys.length} keys to ${relative(root, abs)}`);
    return 0;
  }

  const baseline = readBaseline(adapter);
  const nu = findings.filter((f) => !baseline.has(f.key));
  const known = findings.filter((f) => baseline.has(f.key));

  if (flag("json")) {
    console.log(JSON.stringify({ scanned: files.length, new: nu, known }, null, 2));
  } else {
    console.log(render(nu, known, files.length));
  }

  return nu.some((f) => f.severity === "block") ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
