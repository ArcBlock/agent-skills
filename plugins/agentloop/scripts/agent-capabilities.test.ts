#!/usr/bin/env bun
/**
 * agent-capabilities.sh — dns-localhost-subdomain probe (arc#4102).
 *
 * Capability scripts list what the machine HAS. The tag is emitted only when
 * a real subdomain fetch to a loopback listener returns HTTP; a missing tag
 * is the gap, not a separate "gap" tag.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CAPS_SCRIPT = join(import.meta.dir, "agent-capabilities.sh");
const IDENTITY_SCRIPT = join(import.meta.dir, "agent-identity.sh");

function runCaps(env: NodeJS.ProcessEnv = process.env): {
  code: number;
  tags: string[];
  stderr: string;
} {
  const p = Bun.spawnSync(["bash", CAPS_SCRIPT], { env, cwd: import.meta.dir });
  const stdout = p.stdout.toString();
  return {
    code: p.exitCode ?? 1,
    tags: stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    stderr: p.stderr.toString(),
  };
}

/** Independent of the script: bind loopback, fetch `{name}.localhost`. */
async function liveSubdomainFetchWorks(): Promise<boolean> {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  try {
    const res = await fetch(`http://arc-probe.localhost:${port}/`);
    return res.status === 200;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function fakeNodeOnPath(exitCode: number): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "caps-node-"));
  tmpDirs.push(dir);
  const node = join(dir, "node");
  writeFileSync(node, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(node, 0o755);
  return { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
}

describe("dns-localhost-subdomain probe (arc#4102)", () => {
  test("live: the script's tag agrees with an independent subdomain fetch", async () => {
    const works = await liveSubdomainFetchWorks();
    const { code, tags } = runCaps();
    expect(code).toBe(0);
    if (works) {
      expect(tags).toContain("dns-localhost-subdomain");
    } else {
      expect(tags).not.toContain("dns-localhost-subdomain");
    }
  });

  test("emits the tag when the probe process succeeds (accept path)", () => {
    const { code, tags } = runCaps(fakeNodeOnPath(0));
    expect(code).toBe(0);
    expect(tags).toContain("dns-localhost-subdomain");
  });

  test("emits nothing for the tag when the probe process fails", () => {
    const { code, tags } = runCaps(fakeNodeOnPath(1));
    expect(code).toBe(0);
    expect(tags).not.toContain("dns-localhost-subdomain");
  });

  test("still reports other capabilities on a probe-fail machine (does not swallow gh-cli)", () => {
    const { tags } = runCaps(fakeNodeOnPath(1));
    // gh is present in this harness (identity.test.ts / pre-pr both use it).
    // A probe that `exit 1`s the whole script would drop every other tag.
    expect(tags).toContain("gh-cli");
  });
});

function identity(env: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync(["bash", IDENTITY_SCRIPT, "--runner", "test"], {
    cwd: import.meta.dir,
    env,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

function identityBaseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ARC_AGENT_ENGINE;
  delete env.ARC_AGENT_MODEL;
  delete env.CLAUDECODE;
  delete env.CODEX_SANDBOX;
  return env;
}

describe("agent identity engine provenance", () => {
  test("launcher engine wins over conflicting inherited CLI markers in both directions", () => {
    const inherited = {
      ...identityBaseEnv(),
      CLAUDECODE: "1",
      CODEX_SANDBOX: "seatbelt",
    };
    expect(identity({ ...inherited, ARC_AGENT_ENGINE: "codex" })).toContain("engine:codex");
    expect(identity({ ...inherited, ARC_AGENT_ENGINE: "claude" })).toContain("engine:claude");
  });

  test("interactive sessions retain self-detection when no launcher marker exists", () => {
    expect(identity({ ...identityBaseEnv(), CLAUDECODE: "1" })).toContain("engine:claude");
    expect(identity({ ...identityBaseEnv(), CODEX_SANDBOX: "seatbelt" })).toContain("engine:codex");
  });

  test("engine is always present even when no source can identify it", () => {
    expect(identity(identityBaseEnv())).toContain("engine:unknown");
  });
});
