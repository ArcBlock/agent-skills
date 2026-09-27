#!/usr/bin/env bun
/**
 * Evidence carry-forward, end to end through the REAL `runScenario` in a
 * throwaway git repo (the planner is unit-tested in carry-forward.test.ts;
 * this proves the wiring: donor lookup across local + shared slots, the git
 * delta, the carried row, and which checks genuinely ran).
 *
 * The fixture scenario has two checks:
 *   - `tests` — the carried one (`carryForwardChecks: ["tests"]`);
 *   - `lint`  — NOT carried, and it READS README.md: it fails when the file
 *               contains "BAD". It stands for every cheap whole-corpus check
 *               (review P1 on #7065: a carried whole-report PASS hid a lint
 *               that would have failed on the changed doc).
 * Each check appends to its own counter file, so "ran" / "did not run" is
 * observed, not inferred from report text.
 *
 * @plugin-tests:isolated spawns a child `runScenario` per step.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERIFICATION_STATE_DIR_ENV } from "./scenario.ts";

const LIB = import.meta.dir;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface Fixture {
  dir: string;
  base: string;
  testsLog: string;
  lintLog: string;
  script: string;
  state: string;
}

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(f: Fixture, files: Record<string, string>, dir = f.dir): string {
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", `change ${Object.keys(files).join(",")}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function fixture(opts: { carryChecks?: string[] | null; judge?: boolean } = {}): Fixture {
  const dir = tmp("agentloop-carry-");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, ".gitignore"), ".verify/\n");
  writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  const scriptDir = tmp("agentloop-carry-script-");
  const testsLog = join(scriptDir, "tests.log");
  const lintLog = join(scriptDir, "lint.log");
  const script = join(scriptDir, "run.ts");
  const carryChecks = opts.carryChecks === undefined ? ["tests"] : opts.carryChecks;
  const judge =
    opts.judge === false
      ? ""
      : `carryForward: (d) =>
           d.files.every((f) => f.status === "M" && f.path.endsWith(".md"))
             ? undefined
             : "not an in-place Markdown edit: " + d.files.map((f) => f.path).join(","),`;
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from "node:fs";
     import { runScenario } from ${JSON.stringify(join(LIB, "scenario.ts"))};
     runScenario(
       {
         scenario: "unit",
         resolveBase: () => ${JSON.stringify(base)},
         ${judge}
         ${carryChecks ? `carryForwardChecks: ${JSON.stringify(carryChecks)},` : ""}
         checks: [
           {
             id: "tests",
             run: () => {
               appendFileSync(${JSON.stringify(testsLog)}, "ran\\n");
               return {
                 check: "tests", title: "Tests", pass: process.env.FIXTURE_PASS !== "0", blocking: true, durationMs: 1,
                 ...(process.env.FIXTURE_ENV_GAP ? { stats: { envGap: process.env.FIXTURE_ENV_GAP } } : {}),
                 ...(process.env.FIXTURE_LOCAL_ONLY ? { reusable: false } : {}),
               };
             },
           },
           {
             id: "lint",
             run: () => {
               appendFileSync(${JSON.stringify(lintLog)}, "ran\\n");
               // Name assembled at runtime: this reads the FIXTURE repo's doc, and a
               // literal here would read to the --na static scan as a test of arc's
               // own root README (scenario.arc-conformance.test.ts, #5817).
               const bad = readFileSync(["README", "md"].join("."), "utf8").includes("BAD");
               return { check: "lint", title: "Lint", pass: !bad, blocking: true, durationMs: 1 };
             },
           },
         ],
       },
       ["bun", "run.ts", ...process.argv.slice(2)],
     );`,
  );
  return { dir, base, testsLog, lintLog, script, state: tmp("agentloop-carry-state-") };
}

function gate(f: Fixture, argv: string[] = [], env: Record<string, string> = {}, cwd = f.dir) {
  const r = spawnSync("bun", [f.script, ...argv], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, [VERIFICATION_STATE_DIR_ENV]: f.state, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const count = (path: string): number =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
const testsRuns = (f: Fixture) => count(f.testsLog);
const lintRuns = (f: Fixture) => count(f.lintLog);

function sharedMetadata(f: Fixture): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  return existsSync(f.state) ? walk(f.state).filter((p) => p.endsWith("metadata.json")) : [];
}

describe("carry-forward through the real runScenario", () => {
  test("ACCEPT: a doc-only delta carries `tests` — which does not run — while `lint` DOES run; the audit trail names donor + delta", () => {
    const f = fixture();
    const c1 = commit(f, { "src.ts": "export const a = 2;\n" });
    expect(gate(f).code).toBe(0);
    expect([testsRuns(f), lintRuns(f)]).toEqual([1, 1]);

    const c2 = commit(f, { "README.md": "# fixture, reworded\n" });
    const r = gate(f);
    expect(r.code).toBe(0);
    expect(testsRuns(f)).toBe(1); // carried: did NOT run
    expect(lintRuns(f)).toBe(2); // not carried: DID run on c2
    const report = readFileSync(join(f.dir, ".verify", `${c2}.md`), "utf8");
    expect(report).toContain("Carried-forward evidence");
    expect(report).toContain(c1.slice(0, 12));
    expect(report).toContain("README.md");
    expect(report).toMatch(/carried from/);
    expect(readFileSync(join(f.dir, ".verify", `${c2}.result`), "utf8").trim()).toBe("PASS");
    const meta = JSON.parse(readFileSync(join(f.dir, ".verify", `${c2}.metadata.json`), "utf8"));
    expect(meta.carriedFrom).toBe(c1);
    expect(meta.checks).toEqual(["tests", "lint"]);
  });

  test("REJECT (review P1 on #7065): a carried delta that breaks a NON-carried check is a FAIL — never a carried PASS", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    expect(gate(f).code).toBe(0);
    const c2 = commit(f, { "README.md": "# fixture BAD link\n" });
    const r = gate(f);
    expect(r.code).not.toBe(0);
    expect(testsRuns(f)).toBe(1); // tests carried…
    expect(lintRuns(f)).toBe(2); // …but lint ran and caught it
    expect(readFileSync(join(f.dir, ".verify", `${c2}.result`), "utf8").trim()).toBe("FAIL");
  });

  test("REJECT: a source delta is refused by the judge — every check runs, and the refusal is printed", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    gate(f);
    commit(f, { "src.ts": "export const a = 3;\n" });
    const r = gate(f);
    expect(r.code).toBe(0);
    expect(testsRuns(f)).toBe(2);
    expect(r.out).toContain("carry-forward declined");
    expect(r.out).toContain("src.ts");
  });

  test("REJECT: the nearest record is a FAIL — an older PASS is never carried past it", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    gate(f); // PASS
    commit(f, { "src.ts": "export const a = 3;\n" });
    expect(gate(f, [], { FIXTURE_PASS: "0" }).code).not.toBe(0); // FAIL recorded
    commit(f, { "README.md": "# doc after a red\n" });
    const r = gate(f);
    expect(testsRuns(f)).toBe(3); // ran again
    expect(r.out).toContain("carry-forward declined");
  });

  test("REJECT (review P2 on #7065): a newer FAIL in ANOTHER worktree's slot blocks an older PASS here", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    expect(gate(f).code).toBe(0); // c1 PASS in A
    const c2 = commit(f, { "src.ts": "export const a = 3;\n" });
    // Worktree B verifies c2 and it FAILS; A never gates c2 itself.
    const b = join(tmp("agentloop-carry-wt-"), "b");
    git(f.dir, ["worktree", "add", "-q", "--detach", b, c2]);
    expect(gate(f, [], { FIXTURE_PASS: "0" }, b).code).not.toBe(0);
    expect(sharedMetadata(f).some((p) => readFileSync(p, "utf8").includes(`"sha":"${c2}"`))).toBe(
      true,
    );
    const before = testsRuns(f);
    commit(f, { "README.md": "# doc after a red elsewhere\n" });
    const r = gate(f);
    expect(testsRuns(f)).toBe(before + 1); // not carried from c1 past c2's red
    expect(r.out).toContain("carry-forward declined");
    expect(r.out).toContain(c2.slice(0, 12));
  });

  test("--no-carry-forward forces a real run on an eligible delta", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    gate(f);
    commit(f, { "README.md": "# reworded\n" });
    expect(gate(f, ["--no-carry-forward"]).code).toBe(0);
    expect(testsRuns(f)).toBe(2);
  });

  test("REJECT: a DIRTY tree never carries — its HEAD is not what would be verified", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    gate(f);
    commit(f, { "README.md": "# reworded\n" });
    writeFileSync(join(f.dir, "src.ts"), "export const a = 999; // uncommitted\n");
    gate(f);
    expect(testsRuns(f)).toBe(2);
  });

  test("REJECT (review P1-3): a donor PASS that reported an ENV GAP is not carried", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    expect(gate(f, [], { FIXTURE_ENV_GAP: "no-docker" }).code).toBe(0);
    commit(f, { "README.md": "# reworded\n" });
    const r = gate(f);
    expect(testsRuns(f)).toBe(2);
    expect(r.out).toMatch(/environment gap/);
  });

  test("REJECT (review P1-3): a host-local donor (reusable:false) carries LOCALLY but never reaches the shared store", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    expect(gate(f, [], { FIXTURE_LOCAL_ONLY: "1" }).code).toBe(0);
    const c2 = commit(f, { "README.md": "# reworded\n" });
    expect(gate(f).code).toBe(0);
    expect(testsRuns(f)).toBe(1); // carried locally
    const forC2 = sharedMetadata(f).filter((p) => readFileSync(p, "utf8").includes(c2));
    expect(forC2).toEqual([]);
  });

  test("ACCEPT twin: a reusable donor's carried record IS published to the shared store", () => {
    const f = fixture();
    commit(f, { "src.ts": "export const a = 2;\n" });
    gate(f);
    const c2 = commit(f, { "README.md": "# reworded\n" });
    gate(f);
    const forC2 = sharedMetadata(f).filter((p) =>
      readFileSync(p, "utf8").includes(`"sha":"${c2}"`),
    );
    expect(forC2.length).toBe(1);
    expect(JSON.parse(readFileSync(forC2[0] as string, "utf8")).carriedFrom).toBeDefined();
  });

  test("no judge → no carry (the scenario behaves exactly as before)", () => {
    const f = fixture({ judge: false });
    commit(f, { "src.ts": "export const a = 2;\n" });
    gate(f);
    commit(f, { "README.md": "# reworded\n" });
    gate(f);
    expect(testsRuns(f)).toBe(2);
  });

  test("no carryForwardChecks → no carry, even with a judge", () => {
    const f = fixture({ carryChecks: null });
    commit(f, { "src.ts": "export const a = 2;\n" });
    gate(f);
    const c2 = commit(f, { "README.md": "# reworded\n" });
    const r = gate(f);
    expect(testsRuns(f)).toBe(2);
    // …and nothing CLAIMS a carry: no notice, no carriedFrom on the record.
    expect(r.out).not.toContain("carrying");
    expect(readFileSync(join(f.dir, ".verify", `${c2}.md`), "utf8")).not.toContain(
      "Carried-forward",
    );
    const meta = JSON.parse(readFileSync(join(f.dir, ".verify", `${c2}.metadata.json`), "utf8"));
    expect(meta.carriedFrom).toBeUndefined();
  });
});
