#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  buildArgv,
  cadenceDue,
  checkoutBaseStatus,
  checkoutDir,
  codexPermissionFlags,
  type DeploymentConfig,
  defaultLogDir,
  engineModelFlags,
  enginePermissionFlags,
  executeRun,
  expandHome,
  loadEnvFile,
  logPaths,
  newRunId,
  permissionFlags,
  pidsWithCwdUnder,
  planRuns,
  type RepoEntry,
  type ResolvedEngine,
  RUN_REPORT_ENV,
  readRunProduct,
  reapGroup,
  reapOrphans,
  referenceEnvKey,
  renderPrompt,
  resolveCovered,
  resolveEngine,
  rotateIfLarge,
  runEnv,
  settleResidual,
  stateKey,
  summaryLine,
} from "./driver.ts";

const CATALOG: RepoEntry[] = [
  { slug: "ArcBlock/arc", defaultBranch: "main", skills: ["issue-sweep", "pr-sweep"] },
  { slug: "ArcBlock/did", defaultBranch: "main", skills: ["issue-sweep", "pr-sweep"] },
  { slug: "ArcBlock/arcblock-site", defaultBranch: "main", skills: ["issue-sweep"] },
];
const base = (over: Partial<DeploymentConfig> = {}): DeploymentConfig => ({
  runner: "r1",
  agentloopRoot: "/plugins/agentloop",
  checkoutBase: "/co",
  cover: "all",
  ...over,
});

describe("resolveCovered", () => {
  it("'all' covers the whole catalog", () => {
    expect(resolveCovered(CATALOG, base()).map((r) => r.slug)).toEqual([
      "ArcBlock/arc",
      "ArcBlock/did",
      "ArcBlock/arcblock-site",
    ]);
  });

  it("a subset covers only the listed repos", () => {
    const r = resolveCovered(CATALOG, base({ cover: ["ArcBlock/did"] }));
    expect(r.map((x) => x.slug)).toEqual(["ArcBlock/did"]);
  });

  it("applies per-slug overrides on top of the catalog entry", () => {
    const r = resolveCovered(
      CATALOG,
      base({ cover: ["ArcBlock/did"], overrides: { "ArcBlock/did": { skills: ["issue-sweep"] } } }),
    );
    expect(r[0].skills).toEqual(["issue-sweep"]);
  });

  it("throws (loud, not silent) when covering a repo absent from the catalog", () => {
    expect(() => resolveCovered(CATALOG, base({ cover: ["ArcBlock/ghost"] }))).toThrow(
      /absent from the catalog/,
    );
  });
});

describe("planRuns", () => {
  it("emits one run per (repo × skill), namespaced + rooted + runner-tagged", () => {
    const plan = planRuns(CATALOG, base({ cover: ["ArcBlock/arc"] }));
    expect(plan.map((p) => p.skill)).toEqual(["agentloop:issue-sweep", "agentloop:pr-sweep"]);
    expect(plan[0].checkoutPath).toBe("/co/ArcBlock__arc");
    expect(plan[0].command).toContain("AGENTLOOP_ROOT=/plugins/agentloop");
    expect(plan[0].command).toContain("ARC_AGENT_RUNNER=r1");
    expect(plan[0].command).toContain("--plugin-dir /plugins/agentloop");
    // --add-dir is required: Bash is sandboxed to the checkout, so without it the skills'
    // own scripts (outside it, under the plugin root) are unreachable — live-smoke finding.
    expect(plan[0].command).toContain("--add-dir /plugins/agentloop");
    // Default posture is the SAFE one; skip is opt-in per deployment.
    expect(plan[0].command).toContain("--permission-mode acceptEdits");
    expect(plan[0].command).not.toContain("--dangerously-skip-permissions");
    // Arms the hook that hard-denies AskUserQuestion/Workflow/EnterPlanMode — a waiting
    // tool call would hang an unattended run forever.
    expect(plan[0].command).toContain("ARC_UNATTENDED=1");
    expect(plan[0].command).toContain("@issue-sweep.md");
    expect(plan[0].skill).toBe("agentloop:issue-sweep");
    expect(plan[0].promptPath).toContain("prompts/issue-sweep.md");
  });

  it("--only narrows to a single repo", () => {
    const plan = planRuns(CATALOG, base(), "ArcBlock/did");
    expect(new Set(plan.map((p) => p.slug))).toEqual(new Set(["ArcBlock/did"]));
  });

  it("carries repo×skill concurrency into the plan, prompt env, and worker setup env", () => {
    const catalog: RepoEntry[] = [
      {
        ...CATALOG[0],
        skills: ["issue-sweep"],
        setupCommand: "pnpm install --frozen-lockfile",
        skillConcurrency: { "issue-sweep": 4 },
      },
    ];
    const cfg = base({ cover: ["ArcBlock/arc"] });
    const run = planRuns(catalog, cfg)[0];
    expect(run.concurrency).toBe(4);
    expect(run.command).toContain("AGENTLOOP_SKILL_CONCURRENCY=4");
    const env = runEnv(run, cfg, {});
    expect(env.AGENTLOOP_SKILL_CONCURRENCY).toBe("4");
    expect(env.AGENTLOOP_SETUP_COMMAND).toBe("pnpm install --frozen-lockfile");
  });

  it("rejects invalid repo×skill concurrency instead of silently running unbounded", () => {
    const invalid = (value: number): RepoEntry[] => [
      {
        ...CATALOG[0],
        skills: ["issue-sweep"],
        skillConcurrency: { "issue-sweep": value },
      },
    ];
    expect(() => planRuns(invalid(0), base({ cover: ["ArcBlock/arc"] }))).toThrow(
      /between 1 and 16/,
    );
    expect(() => planRuns(invalid(1.5), base({ cover: ["ArcBlock/arc"] }))).toThrow(
      /between 1 and 16/,
    );
    expect(() => planRuns(invalid(17), base({ cover: ["ArcBlock/arc"] }))).toThrow(
      /between 1 and 16/,
    );
  });

  it("two deployments covering the same repo plan identical commands (coordination is per-item via labels, not here)", () => {
    const a = planRuns(CATALOG, base({ runner: "a", cover: ["ArcBlock/arc"] }), "ArcBlock/arc");
    const b = planRuns(CATALOG, base({ runner: "b", cover: ["ArcBlock/arc"] }), "ArcBlock/arc");
    expect(a.map((p) => p.skill)).toEqual(b.map((p) => p.skill)); // both plan the same skills; the label lock decides who actually processes each item
  });
});

