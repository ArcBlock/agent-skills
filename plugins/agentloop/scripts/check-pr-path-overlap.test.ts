import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPrPathOverlap,
  diagnoseAllowedPathOverlap,
  type OpenPrPathSet,
} from "./check-pr-path-overlap.ts";

const pr = (number: number, files: string[]): OpenPrPathSet => ({
  number,
  title: `pr-${number}`,
  headRefName: `branch-${number}`,
  isDraft: false,
  files,
});

test("CLI uses the dispatched run cwd, not the manager shell cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-path-overlap-cwd-"));
  const runCwd = join(root, "run");
  const bin = join(root, "bin");
  mkdirSync(runCwd);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    '#!/usr/bin/env bash\nprintf \'[{"number":1,"title":"mine","headRefName":"factory/i1","isDraft":false,"changedFiles":1,"files":[{"path":"scripts/a.ts"}]}]\\n\'\n',
    { mode: 0o755 },
  );
  Bun.spawnSync(["git", "init", "-q", "-b", "factory/i1", runCwd]);
  Bun.spawnSync([
    "git",
    "-C",
    runCwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);

  const result = Bun.spawnSync(
    [
      "bun",
      new URL("./check-pr-path-overlap.ts", import.meta.url).pathname,
      "--run-args",
      JSON.stringify({ cwd: runCwd, allowedPaths: ["scripts/"] }),
    ],
    { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  try {
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"prPathOverlap":"clean"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UNAVAILABLE: missing allowedPaths is not reported as clean", () => {
  expect(checkPrPathOverlap("{}")).toEqual({
    prPathOverlap: "unavailable",
    reason: "allowed-paths-uncheckable: allowedPaths must be a non-empty array",
  });
});

test("UNAVAILABLE: a genuinely missing gh executable returns the third state", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-path-overlap-no-gh-"));
  const bin = join(root, "empty-bin");
  mkdirSync(bin);
  const result = Bun.spawnSync(
    [
      process.execPath,
      new URL("./check-pr-path-overlap.ts", import.meta.url).pathname,
      "--run-args",
      '{"allowedPaths":["scripts/"]}',
    ],
    { cwd: root, env: { ...process.env, PATH: bin } },
  );
  try {
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain(
      '{"prPathOverlap":"unavailable","reason":"open-pr-list-unavailable"}',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UNAVAILABLE: a truncated changed-file list cannot be reported clean", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-path-overlap-truncated-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/bash\nprintf \'[{"number":2,"title":"large","headRefName":"other","isDraft":false,"changedFiles":2,"files":[{"path":"docs/a.md"}]}]\\n\'\n',
    { mode: 0o755 },
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      new URL("./check-pr-path-overlap.ts", import.meta.url).pathname,
      "--run-args",
      '{"allowedPaths":["scripts/"]}',
    ],
    { cwd: root, env: { ...process.env, PATH: bin } },
  );
  try {
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain(
      '{"prPathOverlap":"unavailable","reason":"open-pr-files-incomplete"}',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("diagnoseAllowedPathOverlap", () => {
  test("REJECT: a declared directory prefix contains a concrete PR file", () => {
    expect(
      diagnoseAllowedPathOverlap(
        ["scripts/"],
        [pr(5474, ["scripts/factory-hydrate.sh", "docs/unrelated.md"])],
      ),
    ).toEqual([
      {
        number: 5474,
        title: "pr-5474",
        isDraft: false,
        shared: ["scripts/factory-hydrate.sh"],
      },
    ]);
  });

  test("REJECT: an exact allowed file matches the same PR file", () => {
    expect(
      diagnoseAllowedPathOverlap(
        [".claude/repo-profile.md"],
        [pr(10, [".claude/repo-profile.md"])],
      ),
    ).toHaveLength(1);
  });

  test("ACCEPT: disjoint allowed prefixes and open PR files stay clean", () => {
    expect(
      diagnoseAllowedPathOverlap(
        [".claude/verify/"],
        [pr(5474, ["scripts/factory-hydrate.sh", "scripts/factory-tree-ready.ts"])],
      ),
    ).toEqual([]);
  });

  test("does not confuse a lexical sibling with a contained path", () => {
    expect(diagnoseAllowedPathOverlap(["scripts/foo"], [pr(11, ["scripts/foobar.ts"])])).toEqual(
      [],
    );
  });
});
