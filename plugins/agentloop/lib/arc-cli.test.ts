/**
 * resolveFactoryArcCli — the factory's explicit `arc` (agent-factory#20).
 *
 * A host's global `~/.local/bin/arc` is about to point at another CLI
 * (ArcBlock/arc#10371). Factory call sites must never resolve `arc` from PATH:
 * ARC_BIN, then the host-declared `$ARC_CLI` (#9181), then the factory shim
 * `~/.arc-factory/bin/arc`; nothing else. No source → argv null with a reason
 * naming every place that was probed (fail closed, never `which arc`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_SHIM_RELATIVE_PATH, resolveFactoryArcCli } from "./arc-cli.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function exe(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "factory-arc-cli-"));
  dirs.push(root);
  const home = join(root, "home");
  const pathBin = join(root, "pathbin");
  exe(join(pathBin, "arc")); // the host's global arc: must never be chosen
  return { root, home, pathBin };
}

describe("resolveFactoryArcCli", () => {
  test("ARC_BIN wins over everything", () => {
    const w = world();
    exe(join(w.home, FACTORY_SHIM_RELATIVE_PATH));
    const r = resolveFactoryArcCli({
      env: { HOME: w.home, PATH: w.pathBin, ARC_BIN: "/opt/x/arc", ARC_CLI: "/opt/y/arc" },
    });
    expect(r).toEqual({ argv: ["/opt/x/arc"], source: "ARC_BIN" });
  });

  test("accept: an absolute, executable $ARC_CLI beats the factory shim", () => {
    const w = world();
    exe(join(w.home, FACTORY_SHIM_RELATIVE_PATH));
    const cli = exe(join(w.root, "host", "arc-cli"));
    const r = resolveFactoryArcCli({ env: { HOME: w.home, PATH: w.pathBin, ARC_CLI: cli } });
    expect(r).toEqual({ argv: [cli], source: "ARC_CLI" });
  });

  test("reject: a relative or non-executable $ARC_CLI is refused, not replaced by PATH", () => {
    const w = world();
    exe(join(w.home, FACTORY_SHIM_RELATIVE_PATH));
    for (const bad of ["bin/arc", join(w.root, "missing-arc")]) {
      const r = resolveFactoryArcCli({ env: { HOME: w.home, PATH: w.pathBin, ARC_CLI: bad } });
      expect(r.argv).toBeNull();
      expect(r.source).toBe("none");
      expect(r.reason).toContain(`ARC_CLI=${bad}`);
    }
  });

  test("accept: the factory shim when nothing is declared", () => {
    const w = world();
    const shim = exe(join(w.home, FACTORY_SHIM_RELATIVE_PATH));
    const r = resolveFactoryArcCli({ env: { HOME: w.home, PATH: w.pathBin } });
    expect(r).toEqual({ argv: [shim], source: "factory-shim" });
  });

  test("reject: nothing explicit → none with a reason; PATH's arc is never returned", () => {
    const w = world();
    const r = resolveFactoryArcCli({ env: { HOME: w.home, PATH: w.pathBin } });
    expect(r.argv).toBeNull();
    expect(r.source).toBe("none");
    expect(r.reason).toContain("ARC_BIN");
    expect(r.reason).toContain("ARC_CLI");
    expect(r.reason).toContain(join(w.home, FACTORY_SHIM_RELATIVE_PATH));
    expect(r.reason).toContain("PATH");
  });

  test("blank values are unset", () => {
    const w = world();
    const shim = exe(join(w.home, FACTORY_SHIM_RELATIVE_PATH));
    const r = resolveFactoryArcCli({
      env: { HOME: w.home, PATH: w.pathBin, ARC_BIN: "  ", ARC_CLI: "" },
    });
    expect(r).toEqual({ argv: [shim], source: "factory-shim" });
  });
});
