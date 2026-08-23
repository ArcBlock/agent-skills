import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CompactedFinding,
  type CurrentSnippet,
  compactFindings,
  contextLinesForSnippet,
  fixerBrief,
  type RawFinding,
  validateCompactOutput,
} from "./compact-findings.ts";

const SCRIPT = fileURLToPath(new URL("./compact-findings.ts", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// Accept-path table from ArcBlock/arc#4316's acceptance criteria (A1-A3), reject-path (R1-R3).

describe("compactFindings — A1 accept: still-valid", () => {
  test("finding's code is still there, description still matches → status=still-valid, path:line preserved", () => {
    const findings: RawFinding[] = [
      {
        id: "c1",
        severity: "P1",
        path: "src/auth.ts",
        line: 42,
        description: "token compared with !== instead of constant-time compare",
        expectedSnippet: "if (token !== expected)",
      },
    ];
    const current: CurrentSnippet[] = [
      {
        path: "src/auth.ts",
        line: 42,
        snippet: "  if (token !== expected) {\n    throw new Error();",
      },
    ];

    const result = compactFindings(findings, current);

    expect(result).toEqual([
      {
        id: "c1",
        severity: "P1",
        path: "src/auth.ts",
        line: 42,
        description: "token compared with !== instead of constant-time compare",
        expectedSnippet: "if (token !== expected)",
        status: "still-valid",
      },
    ]);
  });
});

describe("compactFindings — A2 accept: stale (already fixed)", () => {
  test("file changed, described defect no longer present → excluded from fixerBrief, marked stale", () => {
    const findings: RawFinding[] = [
      {
        id: "c2",
        severity: "P2",
        path: "src/auth.ts",
        line: 42,
        description: "token compared with !== instead of constant-time compare",
        expectedSnippet: "if (token !== expected)",
      },
    ];
    const current: CurrentSnippet[] = [
      { path: "src/auth.ts", line: 42, snippet: "  if (timingSafeEqual(token, expected)) {" },
    ];

    const compacted = compactFindings(findings, current);

    expect(compacted[0]?.status).toBe("stale");
    expect(fixerBrief(compacted)).toEqual([]);
  });
});

describe("compactFindings — A3 accept: duplicate", () => {
  test("two findings at the same path:line → only one survives, the other is duplicate-of", () => {
    const findings: RawFinding[] = [
      {
        id: "codex-1",
        severity: "P1",
        path: "src/db.ts",
        line: 10,
        description: "SQL injection via string concat",
      },
      {
        id: "cursor-1",
        severity: "High",
        path: "src/db.ts",
        line: 10,
        description: "unescaped user input in query",
      },
    ];
    const current: CurrentSnippet[] = [{ path: "src/db.ts", line: 10, snippet: undefined }];

    const compacted = compactFindings(findings, current);

    expect(compacted).toHaveLength(2);
    expect(compacted[0]?.status).toBe("still-valid");
    expect(compacted[1]?.status).toBe("duplicate");
    expect(compacted[1]?.duplicateOf).toBe("codex-1");
    expect(fixerBrief(compacted)).toHaveLength(1);
  });

  test("long window then short window at same path:line → canonical judged against the longer window", () => {
    const longWindow = [
      '    if (rec.status !== "running") {',
      '      return { id, kind: "settled" };',
      "    }",
      "    if (isAlive(rec.pid)) {",
      '      return { id, kind: "live" };',
      "    }",
      '    return { id, kind: "ghost" };',
      "  });",
    ].join("\n");
    const shortWindow = "    if (isAlive(rec.pid)) {";
    const findings: RawFinding[] = [
      {
        id: "codex-long",
        severity: "P1",
        path: "src/watchdog.ts",
        line: 13,
        description: "ghost on remote pid",
        expectedSnippet: longWindow,
      },
      {
        id: "cursor-short",
        severity: "High",
        path: "src/watchdog.ts",
        line: 13,
        description: "same loc one-liner",
        expectedSnippet: shortWindow,
      },
    ];
    const current: CurrentSnippet[] = [
      { path: "src/watchdog.ts", line: 13, snippet: longWindow },
      { path: "src/watchdog.ts", line: 13, snippet: shortWindow },
    ];

    const compacted = compactFindings(findings, current);

    expect(compacted[0]?.status).toBe("still-valid");
    expect(compacted[1]?.status).toBe("duplicate");
    expect(compacted[1]?.duplicateOf).toBe("codex-long");
    expect(fixerBrief(compacted).map((f) => f.id)).toEqual(["codex-long"]);
  });

  test("same review thread restated at a different path:line collapses too (threadId wins over location)", () => {
    const findings: RawFinding[] = [
      {
        id: "t1",
        severity: "High",
        path: "src/db.ts",
        line: 10,
        description: "original wording",
        threadId: "thread-9",
      },
      {
        id: "t2",
        severity: "High",
        path: "src/db.ts",
        line: 12,
        description: "reworded after conductor moved the line",
        threadId: "thread-9",
      },
    ];
    const current: CurrentSnippet[] = [
      { path: "src/db.ts", line: 10, snippet: undefined },
      { path: "src/db.ts", line: 12, snippet: undefined },
    ];

    const compacted = compactFindings(findings, current);

    expect(compacted[1]?.status).toBe("duplicate");
    expect(compacted[1]?.duplicateOf).toBe("t1");
  });
});

describe("validateCompactOutput — R1 reject: summary-only fake compact", () => {
  test("a count-only object is rejected, not treated as a usable list", () => {
    const fakeCompact = { findings: 3, stale: 2 };
    expect(validateCompactOutput(fakeCompact)).toBe(false);
  });

  test("an array missing required per-finding fields is rejected", () => {
    const partial = [{ id: "c1", severity: "P1" }]; // missing path/line/description/status
    expect(validateCompactOutput(partial)).toBe(false);
  });

  test("a real compacted array validates", () => {
    const findings: RawFinding[] = [
      { id: "c1", severity: "P1", path: "a.ts", line: 1, description: "x" },
    ];
    const compacted = compactFindings(findings, [{ path: "a.ts", line: 1, snippet: undefined }]);
    expect(validateCompactOutput(compacted)).toBe(true);
  });
});

describe("compactFindings — R2 reject: must never drop a still-valid finding", () => {
  test("no expectedSnippet to compare against → uncertain, kept as still-valid (never silently dropped)", () => {
    const findings: RawFinding[] = [
      {
        id: "p1",
        severity: "P1",
        path: "src/gate.ts",
        line: 5,
        description: "auth bypass on empty token",
      },
    ];
    // No expectedSnippet on the finding, and the current snippet is unreadable — both
    // signals are missing, so the module cannot tell fixed from not-fixed.
    const current: CurrentSnippet[] = [{ path: "src/gate.ts", line: 5, snippet: undefined }];

    const compacted = compactFindings(findings, current);

    expect(compacted[0]?.status).toBe("still-valid");
    expect(fixerBrief(compacted)).toHaveLength(1);
  });

  test("current file unreadable (deleted/renamed) but expectedSnippet was given → still kept, not auto-marked stale", () => {
    const findings: RawFinding[] = [
      {
        id: "p2",
        severity: "P1",
        path: "src/moved.ts",
        line: 5,
        description: "still a real defect",
        expectedSnippet: "dangerouslySetInnerHTML",
      },
    ];
    const current: CurrentSnippet[] = [{ path: "src/moved.ts", line: 5, snippet: undefined }];

    const compacted = compactFindings(findings, current);

    expect(compacted[0]?.status).toBe("still-valid");
  });
});

describe("fixerBrief", () => {
  test("only still-valid findings reach the fixer; stale and duplicate are excluded", () => {
    const findings: RawFinding[] = [
      {
        id: "a",
        severity: "P1",
        path: "x.ts",
        line: 1,
        description: "valid",
        expectedSnippet: "foo()",
      },
      {
        id: "b",
        severity: "P2",
        path: "y.ts",
        line: 2,
        description: "fixed already",
        expectedSnippet: "bar()",
      },
      { id: "c", severity: "Medium", path: "y.ts", line: 2, description: "same spot as b" },
    ];
    const current: CurrentSnippet[] = [
      { path: "x.ts", line: 1, snippet: "  foo();" },
      { path: "y.ts", line: 2, snippet: "  baz();" },
    ];

    const compacted = compactFindings(findings, current);
    const brief = fixerBrief(compacted);

    expect(brief.map((f) => f.id)).toEqual(["a"]);
  });
});

// Production shape from ArcBlock/arc#4616 / PR #4614 Codex P1 3834456415:
// an 8-line expectedSnippet around the finding line. Default `--context 2`
// reads only a 5-line HEAD window, so includes() fails and the still-present
// P1 is marked stale. These tests go through `main()` with no `--context`.
const CODEX_P1_PATH = "src/watchdog.ts";
const CODEX_P1_LINE = 13;
const CODEX_P1_SNIPPET = [
  '    if (rec.status !== "running") {',
  '      return { id, kind: "settled", status: rec.status, pid: rec.pid, cwd: rec.cwd };',
  "    }",
  "    if (isAlive(rec.pid)) {",
  '      return { id, kind: "live", status: rec.status, pid: rec.pid, cwd: rec.cwd };',
  "    }",
  '    return { id, kind: "ghost", status: rec.status, pid: rec.pid, cwd: rec.cwd };',
  "  });",
].join("\n");
const CODEX_P1_FILE = [
  "export function classifyHiredChildren(",
  "  rows: ProcessTableRow[],",
  "  hiredIds: string[],",
  "  isAlive: PidAlive = isPidAlive,",
  "): ChildVerdict[] {",
  "  const byId = new Map(rows.map((r) => [r.id, r]));",
  "  return hiredIds.map((id) => {",
  "    const rec = byId.get(id);",
  '    if (!rec) return { id, kind: "missing", status: "missing" };',
  CODEX_P1_SNIPPET,
  "}",
  "",
].join("\n");

const CODEX_P1_FINDING: RawFinding = {
  id: "3834456415",
  severity: "P1",
  path: CODEX_P1_PATH,
  line: CODEX_P1_LINE,
  description: "cockpit remote pid=-1 treated as ghost",
  expectedSnippet: CODEX_P1_SNIPPET,
};

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "compact-findings-test",
      GIT_AUTHOR_EMAIL: "compact@test.local",
      GIT_COMMITTER_NAME: "compact-findings-test",
      GIT_COMMITTER_EMAIL: "compact@test.local",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if ((proc.exitCode ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-findings-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  return dir;
}

function commitFile(repo: string, relPath: string, content: string, message: string): void {
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(repo, ["add", "--", relPath]);
  git(repo, ["commit", "-m", message]);
}

function runDefaultCli(
  repo: string,
  findings: RawFinding[],
  extraArgs: string[] = [],
): { exitCode: number; stdout: string; stderr: string; compacted: CompactedFinding[] } {
  const inputPath = join(repo, "raw-findings.json");
  writeFileSync(inputPath, JSON.stringify(findings));
  const proc = Bun.spawnSync(["bun", SCRIPT, inputPath, ...extraArgs], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  let compacted: CompactedFinding[] = [];
  try {
    compacted = JSON.parse(stdout) as CompactedFinding[];
  } catch {
    compacted = [];
  }
  return {
    exitCode: proc.exitCode ?? 1,
    stdout,
    stderr: proc.stderr.toString(),
    compacted,
  };
}

describe("contextLinesForSnippet", () => {
  test("8-line Codex P1 window is larger than the old default of 2 and can contain the hunk", () => {
    const n = contextLinesForSnippet(CODEX_P1_SNIPPET);
    expect(n).toBeGreaterThan(2);
    expect(2 * n + 1).toBeGreaterThanOrEqual(CODEX_P1_SNIPPET.split("\n").length);
  });

  test("one-line snippet keeps the historic floor of 2", () => {
    expect(contextLinesForSnippet("    if (isAlive(rec.pid)) {")).toBe(2);
  });
});

describe("CLI default window — R reject: must not over-kill a still-present Codex P1", () => {
  test("8-line expectedSnippet still at HEAD, default flags (no --context) is not stale", () => {
    expect(CODEX_P1_SNIPPET.split("\n").length).toBeGreaterThanOrEqual(8);

    const repo = initRepo();
    commitFile(repo, CODEX_P1_PATH, CODEX_P1_FILE, "add watchdog");

    const { exitCode, compacted, stderr } = runDefaultCli(repo, [CODEX_P1_FINDING]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.status).not.toBe("stale");
    expect(compacted[0]?.status).toBe("still-valid");
    expect(fixerBrief(compacted).map((f) => f.id)).toEqual(["3834456415"]);
  });

  test("8-line P1 then same loc 1-line finding, HEAD still has the 8 lines → canonical still-valid and in fixerBrief", () => {
    expect(CODEX_P1_SNIPPET.split("\n").length).toBeGreaterThanOrEqual(8);

    const repo = initRepo();
    commitFile(repo, CODEX_P1_PATH, CODEX_P1_FILE, "add watchdog");

    const shortDuplicate: RawFinding = {
      id: "cursor-same-line",
      severity: "High",
      path: CODEX_P1_PATH,
      line: CODEX_P1_LINE,
      description: "same loc one-liner",
      expectedSnippet: "    if (isAlive(rec.pid)) {",
    };

    const { exitCode, compacted, stderr } = runDefaultCli(repo, [CODEX_P1_FINDING, shortDuplicate]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(compacted).toHaveLength(2);
    expect(compacted[0]?.id).toBe("3834456415");
    expect(compacted[0]?.status).toBe("still-valid");
    expect(compacted[1]?.status).toBe("duplicate");
    expect(compacted[1]?.duplicateOf).toBe("3834456415");
    expect(fixerBrief(compacted).map((f) => f.id)).toEqual(["3834456415"]);
  });
});

describe("CLI default window — A accept: rewritten / one-line / undecidable", () => {
  test("same 8-line Codex P1 fixture but HEAD rewrote the snippet → stale, dropped from fixerBrief", () => {
    const repo = initRepo();
    commitFile(repo, CODEX_P1_PATH, CODEX_P1_FILE, "add watchdog");
    const rewritten = CODEX_P1_FILE.replace(
      "if (isAlive(rec.pid))",
      "if (isRemoteHire(rec) || isAlive(rec.pid))",
    );
    expect(rewritten).not.toBe(CODEX_P1_FILE);
    commitFile(repo, CODEX_P1_PATH, rewritten, "fix remote pid=-1");

    const { exitCode, compacted } = runDefaultCli(repo, [CODEX_P1_FINDING]);

    expect(exitCode).toBe(0);
    expect(compacted[0]?.status).toBe("stale");
    expect(fixerBrief(compacted)).toEqual([]);
  });

  test("8-line P1 then same loc 1-line, HEAD rewrote the hunk → canonical stale, fixerBrief empty", () => {
    const repo = initRepo();
    commitFile(repo, CODEX_P1_PATH, CODEX_P1_FILE, "add watchdog");
    const rewritten = CODEX_P1_FILE.replace(
      "if (isAlive(rec.pid))",
      "if (isRemoteHire(rec) || isAlive(rec.pid))",
    );
    expect(rewritten).not.toBe(CODEX_P1_FILE);
    commitFile(repo, CODEX_P1_PATH, rewritten, "fix remote pid=-1");

    const shortDuplicate: RawFinding = {
      id: "cursor-same-line",
      severity: "High",
      path: CODEX_P1_PATH,
      line: CODEX_P1_LINE,
      description: "same loc one-liner",
      expectedSnippet: "    if (isAlive(rec.pid)) {",
    };

    const { exitCode, compacted } = runDefaultCli(repo, [CODEX_P1_FINDING, shortDuplicate]);

    expect(exitCode).toBe(0);
    expect(compacted[0]?.id).toBe("3834456415");
    expect(compacted[0]?.status).toBe("stale");
    expect(compacted[1]?.status).toBe("duplicate");
    expect(fixerBrief(compacted)).toEqual([]);
  });

  test("one-line expectedSnippet still present → still-valid", () => {
    const repo = initRepo();
    commitFile(repo, CODEX_P1_PATH, CODEX_P1_FILE, "add watchdog");

    const { compacted } = runDefaultCli(repo, [
      {
        ...CODEX_P1_FINDING,
        id: "one-line",
        expectedSnippet: "    if (isAlive(rec.pid)) {",
      },
    ]);

    expect(compacted[0]?.status).toBe("still-valid");
    expect(fixerBrief(compacted)).toHaveLength(1);
  });

  test("missing file at HEAD → still-valid (undecidable)", () => {
    const repo = initRepo();
    commitFile(repo, "src/other.ts", "export {}\n", "unrelated file");

    const { compacted } = runDefaultCli(repo, [CODEX_P1_FINDING]);

    expect(compacted[0]?.status).toBe("still-valid");
    expect(fixerBrief(compacted)).toHaveLength(1);
  });

  test("missing line at HEAD → still-valid (undecidable)", () => {
    const repo = initRepo();
    commitFile(repo, CODEX_P1_PATH, CODEX_P1_FILE, "add watchdog");

    const { compacted } = runDefaultCli(repo, [{ ...CODEX_P1_FINDING, line: 9999 }]);

    expect(compacted[0]?.status).toBe("still-valid");
    expect(fixerBrief(compacted)).toHaveLength(1);
  });
});
