#!/usr/bin/env bun
/**
 * Tests for the scenario runner's ON-DISK artifacts (`.verify/<sha>.{md,result}`).
 *
 * `runScenario` ends in `process.exit`, so each case runs it in a child process
 * against a throwaway git repo — the runner reads HEAD/dirtiness from git, so a
 * real (tiny) repo is the honest fixture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = import.meta.dir;
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git repo with one commit, so HEAD resolves and the tree is clean. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentloop-scenario-"));
  dirs.push(dir);
  const git = (args: string) =>
    spawnSync("bash", ["-c", `cd ${dir} && git ${args}`], { encoding: "utf8" });
  git("init -q");
  git("config user.email t@t.t");
  git("config user.name t");
  writeFileSync(join(dir, "f.txt"), "one\n");
  git("add -A");
  git("commit -qm init");
  return dir;
}

/** Run a one-check scenario in `dir`; returns HEAD sha + the runner's exit code. */
function runScenarioIn(dir: string, pass: boolean, extraArgv = ""): { sha: string; code: number } {
  // OUTSIDE the repo: an untracked file in it would read as a dirty tree and
  // suppress the very PASS cache one of these cases is asserting.
  const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-script-"));
  dirs.push(scriptDir);
  const script = join(scriptDir, "scenario-run.ts");
  writeFileSync(
    script,
    `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
     runScenario(
       {
         scenario: "unit",
         resolveBase: () => "HEAD",
         checks: [
           {
             id: "only",
             run: () => ({
               check: "only",
               title: "Only",
               pass: ${pass},
               blocking: true,
               durationMs: 1,
               stats: {},
               rawFull: "log-line-that-must-survive",
             }),
           },
         ],
       },
       ["bun", "scenario-run.ts"${extraArgv}],
     );`,
  );
  const r = spawnSync("bash", ["-c", `cd ${dir} && bun ${script}`], { encoding: "utf8" });
  const sha = spawnSync("bash", ["-c", `cd ${dir} && git rev-parse HEAD`], {
    encoding: "utf8",
  }).stdout.trim();
  return { sha, code: r.status ?? -1 };
}

describe("runScenario — .verify cache", () => {
  test("caches a PASS on a clean tree (unchanged behavior)", () => {
    const dir = repo();
    const { sha, code } = runScenarioIn(dir, true);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("PASS");
  });

  test("does NOT cache a PASS on a dirty tree — the sha would not match what ran", () => {
    const dir = repo();
    writeFileSync(join(dir, "f.txt"), "edited\n");
    const { sha, code } = runScenarioIn(dir, true);
    expect(code).toBe(0);
    expect(existsSync(join(dir, ".verify", `${sha}.md`))).toBe(false);
  });

  test("caches a FAIL with its logs, marked FAIL", () => {
    // The PR comment drops the Full Logs section when it is oversized and points
    // the reader at this file; under the old PASS-only rule it was never written
    // on exactly the runs that had something to show (arc PR #3062).
    const dir = repo();
    const { sha, code } = runScenarioIn(dir, false);
    expect(code).toBe(1);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("FAIL");
    expect(readFileSync(join(dir, ".verify", `${sha}.md`), "utf8")).toContain(
      "log-line-that-must-survive",
    );
  });

  test("a cached FAIL is not a gate token: --deliver-cached still exits non-zero", () => {
    const dir = repo();
    const { sha } = runScenarioIn(dir, false);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("FAIL");
    const again = runScenarioIn(dir, false, `, "--deliver-cached"`);
    expect(again.code).toBe(1);
  });
});
