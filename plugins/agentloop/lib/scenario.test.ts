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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("a linked worktree reuses SHA evidence through git-common-dir", () => {
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

    const reused = runScenarioIn(peer, true);
    expect(reused.code).toBe(0);
    expect(readFileSync(join(peer, ".verify", `${first.sha}.result`), "utf8")).toBe("PASS");
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

  test("fails closed for incomplete shared evidence instead of overwriting it", () => {
    const dir = repo();
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    const evidence = join(dir, ".git", "agentloop", "verification", sha, "unit", "HEAD");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "report.md"), "partial report\n");

    const result = runScenarioIn(dir, true);
    expect(result.code).toBe(3);
    expect(readFileSync(join(evidence, "report.md"), "utf8")).toBe("partial report\n");
    expect(existsSync(join(evidence, "lease.lock"))).toBe(false);
  });
});
