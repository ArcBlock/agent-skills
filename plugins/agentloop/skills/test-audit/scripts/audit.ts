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
import { draftIssues } from "./issues.ts";
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

const ALWAYS_EXCLUDED = ["node_modules/", "/dist/", "/build/"];

export async function collectTestFiles(adapter: Adapter): Promise<string[]> {
  const excludes = [...ALWAYS_EXCLUDED, ...(adapter.excludes ?? [])];
  const seen = new Set<string>();
  for (const pattern of adapter.testGlobs) {
    const glob = new Bun.Glob(pattern);
    // `dot: true` is deliberate — tooling trees like `.claude/` hold real test
    // files, and excluding them is how a scan surface silently shrinks.
    for await (const f of glob.scan({ cwd: adapter.root, onlyFiles: true, dot: true })) {
      if (excludes.some((x) => f.includes(x) || f.startsWith(x.replace(/^\//, "")))) continue;
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

  const files = await collectTestFiles(adapter);
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
    console.log(
      `\n${drafts.length} draft(s) printed. Nothing was created.\n` +
        `Each body carries a \`test-audit-key\` marker — publish with upsert-by-marker so a\n` +
        `re-run updates the existing issue instead of filing a duplicate.`,
    );
    return 0;
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
