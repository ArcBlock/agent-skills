#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  cadenceDue,
  checkoutBaseStatus,
  checkoutDir,
  type DeploymentConfig,
  defaultLogDir,
  expandHome,
  loadEnvFile,
  logPaths,
  permissionFlags,
  planRuns,
  type RepoEntry,
  renderPrompt,
  resolveCovered,
  runEnv,
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
    const out = await renderPrompt(p, "robert-macbook");
    expect(out).toContain("runner is 'robert-macbook'");
    expect(out).not.toContain("{{RUNNER}}");
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

  it("does NOT import the shell's own noise (only what the file changed)", () => {
    const e = loadEnvFile(file);
    expect(e.SHLVL).toBeUndefined();
    expect(e._).toBeUndefined();
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

describe("checkoutDir", () => {
  it("owner/name → owner__name under the base", () => {
    expect(checkoutDir("/co/", "ArcBlock/arc")).toBe("/co/ArcBlock__arc");
  });
});
