#!/usr/bin/env bun
/**
 * Tests for the scenario runner's ON-DISK artifacts (`.verify/<sha>.{md,result}`).
 *
 * `runScenario` ends in `process.exit`, so each case runs it in a child process
 * against a throwaway git repo — the runner reads HEAD/dirtiness from git, so a
 * real (tiny) repo is the honest fixture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CheckResult, deriveResult, isSkipped, passed } from "./report.ts";
import {
  type CachedEvidence,
  type CheckSpec,
  provenanceNotice,
  type RunContext,
  runCheckGuarded,
} from "./scenario.ts";

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

/** Add one commit on top of the fixture's base, so `HEAD^..HEAD` is the PR diff. */
function commitFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const committed = spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  expect(committed.status).toBe(0);
  const commit = spawnSync("git", ["commit", "-qm", "fixture change"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(commit.status).toBe(0);
}

/** Run a one-check scenario in `dir`; returns HEAD sha + the runner's exit code. */
function runScenarioIn(
  dir: string,
  pass: boolean,
  extraArgv = "",
  stats: Record<string, number | string> = {},
): { sha: string; code: number; out: string } {
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
               stats: ${JSON.stringify(stats)},
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
  return { sha, code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/**
 * A three-check scenario, so `--only` can select a real subset. Returns HEAD sha,
 * exit code, and combined output.
 */
function runMultiIn(
  dir: string,
  extraArgv = "",
  resolveBase = "HEAD",
  cwd = dir,
): { sha: string; code: number; out: string } {
  const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-multi-"));
  dirs.push(scriptDir);
  const script = join(scriptDir, "multi-run.ts");
  const check = (id: string) =>
    `{ id: ${JSON.stringify(id)}, run: () => ({ check: ${JSON.stringify(id)}, title: ${JSON.stringify(id)}, pass: true, blocking: true, durationMs: 1, rawFull: "log-${id}" }) }`;
  writeFileSync(
    script,
    `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
     runScenario(
       { scenario: "unit", resolveBase: () => ${JSON.stringify(resolveBase)},
         checks: [${["a", "b", "c"].map(check).join(", ")}] },
       ["bun", "multi-run.ts"${extraArgv}],
     );`,
  );
  const r = spawnSync("bun", [script], { cwd, encoding: "utf8" });
  const sha = spawnSync("bash", ["-c", `cd ${dir} && git rev-parse HEAD`], {
    encoding: "utf8",
  }).stdout.trim();
  return { sha, code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const meta = (dir: string, sha: string) =>
  JSON.parse(readFileSync(join(dir, ".verify", `${sha}.metadata.json`), "utf8"));

/**
 * #5067: a partial verification wrote a PASS cache that satisfied the push gate.
 *
 * Arms 1 and 3 are load-bearing: "refuse every cache" satisfies every reject
 * assertion here and would break every normal push, which is worse than the bug.
 */
describe("runScenario — partial verification is not a gate token (#5067)", () => {
  test("arm 1 (accept): a full scenario PASS is still a gate token — --deliver-cached exits 0", () => {
    const dir = repo();
    const { sha, code } = runMultiIn(dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("PASS");
    expect(meta(dir, sha).fullScenario).toBe(true);
    expect(meta(dir, sha).checks).toEqual(["a", "b", "c"]);
    // This is exactly what tools/pre-push.sh runs to decide whether to allow the push.
    expect(runMultiIn(dir, `, "--deliver-cached"`).code).toBe(0);
  });

  test("arm 2 (reject): a passing --only run is refused as a gate, and the refusal names it partial", () => {
    const dir = repo();
    const { sha, code, out } = runMultiIn(dir, `, "--only", "a,b"`);
    // The run itself still succeeds — `--only` is the sanctioned way to debug one
    // check, and breaking that exit code would push people right back to it.
    expect(code).toBe(0);
    // …but the token it leaves behind is not green.
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("PARTIAL");
    expect(meta(dir, sha).fullScenario).toBe(false);
    expect(meta(dir, sha).checks).toEqual(["a", "b"]);
    expect(out).toContain("PARTIAL VERIFICATION");
    // pre-push's oracle refuses, and says why.
    const delivery = runMultiIn(dir, `, "--only", "a,b", "--deliver-cached"`);
    expect(delivery.code).toBe(1);
    expect(delivery.out).toContain("PARTIAL");
    expect(delivery.out).toContain("a, b");
    // A partial run must never reach the shared broker either — at ANY location slot.
    const shaRoot = join(dir, ".git", "agentloop", "verification", sha);
    expect(
      spawnSync("bash", ["-c", `find ${shaRoot} -name result -print -quit 2>/dev/null`], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("");
  });

  test("arm 3 (no regression, PR #3062): the partial run's report is still written and readable", () => {
    const dir = repo();
    const { sha } = runMultiIn(dir, `, "--only", "a,b"`);
    const report = readFileSync(join(dir, ".verify", `${sha}.md`), "utf8");
    expect(report).toContain(`.verify/${sha}.a.log`);
    expect(report).toContain(`.verify/${sha}.b.log`);
    expect(readFileSync(join(dir, ".verify", `${sha}.a.log`), "utf8")).toContain("log-a");
    expect(readFileSync(join(dir, ".verify", `${sha}.b.log`), "utf8")).toContain("log-b");
    expect(report).toContain("PARTIAL VERIFICATION");
  });

  test("--skip is partial too (the other half of `!only && !skip`)", () => {
    const dir = repo();
    const { sha } = runMultiIn(dir, `, "--skip", "c"`);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("PARTIAL");
    expect(meta(dir, sha).checks).toEqual(["a", "b"]);
  });

  test("a red partial stays FAIL — only a green is demoted (FAIL carries the #3062 diagnostic)", () => {
    const dir = repo();
    const { sha } = runScenarioIn(dir, false, `, "--only", "only"`);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("FAIL");
    expect(meta(dir, sha).fullScenario).toBe(false);
  });

  test("arm 1 survives a partial run afterwards: the broker rehydrates the full PASS", () => {
    const dir = repo();
    const { sha } = runMultiIn(dir);
    // The natural sequence: full gate green, then `--only` to poke at one check.
    runMultiIn(dir, `, "--only", "a"`);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("PARTIAL");
    // The push gate must still pass — the full evidence is in the shared broker.
    expect(runMultiIn(dir, `, "--deliver-cached"`).code).toBe(0);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("PASS");
  });

  test("NA accept: an unread documentation file still receives the exemption", () => {
    const dir = repo();
    commitFiles(dir, {
      "docs/accept-path/unread-i5199.md": "This new document is not read by a test.\n",
    });
    const { sha, code } = runMultiIn(dir, `, "--na", "docs-only change"`, "HEAD^");
    expect(code).toBe(0);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("NA");
    expect(meta(dir, sha)).toMatchObject({ fullScenario: true, checks: [] });
  });

  test("NA reject: names the test that reads each changed documentation file", () => {
    const dir = repo();
    commitFiles(dir, {
      "docs/architecture/did-space.md": "old did-space contract\n",
      "docs/architecture/did-space-local-dx.md": "old local-dx contract\n",
      ".claude/verify/did-space-docs-sentinel.test.ts": `
        import { readFileSync } from "node:fs";
        import { join } from "node:path";
        const ARCH = join(import.meta.dir, "..", "..", "docs", "architecture");
        const read = (name: string) => readFileSync(join(ARCH, name), "utf8");
        read("did-space.md");
        read("did-space-local-dx.md");
      `,
    });
    commitFiles(dir, {
      "docs/architecture/did-space.md": "rewritten did-space contract\n",
      "docs/architecture/did-space-local-dx.md": "rewritten local-dx contract\n",
    });

    const { sha, code, out } = runMultiIn(dir, `, "--na", "docs-only change"`, "HEAD^");
    expect(code).toBe(2);
    expect(out).toContain("docs/architecture/did-space.md");
    expect(out).toContain("docs/architecture/did-space-local-dx.md");
    expect(out).toContain(".claude/verify/did-space-docs-sentinel.test.ts");
    expect(existsSync(join(dir, ".verify", `${sha}.result`))).toBe(false);
  });

  test("NA reject: a TypeScript source diff cannot claim a no-verification exemption", () => {
    const dir = repo();
    commitFiles(dir, { "src/index.ts": "export const answer = 1;\n" });
    commitFiles(dir, { "src/index.ts": "export const answer = 2;\n" });

    const { sha, code, out } = runMultiIn(dir, `, "--na", "docs-only change"`, "HEAD^");
    expect(code).toBe(2);
    expect(out).toContain("src/index.ts");
    expect(out).toContain("source file");
    expect(existsSync(join(dir, ".verify", `${sha}.result`))).toBe(false);
  });

  test("NA reject: NUL-delimited diff preserves a non-ASCII TypeScript path", () => {
    const dir = repo();
    commitFiles(dir, { "src/功能.ts": "export const answer = 1;\n" });

    const { code, out } = runMultiIn(dir, `, "--na", "docs-only change"`, "HEAD^");
    expect(code).toBe(2);
    expect(out).toContain("src/功能.ts");
  });

  test("NA reject: a rename checks both the old and new documentation paths", () => {
    const dir = repo();
    commitFiles(dir, {
      "docs/contract.md": "contract\n",
      "test/contract.test.ts": `
        import { readFileSync } from "node:fs";
        readFileSync("docs/contract.md", "utf8");
      `,
    });
    renameSync(join(dir, "docs/contract.md"), join(dir, "docs/renamed.md"));
    const committed = spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
    expect(committed.status).toBe(0);
    expect(spawnSync("git", ["commit", "-qm", "rename fixture"], { cwd: dir }).status).toBe(0);

    const { code, out } = runMultiIn(dir, `, "--na", "docs-only change"`, "HEAD^");
    expect(code).toBe(2);
    expect(out).toContain("docs/contract.md");
    expect(out).toContain("test/contract.test.ts");
  });

  test("NA reject: __tests__ source files are runnable static readers", () => {
    const dir = repo();
    commitFiles(dir, {
      "docs/contract.md": "old\n",
      "src/__tests__/docs-contract.ts": `
        import { readFileSync } from "node:fs";
        readFileSync("docs/contract.md", "utf8");
      `,
    });
    commitFiles(dir, { "docs/contract.md": "new\n" });

    const { code, out } = runMultiIn(dir, `, "--na", "docs-only change"`, "HEAD^");
    expect(code).toBe(2);
    expect(out).toContain("src/__tests__/docs-contract.ts");
  });

  test("NA accept: reader-shaped prose in a test comment is not a dependency", () => {
    const dir = repo();
    commitFiles(dir, {
      "docs/contract.md": "old\n",
      "test/unrelated.test.ts": `
        // This example is prose only: readFileSync("docs/contract.md", "utf8")
        test("unrelated", () => expect(true).toBe(true));
      `,
    });
    commitFiles(dir, { "docs/contract.md": "new\n" });

    const { code } = runMultiIn(dir, `, "--na", "docs-only change"`, "HEAD^");
    expect(code).toBe(0);
  });

  test("NA reject is independent of the invocation cwd", () => {
    const dir = repo();
    commitFiles(dir, {
      "docs/contract.md": "old\n",
      "test/contract.test.ts": `
        import { readFileSync } from "node:fs";
        readFileSync("docs/contract.md", "utf8");
      `,
    });
    commitFiles(dir, { "docs/contract.md": "new\n" });

    const { code, out } = runMultiIn(
      dir,
      `, "--na", "docs-only change"`,
      "HEAD^",
      join(dir, "docs"),
    );
    expect(code).toBe(2);
    expect(out).toContain("test/contract.test.ts");
  });

  test("NA reject: Python source is explicitly verifiable", () => {
    const dir = repo();
    commitFiles(dir, { ".claude/skills/example/scripts/check.py": "print('checked')\n" });

    const { code, out } = runMultiIn(dir, `, "--na", "docs-only change"`, "HEAD^");
    expect(code).toBe(2);
    expect(out).toContain(".claude/skills/example/scripts/check.py");
    expect(out).toContain("source file");
  });
});

describe("runScenario — .verify cache", () => {
  test("--help exits before identity, lease, checks, or cache mutation (#4800)", () => {
    const dir = repo();
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    const lock = join(dir, ".git", "agentloop", "verification", sha, "unit", "HEAD", "lease.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), "already-owned\n");
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-script-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "help.ts");
    writeFileSync(
      script,
      `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       runScenario({ scenario: "unit", resolveBase: () => "HEAD", identity: () => { throw new Error("identity must not run"); }, checks: [{ id: "only", run: () => { throw new Error("check must not run"); } }] }, process.argv);`,
    );
    const result = spawnSync("bun", [script, "--help"], { cwd: dir, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Usage: unit");
    expect(existsSync(join(dir, ".verify"))).toBe(false);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe("already-owned\n");
  });

  test("caches a PASS on a clean tree (unchanged behavior)", () => {
    const dir = repo();
    const { sha, code } = runScenarioIn(dir, true);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("PASS");
  });

  test("a dirty tree runs under the shared coordinator without caching evidence", () => {
    const dir = repo();
    writeFileSync(join(dir, "f.txt"), "edited\n");
    const { sha, code } = runScenarioIn(dir, true);
    expect(code).toBe(0);
    expect(existsSync(join(dir, ".verify", `${sha}.md`))).toBe(false);
  });

  test("a dirty admission cannot become a reusable PASS by turning clean during checks", () => {
    const dir = repo();
    const dirty = join(dir, "untracked.txt");
    writeFileSync(dirty, "dirty\n");
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-script-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "dirty-to-clean.ts");
    writeFileSync(
      script,
      `import { unlinkSync } from "node:fs";
       import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       runScenario({ scenario: "unit", resolveBase: () => "HEAD", checks: [{ id: "only", run: () => {
         unlinkSync(${JSON.stringify(dirty)});
         return { check: "only", title: "Only", pass: true, blocking: true, durationMs: 1 };
       }}] }, process.argv);`,
    );
    const first = spawnSync("bun", [script], { cwd: dir, encoding: "utf8" });
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    expect(first.status).toBe(0);
    expect(existsSync(join(dir, ".verify", `${sha}.result`))).toBe(false);
    const delivery = spawnSync("bun", [script, "--deliver-cached"], { cwd: dir, encoding: "utf8" });
    expect(delivery.status).toBe(1);
    expect(`${delivery.stdout}${delivery.stderr}`).toContain("no current unit cache");
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
      `.verify/${sha}.only.log`,
    );
    expect(readFileSync(join(dir, ".verify", `${sha}.only.log`), "utf8")).toContain(
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

  test("--retry-failed archives a terminal failure and runs one new full gate", () => {
    const dir = repo();
    const first = runScenarioIn(dir, false);
    expect(first.code).toBe(1);
    const retried = runScenarioIn(dir, true, `, "--retry-failed"`);
    expect(retried.code).toBe(0);
    expect(`${retried.out}`).toContain("retrying cached FAIL evidence");
    expect(readFileSync(join(dir, ".verify", `${first.sha}.result`), "utf8")).toBe("PASS");
    const shaRoot = join(dir, ".git", "agentloop", "verification", first.sha, "unit", "HEAD");
    const archived = spawnSync(
      "bash",
      ["-c", `find ${shaRoot} -path '*/retries/*' -name result -print -quit`],
      { encoding: "utf8" },
    ).stdout.trim();
    expect(archived).not.toBe("");
    expect(readFileSync(archived, "utf8")).toBe("FAIL\n");
  });

  test("--retry-failed rejects partial scenario selection", () => {
    const dir = repo();
    const retried = runScenarioIn(dir, true, `, "--retry-failed", "--only", "only"`);
    expect(retried.code).toBe(2);
    expect(retried.out).toContain("requires a full scenario");
  });

  test("--retry-failed rejects modes that would not run a retry", () => {
    const dir = repo();
    const retried = runScenarioIn(dir, true, `, "--retry-failed", "--deliver-cached"`);
    expect(retried.code).toBe(2);
    expect(retried.out).toContain("cannot be combined");
  });

  test("a linked worktree reaches the same store through git-common-dir (#5339: own slot)", () => {
    const dir = repo();
    const first = runScenarioIn(dir, true);
    expect(first.code).toBe(0);

    const peer = join(tmpdir(), `agentloop-scenario-peer-${Date.now()}-${Math.random()}`);
    dirs.push(peer);
    const added = spawnSync("git", ["worktree", "add", "-b", "peer", peer, "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(added.status).toBe(0);

    const peerRun = runScenarioIn(peer, true);
    expect(peerRun.code).toBe(0);
    expect(readFileSync(join(peer, ".verify", `${first.sha}.result`), "utf8")).toBe("PASS");
    // The store is the COMMON dir's (the peer's own `.git` is a file), and each tree
    // holds its own record there rather than inheriting the other's verdict.
    const byLocation = join(
      dir,
      ".git",
      "agentloop",
      "verification",
      first.sha,
      "unit",
      "HEAD",
      "by-location",
    );
    expect(readdirSync(byLocation)).toHaveLength(2);
  });

  test("does not reuse pre-merge evidence after its resolved base advances", () => {
    const dir = repo();
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-script-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "moving-base.ts");
    const runs = join(scriptDir, "runs.log");
    writeFileSync(
      script,
      `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       import { run } from ${JSON.stringify(join(LIB, "report.ts"))};
       runScenario({ scenario: "pre-merge", resolveBase: () => process.env.TEST_BASE ?? "base-a", checks: [{ id: "only", run: () => {
         const result = run("echo run >> ${runs}");
         return { check: "only", title: "Only", pass: result.code === 0, blocking: true, durationMs: result.ms };
       }}] }, process.argv);`,
    );
    const first = spawnSync("bun", [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TEST_BASE: "origin-main-a" },
    });
    const staleDelivery = spawnSync("bun", [script, "--deliver-cached"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TEST_BASE: "origin-main-b" },
    });
    const second = spawnSync("bun", [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TEST_BASE: "origin-main-b" },
    });
    expect(first.status).toBe(0);
    expect(staleDelivery.status).toBe(1);
    expect(`${staleDelivery.stdout}${staleDelivery.stderr}`).toContain(
      "no current pre-merge cache",
    );
    expect(second.status).toBe(0);
    expect(`${second.stdout}${second.stderr}`).not.toContain("reused shared pre-merge evidence");
    expect(readFileSync(runs, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("#3170: a watchdog timeout with 0 observed failures caches TIMEOUT, not FAIL — but still exits non-zero (unverified)", () => {
    const dir = repo();
    const { sha, code } = runScenarioIn(dir, false, "", { timedOut: "true" });
    expect(code).toBe(1);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("TIMEOUT");
  });

  test("waits for a concurrent shared gate and reuses its one result", async () => {
    const dir = repo();
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-script-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "slow-scenario.ts");
    writeFileSync(
      script,
      `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       import { run } from ${JSON.stringify(join(LIB, "report.ts"))};
       runScenario({ scenario: "single-flight", resolveBase: () => "HEAD", checks: [{ id: "slow", run: () => {
         const result = run("sleep 1; echo run >> ${join(scriptDir, "runs.log")}");
         return { check: "slow", title: "Slow", pass: result.code === 0, blocking: true, durationMs: result.ms };
       }}] }, ["bun", "slow-scenario.ts"]);`,
    );
    const first = spawn("bun", [script], { cwd: dir, stdio: "ignore" });
    const sha = spawnSync("bash", ["-c", `cd ${dir} && git rev-parse HEAD`], {
      encoding: "utf8",
    }).stdout.trim();
    const lease = join(
      dir,
      ".git",
      "agentloop",
      "verification",
      sha,
      "single-flight",
      "HEAD",
      "lease.lock",
      "owner.json",
    );
    const deadline = Date.now() + 5000;
    while (!existsSync(lease) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(lease)).toBe(true);

    const second = spawnSync("bun", [script], { cwd: dir, encoding: "utf8" });
    expect(second.status).toBe(0);
    expect(`${second.stdout}${second.stderr}`).toContain("reused shared single-flight evidence");
    expect(`${second.stdout}${second.stderr}`).toContain("Reused evidence");
    expect(`${second.stdout}${second.stderr}`).toContain(`.verify/${sha}.*`);
    await new Promise<void>((resolve) => first.once("exit", () => resolve()));
    expect(existsSync(lease)).toBe(false);
    expect(readFileSync(join(scriptDir, "runs.log"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a clean and a dirty sibling race through one shared gate (#4800)", async () => {
    const dir = repo();
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-script-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "slow-scenario.ts");
    const runs = join(scriptDir, "runs.log");
    writeFileSync(
      script,
      `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       import { run } from ${JSON.stringify(join(LIB, "report.ts"))};
       runScenario({ scenario: "single-flight-dirty", resolveBase: () => "HEAD", checks: [{ id: "slow", run: () => {
         const result = run("echo start >> ${runs}; sleep 1; echo end >> ${runs}");
         return { check: "slow", title: "Slow", pass: result.code === 0, blocking: true, durationMs: result.ms };
       }}] }, process.argv);`,
    );
    const peer = join(tmpdir(), `agentloop-scenario-dirty-peer-${Date.now()}-${Math.random()}`);
    dirs.push(peer);
    expect(
      spawnSync("git", ["worktree", "add", "-b", `peer-dirty-${Date.now()}`, peer, "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      }).status,
    ).toBe(0);
    writeFileSync(join(peer, "untracked.txt"), "dirty\n");

    // Do not wait for either lease: this is the race that used to let the dirty
    // caller observe no shared lock and start its own worktree-local gate.
    const clean = spawn("bun", [script], { cwd: dir, stdio: "ignore" });
    const dirty = spawn("bun", [script], { cwd: peer, stdio: "ignore" });
    const [cleanCode, dirtyCode] = await Promise.all(
      [clean, dirty].map(
        (child) => new Promise<number | null>((resolve) => child.once("exit", resolve)),
      ),
    );
    expect(cleanCode).toBe(0);
    expect(dirtyCode).toBe(0);
    const events = readFileSync(runs, "utf8").trim().split("\n");
    // A dirty caller either waits and reuses the clean report (one pair), or
    // validates first and makes the clean caller run after it (two pairs).
    // In neither ordering may two gates overlap as start,start,end,end.
    expect(events).toEqual(
      events.length === 2 ? ["start", "end"] : ["start", "end", "start", "end"],
    );
  });

  test("two dirty siblings serialize through the shared coordinator (#4800)", async () => {
    const dir = repo();
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-script-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "dirty-scenario.ts");
    const runs = join(scriptDir, "runs.log");
    writeFileSync(
      script,
      `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       import { run } from ${JSON.stringify(join(LIB, "report.ts"))};
       runScenario({ scenario: "dirty-single-flight", resolveBase: () => "HEAD", checks: [{ id: "slow", run: () => {
         const result = run("echo start >> ${runs}; sleep 1; echo end >> ${runs}");
         return { check: "slow", title: "Slow", pass: result.code === 0, blocking: true, durationMs: result.ms };
       }}] }, process.argv);`,
    );
    const peers = ["a", "b"].map((suffix) =>
      join(tmpdir(), `agentloop-dirty-${suffix}-${Date.now()}-${Math.random()}`),
    );
    dirs.push(...peers);
    for (const [index, peer] of peers.entries()) {
      expect(
        spawnSync(
          "git",
          ["worktree", "add", "-b", `peer-dirty-${index}-${Date.now()}`, peer, "HEAD"],
          {
            cwd: dir,
            encoding: "utf8",
          },
        ).status,
      ).toBe(0);
      writeFileSync(join(peer, "untracked.txt"), "dirty\n");
    }

    const codes = await Promise.all(
      peers.map((peer) => {
        const child = spawn("bun", [script], { cwd: peer, stdio: "ignore" });
        return new Promise<number | null>((resolve) => child.once("exit", resolve));
      }),
    );
    expect(codes).toEqual([0, 0]);
    expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["start", "end", "start", "end"]);
  });

  test("fails closed for an incomplete lease instead of deleting a concurrent owner's lock", () => {
    const dir = repo();
    const lease = join(dir, ".verify", ".leases", "unit.lock");
    mkdirSync(lease, { recursive: true });
    writeFileSync(join(lease, "owner.json"), "not json\n", { encoding: "utf8", flag: "w" });

    const result = runScenarioIn(dir, true, `, "--only", "only"`);
    expect(result.code).toBe(3);
    expect(readFileSync(join(lease, "owner.json"), "utf8")).toBe("not json\n");
  });

  test("fails closed for a corrupt shared lease instead of deleting a concurrent owner's lock (#5361)", () => {
    const dir = repo();
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    const lock = join(dir, ".git", "agentloop", "verification", sha, "unit", "HEAD", "lease.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), "not json\n", { encoding: "utf8", flag: "w" });

    const result = runScenarioIn(dir, true);
    expect(result.code).toBe(3);
    expect(result.out).toContain("unreadable shared verification lease");
    expect(result.out).toContain("refusing duplicate gate admission");
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe("not json\n");
  });

  test("fails closed for a corrupt retry lease instead of deleting a concurrent owner's lock (#5361)", () => {
    const dir = repo();
    const first = runScenarioIn(dir, false);
    expect(first.code).toBe(1);
    const lock = join(
      dir,
      ".git",
      "agentloop",
      "verification",
      first.sha,
      "unit",
      "HEAD",
      "lease.lock",
    );
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), "not json\n", { encoding: "utf8", flag: "w" });

    const retried = runScenarioIn(dir, true, `, "--retry-failed"`);
    expect(retried.code).toBe(3);
    expect(retried.out).toContain("unreadable shared verification lease");
    expect(retried.out).toContain("refusing retry admission");
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe("not json\n");
  });

  test("fails closed for incomplete shared evidence instead of overwriting it", () => {
    const dir = repo();
    // Produce a real record first, then truncate it the way a crashed publisher would:
    // report.md present, the atomic metadata commit missing.
    const first = runScenarioIn(dir, true);
    expect(first.code).toBe(0);
    const coordination = join(dir, ".git", "agentloop", "verification", first.sha, "unit", "HEAD");
    const slots = readdirSync(join(coordination, "by-location"));
    expect(slots).toHaveLength(1);
    const record = join(coordination, "by-location", slots[0]);
    rmSync(join(record, "metadata.json"));
    rmSync(join(record, "result"));
    writeFileSync(join(record, "report.md"), "partial report\n");

    const result = runScenarioIn(dir, true);
    expect(result.code).toBe(3);
    expect(readFileSync(join(record, "report.md"), "utf8")).toBe("partial report\n");
    expect(existsSync(join(coordination, "lease.lock"))).toBe(false);
  });
});

/**
 * #5361 — creating a lease used to `mkdir` then `writeFile(owner.json)`. A racer
 * that hit EEXIST in that window saw `owner === undefined` and fail-closed with
 * exit 3, including on a healthy concurrent start. Fail-closed for a *corrupt*
 * owner.json is still required; a healthy race must not look like one.
 *
 * The mutation is the atomic invariant: whenever `lease.lock` exists as a
 * directory, `owner.json` is already inside. A concurrent observer polling
 * `exists(lock) && !exists(lock/owner.json)` during create must see that state
 * zero times. Reintroducing mkdir-then-write trips the observer; gutting the
 * observer fails the planted-empty reject guard.
 */
describe("runScenario — atomic lease create (#5361)", () => {
  function waitExit(
    child: ReturnType<typeof spawn>,
  ): Promise<{ code: number | null; out: string }> {
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      out += String(chunk);
    });
    return new Promise((resolve) => child.once("exit", (code) => resolve({ code, out })));
  }

  function slowScript(runs: string, scenario = "unit"): string {
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-lease-race-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "slow.ts");
    writeFileSync(
      script,
      `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       import { run } from ${JSON.stringify(join(LIB, "report.ts"))};
       runScenario({ scenario: ${JSON.stringify(scenario)}, resolveBase: () => "HEAD", checks: [{ id: "slow", run: () => {
         const result = run("echo run >> ${runs}; sleep 0.5; echo done >> ${runs}");
         return { check: "slow", title: "Slow", pass: process.env.TEST_FAIL === "1" ? false : result.code === 0, blocking: true, durationMs: result.ms };
       }}] }, process.argv);`,
    );
    return script;
  }

  function race(script: string, cwdA: string, cwdB: string, args: string[] = []) {
    const a = spawn("bun", [script, ...args], { cwd: cwdA });
    const b = spawn("bun", [script, ...args], { cwd: cwdB });
    return Promise.all([waitExit(a), waitExit(b)]);
  }

  function sharedLockPath(dir: string, sha: string, scenario: string): string {
    return join(dir, ".git", "agentloop", "verification", sha, scenario, "HEAD", "lease.lock");
  }

  function localLockPath(dir: string, scenario = "unit"): string {
    return join(dir, ".verify", ".leases", `${scenario}.lock`);
  }

  /**
   * Busy-poll `lock` from a sibling process. Returns how many times the lock
   * directory was visible without `owner.json`. Stop by resolving `hits()`.
   */
  function startEmptyLockObserver(lock: string): {
    ready: Promise<void>;
    hits: () => Promise<number>;
  } {
    const work = mkdtempSync(join(tmpdir(), "agentloop-lease-observe-"));
    dirs.push(work);
    const stopFile = join(work, "stop");
    const readyFile = join(work, "ready");
    const script = join(work, "observe.ts");
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from "node:fs";
       const lock = process.argv[2];
       const stop = process.argv[3];
       const ready = process.argv[4];
       writeFileSync(ready, "1");
       let hits = 0;
       let seenOwner = false;
       while (!existsSync(stop)) {
         if (existsSync(lock + "/owner.json")) {
           seenOwner = true;
         } else if (
           !seenOwner &&
           existsSync(lock) &&
           !existsSync(lock + "/owner.json")
         ) {
           // Count only the CREATE window. rmSync unlinks owner.json before
           // the directory; that teardown is not the mkdir→write race.
           hits++;
         }
       }
       process.stdout.write(String(hits));`,
    );
    const child = spawn("bun", [script, lock, stopFile, readyFile]);
    const ready = (async () => {
      const deadline = Date.now() + 5000;
      while (!existsSync(readyFile) && Date.now() < deadline) await Bun.sleep(5);
      if (!existsSync(readyFile)) throw new Error("empty-lock observer never became ready");
    })();
    return {
      ready,
      hits: async () => {
        writeFileSync(stopFile, "1");
        const result = await waitExit(child);
        const raw = result.out.trim();
        if (!/^\d+$/.test(raw)) return -1;
        return Number(raw);
      },
    };
  }

  async function withEmptyLockObserver(lock: string, fn: () => Promise<void>): Promise<number> {
    const observer = startEmptyLockObserver(lock);
    let error: unknown;
    try {
      await observer.ready;
      await fn();
    } catch (e) {
      error = e;
    }
    const hits = await observer.hits();
    if (error) throw error;
    return hits;
  }

  test("reject guard: the empty-lock observer reports a planted mkdir-without-owner", async () => {
    const parent = mkdtempSync(join(tmpdir(), "agentloop-lease-plant-"));
    dirs.push(parent);
    const lock = join(parent, "lease.lock");
    mkdirSync(lock);
    const hits = await withEmptyLockObserver(lock, () => Bun.sleep(20));
    expect(hits).toBeGreaterThan(0);
  });

  test("reject guard: observer trips on mkdir-then-write, the window production must not have", async () => {
    const parent = mkdtempSync(join(tmpdir(), "agentloop-lease-window-"));
    dirs.push(parent);
    const lock = join(parent, "lease.lock");
    const hits = await withEmptyLockObserver(lock, async () => {
      mkdirSync(lock);
      await Bun.sleep(30);
      writeFileSync(join(lock, "owner.json"), "{}\n");
    });
    expect(hits).toBeGreaterThan(0);
  });

  test("reject: does not replace a pre-existing empty local lock directory", () => {
    const dir = repo();
    const lock = localLockPath(dir);
    mkdirSync(lock, { recursive: true });
    const result = runScenarioIn(dir, true, `, "--only", "only"`);
    expect(result.code).toBe(3);
    expect(result.out).toContain("unreadable verification lease");
    expect(existsSync(join(lock, "owner.json"))).toBe(false);
    expect(readdirSync(lock)).toEqual([]);
  });

  test("reject: does not replace a pre-existing empty shared lock directory", () => {
    const dir = repo();
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    const lock = sharedLockPath(dir, sha, "unit");
    mkdirSync(lock, { recursive: true });
    const result = runScenarioIn(dir, true);
    expect(result.code).toBe(3);
    expect(result.out).toContain("unreadable shared verification lease");
    expect(existsSync(join(lock, "owner.json"))).toBe(false);
    expect(readdirSync(lock)).toEqual([]);
  });

  test("accept: two shared acquires race; neither fail-closes as unreadable", async () => {
    const dir = repo();
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    const runsDir = mkdtempSync(join(tmpdir(), "agentloop-lease-runs-"));
    dirs.push(runsDir);
    const runs = join(runsDir, "runs.log");
    const script = slowScript(runs, "shared-race");
    const lock = sharedLockPath(dir, sha, "shared-race");
    const observer = startEmptyLockObserver(lock);
    await observer.ready;
    const [a, b] = await race(script, dir, dir);
    const hits = await observer.hits();
    const combined = `${a.out}${b.out}`;
    expect(hits).toBe(0);
    expect([a.code, b.code].sort()).toEqual([0, 0]);
    expect(combined).not.toContain("unreadable shared verification lease");
    expect(combined).not.toContain("refusing duplicate gate admission");
    expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["run", "done"]);
    expect(combined).toContain("reused shared shared-race evidence");
  }, 20000);

  test("accept: two local acquires race; loser is already-running, not unreadable", async () => {
    const dir = repo();
    const runsDir = mkdtempSync(join(tmpdir(), "agentloop-lease-runs-"));
    dirs.push(runsDir);
    const runs = join(runsDir, "runs.log");
    const script = slowScript(runs);
    const lock = localLockPath(dir);
    const observer = startEmptyLockObserver(lock);
    await observer.ready;
    const [a, b] = await race(script, dir, dir, ["--only", "slow"]);
    const hits = await observer.hits();
    const codes = [a.code, b.code].sort();
    const loser = a.code === 3 ? a : b;
    const winner = a.code === 0 ? a : b;
    expect(hits).toBe(0);
    expect(codes).toEqual([0, 3]);
    expect(loser.out).toContain("already running");
    expect(loser.out).not.toContain("unreadable verification lease");
    expect(winner.out).not.toContain("unreadable verification lease");
    expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["run", "done"]);
  }, 20000);

  test("accept: two --retry-failed acquires race; neither fail-closes as unreadable", async () => {
    const dir = repo();
    const runsDir = mkdtempSync(join(tmpdir(), "agentloop-lease-runs-"));
    dirs.push(runsDir);
    const runs = join(runsDir, "runs.log");
    const script = slowScript(runs, "retry-race");
    const failed = spawnSync("bun", [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TEST_FAIL: "1" },
    });
    expect(failed.status).toBe(1);
    writeFileSync(runs, "");
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    const lock = sharedLockPath(dir, sha, "retry-race");
    const observer = startEmptyLockObserver(lock);
    await observer.ready;
    const [a, b] = await race(script, dir, dir, ["--retry-failed"]);
    const hits = await observer.hits();
    const combined = `${a.out}${b.out}`;
    expect(hits).toBe(0);
    expect([a.code, b.code].sort()).toEqual([0, 0]);
    expect(combined).not.toContain("unreadable shared verification lease");
    expect(combined).not.toContain("refusing retry admission");
    expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["run", "done"]);
  }, 20000);
});

describe("runScenario — fail-fast skip (#5223)", () => {
  test("a blocking fail skips the expensive remainder and still runs the cheap tail", () => {
    const dir = repo();
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-failfast-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "failfast.ts");
    const ran = join(scriptDir, "ran.log");
    writeFileSync(ran, "");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
       import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       const mark = (id) => appendFileSync(${JSON.stringify(ran)}, id + "\\n");
       runScenario({
         scenario: "unit",
         resolveBase: () => "HEAD",
         failFastSkip: ["expensive"],
         checks: [
           { id: "cheapFail", title: "Cheap fail", run: () => { mark("cheapFail"); return { check: "cheapFail", title: "Cheap fail", pass: false, blocking: true, durationMs: 1, rawTail: "lint red" }; } },
           { id: "expensive", title: "Expensive", run: () => { mark("expensive"); return { check: "expensive", title: "Expensive", pass: true, blocking: true, durationMs: 1 }; } },
           { id: "tail", title: "Tail", run: () => { mark("tail"); return { check: "tail", title: "Tail", pass: true, blocking: false, durationMs: 1 }; } },
         ],
       }, ["bun", "failfast.ts"]);`,
    );
    const r = spawnSync("bun", [script], { cwd: dir, encoding: "utf8" });
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("fail-fast: skipping expensive");
    expect(readFileSync(ran, "utf8").trim().split("\n")).toEqual(["cheapFail", "tail"]);
    const report = readFileSync(join(dir, ".verify", `${sha}.md`), "utf8");
    expect(report).toContain("fail-fast: skipped after a blocking failure");
    expect(report).toContain("| Tail |");
    expect(readFileSync(join(dir, ".verify", `${sha}.expensive.log`), "utf8")).toContain(
      "did not run",
    );
  });

  test("warn-only failure does not trigger fail-fast", () => {
    const dir = repo();
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-failfast-warn-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "warn.ts");
    const ran = join(scriptDir, "ran.log");
    writeFileSync(ran, "");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
       import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       runScenario({
         scenario: "unit",
         resolveBase: () => "HEAD",
         failFastSkip: ["expensive"],
         checks: [
           { id: "warn", run: () => { appendFileSync(${JSON.stringify(ran)}, "warn\\n"); return { check: "warn", title: "Warn", pass: false, blocking: false, durationMs: 1 }; } },
           { id: "expensive", run: () => { appendFileSync(${JSON.stringify(ran)}, "expensive\\n"); return { check: "expensive", title: "Expensive", pass: true, blocking: true, durationMs: 1 }; } },
         ],
       }, ["bun", "warn.ts"]);`,
    );
    const r = spawnSync("bun", [script], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(ran, "utf8").trim().split("\n")).toEqual(["warn", "expensive"]);
  });
});

describe("runScenario — same-checkout reuse is disclosed (#5223)", () => {
  test("a second full run of the same SHA names the reuse on stderr", () => {
    const dir = repo();
    const first = runScenarioIn(dir, true);
    expect(first.code).toBe(0);
    expect(first.out).not.toContain("Reused evidence");
    const second = runScenarioIn(dir, true);
    expect(second.code).toBe(0);
    expect(second.out).toContain("Reused evidence");
    // The path is resolved, not a `<sha>` template a reader has to guess at (#5339).
    const printed = /Shared record: `([^`]+)`/.exec(second.out)?.[1];
    expect(printed).toContain(first.sha);
    expect(existsSync(printed as string)).toBe(true);
  });
});

/**
 * #5339 — evidence used to be keyed by (sha, scenario, base) ALONE, so a verdict
 * produced in one tree became this SHA's verdict in every tree that shared the
 * git common dir. The fix puts the producing LOCATION in the key and in the
 * artifact.
 *
 * The reject-guard test ("the same tree still hits the cache") is load-bearing:
 * simply never reusing anything makes every other case here green while throwing
 * away #5223's whole benefit.
 */
describe("runScenario — evidence carries its production location (#5339)", () => {
  /** A scenario whose single check appends its cwd to `runs`, so re-runs are countable. */
  function countingScript(runs: string, scenario = "loc"): string {
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-location-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "counting.ts");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
       import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       runScenario({ scenario: ${JSON.stringify(scenario)}, resolveBase: () => "HEAD", checks: [{ id: "one", run: () => {
         appendFileSync(${JSON.stringify(runs)}, process.cwd() + "\\n");
         return { check: "one", title: "One", pass: process.env.TEST_FAIL !== "1", blocking: true, durationMs: 1 };
       }}] }, process.argv);`,
    );
    return script;
  }

  function runsLog(): string {
    const dir = mkdtempSync(join(tmpdir(), "agentloop-location-runs-"));
    dirs.push(dir);
    const runs = join(dir, "runs.log");
    writeFileSync(runs, "");
    return runs;
  }

  const countRuns = (runs: string): number =>
    readFileSync(runs, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;

  const shaOf = (dir: string): string =>
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

  const exec = (script: string, cwd: string, env: Record<string, string> = {}) => {
    const r = spawnSync("bun", [script], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };

  function addWorktree(dir: string, name: string): string {
    const peer = join(tmpdir(), `agentloop-location-peer-${name}-${Date.now()}-${Math.random()}`);
    dirs.push(peer);
    expect(
      spawnSync("git", ["worktree", "add", "-b", `${name}-${Date.now()}`, peer, "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      }).status,
    ).toBe(0);
    return peer;
  }

  test("accept: the report and the metadata name tree, host clone, scenario and base", () => {
    const dir = repo();
    const runs = runsLog();
    expect(exec(countingScript(runs), dir).code).toBe(0);

    const sha = shaOf(dir);
    const tree = realpathSync(dir);
    const hostClone = join(tree, ".git");
    const report = readFileSync(join(dir, ".verify", `${sha}.md`), "utf8");
    expect(report).toContain("Produced at");
    expect(report).toContain(`tree \`${tree}\``);
    expect(report).toContain(`host clone \`${hostClone}\``);
    expect(report).toContain("scenario `loc`");
    expect(report).toContain("base `HEAD`");
    expect(meta(dir, sha).location).toEqual({ worktree: tree, hostClone });
  });

  test("reject guard (#5223): a second run in the SAME tree still reuses the cache", () => {
    const dir = repo();
    const runs = runsLog();
    const script = countingScript(runs);
    expect(exec(script, dir).code).toBe(0);
    const second = exec(script, dir);
    expect(second.code).toBe(0);
    expect(second.out).toContain("reused shared loc evidence");
    expect(countRuns(runs)).toBe(1);
  });

  test("accept: a DIFFERENT tree at the same sha really re-runs instead of reusing", () => {
    const dir = repo();
    const runs = runsLog();
    const script = countingScript(runs);
    expect(exec(script, dir).code).toBe(0);

    const peer = addWorktree(dir, "rerun");
    const second = exec(script, peer);
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("reused shared loc evidence");
    // The re-run is real, and it happened in the peer.
    expect(countRuns(runs)).toBe(2);
    expect(readFileSync(runs, "utf8")).toContain(realpathSync(peer));
    // Both records survive: the second location does not overwrite the first.
    const byLocation = join(
      dir,
      ".git",
      "agentloop",
      "verification",
      shaOf(dir),
      "loc",
      "HEAD",
      "by-location",
    );
    expect(readdirSync(byLocation)).toHaveLength(2);
    // …and the divergence is stated in the report, not left for a human to notice.
    const peerReport = readFileSync(join(peer, ".verify", `${shaOf(dir)}.md`), "utf8");
    expect(peerReport).toContain("Independent evidence");
    expect(peerReport).toContain(realpathSync(dir));
  });

  test("accept: the reuse notice names the REAL shared record, and deleting it forces a re-run", () => {
    const dir = repo();
    const runs = runsLog();
    const script = countingScript(runs);
    // Run from a linked worktree: its own `.git` is a FILE, so the old advice
    // ("delete .git/agentloop/verification/<sha>") pointed at nothing (#5325).
    const peer = addWorktree(dir, "notice");
    expect(exec(script, peer).code).toBe(0);
    const second = exec(script, peer);
    expect(second.out).toContain("reused shared loc evidence");

    const printed = /Shared record: `([^`]+)`/.exec(second.out)?.[1];
    expect(printed).toBeTruthy();
    expect(existsSync(printed as string)).toBe(true);
    // The record lives in the COMMON git dir, not in the linked worktree's .git.
    expect((printed as string).startsWith(realpathSync(dir))).toBe(true);
    expect((printed as string).startsWith(realpathSync(peer))).toBe(false);

    rmSync(printed as string, { recursive: true, force: true });
    rmSync(join(peer, ".verify"), { recursive: true, force: true });
    const third = exec(script, peer);
    expect(third.code).toBe(0);
    expect(third.out).not.toContain("reused shared loc evidence");
    expect(countRuns(runs)).toBe(2);
  });

  test("accept: reusing a cached FAIL says why it was not re-run and how to force one", () => {
    const dir = repo();
    const runs = runsLog();
    const script = countingScript(runs);
    expect(exec(script, dir, { TEST_FAIL: "1" }).code).toBe(1);
    const second = exec(script, dir, { TEST_FAIL: "1" });
    expect(second.code).toBe(1);
    expect(second.out).toContain("reused shared loc evidence");
    expect(second.out).toContain("--retry-failed");
    expect(countRuns(runs)).toBe(1);
  });

  test("reject: a record filed in this slot but claiming another tree is not reused", () => {
    const dir = repo();
    const runs = runsLog();
    const script = countingScript(runs);
    expect(exec(script, dir).code).toBe(0);

    // The slot is location-keyed, but the producer's own statement is checked too:
    // a record moved (or forged) into this slot still answers only for where it was made.
    const slotRoot = join(
      dir,
      ".git",
      "agentloop",
      "verification",
      shaOf(dir),
      "loc",
      "HEAD",
      "by-location",
    );
    const [slot] = readdirSync(slotRoot);
    const metadataPath = join(slotRoot, slot, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.location = { worktree: "/somewhere/else", hostClone: "/somewhere/else/.git" };
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);

    // Fail-closed: evidence-shaped but untrustworthy is neither reused nor overwritten,
    // and the refusal names the resolved record so the way out is followable.
    const second = exec(script, dir);
    expect(second.code).toBe(3);
    expect(second.out).not.toContain("reused shared loc evidence");
    expect(second.out).toContain("unreadable shared verification evidence");
    expect(second.out).toContain(join(slotRoot, slot));
    expect(countRuns(runs)).toBe(1);
  });

  test("a worktree path with spaces or dots stays one safe directory segment", () => {
    const dir = repo();
    const runs = runsLog();
    const script = countingScript(runs);
    const odd = join(tmpdir(), `agentloop-loc odd..${Date.now()}`);
    dirs.push(odd);
    expect(
      spawnSync("git", ["worktree", "add", "-b", `odd-${Date.now()}`, odd, "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      }).status,
    ).toBe(0);
    expect(exec(script, odd).code).toBe(0);
    const slots = readdirSync(
      join(dir, ".git", "agentloop", "verification", shaOf(dir), "loc", "HEAD", "by-location"),
    );
    expect(slots).toHaveLength(1);
    // One segment, no separator and no traversal smuggled in from the path.
    expect(slots[0]).not.toContain("/");
    expect(slots[0]).not.toContain(" ");
    expect(slots[0].split("-").at(-1)).toMatch(/^[0-9a-f]{12}$/);
  });

  test('unknown three-state (#5140): an undeterminable host clone reads "unknown", not omitted', () => {
    const dir = repo();
    const runs = runsLog();
    const script = countingScript(runs);
    // A git shim that fails ONLY `rev-parse --git-common-dir`; the state-dir
    // override still gives the runner a shared root to publish into.
    const shimDir = mkdtempSync(join(tmpdir(), "agentloop-location-shim-"));
    dirs.push(shimDir);
    const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/bash\nfor a in "$@"; do [ "$a" = "--git-common-dir" ] && exit 1; done\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(shimDir, "git"), 0o755);
    const state = mkdtempSync(join(tmpdir(), "agentloop-location-state-"));
    dirs.push(state);

    const r = exec(script, dir, {
      PATH: `${shimDir}:${process.env.PATH}`,
      AGENTLOOP_VERIFICATION_STATE_DIR: state,
    });
    expect(r.code).toBe(0);
    const sha = shaOf(dir);
    expect(meta(dir, sha).location).toEqual({ worktree: realpathSync(dir), hostClone: "unknown" });
    expect(readFileSync(join(dir, ".verify", `${sha}.md`), "utf8")).toContain(
      "host clone `unknown`",
    );
  });
});

/**
 * #5339 blocker: the "Force a real re-run" line is an EXECUTABLE command an agent is
 * told to paste. `record` is a resolved filesystem path (git common dir), and paths may
 * legally contain `'`. Interpolating it raw inside single quotes breaks a legitimate
 * path's command and lets a hostile one close the quote and append a second command —
 * to an `rm -rf`.
 *
 * Both acceptance directions matter. Deleting `record` from the command would silence
 * every injection assertion while destroying the only thing the notice is for: naming
 * the record to remove. So the accept cases assert the command still REMOVES THE REAL
 * RECORD, not merely that it parses.
 */
describe("provenanceNotice force-rerun command (#5339)", () => {
  const SHA = "a05fdc3ddebb82fe00b65f53a63278d965ad72a4";

  const cached: CachedEvidence = {
    report: "# report\n",
    result: "PASS",
    coverage: { fullScenario: true, checks: ["build"] },
    location: { worktree: "/tmp/tree", hostClone: "/tmp/clone/.git" },
  };

  /** The command exactly as the notice offers it for pasting. */
  function forceCommand(record: string | undefined): string {
    const line = provenanceNotice(cached, SHA, record).match(/Force a real re-run here: `([^`]*)`/);
    expect(line).not.toBeNull();
    return (line as RegExpMatchArray)[1];
  }

  /** A throwaway cwd holding a `.verify/<sha>.log` plus a record dir at `record`. */
  function fixture(recordName: string): { cwd: string; record: string } {
    const cwd = mkdtempSync(join(tmpdir(), "agentloop-force-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".verify"), { recursive: true });
    writeFileSync(join(cwd, ".verify", `${SHA}.log`), "x");
    const record = join(cwd, recordName);
    mkdirSync(record, { recursive: true });
    writeFileSync(join(record, "metadata.json"), "{}");
    return { cwd, record };
  }

  const shell = (bin: string, args: string[], cwd?: string) =>
    spawnSync(bin, args, { encoding: "utf8", cwd });

  test("accept: a legitimate path containing `'` produces a command both shells can parse", () => {
    const cmd = forceCommand("/tmp/o'brien/agentloop/verification/abc");
    for (const sh of ["bash", "zsh"]) {
      const r = shell(sh, ["-n", "-c", cmd]);
      expect(`${sh}:${r.status}:${r.stderr}`).toBe(`${sh}:0:`);
    }
  });

  test("accept: the command actually removes the quoted record, not a mangled path", () => {
    const { cwd, record } = fixture("o'brien");
    const keep = join(cwd, "keep.txt");
    writeFileSync(keep, "untouched");

    const r = shell("bash", ["-c", forceCommand(record)], cwd);
    expect(`${r.status}:${r.stderr}`).toBe("0:");
    expect(existsSync(record)).toBe(false);
    expect(existsSync(join(cwd, ".verify", `${SHA}.log`))).toBe(false);
    expect(readFileSync(keep, "utf8")).toBe("untouched");
  });

  test("accept: an ordinary path yields byte-for-byte the command it always did", () => {
    expect(forceCommand("/tmp/clone/.git/agentloop/verification/abc")).toBe(
      `rm -rf .verify/${SHA}.* '/tmp/clone/.git/agentloop/verification/abc'`,
    );
  });

  test("accept: with no shared record the command still targets the local artifacts", () => {
    expect(forceCommand(undefined)).toBe(`rm -rf .verify/${SHA}.*`);
  });

  test("reject: an injection attempt stays one rm argument and runs no second command", () => {
    const { cwd } = fixture("plain");
    const sentinel = join(cwd, "pwned");
    const hostile = `/tmp/x'; touch ${sentinel}; '`;
    const cmd = forceCommand(hostile);

    // The literal path is still named — a fix that drops `record` must not pass here.
    expect(cmd).toContain("touch");
    const r = shell("bash", ["-c", cmd], cwd);
    expect(r.status).toBe(0);
    expect(existsSync(sentinel)).toBe(false);

    // ...and it was rejected as "no such path", not as a broken command.
    expect(r.stderr).not.toContain("unexpected EOF");
    for (const sh of ["bash", "zsh"]) {
      expect(shell(sh, ["-n", "-c", cmd]).status).toBe(0);
    }
  });
});

/**
 * #5591 (epic #5560, W1.1a) — the carrying surface for `UNKNOWN`.
 *
 * Before this, `scenario.ts` ran `c.run(ctx)` bare. A check that THREW took the
 * whole run down, so no `CheckResult` was produced at all — and `UNKNOWN`, whose
 * criterion is literally "no CheckResult was produced", had nowhere to live. The
 * class was self-referential and unreachable
 * (docs/architecture/verification-result-taxonomy.md §5.4).
 *
 * The cases below are the accept-path iron law, not decoration. A wrapper that
 * marks EVERYTHING `UNKNOWN` satisfies every "a throw is classified UNKNOWN"
 * assertion, and so does one that classifies nothing at all if you only ever feed
 * it throws. `scripts/nightly-test.ts:1435-1442` is the cautionary shape: it does
 * wrap `step.run()`, but its catch writes `pass = false`, collapsing "it threw"
 * and "it failed" into one boolean. Case 4 is the assertion that keeps this
 * wrapper from repeating that.
 */
describe("runCheckGuarded — a throwing check becomes a check-level UNKNOWN (#5591)", () => {
  const ctx: RunContext = { base: "base", sha: "deadbeef", changedFiles: "" };

  const okResult: CheckResult = {
    check: "ok",
    title: "A check that returns normally",
    pass: true,
    blocking: true,
    durationMs: 42,
    stats: { errors: 0, files: 7 },
    rawTail: "tail",
    rawFull: "full output",
  };

  const spec = (id: string, run: CheckSpec["run"], extra: Partial<CheckSpec> = {}): CheckSpec => ({
    id,
    run,
    ...extra,
  });

  test("1 ACCEPT: a normally-returning check is passed through field-for-field", () => {
    const got = runCheckGuarded(
      spec("ok", () => okResult),
      ctx,
    );
    // Field-for-field: same values AND no extra keys (no stray `failure`, no
    // re-measured duration overwriting the check's own).
    expect(got).toEqual(okResult);
    expect(Object.keys(got).sort()).toEqual(Object.keys(okResult).sort());
    expect(got.failure).toBeUndefined();
  });

  test("1 ACCEPT: a normally-returning WARN-ONLY check keeps blocking:false", () => {
    const warn: CheckResult = { ...okResult, check: "warn", blocking: false, pass: false };
    const got = runCheckGuarded(
      spec("warn", () => warn, { blocking: false }),
      ctx,
    );
    // The wrapper must not promote an ordinary warn-only failure to a hard gate.
    expect(got).toEqual(warn);
    expect(got.blocking).toBe(false);
  });

  test("2 REJECT: a throwing check yields class UNKNOWN / no-check-result-produced, red", () => {
    const got = runCheckGuarded(
      spec("boom", () => {
        throw new Error("kaboom from inside the check");
      }),
      ctx,
    );
    expect(got.check).toBe("boom");
    expect(got.pass).toBe(false);
    expect(got.blocking).toBe(true);
    expect(got.failure).toEqual({ class: "UNKNOWN", reason: "no-check-result-produced" });
    // Never a downgrade: `passed()` tolerates pass / !blocking / skipped — an
    // UNKNOWN must trip none of them.
    expect(isSkipped(got)).toBe(false);
    expect(passed([got])).toBe(false);
    // …and the thrown message survives, or a human has nothing to act on.
    expect(got.rawTail).toContain("kaboom from inside the check");
  });

  test("2 REJECT: an UNKNOWN derives FAIL, never TIMEOUT (no fabricated timeout stats)", () => {
    const got = runCheckGuarded(
      spec("boom", () => {
        throw new Error("kaboom");
      }),
      ctx,
    );
    expect(String(got.stats?.timedOut)).not.toBe("true");
    expect(deriveResult([got])).toBe("FAIL");
  });

  test("2 REJECT: a non-Error throw (string, undefined, null, 0) is an UNKNOWN, not a crash", () => {
    for (const thrown of ["a bare string", undefined, null, 0]) {
      const got = runCheckGuarded(
        spec("boom", () => {
          throw thrown;
        }),
        ctx,
      );
      expect(got.failure).toEqual({ class: "UNKNOWN", reason: "no-check-result-produced" });
      expect(got.pass).toBe(false);
      expect(got.blocking).toBe(true);
    }
  });

  /**
   * The ONE behavioural axis this wrapper has a choice about, tested in both
   * directions. The accept case above only exercises a warn-only check that
   * RETURNS — that path never reads `spec.blocking` at all, so it says nothing
   * about what a warn-only check that THROWS becomes.
   *
   * Forcing `blocking: true` here would let a single buggy warn-only check turn
   * the gate red for everyone; "a warn-only check threw" belongs to the
   * UNKNOWN-rate ceiling (taxonomy §7.2), not to the gate's colour. The class
   * is carried in both cases either way — that is what makes it observable.
   */
  test("2 REJECT (warn-only): a throwing warn-only check is UNKNOWN but stays blocking:false", () => {
    const got = runCheckGuarded(
      spec(
        "warn",
        () => {
          throw new Error("kaboom");
        },
        { blocking: false },
      ),
      ctx,
    );
    expect(got.failure).toEqual({ class: "UNKNOWN", reason: "no-check-result-produced" });
    expect(got.pass).toBe(false);
    // Not promoted: the wrapper reports the class, it does not re-colour the gate.
    expect(got.blocking).toBe(false);
  });

  test("2 REJECT (default): a throwing check that declared no blocking IS blocking:true", () => {
    // The dual of the case above — the pair is what proves `c.blocking ?? true`
    // is being read rather than a constant being written. A wrapper hardcoding
    // either literal fails exactly one of these two.
    const got = runCheckGuarded(
      spec("boom", () => {
        throw new Error("kaboom");
      }),
      ctx,
    );
    expect(got.failure?.class).toBe("UNKNOWN");
    expect(got.blocking).toBe(true);
    expect(passed([got])).toBe(false);
  });

  test("3 REASON-OF-REJECTION: in one run, only the throwing check is UNKNOWN", () => {
    // Proves the wrapper is not simply stamping UNKNOWN on everything — the
    // failure mode a reject-only suite cannot see.
    const specs = [
      spec("ok", () => okResult),
      spec("boom", () => {
        throw new Error("kaboom");
      }),
      spec("red", () => ({ ...okResult, check: "red", pass: false })),
    ];
    const results = specs.map((s) => runCheckGuarded(s, ctx));
    expect(results.map((r) => r.check)).toEqual(["ok", "boom", "red"]);
    expect(results.map((r) => r.failure?.class ?? null)).toEqual([null, "UNKNOWN", null]);
    expect(results.map((r) => r.pass)).toEqual([true, false, false]);
  });

  test("4 ANTI-SAME-COLOUR: 'it threw' and 'it failed' share the boolean but NOT the class", () => {
    const threw = runCheckGuarded(
      spec("boom", () => {
        throw new Error("kaboom");
      }),
      ctx,
    );
    const failed = runCheckGuarded(
      spec("red", () => ({ ...okResult, check: "red", pass: false })),
      ctx,
    );
    // The boolean cannot tell them apart. That is exactly the nightly-test.ts
    // bug (`catch { pass = false }`) this must not repeat.
    expect(threw.pass).toBe(failed.pass);
    // The class can, and must.
    expect(threw.failure?.class).toBe("UNKNOWN");
    expect(failed.failure?.class).not.toBe("UNKNOWN");
    expect(threw.failure?.class).not.toBe(failed.failure?.class);
  });
});

describe("runScenario — a throwing check does not take the run down (#5591)", () => {
  /** A scenario whose middle check throws; the other two return normally. */
  function runThrowingIn(dir: string): { sha: string; code: number; out: string } {
    const scriptDir = mkdtempSync(join(tmpdir(), "agentloop-scenario-throw-"));
    dirs.push(scriptDir);
    const script = join(scriptDir, "throw-run.ts");
    writeFileSync(
      script,
      `import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
       const ok = (id) => ({ id, run: () => ({ check: id, title: id, pass: true, blocking: true, durationMs: 1, rawFull: "log-" + id }) });
       runScenario(
         { scenario: "unit", resolveBase: () => "HEAD",
           checks: [ok("a"), { id: "boom", run: () => { throw new Error("kaboom from inside the check"); } }, ok("c")] },
         ["bun", "throw-run.ts"],
       );`,
    );
    const r = spawnSync("bun", [script], { cwd: dir, encoding: "utf8" });
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    return { sha, code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  test("the run completes, writes its artifacts, and stamps FAIL", () => {
    const dir = repo();
    const { sha, code, out } = runThrowingIn(dir);
    // A crashed process also exits non-zero, so the exit code alone proves
    // nothing. The artifacts are what prove the run reached the end.
    expect(code).not.toBe(0);
    expect(readFileSync(join(dir, ".verify", `${sha}.result`), "utf8")).toBe("FAIL");
    const report = readFileSync(join(dir, ".verify", `${sha}.md`), "utf8");
    expect(report).toContain("boom");
    expect(report).toContain("kaboom from inside the check");
    expect(out).toContain("kaboom from inside the check");
  });

  test("checks AFTER the throwing one still run (the throw is contained to its check)", () => {
    const dir = repo();
    const { sha } = runThrowingIn(dir);
    // `c` is third; without containment the run would have died at `boom`.
    expect(readFileSync(join(dir, ".verify", `${sha}.c.log`), "utf8")).toContain("log-c");
    expect(readFileSync(join(dir, ".verify", `${sha}.a.log`), "utf8")).toContain("log-a");
    expect(meta(dir, sha).checks).toEqual(["a", "boom", "c"]);
  });
});
