/**
 * Arc-side accept-set conformance for the generic `--na` static-reader gate.
 * Every tracked runnable test is fed into the real predicate: these rows are
 * repository ground truth, not a second hand-built parser fixture.
 *
 * Both arms are load-bearing. "MUST refuse" proves the predicate finds the
 * readers that exist. "MUST grant" is its accept arm: a predicate that simply
 * answered `true` — by unioning unrelated strings out of every test file —
 * satisfies every refuse row while refusing `--na` for the entire repository.
 * "manufactured" therefore means INVENTED BY THE PARSER, not "written in order
 * to satisfy this test".
 *
 * Maintenance rule, learned the expensive way in #5817: a grant row asserts a
 * fact about arc's corpus, and arc's corpus moves. #5806 gave `CLAUDE.md` a real
 * reader — `scripts/test/stash-pop-policy.test.ts` asserts on its wording — and
 * this row was red on main for a week. When a grant row goes red, decide which
 * world changed:
 *   - the reader is REAL ⇒ move the row into the refuse table, naming it. The
 *     `--na` exemption genuinely is no longer available for that path, and
 *     saying so is this file's job.
 *   - the reader is INVENTED ⇒ `testReadsPath` is over-matching; fix it there.
 * There is no third option. Do not teach either table that only some readers
 * count: a hand-maintained exclusion list is the exact thing this conformance
 * file exists to replace.
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
    // #5806 turned the root contributor guide into a tested artifact: the
    // stash-pop guard asserts CLAUDE.md still carries the corrected wording, so
    // rewording that paragraph alone reds a test. Same shape as the two doc
    // sentinels above — a prose-only PR to it is not exempt from the gate.
    ["CLAUDE.md", "scripts/test/stash-pop-policy.test.ts"],
  ])(
    "MUST refuse %s via its actionable reader",
    (path, expectedReader) => {
      expect(readers(path), `${path} must name its real test reader`).toContain(expectedReader);
    },
    30_000,
  );

  test.each([
    "README.md",
    ".claude/plugins/agentloop/lib/fixtures/i5199-unread.md",
    "providers/runtime/ui/docs/settings-persistence.md",
  ])("MUST grant %s", (path) => {
    expect(
      readers(path),
      `${path} must not acquire manufactured readers — if a named test really does read ` +
        `it, move the row into the MUST-refuse table above rather than teaching the ` +
        `predicate to overlook readers (#5817)`,
    ).toEqual([]);
  }, 30_000);
});
