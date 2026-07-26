import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { DeploymentConfig, RepoEntry } from "./driver.ts";
import {
  buildCatalog,
  buildCloudPlan,
  buildDeployment,
  CRON_BEGIN,
  CRON_END,
  cmpSemver,
  coveredRepos,
  coveredSkills,
  detectCodexPluginRoot,
  parseProbedPath,
  parseReposSpec,
  paths,
  reconcileCrontab,
  renderCronBlock,
  renderCronRow,
  renderRunnerScript,
  type SetupInput,
  scaffoldEnvFile,
  skillBaseMinute,
  staggerOffset,
  stripCronBlock,
} from "./setup.ts";

const baseInput = (over: Partial<SetupInput> = {}): SetupInput => ({
  runner: "alice",
  configDir: "/home/alice/.agentloop-fleet",
  agentloopRoot: "/home/alice/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop",
  bunPath: "/home/alice/.bun/bin/bun",
  os: "Linux",
  cronPath: "/usr/bin:/bin",
  ...over,
});

const repos: RepoEntry[] = [
  {
    slug: "ArcBlock/arc",
    defaultBranch: "main",
    skills: ["issue-sweep", "pr-sweep"],
    cadenceMinutes: 120,
  },
  { slug: "ArcBlock/did", defaultBranch: "main", skills: ["issue-sweep"], cadenceMinutes: 120 },
];

describe("staggerOffset", () => {
  test("deterministic + within [0, mod)", () => {
    expect(staggerOffset("alice")).toBe(staggerOffset("alice"));
    expect(staggerOffset("alice")).toBeGreaterThanOrEqual(0);
    expect(staggerOffset("alice")).toBeLessThan(13);
  });
  test("different runners usually differ", () => {
    expect(staggerOffset("alice")).not.toBe(staggerOffset("bob-with-a-different-name"));
  });
});

describe("skillBaseMinute", () => {
  test("reserved lanes for the two shipped skills", () => {
    expect(skillBaseMinute("issue-sweep", ["issue-sweep", "pr-sweep"])).toBe(9);
    expect(skillBaseMinute("pr-sweep", ["issue-sweep", "pr-sweep"])).toBe(39);
  });
  test("unknown skill gets a deterministic non-reserved slot < 60", () => {
    const m = skillBaseMinute("custom", ["custom", "issue-sweep"]);
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThan(60);
  });
});

describe("buildDeployment", () => {
  test("first-time defaults (skip posture, parallel, ceiling env)", () => {
    const d = buildDeployment(baseInput());
    expect(d.runner).toBe("alice");
    expect(d.cover).toBe("all");
    expect(d.permissionMode).toBe("skip");
    expect(d.parallel).toBe(true);
    expect(d.checkoutPerSkill).toBe(true);
    expect(d.env?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe("0");
    expect(d.checkoutBase).toBe("/home/alice/.agentloop-fleet/checkouts");
    expect(d.logDir).toBe("/home/alice/.agentloop-fleet/logs");
  });
  test("reconcile PRESERVES a hand-added skillEnv / extra env the input omits", () => {
    const existing: Partial<DeploymentConfig> = {
      skillEnv: { "issue-sweep": { ARC_SERVICE_PORT: "4910" } },
      env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ANDROID_HOME: "/sdk" },
    };
    const d = buildDeployment(baseInput({ model: "claude-sonnet-5" }), existing);
    expect(d.skillEnv?.["issue-sweep"]?.ARC_SERVICE_PORT).toBe("4910");
    expect(d.env?.ANDROID_HOME).toBe("/sdk");
    expect(d.model).toBe("claude-sonnet-5"); // explicit input still applied
  });
  test("explicit input overrides existing", () => {
    const d = buildDeployment(baseInput({ permissionMode: "acceptEdits", parallel: false }), {
      permissionMode: "skip",
    });
    expect(d.permissionMode).toBe("acceptEdits");
    expect(d.parallel).toBe(false);
  });
  test("no engine by default (absent == claude, back-compat)", () => {
    expect(buildDeployment(baseInput()).engine).toBeUndefined();
  });
  test("emits engine when the input carries one, and reconcile preserves a hand-set engine", () => {
    expect(
      buildDeployment(baseInput({ engine: { kind: "codex", model: "gpt-x" } })).engine,
    ).toEqual({ kind: "codex", model: "gpt-x" });
    // input omits engine → an existing hand-set engine survives the reconcile
    expect(buildDeployment(baseInput(), { engine: { kind: "codex" } }).engine).toEqual({
      kind: "codex",
    });
  });
});

