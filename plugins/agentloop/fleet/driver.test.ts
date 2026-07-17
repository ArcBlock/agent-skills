#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import {
  checkoutDir,
  type DeploymentConfig,
  expandHome,
  permissionFlags,
  planRuns,
  type RepoEntry,
  renderPrompt,
  resolveCovered,
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

describe("checkoutDir", () => {
  it("owner/name → owner__name under the base", () => {
    expect(checkoutDir("/co/", "ArcBlock/arc")).toBe("/co/ArcBlock__arc");
  });
});
