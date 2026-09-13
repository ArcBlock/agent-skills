#!/usr/bin/env bun
/**
 * Accept-path for scripts/publish-arc-plugin.sh (#6436).
 *
 * publish-agentloop.sh's cmp is empty-spin: it `cp`s Claude → Codex BEFORE the
 * check, then `echo ⚠` on mismatch with no `exit 1`. These tests exist so that
 * hole cannot land here.
 *
 * Pair mutation is load-bearing (accept-path 铁律): a script that refuses
 * everything satisfies every reject assertion. The --dry-run tests below are
 * why this is a gate rather than a comment.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN_ROOT = import.meta.dir;
const REPO_ROOT = resolve(PLUGIN_ROOT, "..", "..", "..");
const PUBLISH_SCRIPT = join(REPO_ROOT, "scripts", "publish-arc-plugin.sh");
const CLAUDE_MANIFEST = join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");

const temporaryRoots: string[] = [];
const hasGrok = Bun.which("grok") !== null;
const hasRsync = Bun.which("rsync") !== null;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tmpDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writePlugin(
  root: string,
  claude: Record<string, unknown>,
  codex?: Record<string, unknown>,
): void {
  writeJson(join(root, ".claude-plugin", "plugin.json"), claude);
  writeJson(join(root, ".codex-plugin", "plugin.json"), codex ?? claude);
}

function writeDest(
  root: string,
  marketplace: unknown = { name: "arcblock-agent-skills", plugins: [] },
): string {
  // Real git repo required: publish runs `git -C dest status --porcelain`.
  // An empty `.git` directory is not a repository (git exits 128).
  const init = Bun.spawnSync(["git", "init"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if ((init.exitCode ?? 1) !== 0) {
    throw new Error(`git init failed: ${init.stderr.toString()}`);
  }
  writeJson(join(root, ".claude-plugin", "marketplace.json"), marketplace);
  return join(root, ".claude-plugin", "marketplace.json");
}

function runPublish(
  args: string[],
  env: Record<string, string | undefined> = {},
): { exitCode: number; stdout: string; stderr: string; combined: string } {
  const result = Bun.spawnSync(["bash", PUBLISH_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return {
    exitCode: result.exitCode ?? 1,
    stdout,
    stderr,
    combined: `${stdout}${stderr}`,
  };
}

const SAMPLE = {
  name: "arc",
  version: "0.1.0",
  description: "ARC agent plugin skeleton",
  author: { name: "ArcBlock Team", email: "engineering@arcblock.io" },
  license: "MIT",
  keywords: ["arc"],
};

describe("publish-arc-plugin.sh — accept path", () => {
  test("the publish script exists", () => {
    expect(existsSync(PUBLISH_SCRIPT)).toBe(true);
  });

  test("ACCEPT: --dry-run exits 0 and prints the marketplace entry (name + version)", () => {
    const r = runPublish(["--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.combined).toContain("marketplace entry");
    expect(r.combined).toMatch(/name:\s*arc/);
    const version = (JSON.parse(readFileSync(CLAUDE_MANIFEST, "utf8")) as { version: string })
      .version;
    expect(r.combined).toMatch(new RegExp(`version:\\s*${version.replaceAll(".", "\\.")}`));
    expect(r.combined).not.toMatch(/synced /);
  });

  test("ACCEPT: --dry-run against a matching fixture prints that fixture's name + version", () => {
    const src = tmpDir("arc-plugin-ok-");
    writePlugin(src, { ...SAMPLE, name: "arc", version: "1.2.3" });
    const r = runPublish(["--dry-run"], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(0);
    expect(r.combined).toMatch(/name:\s*arc/);
    expect(r.combined).toMatch(/version:\s*1\.2\.3/);
  });

  test("ACCEPT: --dry-run does not mutate a dest marketplace even when dest is passed", () => {
    const src = tmpDir("arc-plugin-src-");
    writePlugin(src, SAMPLE);
    const dest = tmpDir("arc-plugin-dest-");
    const marketplacePath = writeDest(dest, {
      name: "arcblock-agent-skills",
      plugins: [{ name: "agentloop", version: "0.0.0" }],
    });
    const before = readFileSync(marketplacePath, "utf8");
    const r = runPublish(["--dry-run", dest], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(marketplacePath, "utf8")).toBe(before);
    expect(existsSync(join(dest, "plugins", "arc"))).toBe(false);
  });
});

describe("publish-arc-plugin.sh — consistency gate (independent, before regenerate)", () => {
  test("REJECT: extra key in .codex-plugin (regeneration would overwrite it) exits 1", () => {
    const src = tmpDir("arc-plugin-extra-");
    writePlugin(src, SAMPLE, { ...SAMPLE, extra: "drift" });
    const dest = tmpDir("arc-plugin-dest-");
    const marketplacePath = writeDest(dest);
    const before = readFileSync(marketplacePath, "utf8");
    const r = runPublish([dest], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/differ|mismatch|inconsistent/i);
    expect(
      JSON.parse(readFileSync(join(src, ".codex-plugin", "plugin.json"), "utf8")),
    ).toHaveProperty("extra", "drift");
    expect(readFileSync(marketplacePath, "utf8")).toBe(before);
    expect(existsSync(join(dest, "plugins", "arc"))).toBe(false);
  });

  test("REJECT: hand-editing one manifest version exits 1", () => {
    const src = tmpDir("arc-plugin-ver-");
    writePlugin(src, SAMPLE, { ...SAMPLE, version: "9.9.9" });
    const r = runPublish(["--dry-run"], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/differ|mismatch|inconsistent/i);
  });

  test("REJECT: mutating .claude-plugin name (regeneration copies FROM claude) exits 1", () => {
    const src = tmpDir("arc-plugin-name-");
    writePlugin(src, { ...SAMPLE, name: "not-arc" }, SAMPLE);
    const r = runPublish(["--dry-run"], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/differ|mismatch|inconsistent/i);
  });

  test("REJECT: enumerating 0 manifests is not green — names the empty count", () => {
    const src = tmpDir("arc-plugin-empty-");
    mkdirSync(src, { recursive: true });
    const r = runPublish(["--dry-run"], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).not.toBe(0);
    expect(r.combined).toMatch(/0 manifest/);
  });

  test("REJECT: a single manifest is not treated as consistent", () => {
    const src = tmpDir("arc-plugin-one-");
    mkdirSync(join(src, ".claude-plugin"), { recursive: true });
    writeJson(join(src, ".claude-plugin", "plugin.json"), SAMPLE);
    const r = runPublish(["--dry-run"], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/found 1|expected 2|only 1/i);
  });
});

describe("publish-arc-plugin.sh — source order (cmp before cp)", () => {
  test("the consistency cmp on the source tree appears before any Claude→Codex cp", () => {
    const script = readFileSync(PUBLISH_SCRIPT, "utf8");
    const check = script.indexOf("check_source_consistency");
    expect(check).toBeGreaterThan(0);
    const firstCall = script.indexOf(
      "check_source_consistency",
      check + "check_source_consistency".length,
    );
    expect(firstCall).toBeGreaterThan(check);
    const cp = script.indexOf(
      'cp "$SRC/.claude-plugin/plugin.json" "$SRC/.codex-plugin/plugin.json"',
    );
    expect(cp).toBeGreaterThan(firstCall);
    expect(script).toMatch(/cmp -s "\$claude" "\$codex"/);
    expect(script).toMatch(/differs from \.claude-plugin[\s\S]*?exit 1/);
  });
});

describe("grok plugin validate (left-shifted host accept-path)", () => {
  test.skipIf(!hasGrok)("grok plugin validate prints Plugin manifest is valid.", () => {
    const r = Bun.spawnSync(["grok", "plugin", "validate", PLUGIN_ROOT], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const combined = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(r.exitCode).toBe(0);
    expect(combined).toContain("Plugin manifest is valid.");
  });
});

describe("publish-arc-plugin.sh — live publish path", () => {
  test.skipIf(!hasRsync)("non-dry-run upserts the marketplace entry and mirrors the plugin", () => {
    const src = tmpDir("arc-plugin-pub-src-");
    writePlugin(src, SAMPLE);
    const dest = tmpDir("arc-plugin-pub-dest-");
    writeDest(dest, { name: "arcblock-agent-skills", plugins: [] });
    const r = runPublish([dest], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(0);
    const marketplace = JSON.parse(
      readFileSync(join(dest, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { plugins: Array<{ name: string; version: string }> };
    const entry = marketplace.plugins.find((p) => p.name === "arc");
    expect(entry?.version).toBe("0.1.0");
    expect(
      readFileSync(join(dest, "plugins", "arc", ".claude-plugin", "plugin.json"), "utf8"),
    ).toBe(readFileSync(join(src, ".claude-plugin", "plugin.json"), "utf8"));
  });
});

describe("publish-arc-plugin.sh — S7 three-place version gate (arc#6444)", () => {
  test.skipIf(!hasRsync)(
    "ACCEPT: live publish leaves Claude, Codex, and marketplace versions identical",
    () => {
      const src = tmpDir("arc-plugin-s7-ok-");
      writePlugin(src, { ...SAMPLE, version: "0.1.1" });
      const dest = tmpDir("arc-plugin-s7-dest-");
      writeDest(dest, { name: "arcblock-agent-skills", plugins: [] });
      const r = runPublish([dest], { ARC_PLUGIN_SRC: src });
      expect(r.exitCode).toBe(0);
      const claude = JSON.parse(
        readFileSync(join(dest, "plugins", "arc", ".claude-plugin", "plugin.json"), "utf8"),
      ) as { version: string };
      const codex = JSON.parse(
        readFileSync(join(dest, "plugins", "arc", ".codex-plugin", "plugin.json"), "utf8"),
      ) as { version: string };
      const marketplace = JSON.parse(
        readFileSync(join(dest, ".claude-plugin", "marketplace.json"), "utf8"),
      ) as { plugins: Array<{ name: string; version: string }> };
      const entry = marketplace.plugins.find((x) => x.name === "arc");
      expect(claude.version).toBe("0.1.1");
      expect(codex.version).toBe(claude.version);
      expect(entry?.version).toBe(claude.version);
    },
  );

  test("ACCEPT: --check exits 0 when marketplace entry matches plugin.json", () => {
    const src = tmpDir("arc-plugin-s7-chk-ok-");
    writePlugin(src, { ...SAMPLE, version: "0.1.1" });
    const dest = tmpDir("arc-plugin-s7-chk-dest-");
    writeDest(dest, {
      name: "arcblock-agent-skills",
      plugins: [{ name: "arc", version: "0.1.1", source: "./plugins/arc" }],
    });
    const before = readFileSync(join(dest, ".claude-plugin", "marketplace.json"), "utf8");
    const r = runPublish(["--check", dest], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(0);
    expect(r.combined).toMatch(/matches plugin\.json|marketplace entry arc@0\.1\.1/);
    expect(readFileSync(join(dest, ".claude-plugin", "marketplace.json"), "utf8")).toBe(before);
  });

  test("REJECT: --check exits 1 when marketplace entry version differs (gate not warn-only)", () => {
    const src = tmpDir("arc-plugin-s7-chk-bad-");
    writePlugin(src, { ...SAMPLE, version: "0.1.1" });
    const dest = tmpDir("arc-plugin-s7-chk-bad-dest-");
    const marketplacePath = writeDest(dest, {
      name: "arcblock-agent-skills",
      plugins: [
        { name: "agentloop", version: "0.37.0" },
        { name: "arc", version: "9.9.9", source: "./plugins/arc" },
      ],
    });
    const before = readFileSync(marketplacePath, "utf8");
    const r = runPublish(["--check", dest], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/9\.9\.9|three-place|must match/i);
    expect(readFileSync(marketplacePath, "utf8")).toBe(before);
  });

  test("REJECT: --check exits 1 when marketplace has plugins but no arc entry", () => {
    const src = tmpDir("arc-plugin-s7-chk-miss-");
    writePlugin(src, { ...SAMPLE, version: "0.1.1" });
    const dest = tmpDir("arc-plugin-s7-chk-miss-dest-");
    writeDest(dest, {
      name: "arcblock-agent-skills",
      plugins: [{ name: "agentloop", version: "0.37.0" }],
    });
    const r = runPublish(["--check", dest], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/no entry named ['"]arc['"]|publish first/i);
  });

  test("REJECT: --check exits 1 when marketplace plugins enumeration is empty", () => {
    const src = tmpDir("arc-plugin-s7-chk-empty-");
    writePlugin(src, { ...SAMPLE, version: "0.1.1" });
    const dest = tmpDir("arc-plugin-s7-chk-empty-dest-");
    writeDest(dest, { name: "arcblock-agent-skills", plugins: [] });
    const r = runPublish(["--check", dest], { ARC_PLUGIN_SRC: src });
    expect(r.exitCode).toBe(1);
    expect(r.combined).toMatch(/0 plugins/);
  });

  test("ACCEPT: real source tree dry-run prints 0.1.1 (S7 bump)", () => {
    const r = runPublish(["--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.combined).toMatch(/version:\s*0\.1\.1/);
    expect(r.combined).toMatch(/name:\s*arc/);
    expect(r.combined).toContain('"source": "./plugins/arc"');
  });

  test("ACCEPT: README documents local-vs-remote, @blocklet/cli, and three host installs", () => {
    const readme = readFileSync(join(PLUGIN_ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/#6432/);
    expect(readme).toMatch(/Not available|not available|Out of scope/i);
    expect(readme).toContain("@blocklet/cli");
    expect(readme).toContain("/plugin install arc@arcblock-agent-skills");
    expect(readme).toContain("grok plugin install ArcBlock/agent-skills#plugins/arc");
    expect(readme).toContain("codex plugin add arc");
  });
});
