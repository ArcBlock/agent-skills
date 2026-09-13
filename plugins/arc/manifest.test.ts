#!/usr/bin/env bun
/**
 * Manifest invariants for the arc plugin skeleton (#6436).
 *
 * Two runtime manifests, one source:
 *   .claude-plugin/plugin.json   Claude Code / Grok Build  ← the one a human edits
 *   .codex-plugin/plugin.json    Codex CLI                 ← GENERATED copy
 *
 * There is no `.grok-plugin/`: Grok reads `.claude-plugin` (epic #6429 pre-flight).
 * A third copy would be another drift source with zero gain inside this epic.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const CLAUDE_MANIFEST = join(ROOT, ".claude-plugin", "plugin.json");
const CODEX_MANIFEST = join(ROOT, ".codex-plugin", "plugin.json");
const GROK_PLUGIN_DIR = join(ROOT, ".grok-plugin");

const read = (p: string) => readFileSync(p, "utf8");

describe("plugin manifests (Claude Code + Codex, no Grok shadow)", () => {
  test("the Codex manifest exists", () => {
    expect(() => read(CODEX_MANIFEST)).not.toThrow();
  });

  test("the two manifests are byte-identical", () => {
    expect(read(CODEX_MANIFEST)).toBe(read(CLAUDE_MANIFEST));
  });

  test("JSON.parse succeeds and the fields both runtimes require match", () => {
    const claude = JSON.parse(read(CLAUDE_MANIFEST));
    const codex = JSON.parse(read(CODEX_MANIFEST));
    expect(codex).toEqual(claude);
    expect(claude.name).toBe("arc");
    expect(claude.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(claude.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof claude.description).toBe("string");
    expect(claude.description.length).toBeGreaterThan(0);
  });

  test("there is no .grok-plugin directory — only two manifests", () => {
    expect(existsSync(GROK_PLUGIN_DIR)).toBe(false);
    const runtimeDirs = readdirSync(ROOT).filter((name) => name.endsWith("-plugin"));
    expect(runtimeDirs.sort()).toEqual([".claude-plugin", ".codex-plugin"]);
  });
});
