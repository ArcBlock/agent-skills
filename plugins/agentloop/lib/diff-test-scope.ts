#!/usr/bin/env bun
/**
 * Pick the test files that can see a diff, or refuse and run the whole tree.
 *
 * L0 used to treat a directory prefix as the run set: one file under `scripts/`
 * paid for every standing test, and one file under `.claude/plugins/` paid for
 * the whole plugin suite. The full trees stay on L1. Here a test is selected
 * when it is itself in the diff, when a relative import resolves to a changed
 * file, when its source quotes that path, or when `testReadsPath` proves it
 * reads the file. A changed file with no such reader is unread — the caller
 * runs the whole tree. An empty selection is the same refusal: "0 tests" is
 * not a scoped pass.
 */
import { dirname, join, normalize } from "node:path";
import { testReadsPath } from "./scenario.ts";

export interface TestSource {
  /** Path relative to the scan root (repo root, or a plugin root). */
  path: string;
  source: string;
}

export interface SuiteReader {
  /** Test path relative to the same root as {@link TestSource.path}. */
  path: string;
  when: (changedPath: string) => boolean;
}

export interface DiffTestScope {
  mode: "scoped" | "full";
  /** Selected test paths when `mode` is `scoped`; empty when `full`. */
  files: string[];
  /** Changed paths that no selected test reads. Non-empty iff `mode` is `full`. */
  unread: string[];
}

const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g;

function stripExt(path: string): string {
  return path.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
}

function sameFile(a: string, b: string): boolean {
  const left = stripExt(a.replace(/^\.\//, ""));
  const right = stripExt(b.replace(/^\.\//, ""));
  return left === right;
}

function resolveImport(fromFile: string, spec: string): string {
  const raw = normalize(join(dirname(fromFile), spec)).replaceAll("\\", "/");
  return raw.replace(/^\.\//, "");
}

function importsChanged(source: string, fromFile: string, changed: string): boolean {
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec) continue;
    if (sameFile(resolveImport(fromFile, spec), changed)) return true;
  }
  return false;
}

function quotesPath(source: string, path: string): boolean {
  return (
    source.includes(`"${path}"`) || source.includes(`'${path}'`) || source.includes(`\`${path}\``)
  );
}

function readsChanged(test: TestSource, changed: string, root: string): boolean {
  return (
    importsChanged(test.source, test.path, changed) ||
    quotesPath(test.source, changed) ||
    testReadsPath(test.source, changed, test.path, root)
  );
}

/**
 * `changed` and `tests[].path` share one root. `root` is that directory on
 * disk, for `testReadsPath`. `suiteReaders` are named tests that read a class
 * of file the static scan cannot see (a helper that joins a variable).
 */
export function scopeTestsToDiff(args: {
  changed: string[];
  tests: TestSource[];
  root?: string;
  suiteReaders?: readonly SuiteReader[];
}): DiffTestScope {
  const changed = [...new Set(args.changed.map((p) => p.replace(/^\.\//, "")).filter(Boolean))];
  const tests = args.tests;
  const byPath = new Map(tests.map((t) => [t.path, t]));
  const root = args.root ?? process.cwd();
  if (changed.length === 0 || tests.length === 0) {
    return { mode: "full", files: [], unread: changed };
  }

  const selected = new Set<string>();
  const unread: string[] = [];
  for (const file of changed) {
    const self = byPath.get(file);
    const readers: string[] = [];
    if (self) readers.push(file);
    for (const test of tests) {
      if (test.path === file) continue;
      if (readsChanged(test, file, root)) readers.push(test.path);
    }
    for (const extra of args.suiteReaders ?? []) {
      if (!extra.when(file)) continue;
      if (byPath.has(extra.path)) readers.push(extra.path);
    }
    if (readers.length === 0) unread.push(file);
    else for (const reader of readers) selected.add(reader);
  }
  if (unread.length > 0 || selected.size === 0) {
    return { mode: "full", files: [], unread: unread.length > 0 ? unread : changed };
  }
  return { mode: "scoped", files: [...selected].sort(), unread: [] };
}
