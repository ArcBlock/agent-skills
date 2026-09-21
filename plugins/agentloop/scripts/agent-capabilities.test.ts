#!/usr/bin/env bun
/**
 * agent-capabilities.sh — dns-localhost-subdomain probe (arc#4102).
 *
 * Capability scripts list what the machine HAS. The tag is emitted only when
 * a real subdomain fetch to a loopback listener returns HTTP; a missing tag
 * is the gap, not a separate "gap" tag.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // grok-build stamps (arc#6183). Leaving them in would make every "unknown"
  // fixture look like grok when this suite itself runs under grok-build.
  delete env.GROK_SESSION_ID;
  delete env.GROK_AGENT;
  delete env.GROK_HOME;
  delete env.GROK_SANDBOX;
  return env;
}

/** Trailing token of `engine:<kind>[/<model>]`. Exact, so `grok` ≠ `grok-build`. */
function engineOf(line: string): string {
  return /\bengine:([A-Za-z0-9._?-]+)/.exec(line)?.[1] ?? "";
}

function identityFromScript(script: string, env: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync(["bash", script, "--runner", "test"], {
    cwd: import.meta.dir,
    env,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

describe("agent identity engine provenance", () => {
  test("launcher engine wins over conflicting inherited CLI markers in both directions", () => {
    const inherited = {
      ...identityBaseEnv(),
      CLAUDECODE: "1",
      CODEX_SANDBOX: "seatbelt",
      GROK_SESSION_ID: "01a0b3c1-21a1-7f43-a174-e60dd46c837f",
      GROK_AGENT: "1",
    };
    expect(engineOf(identity({ ...inherited, ARC_AGENT_ENGINE: "codex" }))).toBe("codex");
    expect(engineOf(identity({ ...inherited, ARC_AGENT_ENGINE: "claude" }))).toBe("claude");
    expect(engineOf(identity({ ...inherited, ARC_AGENT_ENGINE: "grok-build" }))).toBe("grok-build");
  });

  test("interactive sessions retain self-detection when no launcher marker exists", () => {
    expect(engineOf(identity({ ...identityBaseEnv(), CLAUDECODE: "1" }))).toBe("claude");
    expect(engineOf(identity({ ...identityBaseEnv(), CODEX_SANDBOX: "seatbelt" }))).toBe("codex");
  });

  test("engine is always present even when no source can identify it", () => {
    expect(engineOf(identity(identityBaseEnv()))).toBe("unknown");
  });
});

describe("arc#6183 grok-build self-detect", () => {
  const grokSession = "01a0b3c1-21a1-7f43-a174-e60dd46c837f";

  test("ACCEPT: GROK_SESSION_ID fixture is grok-build, not unknown", () => {
    const line = identity({ ...identityBaseEnv(), GROK_SESSION_ID: grokSession });
    expect(engineOf(line)).toBe("grok-build");
  });

  test("ACCEPT: GROK_AGENT=1 wrapper stamp is grok-build", () => {
    expect(engineOf(identity({ ...identityBaseEnv(), GROK_AGENT: "1" }))).toBe("grok-build");
  });

  test("REJECT: GROK_AGENT profile name is config-input, not a self-stamp", () => {
    expect(engineOf(identity({ ...identityBaseEnv(), GROK_AGENT: "my-custom-agent" }))).toBe(
      "unknown",
    );
  });

  test("REJECT: GROK_SANDBOX is config-input and must not identify grok", () => {
    expect(engineOf(identity({ ...identityBaseEnv(), GROK_SANDBOX: "workspace" }))).toBe("unknown");
  });

  test("REJECT: GROK_HOME is a path override and must not identify grok", () => {
    expect(engineOf(identity({ ...identityBaseEnv(), GROK_HOME: "/tmp/fake-grok-home" }))).toBe(
      "unknown",
    );
  });

  test("leaked CLAUDECODE into a grok session must not silently become claude", () => {
    const line = identity({
      ...identityBaseEnv(),
      GROK_SESSION_ID: grokSession,
      CLAUDECODE: "1",
    });
    expect(engineOf(line)).toBe("grok-build");
  });

  test("ACCEPT: a real claude session is still claude, not grok", () => {
    expect(engineOf(identity({ ...identityBaseEnv(), CLAUDECODE: "1" }))).toBe("claude");
  });

  test("ACCEPT: a real codex session is still codex, not grok", () => {
    expect(engineOf(identity({ ...identityBaseEnv(), CODEX_SANDBOX: "seatbelt" }))).toBe("codex");
  });

  test("mutation: commenting out the grok-build assignment makes a grok fixture look unknown", () => {
    const src = readFileSync(IDENTITY_SCRIPT, "utf8");
    // Comment out the assignment but keep a `:` so `then`/`elif` stays valid bash.
    const mutated = src.replace(/(\n[ \t]*)engine="grok-build"/g, '$1: # engine="grok-build"');
    expect(mutated).not.toBe(src);

    const dir = mkdtempSync(join(tmpdir(), "identity-mutate-"));
    tmpDirs.push(dir);
    const mutatedScript = join(dir, "agent-identity.sh");
    writeFileSync(mutatedScript, mutated);

    const grokEnv = { ...identityBaseEnv(), GROK_SESSION_ID: grokSession, GROK_AGENT: "1" };
    expect(engineOf(identity(grokEnv))).toBe("grok-build");
    expect(engineOf(identityFromScript(mutatedScript, grokEnv))).toBe("unknown");
  });
});

function identityArgs(args: string[], env: NodeJS.ProcessEnv = identityBaseEnv()): string {
  const result = Bun.spawnSync(["bash", IDENTITY_SCRIPT, "--runner", "test", ...args], {
    cwd: import.meta.dir,
    env,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

/** Split `engine:a+b[/model]` into kinds. `+` is the set delimiter (arc#6184). */
function engineSetOf(line: string): string[] {
  const raw = /\bengine:([A-Za-z0-9._+-]+)/.exec(line)?.[1] ?? "";
  return raw
    .split("+")
    .map((p) => p.split("/")[0] ?? "")
    .filter((p) => p && p !== "unknown");
}

describe("arc#6184 identity line engine set — append, never overwrite", () => {
  test("ACCEPT: --prior-engines grok-build + current claude emits grok-build+claude", () => {
    const line = identityArgs(["--engine", "claude", "--prior-engines", "grok-build"]);
    expect(engineSetOf(line)).toEqual(["grok-build", "claude"]);
  });

  test("ACCEPT: 自己已在集合里再跑一次不重复追加", () => {
    const line = identityArgs(["--engine", "claude", "--prior-engines", "grok-build+claude"]);
    expect(engineSetOf(line)).toEqual(["grok-build", "claude"]);
  });

  test("ACCEPT: 没有 --prior-engines 时单引擎行为不变", () => {
    expect(engineOf(identityArgs(["--engine", "claude"]))).toBe("claude");
  });

  test("mutation: ignoring --prior-engines overwrites to {claude} — grok would false-PASS", () => {
    const src = readFileSync(IDENTITY_SCRIPT, "utf8");
    expect(src).toContain("--prior-engines");
    const mutated = src.replace(
      /(\n[ \t]*)engine="\$\(union_coder_engines/g,
      '$1: # engine="$(union_coder_engines',
    );
    expect(mutated).not.toBe(src);

    const dir = mkdtempSync(join(tmpdir(), "identity-prior-"));
    tmpDirs.push(dir);
    const mutatedScript = join(dir, "agent-identity.sh");
    writeFileSync(mutatedScript, mutated);

    const env = identityBaseEnv();
    const real = identityArgs(["--engine", "claude", "--prior-engines", "grok-build"], env);
    expect(engineSetOf(real)).toEqual(["grok-build", "claude"]);

    const dropped = identityFromScriptWithArgs(mutatedScript, [
      "--engine",
      "claude",
      "--prior-engines",
      "grok-build",
    ]);
    expect(engineSetOf(dropped)).toEqual(["claude"]);
  });
});

function identityFromScriptWithArgs(script: string, args: string[]): string {
  const result = Bun.spawnSync(["bash", script, "--runner", "test", ...args], {
    cwd: import.meta.dir,
    env: identityBaseEnv(),
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}
