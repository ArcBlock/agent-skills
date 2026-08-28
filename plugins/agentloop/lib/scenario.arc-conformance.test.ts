/**
 * Arc-side accept-set conformance for the generic `--na` static-reader gate.
 * Every tracked runnable test is fed into the real predicate: these rows are
 * repository ground truth, not a second hand-built parser fixture.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isStaticTestFile, testReadsPath } from "./scenario.ts";

const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (rootResult.status !== 0) throw new Error("conformance test requires a git checkout");
const ROOT = rootResult.stdout.trim();
const listed = spawnSync("git", ["-C", ROOT, "ls-files", "-co", "--exclude-standard", "-z"], {
  encoding: "utf8",
});
if (listed.status !== 0) throw new Error("unable to enumerate the repository test corpus");

const TESTS = listed.stdout
  .split("\0")
  .filter(isStaticTestFile)
  .filter((path) => existsSync(resolve(ROOT, path)))
  .map((path) => ({ path, source: readFileSync(resolve(ROOT, path), "utf8") }));

function readers(path: string): string[] {
  return TESTS.filter((candidate) =>
    testReadsPath(candidate.source, path, candidate.path, ROOT),
  ).map((candidate) => candidate.path);
}

describe("--na static-reader conformance against arc's tracked corpus", () => {
  test.each([
    ["docs/architecture/did-space.md", ".claude/verify/did-space-docs-sentinel.test.ts"],
    [
      "providers/basic/did-space/README.md",
      "providers/basic/did-space/test/readme-contract-sentinel.test.ts",
    ],
    [
      "blocklets/arch-qa/docs/architecture/small-world-afs.md",
      "providers/basic/index/test/arch-qa-corpus-query.test.ts",
    ],
  ])(
    "MUST refuse %s via its actionable reader",
    (path, expectedReader) => {
      expect(readers(path), `${path} must name its real test reader`).toContain(expectedReader);
    },
    30_000,
  );

  test.each([
    "README.md",
    "CLAUDE.md",
    ".claude/plugins/agentloop/lib/fixtures/i5199-unread.md",
    "providers/runtime/ui/docs/settings-persistence.md",
  ])("MUST grant %s", (path) => {
    expect(readers(path), `${path} must not acquire manufactured readers`).toEqual([]);
  }, 30_000);
});
