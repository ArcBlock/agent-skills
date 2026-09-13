#!/usr/bin/env bun
/**
 * Plugin-tree smoke for S5 CLI bootstrap (arc#6443).
 * Full accept-path: scripts/test/ensure-arc.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  diagnoseBootstrapTree,
  findForbiddenEnsureArcPatterns,
} from "../../../scripts/lib/ensure-arc.ts";

const PLUGIN_ROOT = import.meta.dir;
const REPO_ROOT = join(PLUGIN_ROOT, "../../..");

describe("arc plugin CLI bootstrap (S5)", () => {
  test("ACCEPT: ensure-arc.sh + hooks + bin exist under plugin root", () => {
    expect(existsSync(join(PLUGIN_ROOT, "scripts/ensure-arc.sh"))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, "scripts/install.sh"))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, "hooks/hooks.json"))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, "bin/arc"))).toBe(true);
  });

  test("ACCEPT: ensure-arc.sh and bin/arc are executable", () => {
    expect((statSync(join(PLUGIN_ROOT, "scripts/ensure-arc.sh")).mode & 0o111) !== 0).toBe(true);
    expect((statSync(join(PLUGIN_ROOT, "bin/arc")).mode & 0o111) !== 0).toBe(true);
  });

  test("ACCEPT: diagnoseBootstrapTree green on this repo", () => {
    const r = diagnoseBootstrapTree(REPO_ROOT);
    expect(r.ok).toBe(true);
  });

  test("ACCEPT: no ownership-workaround tokens in ensure-arc.sh", () => {
    const src = readFileSync(join(PLUGIN_ROOT, "scripts/ensure-arc.sh"), "utf8");
    expect(findForbiddenEnsureArcPatterns(src)).toEqual([]);
  });

  test("ACCEPT: plugin.json version is 0.1.1 (S7 unique bump landed)", () => {
    const v = (
      JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin/plugin.json"), "utf8")) as {
        version: string;
      }
    ).version;
    expect(v).toBe("0.1.1");
  });
});