describe("cmpSemver", () => {
  test("orders by major, then minor, then patch", () => {
    expect(cmpSemver("0.20.0", "0.19.9")).toBeGreaterThan(0);
    expect(cmpSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(cmpSemver("0.20.0", "0.20.1")).toBeLessThan(0);
    expect(cmpSemver("0.20.0", "0.20.0")).toBe(0);
    expect(cmpSemver("0.9.0", "0.10.0")).toBeLessThan(0); // numeric, not lexical
  });
});

describe("detectCodexPluginRoot (codex loads only GLOBALLY-installed plugins)", () => {
  test("undefined when the codex cache does not exist", () => {
    const home = mkdtempSync(`${tmpdir()}/codex-none-`);
    try {
      expect(detectCodexPluginRoot(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("picks the HIGHEST-semver install (old versions persist in the cache)", () => {
    const home = mkdtempSync(`${tmpdir()}/codex-vers-`);
    try {
      const mk = (ver: string) => {
        const dir = `${home}/.codex/plugins/cache/arcblock-agent-skills/agentloop/${ver}/.claude-plugin`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/plugin.json`, JSON.stringify({ name: "agentloop", version: ver }));
      };
      mk("0.19.5");
      mk("0.20.0");
      mk("0.9.0"); // must NOT win despite sorting last lexically among these
      expect(detectCodexPluginRoot(home)).toBe(
        `${home}/.codex/plugins/cache/arcblock-agent-skills/agentloop/0.20.0`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("undefined when a marketplace dir exists but has no agentloop install", () => {
    const home = mkdtempSync(`${tmpdir()}/codex-empty-`);
    try {
      mkdirSync(`${home}/.codex/plugins/cache/some-other-mkt/other-plugin/1.0.0`, {
        recursive: true,
      });
      expect(detectCodexPluginRoot(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("renderRunnerScript (the launcher fix — content shape)", () => {
  test("is self-contained: no imports from the plugin itself, only node: builtins", () => {
    const script = renderRunnerScript(
      "/home/alice/.bun/bin/bun",
      "/home/alice/.agentloop-fleet/agentloop-current",
    );
    const importLines = script.split("\n").filter((l) => l.trim().startsWith("import "));
    for (const line of importLines) expect(line).toMatch(/from "node:/);
  });

  test("embeds the given bunPath and currentLink literally", () => {
    const script = renderRunnerScript("/opt/bun/bun", "/x/agentloop-current");
    expect(script).toContain('"/opt/bun/bun"');
    expect(script).toContain('"/x/agentloop-current"');
  });

  test("checks the codex cache first (codex has no per-invocation --plugin-dir), then the marketplace clone, then the claude cache", () => {
    const script = renderRunnerScript("/b/bun", "/x/link");
    expect(script).toContain("marketplaces/arcblock-agent-skills/plugins/agentloop");
    expect(script).toContain(".codex/plugins/cache");
    expect(script).toContain(".claude/plugins/cache");
    expect(script).toContain("cmpSemver");
  });

  test("errors loudly (not a bare crash) when nothing is found", () => {
    const script = renderRunnerScript("/b/bun", "/x/link");
    expect(script).toContain("no agentloop plugin installation found");
    expect(script).toContain("process.exit(1)");
  });

  test("has no un-escaped backtick template literals in the GENERATED code (the nesting footgun)", () => {
    const script = renderRunnerScript("/b/bun", "/x/link");
    // the generated script's OWN logic must use string concatenation, never backticks —
    // nesting backtick template literals inside this file's own template literal is the
    // exact mistake this test guards against (see renderRunnerScript's doc comment).
    const bodyLines = script.split("\n").filter((l) => !l.trim().startsWith("//"));
    for (const line of bodyLines) expect(line).not.toContain("`");
  });
});

describe("renderRunnerScript (the launcher fix — actually EXECUTED, not just inspected)", () => {
  function fixture() {
    const home = mkdtempSync(`${tmpdir()}/agentloop-launcher-`);
    const configDir = `${home}/.agentloop-fleet`;
    mkdirSync(configDir, { recursive: true });
    return { home, configDir };
  }

  function installStubVersion(home: string, engine: "codex" | "claude", version: string): string {
    const dir = `${home}/.${engine}/plugins/cache/arcblock-agent-skills/agentloop/${version}`;
    mkdirSync(`${dir}/.claude-plugin`, { recursive: true });
    writeFileSync(
      `${dir}/.claude-plugin/plugin.json`,
      JSON.stringify({ name: "agentloop", version }),
    );
    mkdirSync(`${dir}/fleet`, { recursive: true });
    // A minimal driver.ts stub: prints which version invoked it + its argv, so the test
    // can prove the launcher resolved and exec'd the RIGHT one, not just "some" one.
    writeFileSync(
      `${dir}/fleet/driver.ts`,
      `console.log("STUB_DRIVER_RAN version=${version} argv=" + process.argv.slice(2).join(","));\n`,
    );
    return dir;
  }

  function runLauncher(home: string, configDir: string, args: string[] = ["--hello"]) {
    const p = paths({ configDir });
    writeFileSync(p.launcher, renderRunnerScript("bun", p.currentLink), { mode: 0o755 });
    const proc = Bun.spawnSync(["bun", p.launcher, ...args], {
      env: { ...process.env, HOME: home },
    });
    return {
      code: proc.exitCode,
      out: new TextDecoder().decode(proc.stdout),
      err: new TextDecoder().decode(proc.stderr),
      currentLink: p.currentLink,
    };
  }

  test("resolves the ONLY installed version and execs its driver.ts with argv passed through", () => {
    const { home, configDir } = fixture();
    try {
      const dir = installStubVersion(home, "codex", "0.20.0");
      const r = runLauncher(home, configDir, ["--skill", "issue-sweep", "--run"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("STUB_DRIVER_RAN version=0.20.0");
      expect(r.out).toContain("argv=--skill,issue-sweep,--run");
      // and it left a symlink pointing at the resolved version, for agentloopRoot to use
      expect(lstatSync(r.currentLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(r.currentLink)).toBe(dir);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("picks the HIGHEST semver among several coexisting installs", () => {
    const { home, configDir } = fixture();
    try {
      installStubVersion(home, "codex", "0.19.5");
      const newest = installStubVersion(home, "codex", "0.20.0");
      installStubVersion(home, "codex", "0.9.0"); // must not win despite sorting last lexically
      const r = runLauncher(home, configDir);
      expect(r.out).toContain("STUB_DRIVER_RAN version=0.20.0");
      expect(readlinkSync(r.currentLink)).toBe(newest);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // THE regression test for the actual incident: a plugin upgrade deletes the old version
  // dir between two ticks. Before this fix, the crontab's hardcoded path would fail on
  // EVERY subsequent tick with a bare "Module not found" — silently, forever. After this
  // fix, the very next tick must pick up the new version with zero human action.
  test("SELF-HEALS across a version upgrade: old dir deleted, new one appears — next run just picks it up", () => {
    const { home, configDir } = fixture();
    try {
      installStubVersion(home, "codex", "0.22.1");
      const first = runLauncher(home, configDir);
      expect(first.out).toContain("STUB_DRIVER_RAN version=0.22.1");

      // Simulate the exact incident: the upgrade DELETES the old version wholesale.
      rmSync(`${home}/.codex/plugins/cache/arcblock-agent-skills/agentloop/0.22.1`, {
        recursive: true,
        force: true,
      });
      const newDir = installStubVersion(home, "codex", "0.22.2");

      const second = runLauncher(home, configDir);
      expect(second.code).toBe(0);
      expect(second.out).toContain("STUB_DRIVER_RAN version=0.22.2");
      expect(second.err).not.toContain("Module not found"); // the literal old failure mode
      expect(readlinkSync(second.currentLink)).toBe(newDir); // symlink followed the upgrade
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("errors loudly and exits non-zero when NOTHING is installed anywhere (not a bare module-not-found)", () => {
    const { home, configDir } = fixture();
    try {
      const r = runLauncher(home, configDir);
      expect(r.code).toBe(1);
      expect(r.err).toContain("no agentloop plugin installation found");
      expect(r.err).toContain("codex plugin add agentloop@arcblock-agent-skills");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  function installMarketplace(home: string): string {
    const marketplace = `${home}/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop`;
    mkdirSync(`${marketplace}/.claude-plugin`, { recursive: true });
    writeFileSync(
      `${marketplace}/.claude-plugin/plugin.json`,
      JSON.stringify({ name: "agentloop", version: "0.0.0-marketplace" }),
    );
    mkdirSync(`${marketplace}/fleet`, { recursive: true });
    writeFileSync(
      `${marketplace}/fleet/driver.ts`,
      'console.log("STUB_DRIVER_RAN marketplace");\n',
    );
    return marketplace;
  }

  // codex has NO per-invocation --plugin-dir — it loads the skill it invokes BY NAME from
  // wherever it is globally installed, independent of --add-dir. So whenever codex has ANY
  // install, it MUST win, even over an equally-current marketplace clone — otherwise the
  // prompt (read from our resolved root) and the skill codex actually loads (read from
  // codex's own registry) could land on two different versions. This is not a preference,
  // it is the exact invariant detectCodexPluginRoot's doc comment already documents; the
  // launcher must preserve it, not just "pick something that works".
  test("codex cache wins over the marketplace clone whenever codex has ANY install", () => {
    const { home, configDir } = fixture();
    try {
      const codexDir = installStubVersion(home, "codex", "0.20.0");
      installMarketplace(home); // present, but must lose to the codex install
      const r = runLauncher(home, configDir);
      expect(r.out).toContain("STUB_DRIVER_RAN version=0.20.0");
      expect(readlinkSync(r.currentLink)).toBe(codexDir);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("falls back to the marketplace clone only when codex has NO install at all", () => {
    const { home, configDir } = fixture();
    try {
      const marketplace = installMarketplace(home);
      const r = runLauncher(home, configDir);
      expect(r.out).toContain("STUB_DRIVER_RAN marketplace");
      expect(readlinkSync(r.currentLink)).toBe(marketplace);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a stale symlink from a PRIOR run does not confuse resolution or block relinking", () => {
    const { home, configDir } = fixture();
    try {
      const p = paths({ configDir });
      // Pre-seed a symlink pointing at garbage, as if left over from a much older run.
      symlinkSync("/nonexistent/ghost-version", p.currentLink);
      installStubVersion(home, "codex", "0.21.0");
      const r = runLauncher(home, configDir);
      expect(r.code).toBe(0);
      expect(r.out).toContain("STUB_DRIVER_RAN version=0.21.0");
      expect(readlinkSync(r.currentLink)).not.toBe("/nonexistent/ghost-version");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("parseReposSpec — referenceRepos", () => {
  test("parses the +refs tail without disturbing skills or cadence", () => {
    const [r] = parseReposSpec("ArcBlock/site=issue-sweep,pr-sweep@240+ArcBlock/arc");
    expect(r.slug).toBe("ArcBlock/site");
    expect(r.skills).toEqual(["issue-sweep", "pr-sweep"]);
    expect(r.cadenceMinutes).toBe(240);
    expect(r.referenceRepos).toEqual(["ArcBlock/arc"]);
  });
  test("accepts several references", () => {
    const [r] = parseReposSpec("O/a=issue-sweep+O/b,O/c");
    expect(r.referenceRepos).toEqual(["O/b", "O/c"]);
  });
  test("omits the key entirely when no reference is given — the common case", () => {
    const [r] = parseReposSpec("O/a=issue-sweep@60");
    expect(r.referenceRepos).toBeUndefined();
    expect(r.cadenceMinutes).toBe(60);
  });
});

describe("scaffoldEnvFile", () => {
  const KEYS = ["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

  test("writes what the machine can answer, and marks what it cannot", () => {
    let body = "";
    const out = scaffoldEnvFile(
      "/e/env",
      () => false,
      () => "",
      (_p, b) => {
        body = b;
      },
      (cmd) => (cmd.includes("gh auth token") ? "gho_derived" : ""),
    );
    expect(body).toContain("export GH_TOKEN=gho_derived");
    expect(body).toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
    expect(body).toContain("FILL"); // the hole is obvious, not implied
    expect(out.join("\n")).toContain("claude setup-token"); // and says exactly how to fill it
  });

  // The one behaviour that must never regress: this file holds someone's credentials.
  test("NEVER overwrites an existing file", () => {
    let wrote = false;
    const out = scaffoldEnvFile(
      "/e/env",
      () => true,
      () => KEYS.map((k) => `export ${k}=real`).join("\n"),
      () => {
        wrote = true;
      },
      () => "should-not-be-called",
    );
    expect(wrote).toBe(false);
    expect(out[0]).toContain("already sets");
  });

  test("flags an existing file that is missing a key rather than silently passing", () => {
    const out = scaffoldEnvFile(
      "/e/env",
      () => true,
      () => "export GH_TOKEN=real\n", // no CLAUDE_CODE_OAUTH_TOKEN
      () => {},
      () => "",
    );
    expect(out[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(out[0]).toContain("aborts");
  });

  test("derives nothing when the machine has no gh session — still writes a usable skeleton", () => {
    let body = "";
    const out = scaffoldEnvFile(
      "/e/env",
      () => false,
      () => "",
      (_p, b) => {
        body = b;
      },
      () => "",
    );
    for (const k of KEYS) expect(body).toContain(`export ${k}=`);
    expect(out.filter((l) => l.includes("RUN:")).length).toBe(2);
  });
});

describe("skillEnv defaults (daemon repos must not fight over ports)", () => {
  test("a fresh config gets isolated ports per skill", () => {
    const d = buildDeployment(baseInput());
    expect(d.skillEnv?.["issue-sweep"]?.ARC_SERVICE_PORT).toBe("4910");
    expect(d.skillEnv?.["pr-sweep"]?.ARC_SERVICE_PORT).toBe("4920");
    // Same port for two concurrently-sweeping skills = the second daemon dies on bind,
    // which reads as a broken sweep rather than a config gap.
    expect(d.skillEnv?.["issue-sweep"]?.ARC_SERVICE_PORT).not.toBe(
      d.skillEnv?.["pr-sweep"]?.ARC_SERVICE_PORT,
    );
    expect(d.skillEnv?.["issue-sweep"]?.ARC_HOME).toContain("{{CHECKOUT}}");
  });

  test("never clobbers a hand-tuned skillEnv", () => {
    const mine = { "issue-sweep": { ARC_SERVICE_PORT: "9999" } };
    const d = buildDeployment(baseInput(), { skillEnv: mine } as never);
    expect(d.skillEnv).toEqual(mine);
  });
});

describe("buildCatalog", () => {
  test("empty incoming keeps existing untouched", () => {
    expect(buildCatalog(undefined, repos)).toEqual(repos);
    expect(buildCatalog([], repos)).toEqual(repos);
  });
  test("merges per-slug, preserving fields the incoming entry omits", () => {
    const existing: RepoEntry[] = [
      {
        slug: "ArcBlock/arc",
        defaultBranch: "main",
        skills: ["issue-sweep"],
        cloneUrl: "git@github.com:ArcBlock/arc.git",
        setupCommand: "pnpm install",
        skillConcurrency: { "issue-sweep": 4 },
      },
    ];
    const incoming: RepoEntry[] = [
      {
        slug: "ArcBlock/arc",
        defaultBranch: "main",
        skills: ["issue-sweep", "pr-sweep"],
        cadenceMinutes: 120,
      },
    ];
    const merged = buildCatalog(incoming, existing);
    expect(merged).toHaveLength(1);
    expect(merged[0].skills).toEqual(["issue-sweep", "pr-sweep"]); // updated
    expect(merged[0].cadenceMinutes).toBe(120); // added
    expect(merged[0].cloneUrl).toBe("git@github.com:ArcBlock/arc.git"); // preserved
    expect(merged[0].setupCommand).toBe("pnpm install"); // preserved
    expect(merged[0].skillConcurrency).toEqual({ "issue-sweep": 4 }); // preserved
  });
  test("preserves hand-added referenceRepos (the installer never asks for them)", () => {
    const existing: RepoEntry[] = [
      {
        slug: "ArcBlock/arcblock-site",
        defaultBranch: "main",
        skills: ["issue-sweep"],
        referenceRepos: ["ArcBlock/arc"],
      },
    ];
    const merged = buildCatalog(
      [{ slug: "ArcBlock/arcblock-site", defaultBranch: "main", skills: ["issue-sweep"] }],
      existing,
    );
    expect(merged[0].referenceRepos).toEqual(["ArcBlock/arc"]);
  });
  test("adds a new repo alongside existing", () => {
    const merged = buildCatalog(
      [{ slug: "ArcBlock/new", defaultBranch: "main", skills: ["issue-sweep"] }],
      repos,
    );
    expect(merged.map((r) => r.slug)).toContain("ArcBlock/new");
    expect(merged).toHaveLength(3);
  });
});

describe("coveredSkills", () => {
  test("union across repos, stable sorted", () => {
    expect(coveredSkills(repos, "all")).toEqual(["issue-sweep", "pr-sweep"]);
  });
  test("respects an explicit cover subset", () => {
    expect(coveredSkills(repos, ["ArcBlock/did"])).toEqual(["issue-sweep"]);
  });
});

describe("renderCronRow", () => {
  test("invokes the STABLE launcher (never a versioned plugin path), sources envFile, NO cron-level lock", () => {
    const row = renderCronRow(baseInput({ envFile: "~/.arc-routines/env" }), "issue-sweep", 9);
    expect(row).not.toContain("shlock");
    expect(row).not.toContain("flock");
    expect(row).toContain("/agentloop-run.ts --config");
    // NEVER the raw agentloopRoot baked in directly — that is exactly the staleness bug
    // this launcher indirection exists to prevent (a plugin upgrade deletes that path).
    expect(row).not.toContain("/fleet/driver.ts");
    expect(row).toContain("--skill issue-sweep --run");
    expect(row).toContain(". /"); // envFile sourced (expandHome'd absolute path)
    expect(row).toContain("cron-issue-sweep.log");
    expect(row.startsWith("9 * * * *")).toBe(true);
  });
  test("OS-independent now that the cron lock is gone (Darwin === Linux)", () => {
    const darwin = renderCronRow(baseInput({ os: "Darwin" }), "pr-sweep", 39);
    const linux = renderCronRow(baseInput({ os: "Linux" }), "pr-sweep", 39);
    expect(darwin).toBe(linux);
  });
  test("no envFile → no source prefix, still runs the driver", () => {
    const row = renderCronRow(baseInput({ envFile: undefined }), "pr-sweep", 39);
    expect(row).not.toContain(". /");
    expect(row).toContain("--skill pr-sweep --run");
  });
});

describe("renderCronBlock", () => {
  test("has begin/end markers, PATH, one row per skill, stagger applied", () => {
    const input = baseInput({ cover: "all" });
    const block = renderCronBlock(input, repos);
    expect(block).toContain(CRON_BEGIN);
    expect(block.trimEnd().endsWith(CRON_END)).toBe(true);
    expect(block).toContain("PATH=/usr/bin:/bin");
    const off = staggerOffset("alice");
    expect(block).toContain(`\n${(9 + off) % 60} * * * *`);
    expect(block).toContain(`\n${(39 + off) % 60} * * * *`);
    // one row per distinct skill
    expect((block.match(/agentloop-run\.ts --config/g) ?? []).length).toBe(2);
  });
});

describe("stripCronBlock / reconcileCrontab", () => {
  const other = "# my own job\n0 3 * * * /usr/bin/backup\n";

  test("strips only our block, keeps foreign lines", () => {
    const block = renderCronBlock(baseInput(), repos);
    const combined = `${other}\n${block}\n`;
    const { without, had } = stripCronBlock(combined);
    expect(had).toBe(true);
    expect(without).toContain("/usr/bin/backup");
    expect(without).not.toContain(CRON_BEGIN);
    expect(without).not.toContain("agentloop-run.ts");
  });

  test("no block present → had=false, content unchanged in spirit", () => {
    const { had } = stripCronBlock(other);
    expect(had).toBe(false);
  });

  test("reconcile is IDEMPOTENT — installing twice yields the same crontab", () => {
    const block = renderCronBlock(baseInput(), repos);
    const first = reconcileCrontab(other, block);
    expect(first.replaced).toBe(false);
    const second = reconcileCrontab(first.next, block);
    expect(second.replaced).toBe(true);
    expect(second.next).toBe(first.next); // stable
    // foreign job survives both passes
    expect(second.next).toContain("/usr/bin/backup");
  });

  test("reconcile replaces an OLD block with a new one (upgrade path)", () => {
    const oldBlock = renderCronBlock(baseInput({ cover: "all" }), [repos[0]]); // only arc
    const withOld = reconcileCrontab(other, oldBlock).next;
    const newBlock = renderCronBlock(baseInput(), repos); // arc + did
    const { next, replaced } = reconcileCrontab(withOld, newBlock);
    expect(replaced).toBe(true);
    // exactly one managed block remains
    expect(
      (next.match(new RegExp(CRON_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length,
    ).toBe(1);
    expect(next).toContain("ArcBlock/did".split("/").pop() as string);
  });
});

describe("coveredRepos", () => {
  test("all vs explicit subset", () => {
    expect(coveredRepos(repos, "all")).toHaveLength(2);
    expect(coveredRepos(repos, ["ArcBlock/arc"]).map((r) => r.slug)).toEqual(["ArcBlock/arc"]);
  });
});

describe("buildCloudPlan", () => {
  test("one routine per (repo × skill) with canonical name, cron, prompt path", () => {
    const plan = buildCloudPlan(baseInput({ cover: "all", model: "claude-sonnet-5" }), repos);
    // arc has 2 skills, did has 1 → 3 routines
    expect(plan).toHaveLength(3);
    const arcIssue = plan.find((p) => p.canonicalName === "arc issue-sweep hourly");
    expect(arcIssue).toBeDefined();
    expect(arcIssue?.slug).toBe("ArcBlock/arc");
    expect(arcIssue?.model).toBe("claude-sonnet-5");
    expect(arcIssue?.concurrency).toBe(3);
    expect(arcIssue?.promptPath.endsWith("/fleet/prompts/issue-sweep.md")).toBe(true);
    expect(arcIssue?.cron).toMatch(/^\d+ \* \* \* \*$/);
    expect(plan.map((p) => p.canonicalName)).toContain("did issue-sweep hourly");
  });
  test("carries per-repo skill concurrency into the cloud render plan", () => {
    const configured: RepoEntry[] = [
      { ...repos[0], skills: ["issue-sweep"], skillConcurrency: { "issue-sweep": 5 } },
    ];
    const plan = buildCloudPlan(baseInput({ cover: "all" }), configured);
    expect(plan[0].concurrency).toBe(5);
  });
  test("deterministic + respects cover subset", () => {
    const a = buildCloudPlan(baseInput({ cover: ["ArcBlock/did"] }), repos);
    const b = buildCloudPlan(baseInput({ cover: ["ArcBlock/did"] }), repos);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a[0].canonicalName).toBe("did issue-sweep hourly");
  });
});

describe("parseReposSpec", () => {
  test("parses slug=skills@cadence;…", () => {
    const parsed = parseReposSpec(
      "ArcBlock/arc=issue-sweep,pr-sweep@120;ArcBlock/did=issue-sweep@120",
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      slug: "ArcBlock/arc",
      skills: ["issue-sweep", "pr-sweep"],
      cadenceMinutes: 120,
      defaultBranch: "main",
    });
    expect(parsed[1]).toMatchObject({
      slug: "ArcBlock/did",
      skills: ["issue-sweep"],
      cadenceMinutes: 120,
    });
  });
  test("cadence optional", () => {
    const parsed = parseReposSpec("ArcBlock/arc=issue-sweep");
    expect(parsed[0].cadenceMinutes).toBeUndefined();
  });
});

describe("parseProbedPath", () => {
  test("plain output", () => {
    expect(parseProbedPath("/usr/bin/node\n")).toBe("/usr/bin/node");
  });

  // A themed profile emits a colour reset on stdout before `command -v` runs; `.trim()`
  // does not strip control chars, so these bytes used to land in the crontab PATH and
  // turn a real dir into an unresolvable one.
  test("strips ANSI escapes a login profile emits before the path", () => {
    const out = "\x1b(B\x1b[m/Users/me/.nvm/versions/node/v24.15.0/bin/node\n";
    expect(parseProbedPath(out)).toBe("/Users/me/.nvm/versions/node/v24.15.0/bin/node");
  });

  test("ignores profile chatter lines and takes the real path", () => {
    const out = "nvm: using v24\x1b[0m\nsome banner\n/opt/homebrew/bin/pnpm\n";
    expect(parseProbedPath(out)).toBe("/opt/homebrew/bin/pnpm");
  });

  test("undefined when the tool is absent or is a shell builtin", () => {
    expect(parseProbedPath("")).toBeUndefined();
    expect(parseProbedPath("cd\n")).toBeUndefined();
  });
});
