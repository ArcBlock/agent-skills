/**
 * Plugin-tree smoke for `.mcp.json` (arc#6442). Full accept-path lives in
 * scripts/test/arc-plugin-mcp.test.ts; this file keeps the plugins gate from
 * shipping a tree whose MCP declaration drifted without a suite under
 * `.claude/plugins/arc/`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  diagnoseMcpJson,
  diagnoseNegotiationSkill,
  parseMcpJsonText,
} from "../../../scripts/lib/arc-plugin-mcp.ts";

const PLUGIN_ROOT = import.meta.dir;
const MCP_JSON = join(PLUGIN_ROOT, ".mcp.json");
const MCP_SKILL = join(PLUGIN_ROOT, "skills/mcp/SKILL.md");
const CLAUDE_MANIFEST = join(PLUGIN_ROOT, ".claude-plugin/plugin.json");

describe("arc plugin .mcp.json (S4)", () => {
  test("ACCEPT: .mcp.json exists at plugin root (not inside .claude-plugin/)", () => {
    expect(existsSync(MCP_JSON)).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, ".claude-plugin/.mcp.json"))).toBe(false);
  });

  test("ACCEPT: declares only arc-local stdio", () => {
    const { config, error } = parseMcpJsonText(readFileSync(MCP_JSON, "utf8"));
    expect(error).toBeUndefined();
    const report = diagnoseMcpJson(config);
    expect(report.ok).toBe(true);
    expect(report.servers).toEqual(["arc-local"]);
  });

  test("ACCEPT: negotiation skill projected and readable without needing arc binary", () => {
    const md = readFileSync(MCP_SKILL, "utf8");
    expect(diagnoseNegotiationSkill(md).ok).toBe(true);
  });

  test("ACCEPT: plugin.json version is 0.1.1 (S7 unique bump landed)", () => {
    const v = (JSON.parse(readFileSync(CLAUDE_MANIFEST, "utf8")) as { version: string }).version;
    expect(v).toBe("0.1.1");
  });
});
