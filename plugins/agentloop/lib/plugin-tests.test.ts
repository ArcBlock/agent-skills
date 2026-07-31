import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPluginTests,
  discoverTestDirs,
  minimalDirs,
  parseBunCounts,
  runPluginTests,
  touchedPluginRoots,
} from "./plugin-tests.ts";

// ── touchedPluginRoots ───────────────────────────────────────────────────────

describe("touchedPluginRoots", () => {
  test("derives one root per plugin, deduped and sorted", () => {
    const diff = [
      ".claude/plugins/agentloop/fleet/driver.ts",
      ".claude/plugins/agentloop/lib/report.ts",
      ".claude/plugins/other/skills/x/SKILL.md",
      "packages/core/src/index.ts",
    ].join("\n");
    expect(touchedPluginRoots(diff)).toEqual([
      ".claude/plugins/agentloop",
      ".claude/plugins/other",
    ]);
  });

  test("no plugin files → no roots (this is what makes the check SKIP)", () => {
    expect(touchedPluginRoots("packages/core/src/index.ts\ndocs/guides/x.md")).toEqual([]);
  });

  test("a file directly under .claude/plugins/ belongs to no plugin", () => {
    expect(touchedPluginRoots(".claude/plugins/README.md")).toEqual([]);
  });

  test("tolerates blank lines and surrounding whitespace", () => {
    expect(touchedPluginRoots("\n  .claude/plugins/a/lib/x.ts  \n\n")).toEqual([
      ".claude/plugins/a",
    ]);
  });
});

// ── minimalDirs ──────────────────────────────────────────────────────────────

describe("minimalDirs", () => {
  test("drops directories already covered by an ancestor (bun test recurses)", () => {
    expect(minimalDirs(["skills/x/test", "skills/x/test/golden", "lib"])).toEqual([
      "lib",
      "skills/x/test",
    ]);
  });

  test("keeps sibling prefixes that are not real ancestors", () => {
    // "lib2" starts with "lib" as a STRING but is not under it as a PATH.
    expect(minimalDirs(["lib", "lib2"])).toEqual(["lib", "lib2"]);
  });
});

// ── parseBunCounts ───────────────────────────────────────────────────────────

describe("parseBunCounts", () => {
  test("reads bun's summary lines", () => {
    expect(parseBunCounts(" 334 pass\n 0 fail\n 758 expect() calls\n")).toEqual({
      pass: 334,
      fail: 0,
    });
  });

  test("a crashed run with no summary reports -1, never a fake 0 fail", () => {
    expect(parseBunCounts("SyntaxError: unexpected token\n")).toEqual({ pass: -1, fail: -1 });
  });
});

// ── end-to-end against real plugin trees ─────────────────────────────────────

/** Build a throwaway repo root containing one plugin with the given test files. */
function fixtureRepo(plugin: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agentloop-plugin-tests-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ".claude/plugins", plugin, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const GREEN = `import { expect, test } from "bun:test";
test("green", () => { expect(1 + 1).toBe(2); });
`;
const RED = `import { expect, test } from "bun:test";
test("red", () => { expect(1 + 1).toBe(3); });
`;

describe("checkPluginTests (real bun runs)", () => {
  test("SKIPs when the diff touches no plugin", () => {
    const r = checkPluginTests({ changedFiles: "packages/core/src/index.ts", repoRoot: "/nope" });
    expect(r.skipped).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.stats).toEqual({});
  });

  test("green plugin suite → pass, with REAL counts in stats (not tasks=0)", () => {
    const root = fixtureRepo("demo", { "lib/a.test.ts": GREEN, "fleet/b.test.ts": GREEN });
    try {
      const r = checkPluginTests({
        changedFiles: ".claude/plugins/demo/lib/a.test.ts",
        repoRoot: root,
      });
      expect(r.pass).toBe(true);
      expect(r.blocking).toBe(true);
      expect(r.skipped).toBeUndefined();
      expect(r.stats.pass).toBe(2);
      expect(r.stats.fail).toBe(0);
      expect(r.stats.demo).toBe("2 pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a red plugin test turns the gate red — the whole point of #2643", () => {
    const root = fixtureRepo("demo", { "lib/a.test.ts": GREEN, "lib/b.test.ts": RED });
    try {
      const r = checkPluginTests({
        changedFiles: ".claude/plugins/demo/lib/b.test.ts",
        repoRoot: root,
      });
      expect(r.pass).toBe(false);
      expect(r.blocking).toBe(true);
      expect(r.stats.fail).toBe(1);
      expect(r.rawTail).toContain("FAILED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plugin with no tests reports `no tests`, not a fake green count", () => {
    const root = fixtureRepo("demo", { "lib/a.ts": "export const a = 1;\n" });
    try {
      const r = checkPluginTests({
        changedFiles: ".claude/plugins/demo/lib/a.ts",
        repoRoot: root,
      });
      expect(r.pass).toBe(true);
      expect(r.stats.demo).toBe("no tests");
      expect(r.stats.pass).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested test dirs are collapsed so nothing is counted twice", () => {
    const root = fixtureRepo("demo", {
      "skills/s/test/a.test.ts": GREEN,
      "skills/s/test/golden/b.test.ts": GREEN,
    });
    try {
      const runs = runPluginTests({
        changedFiles: ".claude/plugins/demo/skills/s/test/a.test.ts",
        repoRoot: root,
      });
      expect(runs[0].dirs).toEqual(["skills/s/test"]);
      expect(runs[0].pass).toBe(2); // 2, not 3 — the nested file runs exactly once
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discoverTestDirs ignores node_modules", () => {
    const root = fixtureRepo("demo", {
      "lib/a.test.ts": GREEN,
      "node_modules/dep/x.test.ts": RED,
    });
    try {
      const dirs = discoverTestDirs(join(root, ".claude/plugins/demo"), (cmd, cwd) => {
        const p = Bun.spawnSync(["bash", "-c", cmd], { cwd });
        return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
      });
      expect(dirs).toEqual(["lib"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
