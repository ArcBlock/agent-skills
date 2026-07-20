import { describe, expect, test } from "bun:test";
import type { DeploymentConfig, RepoEntry } from "./driver.ts";
import {
  buildCatalog,
  buildCloudPlan,
  buildDeployment,
  CRON_BEGIN,
  CRON_END,
  coveredRepos,
  coveredSkills,
  parseProbedPath,
  parseReposSpec,
  reconcileCrontab,
  renderCronBlock,
  renderCronRow,
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
  test("runs the driver directly, sources envFile, NO cron-level lock (driver self-locks per repo)", () => {
    const row = renderCronRow(baseInput({ envFile: "~/.arc-routines/env" }), "issue-sweep", 9);
    expect(row).not.toContain("shlock");
    expect(row).not.toContain("flock");
    expect(row).toContain("/fleet/driver.ts --config");
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
    expect((block.match(/driver\.ts --config/g) ?? []).length).toBe(2);
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
    expect(without).not.toContain("driver.ts");
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
    expect(arcIssue?.promptPath.endsWith("/fleet/prompts/issue-sweep.md")).toBe(true);
    expect(arcIssue?.cron).toMatch(/^\d+ \* \* \* \*$/);
    expect(plan.map((p) => p.canonicalName)).toContain("did issue-sweep hourly");
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
