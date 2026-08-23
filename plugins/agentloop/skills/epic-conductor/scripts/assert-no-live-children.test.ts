/**
 * Live-hired-children watchdog (ArcBlock/arc#4605).
 *
 * Reject + accept-path: a check that always fails is the same color as a
 * correct reject. Empty hire list / settled / ghost pid must exit 0.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyHiredChildren,
  formatLiveChildrenFailure,
  type ProcessTableRow,
} from "./assert-no-live-children.ts";

const SCRIPT = fileURLToPath(new URL("./assert-no-live-children.ts", import.meta.url));
const SKILL = fileURLToPath(new URL("../SKILL.md", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const FACTORY_SKILL = join(REPO_ROOT, ".claude/skills/factory-dispatch/SKILL.md");

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tmpRuns(): string {
  const dir = mkdtempSync(join(tmpdir(), "live-children-"));
  dirs.push(dir);
  const runs = join(dir, "runs");
  mkdirSync(runs);
  return runs;
}

function writeRow(runs: string, row: ProcessTableRow): void {
  writeFileSync(join(runs, `${row.id}.json`), JSON.stringify(row));
}

function row(
  partial: Partial<ProcessTableRow> & Pick<ProcessTableRow, "id" | "status">,
): ProcessTableRow {
  return {
    pid: partial.pid ?? 0,
    cwd: partial.cwd ?? "/tmp/work",
    startedAt: partial.startedAt ?? "2026-08-21T20:30:00Z",
    ...partial,
    id: partial.id,
    status: partial.status,
  };
}

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function deadPid(): number {
  for (let pid = 2_000_000; pid > 100_000; pid -= 1000) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error("could not find a dead pid for the ghost fixture");
}

describe("classifyHiredChildren — REJECT: live hired child", () => {
  test("status=running and pid alive → live, failure text names the child id", () => {
    const hired = [
      row({
        id: "agent-28f61685",
        status: "running",
        pid: 4242,
        cwd: "/tmp/4102",
      }),
    ];
    const verdicts = classifyHiredChildren(hired, ["agent-28f61685"], () => true);
    expect(verdicts).toEqual([
      {
        id: "agent-28f61685",
        kind: "live",
        status: "running",
        pid: 4242,
        cwd: "/tmp/4102",
      },
    ]);
    const text = formatLiveChildrenFailure(verdicts.filter((v) => v.kind === "live"));
    expect(text).toContain("agent-28f61685");
    expect(text.toLowerCase()).not.toBe("busy");
    expect(text.toLowerCase()).not.toContain("busy");
  });

  test("status=running and pid=-1 is live (cockpit remote sentinel), not ghost", () => {
    const neverAlive: (pid: number) => boolean = () => {
      throw new Error("must not probe pid=-1");
    };
    const table = [
      row({
        id: "agent-ba60becc",
        status: "running",
        pid: -1,
        cwd: "/tmp/factory",
      }),
    ];
    const verdicts = classifyHiredChildren(table, ["agent-ba60becc"], neverAlive);
    expect(verdicts).toEqual([
      {
        id: "agent-ba60becc",
        kind: "live",
        status: "running",
        pid: -1,
        cwd: "/tmp/factory",
      },
    ]);
    const text = formatLiveChildrenFailure(verdicts.filter((v) => v.kind === "live"));
    expect(text).toContain("agent-ba60becc");
    expect(text.toLowerCase()).not.toContain("busy");
  });

  test("status=running with remoteId is live even when local pid is not alive", () => {
    const table = [
      row({
        id: "agent-a02ccce5",
        status: "running",
        pid: 0,
        remoteId: "agent-28f61685",
      }),
    ];
    const verdicts = classifyHiredChildren(table, ["agent-a02ccce5"], () => false);
    expect(verdicts[0]?.kind).toBe("live");
    expect(verdicts[0]?.id).toBe("agent-a02ccce5");
  });

  test('status=running with capabilities.launch="remote" is live even when local pid is not alive', () => {
    const table = [
      row({
        id: "agent-8a3fd4be",
        status: "running",
        pid: 0,
        capabilities: { launch: "remote" },
      }),
    ];
    const verdicts = classifyHiredChildren(table, ["agent-8a3fd4be"], () => false);
    expect(verdicts[0]?.kind).toBe("live");
    expect(verdicts[0]?.id).toBe("agent-8a3fd4be");
  });
});

describe("classifyHiredChildren — ACCEPT: empty hire list", () => {
  test("no hired ids → no live children, even if the table has a running row", () => {
    const table = [row({ id: "agent-28f61685", status: "running", pid: 4242 })];
    const verdicts = classifyHiredChildren(table, [], () => true);
    expect(verdicts).toEqual([]);
    expect(verdicts.filter((v) => v.kind === "live")).toEqual([]);
  });
});

describe("classifyHiredChildren — ACCEPT: settled closeout", () => {
  test("exited and stopped rows with exitedAt are not live", () => {
    const table = [
      row({
        id: "agent-28f61685",
        status: "exited",
        pid: 11,
        exitedAt: "2026-08-21T21:00:00Z",
      }),
      row({
        id: "agent-3fcd4c34",
        status: "stopped",
        pid: 12,
        exitedAt: "2026-08-21T21:01:00Z",
      }),
    ];
    const verdicts = classifyHiredChildren(table, ["agent-28f61685", "agent-3fcd4c34"], () => true);
    expect(verdicts.every((v) => v.kind === "settled")).toBe(true);
    expect(verdicts.filter((v) => v.kind === "live")).toEqual([]);
  });
});

describe("classifyHiredChildren — ACCEPT: ghost running + dead pid", () => {
  test("status=running but pid dead is a ghost, not live", () => {
    const table = [row({ id: "agent-3fcd4c34", status: "running", pid: 999_001 })];
    const verdicts = classifyHiredChildren(table, ["agent-3fcd4c34"], () => false);
    expect(verdicts).toEqual([
      {
        id: "agent-3fcd4c34",
        kind: "ghost",
        status: "running",
        pid: 999_001,
        cwd: "/tmp/work",
      },
    ]);
    expect(verdicts.filter((v) => v.kind === "live")).toEqual([]);
  });
});

describe("assert-no-live-children CLI", () => {
  test("REJECT: running + live pid exits non-zero and names the child id", () => {
    const runs = tmpRuns();
    writeRow(
      runs,
      row({
        id: "agent-28f61685",
        status: "running",
        pid: process.pid,
        cwd: "/tmp/4102",
      }),
    );
    const result = runCli(["--runs-dir", runs, "--ids", "agent-28f61685"]);
    expect(result.exitCode).not.toBe(0);
    const text = `${result.stdout}${result.stderr}`;
    expect(text).toContain("agent-28f61685");
    expect(text.toLowerCase()).not.toContain("busy");
  });

  test("REJECT: running + pid=-1 exits non-zero and names the child id", () => {
    const runs = tmpRuns();
    writeRow(
      runs,
      row({
        id: "agent-ba60becc",
        status: "running",
        pid: -1,
        cwd: "/tmp/factory",
      }),
    );
    const result = runCli(["--runs-dir", runs, "--ids", "agent-ba60becc"]);
    expect(result.exitCode).not.toBe(0);
    const text = `${result.stdout}${result.stderr}`;
    expect(text).toContain("agent-ba60becc");
    expect(text.toLowerCase()).not.toContain("busy");
    expect(text.toLowerCase()).not.toContain("ghost");
  });

  test("REJECT: running + remoteId (cockpit manager row) exits non-zero", () => {
    const runs = tmpRuns();
    writeRow(
      runs,
      row({
        id: "agent-a02ccce5",
        status: "running",
        pid: 0,
        remoteId: "agent-28f61685",
        capabilities: { launch: "remote" },
      }),
    );
    const result = runCli(["--runs-dir", runs, "--ids", "agent-a02ccce5"]);
    expect(result.exitCode).not.toBe(0);
    const text = `${result.stdout}${result.stderr}`;
    expect(text).toContain("agent-a02ccce5");
  });

  test("ACCEPT: empty hire list exits 0", () => {
    const runs = tmpRuns();
    writeRow(runs, row({ id: "agent-28f61685", status: "running", pid: process.pid }));
    const result = runCli(["--runs-dir", runs, "--ids", ""]);
    expect(result.exitCode).toBe(0);
  });

  test("ACCEPT: all exited/stopped with exitedAt exits 0", () => {
    const runs = tmpRuns();
    writeRow(
      runs,
      row({
        id: "agent-28f61685",
        status: "exited",
        pid: 11,
        exitedAt: "2026-08-21T21:00:00Z",
      }),
    );
    writeRow(
      runs,
      row({
        id: "agent-3fcd4c34",
        status: "stopped",
        pid: 12,
        exitedAt: "2026-08-21T21:01:00Z",
      }),
    );
    const result = runCli(["--runs-dir", runs, "--ids", "agent-28f61685,agent-3fcd4c34"]);
    expect(result.exitCode).toBe(0);
  });

  test("ACCEPT: status=running with a dead pid exits 0 (ghost)", () => {
    const runs = tmpRuns();
    const pid = deadPid();
    writeRow(runs, row({ id: "agent-3fcd4c34", status: "running", pid }));
    const result = runCli(["--runs-dir", runs, "--ids", "agent-3fcd4c34"]);
    expect(result.exitCode).toBe(0);
    const text = `${result.stdout}${result.stderr}`;
    expect(text.toLowerCase()).toContain("ghost");
    expect(text).toContain("agent-3fcd4c34");
  });

  test("ACCEPT: empty runs-dir (no rows) exits 0", () => {
    const runs = tmpRuns();
    const result = runCli(["--runs-dir", runs]);
    expect(result.exitCode).toBe(0);
  });
});

describe("epic-conductor SKILL.md residency rule", () => {
  test("explicit ban: live hired children ⇒ must not end_turn / close the session", () => {
    const text = readFileSync(SKILL, "utf8");
    // "stay alive" alone is the hole this issue closes — require the named
    // failure mode (hired children, status=running, pid, end_turn forbidden).
    expect(text).toMatch(/hired[\s\S]{0,500}status=running/);
    expect(text).toMatch(/status=running[\s\S]{0,400}pid/);
    expect(text).toMatch(
      /(forbidden|must not)[\s\S]{0,160}end_turn|end_turn[\s\S]{0,160}(forbidden|must not)/,
    );
    expect(text).toMatch(/close the session/);
  });

  test("closeout-after-evidence is allowed (PR URL or skip-comment, or explicit stop)", () => {
    const text = readFileSync(SKILL, "utf8");
    expect(text).toMatch(/PR URL/);
    expect(text).toMatch(/skip-comment/);
    expect(text).toMatch(/explicitly `stop`|explicitly stopped|explicit `stop`/);
  });

  test("factory cockpit pid=-1 rows must fail-closed (live, not ghost)", () => {
    const text = readFileSync(SKILL, "utf8");
    expect(text).toMatch(/pid=-1/);
    expect(text).toMatch(/fail-closed/);
  });
});

describe("factory-dispatch SKILL.md one-line hard rule", () => {
  test("end_turn ban extends to live hired children and points at epic-conductor", () => {
    const text = readFileSync(FACTORY_SKILL, "utf8");
    expect(text).toMatch(/end_turn[\s\S]{0,240}status=running|status=running[\s\S]{0,240}end_turn/);
    expect(text).toMatch(/epic-conductor/);
  });

  test("REJECT: skill must not hedge #4437/#4438 as future", () => {
    const text = readFileSync(FACTORY_SKILL, "utf8");
    expect(text).not.toContain("until workers run a CLI that includes #4437");
    expect(text).not.toContain("until #4437 CLI is live");
    expect(text).not.toContain("until the live CLI includes #4438");
  });

  test("ACCEPT: lastTurn-only is not done (GitHub evidence required)", () => {
    const text = readFileSync(FACTORY_SKILL, "utf8");
    expect(text).toMatch(/lastTurn-only is not done/);
  });

  test("ACCEPT: list-timeout LIVE=none is not death without checking pids (no until)", () => {
    const text = readFileSync(FACTORY_SKILL, "utf8");
    expect(text).toMatch(/list-timeout[\s\S]{0,40}LIVE=none[\s\S]{0,80}without checking pids/);
    expect(text).not.toMatch(/LIVE=none[\s\S]{0,80}without checking pids[\s\S]{0,40}until/);
  });
});
