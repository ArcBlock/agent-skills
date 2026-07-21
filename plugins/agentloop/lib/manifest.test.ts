#!/usr/bin/env bun
/**
 * Manifest invariants — the plugin ships metadata for TWO runtimes:
 *
 *   .claude-plugin/plugin.json   Claude Code   ← the one a human edits
 *   .codex-plugin/plugin.json    Codex CLI     ← GENERATED copy
 *
 * The schemas are identical, so the second file is a copy, and a copy is a drift
 * source. `scripts/publish-agentloop.sh` regenerates it on every publish, but publish
 * is the LAST step — this test fails the moment the two diverge in the working tree,
 * so a forgotten copy is caught by `bun test` rather than shipping a plugin that
 * reports the wrong version to one runtime only.
 *
 * Why a copy and not a symlink: `codex plugin add` does not follow a directory
 * symlink — it leaves `.codex-plugin` ABSENT from the install cache while the plugin
 * still appears to load (Codex reads metadata from the source at install time). That
 * failure is invisible until something reads the cached copy, which is exactly the
 * kind of silent breakage a real file avoids.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLAUDE_MANIFEST = join(ROOT, ".claude-plugin", "plugin.json");
const CODEX_MANIFEST = join(ROOT, ".codex-plugin", "plugin.json");

const read = (p: string) => readFileSync(p, "utf8");

describe("plugin manifests (Claude Code + Codex)", () => {
  test("the Codex manifest exists", () => {
    // A missing file means `codex plugin add` sees no plugin at all.
    expect(() => read(CODEX_MANIFEST)).not.toThrow();
  });

  test("the two manifests are byte-identical", () => {
    // Byte-identical, not just semantically equal: the generator is a plain `cp`,
    // so any difference at all means the copy did not run or was hand-edited.
    expect(read(CODEX_MANIFEST)).toBe(read(CLAUDE_MANIFEST));
  });

  test("the manifest carries the fields both runtimes require", () => {
    const m = JSON.parse(read(CLAUDE_MANIFEST));
    expect(m.name).toBe("agentloop");
    // Version drives cache invalidation in BOTH runtimes: same version + changed
    // content is not reliably picked up (see CLAUDE.md rule 2).
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof m.description).toBe("string");
    expect(m.description.length).toBeGreaterThan(0);
  });
});