describe("permissionMode (a per-deployment blast-radius choice, never the driver's)", () => {
  it("defaults to the safe posture (acceptEdits), NOT unrestricted", () => {
    expect(permissionFlags(undefined)).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("'skip' is an explicit opt-in to unrestricted tool access", () => {
    expect(permissionFlags("skip")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("'default' passes no flag (strictest)", () => {
    expect(permissionFlags("default")).toEqual([]);
  });

  it("the chosen posture reaches the planned command + the run", () => {
    const plan = planRuns(CATALOG, base({ cover: ["ArcBlock/arc"], permissionMode: "skip" }));
    expect(plan[0].command).toContain("--dangerously-skip-permissions");
    expect(plan[0].permFlags).toEqual(["--dangerously-skip-permissions"]);
  });
});

describe("expandHome", () => {
  it("expands a leading ~/ (the shell does, node's existsSync does NOT — that mismatch made the checkout probe always miss)", () => {
    expect(expandHome("~/x")).toBe(`${homedir()}/x`);
    expect(expandHome("/abs/x")).toBe("/abs/x");
    expect(expandHome("rel/x")).toBe("rel/x");
  });

  it("planRuns expands ~ in checkoutBase so the probe sees a real path", () => {
    const plan = planRuns(CATALOG, base({ checkoutBase: "~/.fleet", cover: ["ArcBlock/arc"] }));
    expect(plan[0].checkoutPath).toBe(`${homedir()}/.fleet/ArcBlock__arc`);
  });

  it("planRuns expands ~ in the worktree baseDir too", () => {
    const plan = planRuns(
      CATALOG,
      base({
        cover: ["ArcBlock/arc"],
        checkout: { mode: "worktree", baseDir: "~/Develop/arcblock" },
      }),
    );
    expect(plan[0].policy).toEqual({ mode: "worktree", baseDir: `${homedir()}/Develop/arcblock` });
  });
});

describe("renderPrompt", () => {
  it("substitutes {{RUNNER}} in the real generalized prompt + keeps the namespaced skill name", async () => {
    const p = new URL("prompts/issue-sweep.md", import.meta.url).pathname;
    const out = await renderPrompt(p, "robert-macbook", 4);
    expect(out).toContain("runner is 'robert-macbook'");
    expect(out).not.toContain("{{RUNNER}}");
    expect(out).not.toContain("{{CONCURRENCY}}");
    expect(out).toContain("--concurrency 4");
    expect(out).toContain("agentloop:issue-sweep"); // namespaced, per the namespace fix
    expect(out.toLowerCase()).toContain("unattended");
  });
});

describe("envFile / env / skillEnv (cron parity: a scheduled round has almost no environment)", () => {
  const T = `${tmpdir()}/agentloop-envfile-test`;
  const file = `${T}/env`;
  beforeAll(() => {
    mkdirSync(T, { recursive: true });
    // The shape the live cron block uses: a sourced file holding the credentials.
    writeFileSync(
      file,
      'export GH_TOKEN=gho_faketoken\nexport CLAUDE_CODE_OAUTH_TOKEN=sk-ant-fake\nexport PATH="$PATH:/added/bin"\n',
    );
  });
  afterAll(() => rmSync(T, { recursive: true, force: true }));

  it("returns the vars the file sets, and resolves $PATH-style appends against the real shell", () => {
    const e = loadEnvFile(file);
    expect(e.GH_TOKEN).toBe("gho_faketoken");
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-fake");
    expect(e.PATH).toContain("/added/bin");
  });

  it("does NOT import the shell's own noise (only the vars the file assigns)", () => {
    const e = loadEnvFile(file);
    expect(e.SHLVL).toBeUndefined();
    expect(e._).toBeUndefined();
    expect(e.PWD).toBeUndefined();
  });

  it("returns the file's var even when it is ALREADY in the environment with the SAME value", () => {
    // Reproduces the live cron bug: the cron line did `. env` first, so GH_TOKEN was already
    // set to the same value; a before/after diff was empty and the guard aborted. The
    // assignment-based read must still return it. realSh inherits process.env, so pre-set it.
    const f = `${T}/env-preset`;
    writeFileSync(f, "export ALREADY=fromfile\n");
    process.env.ALREADY = "fromfile"; // identical to the file → old diff would be empty
    try {
      expect(loadEnvFile(f).ALREADY).toBe("fromfile");
    } finally {
      delete process.env.ALREADY;
    }
  });

  it("throws on a missing envFile — a nightly run without credentials must not look like a quiet no-op", () => {
    expect(() => loadEnvFile(`${T}/nope`)).toThrow(/not readable/);
  });

  it("layers process env < envFile < env < skillEnv, and expands {{CHECKOUT}}", () => {
    const cfg = base({
      envFile: file,
      env: { ARC_HOME: "{{CHECKOUT}}/.arc-home", SHARED: "deployment" },
      skillEnv: { "issue-sweep": { ARC_SERVICE_PORT: "4910", SHARED: "skill-wins" } },
    });
    const run = {
      skillLocal: "issue-sweep",
      checkoutPath: "/co/x",
      root: "/plugins",
      runner: "r1",
    };
    const e = runEnv(run, cfg, { PRE_EXISTING: "kept", SHARED: "process" });
    expect(e.PRE_EXISTING).toBe("kept");
    expect(e.GH_TOKEN).toBe("gho_faketoken"); // envFile beats process env
    expect(e.ARC_HOME).toBe("/co/x/.arc-home"); // {{CHECKOUT}} expanded
    expect(e.ARC_SERVICE_PORT).toBe("4910");
    expect(e.SHARED).toBe("skill-wins"); // per-skill has the last word
    // Driver-owned identity must not be overridable by config.
    expect(e.ARC_UNATTENDED).toBe("1");
    expect(e.ARC_AGENT_RUNNER).toBe("r1");
  });

  it("gives each routine its own ports — the collision the hand-written cron block avoided", () => {
    const cfg = base({
      skillEnv: {
        "issue-sweep": { ARC_SERVICE_PORT: "4910", ARC_WORKER_PORT: "8797" },
        "pr-sweep": { ARC_SERVICE_PORT: "4920", ARC_WORKER_PORT: "8807" },
      },
    });
    const mk = (s: string) => ({ skillLocal: s, checkoutPath: "/co/x", root: "/p", runner: "r" });
    expect(runEnv(mk("issue-sweep"), cfg, {}).ARC_SERVICE_PORT).toBe("4910");
    expect(runEnv(mk("pr-sweep"), cfg, {}).ARC_SERVICE_PORT).toBe("4920");
  });

  it("NEVER prints secret values in the plan — only that the file is sourced", () => {
    const plan = planRuns(
      CATALOG,
      base({ cover: ["ArcBlock/arc"], envFile: file, env: { TOKENISH: "s3cret" } }),
    );
    expect(plan[0].command).toContain(`. ${file}`);
    expect(plan[0].command).toContain("TOKENISH=…");
    expect(plan[0].command).not.toContain("s3cret");
    expect(plan[0].command).not.toContain("gho_faketoken");
  });
});

describe("checkoutPerSkill + --skill (independent cadences, the shape the cron block had)", () => {
  it("defaults to ONE tree per repo (skills share it, so they must run serially)", () => {
    const plan = planRuns(CATALOG, base({ cover: ["ArcBlock/arc"] }));
    expect(plan.map((p) => p.checkoutPath)).toEqual(["/co/ArcBlock__arc", "/co/ArcBlock__arc"]);
  });

  it("checkoutPerSkill gives each routine its own tree — so cron can run them concurrently", () => {
    const plan = planRuns(CATALOG, base({ cover: ["ArcBlock/arc"], checkoutPerSkill: true }));
    expect(plan.map((p) => p.checkoutPath)).toEqual([
      "/co/ArcBlock__arc__issue-sweep",
      "/co/ArcBlock__arc__pr-sweep",
    ]);
  });

  it("--skill narrows to one routine (cron: :09 issue-sweep, :39 pr-sweep)", () => {
    const plan = planRuns(CATALOG, base(), undefined, "pr-sweep");
    expect(plan.every((p) => p.skillLocal === "pr-sweep")).toBe(true);
    expect(plan.map((p) => p.slug)).toEqual(["ArcBlock/arc", "ArcBlock/did"]); // arcblock-site has no pr-sweep
  });

  it("--only + --skill compose to exactly one run", () => {
    const plan = planRuns(CATALOG, base(), "ArcBlock/did", "issue-sweep");
    expect(plan.length).toBe(1);
    expect(plan[0].skill).toBe("agentloop:issue-sweep");
  });

  it("an unknown --skill plans nothing rather than silently running everything", () => {
    expect(planRuns(CATALOG, base(), undefined, "no-such-skill")).toEqual([]);
  });
});

describe("setupCommand", () => {
  it("carries the catalog's install command into the run (a fresh tree has no node_modules)", () => {
    const cat: RepoEntry[] = [
      { ...CATALOG[0], skills: ["issue-sweep"], setupCommand: "pnpm install --frozen-lockfile" },
    ];
    expect(planRuns(cat, base({ cover: ["ArcBlock/arc"] }))[0].setupCommand).toBe(
      "pnpm install --frozen-lockfile",
    );
  });

  it("is absent when the catalog declares none", () => {
    expect(planRuns(CATALOG, base({ cover: ["ArcBlock/did"] }))[0].setupCommand).toBeUndefined();
  });

  // REGRESSION GUARD. setupCommand used to inherit the driver's own environment, so a
  // deployment's `env` reached the skill but NOT the install. The failure is silent — the
  // install "succeeds" against the wrong config (wrong store-dir/registry/proxy) and nothing
  // errors — so only a test can hold this. If you refactor executeRun, keep the env argument.
  it("runs with the deployment's env, not the driver's (a silent-wrong-install regression)", async () => {
    const root = `${tmpdir()}/fleet-setupenv-${process.pid}`;
    const co = `${root}/checkouts/ArcBlock__arc__issue-sweep`;
    mkdirSync(`${co}/.git`, { recursive: true });
    // Mark the tree as ours so ensureCheckout resets it instead of refusing to touch it.
    mkdirSync(`${root}/checkouts/.agentloop-fleet-markers`, { recursive: true });
    writeFileSync(`${root}/checkouts/.agentloop-fleet-markers/ArcBlock__arc__issue-sweep`, "");

    const seen: { cmd: string; env?: Record<string, string> }[] = [];
    const fakeSh = (cmd: string, env?: Record<string, string>) => {
      seen.push({ cmd, env });
      // Fail the install so executeRun returns before spawning a real `claude`.
      return cmd.includes("pnpm install") ? { code: 1, out: "boom" } : { code: 0, out: "" };
    };

    const cfg = base({
      checkoutBase: `${root}/checkouts`,
      logDir: `${root}/logs`,
      cover: ["ArcBlock/arc"],
      checkoutPerSkill: true, // matches the shipped deployment shape (tree per repo × skill)
      env: { npm_config_store_dir: "/Volumes/Ext/store", SHARED: "from-deployment" },
      skillEnv: { "issue-sweep": { ARC_SERVICE_PORT: "4910" } },
    });
    const cat: RepoEntry[] = [
      { ...CATALOG[0], skills: ["issue-sweep"], setupCommand: "pnpm install --frozen-lockfile" },
    ];
    const run = planRuns(cat, cfg)[0];
    const res = await executeRun(run, cfg, fakeSh, false);

    expect(res.ok).toBe(false); // we forced the install to fail
    const setup = seen.find((s) => s.cmd.includes("pnpm install"));
    expect(setup).toBeDefined();
    expect(setup?.env).toBeDefined(); // ← the whole point: env must be PASSED, not inherited
    expect(setup?.env?.npm_config_store_dir).toBe("/Volumes/Ext/store");
    expect(setup?.env?.SHARED).toBe("from-deployment");
    expect(setup?.env?.ARC_SERVICE_PORT).toBe("4910"); // per-skill env reaches setup too
    expect(setup?.env?.ARC_UNATTENDED).toBe("1"); // driver-owned identity is there as well

    // The checkout is a step of the run too — a deployment's git config (proxy,
    // GIT_SSH_COMMAND) must reach `git clone`/`fetch`, not just the install.
    const git = seen.filter((s) => s.cmd.startsWith("git "));
    expect(git.length).toBeGreaterThan(0);
    for (const g of git) expect(g.env?.SHARED).toBe("from-deployment");

    // Superset, not replacement: what git inherits today must survive.
    expect(setup?.env?.PATH).toBe(process.env.PATH);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("referenceRepos (a repo that must READ another repo to work)", () => {
  const cat: RepoEntry[] = [
    { ...CATALOG[2], skills: ["issue-sweep"], referenceRepos: ["ArcBlock/arc"] },
    { ...CATALOG[0], cloneUrl: "git@github.com:ArcBlock/arc.git" },
  ];

  it("mounts one shared copy under .reference/, never inside a checkout leaf", () => {
    const p = planRuns(cat, base({ cover: ["ArcBlock/arcblock-site"] }))[0];
    expect(p.referenceRepos).toHaveLength(1);
    expect(p.referenceRepos[0].path).toBe("/co/.reference/ArcBlock__arc");
    expect(p.referenceRepos[0].cloneUrl).toBe("git@github.com:ArcBlock/arc.git"); // from catalog
    expect(p.referenceRepos[0].branch).toBe("main");
  });

  it("hands the reference to the skill as an extra --add-dir root", () => {
    const p = planRuns(cat, base({ cover: ["ArcBlock/arcblock-site"] }))[0];
    expect(p.command).toContain("--add-dir /co/.reference/ArcBlock__arc");
  });

  it("throws on a slug absent from the catalog (a silent no-mount degrades the run blind)", () => {
    const bad: RepoEntry[] = [{ ...CATALOG[2], referenceRepos: ["ArcBlock/ghost"] }];
    expect(() => planRuns(bad, base({ cover: ["ArcBlock/arcblock-site"] }))).toThrow(
      /not in the catalog/,
    );
  });

  it("is empty for a repo that declares none", () => {
    expect(planRuns(CATALOG, base({ cover: ["ArcBlock/did"] }))[0].referenceRepos).toEqual([]);
  });

  // A repo-profile is committed and read on every machine — it must NOT name a mount path
  // (external disk here, home dir there). It names this env key, which the driver fills in.
  it("exports the mount path as a stable env key the committed profile can name", () => {
    const p = planRuns(cat, base({ cover: ["ArcBlock/arcblock-site"] }))[0];
    expect(referenceEnvKey("ArcBlock/arc")).toBe("AGENTLOOP_REF_ARCBLOCK_ARC");
    const e = runEnv(p, base({ cover: ["ArcBlock/arcblock-site"] }), {});
    expect(e.AGENTLOOP_REF_ARCBLOCK_ARC).toBe("/co/.reference/ArcBlock__arc");
  });

  // THE safety property. `--add-dir` grants WRITE, and the fleet runs
  // --dangerously-skip-permissions. A worktree reference would hang off the developer's own
  // clone; mounting that is handing an unattended agent a writable path into a human's tree.
  it("materializes in CLONE mode even when the deployment's own policy is worktree", async () => {
    const root = `${tmpdir()}/fleet-ref-${process.pid}`;
    const co = `${root}/checkouts/ArcBlock__arcblock-site`;
    mkdirSync(`${co}/.git`, { recursive: true });
    mkdirSync(`${root}/checkouts/.agentloop-fleet-markers`, { recursive: true });
    writeFileSync(`${root}/checkouts/.agentloop-fleet-markers/ArcBlock__arcblock-site`, "");
    // A real base clone, so the deployment's worktree policy is genuinely exercised —
    // without it the main checkout aborts and the reference step is never reached.
    mkdirSync(`${root}/base/arcblock-site/.git`, { recursive: true });

    const seen: string[] = [];
    const fakeSh = (cmd: string) => {
      seen.push(cmd);
      return cmd.includes("pnpm install") ? { code: 1, out: "stop" } : { code: 0, out: "" };
    };
    const cfg = base({
      checkoutBase: `${root}/checkouts`,
      logDir: `${root}/logs`,
      cover: ["ArcBlock/arcblock-site"],
      checkout: { mode: "worktree", baseDir: `${root}/base` },
    });
    const withSetup: RepoEntry[] = [{ ...cat[0], setupCommand: "pnpm install" }, cat[1]];
    await executeRun(planRuns(withSetup, cfg)[0], cfg, fakeSh, false);

    const refCmds = seen.filter((c) => c.includes(".reference/ArcBlock__arc"));
    expect(refCmds.length).toBeGreaterThan(0);
    expect(refCmds.some((c) => c.includes("git clone"))).toBe(true);
    // The reference is never materialized as a worktree, even though this deployment's own
    // checkout policy is — no command may do both.
    expect(refCmds.some((c) => c.includes("worktree"))).toBe(false);
    // …and nothing reaches into the base clone on the reference's behalf.
    expect(seen.some((c) => c.includes(`${root}/base/arc `))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("process hygiene (a round's descendants must not outlive it)", () => {
  // Found in production, not in review: a live round signalled the group and counted
  // residue in the same tick, reported "1 survived the reap", and the pid was already gone
  // when it was looked up. A residue signal that cries wolf gets ignored — which costs more
  // than the leak it exists to expose. The waits below are what make the count truthful.
  it("waits between TERM and KILL, and after KILL, so the residue count is not a race", async () => {
    const order: string[] = [];
    const slept: number[] = [];
    await reapGroup(
      4242,
      () => {},
      (_t, s) => order.push(s as string),
      999,
      async (ms) => {
        slept.push(ms);
        order.push(`wait${ms}`);
      },
      2000,
    );
    expect(order).toEqual(["SIGTERM", "wait2000", "SIGKILL", "wait250"]);
    expect(slept.length).toBe(2); // never signal-then-count in the same tick
  });

  it("skips SIGKILL entirely when the group went down on SIGTERM", async () => {
    const sent: string[] = [];
    await reapGroup(
      4242,
      () => {},
      (_t, s) => {
        sent.push(s as string);
        if (s === "SIGKILL") throw new Error("ESRCH"); // group already empty
      },
      999,
      async () => {},
    );
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]); // attempted, ESRCH → stop, no extra wait
  });

  it("signals the GROUP, not the pid — that is what reaches grandchildren", async () => {
    const sent: { target: number; sig: string }[] = [];
    await reapGroup(
      4242,
      () => {},
      (t, s) => {
        sent.push({ target: t, sig: s as string });
      },
      999,
      async () => {},
    );
    // Negative target = process group. A positive one would leave every grandchild alive,
    // which is exactly the bug: `claude` exits, its `bun test` child does not.
    expect(sent.every((s) => s.target === -4242)).toBe(true);
    expect(sent.map((s) => s.sig)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("REFUSES to reap when the child shares the driver's group (it would kill the driver)", async () => {
    const sent: number[] = [];
    let logged = "";
    await reapGroup(
      777,
      (s) => {
        logged += s;
      },
      (t) => {
        sent.push(t);
      },
      777,
      async () => {},
    );
    expect(sent).toEqual([]); // measured: without `detached`, grandchildren sit in OUR group
    expect(logged).toContain("SKIPPED");
  });

  it("stops at the first ESRCH — an empty group is the healthy path, not an error", async () => {
    const sent: string[] = [];
    let threw = false;
    await reapGroup(
      1234,
      () => {},
      (_t, s) => {
        sent.push(s as string);
        throw new Error("ESRCH");
      },
      999,
      async () => {},
    ).catch(() => {
      threw = true;
    });
    expect(threw).toBe(false); // an already-empty group is not a failure
    expect(sent).toEqual(["SIGTERM"]); // and costs no wait, no pointless SIGKILL
  });

  it("counts residue by cwd prefix, and does not mistake a sibling checkout for it", () => {
    const lsof = [
      "p101",
      "n/co/ArcBlock__arc__issue-sweep", // the checkout itself
      "p102",
      "n/co/ArcBlock__arc__issue-sweep/platforms/swift", // nested — counts
      "p103",
      "n/co/ArcBlock__arc__issue-sweep-OTHER", // prefix-similar sibling — must NOT count
      "p104",
      "n/co/ArcBlock__did__issue-sweep", // another repo's live round — must NOT count
    ].join("\n");
    const pids = pidsWithCwdUnder("/co/ArcBlock__arc__issue-sweep", () => ({
      code: 0,
      out: lsof,
    }));
    expect(pids).toEqual([101, 102]);
  });

  it("reports zero residue as absent, not as a noisy zero", () => {
    expect(pidsWithCwdUnder("/co/nothing-here", () => ({ code: 0, out: "" }))).toEqual([]);
  });

  // Measured on a live fleet: single-sample counting reported an MCP server and a shell
  // script as "survivors" while they were shutting down normally, gone seconds later.
  describe("settleResidual (a process mid-exit is not a leak)", () => {
    const lsofFor = (pids: number[]) => ({
      code: 0,
      out: pids.flatMap((p) => [`p${p}`, "n/co/X"]).join("\n"),
    });
    /** Returns each successive snapshot, so a shrinking tree can be simulated. */
    const shSeq = (snaps: number[][]) => {
      let i = 0;
      return () => lsofFor(snaps[Math.min(i++, snaps.length - 1)]);
    };

    it("does not report a tree that is still shedding", async () => {
      const r = await settleResidual("/co/X", shSeq([[1, 2, 3], [2, 3], [3], []]), async () => {});
      expect(r).toEqual([]);
    });

    it("DOES report what is still there once the set is stable for SEVERAL steps", async () => {
      // 9 never leaves — a real leak, and the whole point of the field. One unchanged step is
      // deliberately not enough: a `sleep 2` still counting down is stable the whole time it
      // is alive, and treating that as wedged was a measured false positive.
      const r = await settleResidual(
        "/co/X",
        shSeq([[9, 10], [9], [9], [9], [9], [9]]),
        async () => {},
      );
      expect(r).toEqual([9]);
    });

    it("does NOT call a set stuck after a single quiet step", async () => {
      // Stable, stable, then gone — the shape of a process on a short timer.
      const r = await settleResidual("/co/X", shSeq([[7], [7], [7], []]), async () => {});
      expect(r).toEqual([]);
    });

    it("returns immediately on a clean checkout — no waiting in the common case", async () => {
      let slept = 0;
      const r = await settleResidual(
        "/co/X",
        () => ({ code: 0, out: "" }),
        async () => {
          slept++;
        },
      );
      expect(r).toEqual([]);
      expect(slept).toBe(0); // the healthy path must not add seconds to every round
    });

    it("gives up at the ceiling rather than waiting on a churning tree forever", async () => {
      // Never stabilises and never empties: alternating sets.
      const flip = shSeq([[1], [2], [1], [2], [1], [2], [1], [2], [1], [2], [1], [2]]);
      const r = await settleResidual("/co/X", flip, async () => {}, 2000, 500, 3);
      expect(r.length).toBe(1); // bounded, and still reports what it last saw
    });
  });
});

// reapOrphans kills processes it did NOT start. Each guard below is the difference between
// "cleans up yesterday's leak" and "kills a colleague's running sweep", so each gets a test.
describe("reapOrphans (cleaning up what an earlier round left behind)", () => {
  // cwd table + ppid lookups, driven through the same `sh` the production code uses.
  const shFor = (cwds: Record<number, string>, ppids: Record<number, number>) => (cmd: string) => {
    if (cmd.includes("lsof")) {
      const out = Object.entries(cwds)
        .flatMap(([pid, cwd]) => [`p${pid}`, `n${cwd}`])
        .join("\n");
      return { code: 0, out };
    }
    const m = cmd.match(/-p (\d+)/);
    return { code: 0, out: m ? String(ppids[Number(m[1])] ?? 0) : "" };
  };

  it("kills the orphan and spares the one with a live parent", () => {
    const sh = shFor({ 101: "/co/X", 102: "/co/X/sub" }, { 101: 1, 102: 555 });
    const sent: number[] = [];
    const r = reapOrphans("/co/X", sh, (p) => sent.push(p), 999);
    expect(r.killed).toEqual([101]); // PPID 1 → re-parented leftover
    expect(sent).toEqual([101]);
    expect(r.spared).toEqual([{ pid: 102, why: "live parent 555" }]); // a RUNNING round
  });

  // The guard that matters most: a healthy concurrent sweep in another checkout.
  it("never reaches another repo's checkout, even one with a similar name", () => {
    const sh = shFor(
      { 201: "/co/ArcBlock__arc", 202: "/co/ArcBlock__arcblock-site", 203: "/co/ArcBlock__did" },
      { 201: 1, 202: 1, 203: 1 },
    );
    const sent: number[] = [];
    const r = reapOrphans("/co/ArcBlock__arc", sh, (p) => sent.push(p), 999);
    expect(r.killed).toEqual([201]);
    expect(sent).toEqual([201]); // 202/203 are other repos — scope is the path, not the name
  });

  it("never kills itself", () => {
    const sh = shFor({ 777: "/co/X" }, { 777: 1 });
    const sent: number[] = [];
    const r = reapOrphans("/co/X", sh, (p) => sent.push(p), 777);
    expect(sent).toEqual([]);
    expect(r.spared).toEqual([{ pid: 777, why: "self" }]);
  });

  it("treats a pid that vanished mid-sweep as spared, not as a failure", () => {
    const sh = shFor({ 303: "/co/X" }, { 303: 1 });
    const r = reapOrphans(
      "/co/X",
      sh,
      () => {
        throw new Error("ESRCH");
      },
      999,
    );
    expect(r.killed).toEqual([]);
    expect(r.spared).toEqual([{ pid: 303, why: "vanished" }]);
  });

  it("is a no-op on a clean checkout", () => {
    const r = reapOrphans(
      "/co/X",
      () => ({ code: 0, out: "" }),
      () => {
        throw new Error("must not be called");
      },
      999,
    );
    expect(r).toEqual({ killed: [], spared: [] });
  });
});

describe("observability: what a round DID, not just that it ran", () => {
  it("run ids sort by time and do not collide within a millisecond", () => {
    const a = newRunId(1_700_000_000_000, () => 0.1);
    const b = newRunId(1_700_000_000_000, () => 0.9);
    const later = newRunId(1_700_000_001_000, () => 0.1);
    expect(a).not.toBe(b); // same ms, different random tail
    expect(a < later).toBe(true); // base36 of epoch ms stays lexically sortable
    expect(a).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/);
  });

  it("reads the skill's structured report", () => {
    const p = readRunProduct(
      "/x/report.json",
      () => true,
      () => JSON.stringify({ prsOpened: [2035], issuesClosed: [2029], noop: false }),
      () => {},
    );
    expect(p).toEqual({ prsOpened: [2035], issuesClosed: [2029], noop: false });
  });

  // Without consuming it, a round that reports nothing inherits the previous round's work
  // and looks productive — a false positive in exactly the direction nobody would question.
  it("CONSUMES the report, so a silent round cannot inherit the last one's credit", () => {
    const removed: string[] = [];
    readRunProduct(
      "/x/report.json",
      () => true,
      () => "{}",
      (f) => removed.push(f),
    );
    expect(removed).toEqual(["/x/report.json"]);
  });

  it("survives a skill that wrote nothing, or wrote garbage", () => {
    expect(readRunProduct("/x/none.json", () => false)).toBeUndefined();
    const bad = (body: string) =>
      readRunProduct(
        "/x/r.json",
        () => true,
        () => body,
        () => {},
      );
    expect(bad("not json at all")).toBeUndefined();
    expect(bad("[1,2,3]")).toBeUndefined(); // an array is not a RunProduct
    expect(bad("null")).toBeUndefined();
  });

  it("still consumes a malformed report (else it poisons every later round)", () => {
    const removed: string[] = [];
    readRunProduct(
      "/x/r.json",
      () => true,
      () => "{oops",
      (f) => removed.push(f),
    );
    expect(removed).toEqual(["/x/r.json"]);
  });

  it("names the report file BESIDE the checkout — in-tree would dirty git status forever", () => {
    const run = { skillLocal: "issue-sweep", checkoutPath: "/co/X", root: "/p", runner: "r" };
    const e = runEnv(run, base(), {});
    expect(e[RUN_REPORT_ENV]).toBe("/co/X.run-report.json");
    expect(e[RUN_REPORT_ENV].startsWith("/co/X/")).toBe(false);
  });

  it("rotates a log past the cap, keeping exactly one generation", () => {
    const moves: [string, string][] = [];
    expect(
      rotateIfLarge(
        "/l/a.log",
        100,
        () => 500,
        (f, t) => moves.push([f, t]),
      ),
    ).toBe(true);
    expect(moves).toEqual([["/l/a.log", "/l/a.log.1"]]);
  });

  it("leaves a small log alone, and treats a missing one as nothing to do", () => {
    expect(
      rotateIfLarge(
        "/l/a.log",
        100,
        () => 50,
        () => {},
      ),
    ).toBe(false);
    expect(
      rotateIfLarge(
        "/l/a.log",
        100,
        () => undefined,
        () => {},
      ),
    ).toBe(false);
  });

  it("never fails a round because rotation failed — it is hygiene, not correctness", () => {
    expect(
      rotateIfLarge(
        "/l/a.log",
        100,
        () => 500,
        () => {
          throw new Error("EPERM");
        },
      ),
    ).toBe(false);
  });
});

describe("cadenceDue (make cadenceMinutes real: one frequent cron, per-repo frequencies)", () => {
  const run = (over = {}) => ({
    slug: "ArcBlock/arc",
    skillLocal: "issue-sweep",
    cadenceMinutes: 60,
    ...over,
  });
  const T0 = 1_000_000_000_000;

  it("no cadence declared → always due", () => {
    expect(cadenceDue(run({ cadenceMinutes: undefined }), {}, T0).due).toBe(true);
  });

  it("never run before → due now (empty state)", () => {
    expect(cadenceDue(run(), {}, T0).due).toBe(true);
  });

  it("ran 30m ago with a 60m cadence → NOT due, ~30m remaining", () => {
    const state = { [stateKey("ArcBlock/arc", "issue-sweep")]: T0 - 30 * 60_000 };
    const r = cadenceDue(run(), state, T0);
    expect(r.due).toBe(false);
    expect(r.remainingMin).toBe(30);
  });

  it("ran 61m ago with a 60m cadence → due again", () => {
    const state = { [stateKey("ArcBlock/arc", "issue-sweep")]: T0 - 61 * 60_000 };
    expect(cadenceDue(run(), state, T0).due).toBe(true);
  });

  it("ran 58m ago with a 60m cadence → DUE (slack absorbs cron jitter; else 60 → every 2h)", () => {
    // The hourly cron fires ~59–60m after the last start; without slack this reads "not due".
    const state = { [stateKey("ArcBlock/arc", "issue-sweep")]: T0 - 58 * 60_000 };
    expect(cadenceDue(run(), state, T0).due).toBe(true);
  });

  it("ran 40m ago with a 60m cadence → still NOT due (slack is small, not a free pass)", () => {
    const state = { [stateKey("ArcBlock/arc", "issue-sweep")]: T0 - 40 * 60_000 };
    expect(cadenceDue(run(), state, T0).due).toBe(false);
  });

  it("keys by BOTH repo and skill — a quiet repo's cadence doesn't gate a busy one", () => {
    const state = { [stateKey("ArcBlock/arc", "issue-sweep")]: T0 };
    // same repo, different skill → independent, still due
    expect(cadenceDue(run({ skillLocal: "pr-sweep" }), state, T0).due).toBe(true);
    // different repo, same skill → independent, still due
    expect(cadenceDue(run({ slug: "ArcBlock/did" }), state, T0).due).toBe(true);
  });
});

describe("logging (observability — a per-(repo,skill) file, not one blob per cron line)", () => {
  it("derives an isolated log file per repo AND skill, plus a shared jsonl summary", () => {
    const a = logPaths("/co/logs", "ArcBlock/arc", "issue-sweep");
    const b = logPaths("/co/logs", "ArcBlock/did", "issue-sweep");
    const c = logPaths("/co/logs", "ArcBlock/arc", "pr-sweep");
    expect(a.runLog).toBe("/co/logs/ArcBlock__arc__issue-sweep.log");
    // different repo, same skill → different file (no cross-repo mixing)
    expect(b.runLog).not.toBe(a.runLog);
    // same repo, different skill → different file
    expect(c.runLog).not.toBe(a.runLog);
    // one shared structured summary
    expect(a.summary).toBe("/co/logs/fleet.jsonl");
    expect(b.summary).toBe(a.summary);
  });

  it("defaults the log dir beside the checkouts, and expands ~", () => {
    expect(defaultLogDir("/co")).toBe("/co/logs");
    expect(defaultLogDir("~/.fleet")).toBe(`${homedir()}/.fleet/logs`);
  });

  it("summaryLine is one parseable JSON object per run (tail | jq)", () => {
    const line = summaryLine({
      ts: "2026-07-18T00:00:00.000Z",
      runner: "wangshijun",
      slug: "ArcBlock/arc",
      skill: "issue-sweep",
      outcome: "ok",
      exitCode: 0,
      ms: 1234,
      detail: "checkout reset; claude exit 0",
    });
    const parsed = JSON.parse(line);
    expect(parsed.outcome).toBe("ok");
    expect(parsed.slug).toBe("ArcBlock/arc");
    expect(parsed.ms).toBe(1234);
  });
});

describe("checkoutBaseStatus (mount guard — fail loud when an external disk is gone)", () => {
  it("an internal path is always available (guard is a no-op there)", () => {
    expect(checkoutBaseStatus("/Users/me/.agentloop-fleet/checkouts", () => true).ok).toBe(true);
  });

  it("an unmounted /Volumes/<name> is reported by name, not a cryptic mkdir error", () => {
    // The volume dir does not exist → disk not mounted.
    const r = checkoutBaseStatus("/Volumes/Fleet/agentloop-fleet/checkouts", () => false);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("/Volumes/Fleet");
    expect(r.reason).toContain("not mounted");
  });

  it("a MOUNTED /Volumes/<name> is available (only the volume root needs to exist yet)", () => {
    const mounted = (p: string) => p === "/Volumes/Fleet"; // checkouts subdir not created yet
    expect(checkoutBaseStatus("/Volumes/Fleet/agentloop-fleet/checkouts", mounted).ok).toBe(true);
  });

  it("expands ~ before checking (a literal ~ would never be a /Volumes path)", () => {
    expect(checkoutBaseStatus("~/.agentloop-fleet", (p) => p === homedir()).ok).toBe(true);
  });
});

describe("model", () => {
  it("passes --model through to the plan and the run", () => {
    const plan = planRuns(CATALOG, base({ cover: ["ArcBlock/arc"], model: "claude-opus-4-8" }));
    expect(plan[0].modelFlags).toEqual(["--model", "claude-opus-4-8"]);
    expect(plan[0].command).toContain("--model claude-opus-4-8");
  });

  it("omits the flag entirely when unset (CLI default)", () => {
    expect(planRuns(CATALOG, base({ cover: ["ArcBlock/arc"] }))[0].modelFlags).toEqual([]);
  });
});

describe("engine (claude default + codex) — verified against the live write-back probe", () => {
  const CLAUDE: ResolvedEngine = { kind: "claude", bin: "claude" };
  const CODEX: ResolvedEngine = { kind: "codex", bin: "codex" };
  const argvOpts = (over = {}) => ({
    prompt: "PROMPT",
    root: "/root",
    refPaths: [],
    permFlags: [],
    modelFlags: [],
    ...over,
  });

  it("resolveEngine defaults to claude when nothing is set (back-compat: zero config change)", () => {
    expect(resolveEngine(base())).toEqual({ kind: "claude", bin: "claude" });
  });

  it("resolveEngine: the legacy top-level model still applies to claude with no engine.model", () => {
    expect(resolveEngine(base({ model: "claude-opus-4-8" }))).toEqual({
      kind: "claude",
      bin: "claude",
      model: "claude-opus-4-8",
    });
  });

  it("resolveEngine: a per-repo engine overrides the deployment default", () => {
    const cfg = base({ engine: { kind: "claude" } });
    expect(resolveEngine(cfg, { engine: { kind: "codex", model: "gpt-x" } })).toEqual({
      kind: "codex",
      bin: "codex",
      model: "gpt-x",
    });
  });

  it("resolveEngine: legacy top-level model does NOT leak into codex (id namespaces differ)", () => {
    expect(resolveEngine(base({ model: "claude-opus-4-8", engine: { kind: "codex" } }))).toEqual({
      kind: "codex",
      bin: "codex",
    });
  });

  it("resolveEngine: bin defaults to the kind, and is overridable", () => {
    expect(resolveEngine(base({ engine: { kind: "codex", bin: "/opt/codex" } })).bin).toBe(
      "/opt/codex",
    );
  });

  it("codex permission dialect maps the same three postures (skip == unrestricted)", () => {
    expect(codexPermissionFlags("skip")).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(codexPermissionFlags("default")).toEqual(["-s", "read-only"]);
    expect(codexPermissionFlags(undefined)).toEqual(["-s", "workspace-write"]); // acceptEdits
  });

  it("enginePermissionFlags routes to the right dialect per engine", () => {
    expect(enginePermissionFlags("claude", "skip")).toEqual(["--dangerously-skip-permissions"]);
    expect(enginePermissionFlags("codex", "skip")).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("engineModelFlags uses --model for claude and -m for codex", () => {
    expect(engineModelFlags({ kind: "claude", bin: "claude", model: "m1" })).toEqual([
      "--model",
      "m1",
    ]);
    expect(engineModelFlags({ kind: "codex", bin: "codex", model: "m2" })).toEqual(["-m", "m2"]);
    expect(engineModelFlags(CODEX)).toEqual([]); // no model → no flag
  });

  it("buildArgv(claude) is byte-for-byte the pre-refactor invocation (regression guard)", () => {
    expect(buildArgv(CLAUDE, argvOpts({ permFlags: ["--dangerously-skip-permissions"] }))).toEqual([
      "claude",
      "-p",
      "PROMPT",
      "--plugin-dir",
      "/root",
      "--add-dir",
      "/root",
      "--dangerously-skip-permissions",
    ]);
  });

  it("buildArgv(codex): `exec <prompt>`, NO --plugin-dir/-p, prompt is positional", () => {
    const argv = buildArgv(
      CODEX,
      argvOpts({ permFlags: ["--dangerously-bypass-approvals-and-sandbox"] }),
    );
    expect(argv).toEqual([
      "codex",
      "exec",
      "PROMPT",
      "--add-dir",
      "/root",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(argv).not.toContain("--plugin-dir");
    expect(argv).not.toContain("-p");
  });

  it("buildArgv: --add-dir carries the references identically on both engines", () => {
    const refs = { refPaths: ["/ref/a", "/ref/b"] };
    for (const eng of [CLAUDE, CODEX]) {
      const argv = buildArgv(eng, argvOpts(refs));
      expect(argv).toContain("/ref/a");
      expect(argv).toContain("/ref/b");
      // one --add-dir per reference, plus the root (root only gets --add-dir'd, never --plugin-dir on codex)
      expect(argv.filter((a) => a === "--add-dir").length).toBe(3);
    }
  });

  it("planRuns(codex): the readable command reflects `codex exec`, not claude", () => {
    const plan = planRuns(
      CATALOG,
      base({ cover: ["ArcBlock/arc"], engine: { kind: "codex", model: "gpt-x" } }),
    );
    expect(plan[0].engine).toEqual({ kind: "codex", bin: "codex", model: "gpt-x" });
    expect(plan[0].command).toContain("codex exec --add-dir");
    expect(plan[0].command).not.toContain("--plugin-dir");
    expect(plan[0].command).toContain("-m gpt-x");
    expect(plan[0].modelFlags).toEqual(["-m", "gpt-x"]);
  });

  it("planRuns: a per-repo engine override coexists with a claude default in one plan", () => {
    const cfg = base({
      cover: ["ArcBlock/arc", "ArcBlock/did"],
      overrides: { "ArcBlock/did": { engine: { kind: "codex" } } },
    });
    const byRepo = Object.fromEntries(planRuns(CATALOG, cfg).map((p) => [p.slug, p.engine.kind]));
    expect(byRepo["ArcBlock/arc"]).toBe("claude");
    expect(byRepo["ArcBlock/did"]).toBe("codex");
  });
});

describe("checkoutDir", () => {
  it("owner/name → owner__name under the base", () => {
    expect(checkoutDir("/co/", "ArcBlock/arc")).toBe("/co/ArcBlock__arc");
  });
});
