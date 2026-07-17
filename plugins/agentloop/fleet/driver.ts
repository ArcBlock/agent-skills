#!/usr/bin/env bun
/**
 * agentloop fleet driver — DECENTRALIZED.
 *
 * A deployment (cloud or local) runs this with a deployment config that says which
 * repos IT covers (all, or a subset). Many deployments run independently and may cover
 * overlapping repo sets; they do NOT coordinate directly. Coordination is via GitHub
 * labels: the loop skills acquire an `agent:processing` advisory TTL lock per issue/PR
 * (deterministic branch names + claim checks catch races), so whichever deployment grabs
 * an item first processes it and the rest skip. GitHub is the shared claim substrate —
 * there is no central coordinator.
 *
 *   bun fleet/driver.ts --config <deployment.json> [--catalog <repos.json>] [--only <slug>] [--run]
 *     (default) dry-run: print the plan (which repos × skills, and the exact command)
 *     --run    : ensure a fresh checkout per repo, then run each skill headless, staggered
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { type CheckoutPolicy, ensureCheckout, type Sh } from "./checkout.ts";

/**
 * Expand a leading `~` to the real home dir. Required: the shell expands `~` but
 * node's existsSync does NOT, so a literal `~/...` path would make the checkout probe
 * always report "missing" and re-attempt `worktree add` every round.
 */
export const expandHome = (p: string): string => (p.startsWith("~/") ? homedir() + p.slice(1) : p);

export interface RepoEntry {
  /** owner/name */
  slug: string;
  defaultBranch: string;
  /** agentloop skill local names, invoked as `agentloop:<skill>` (issue-sweep, pr-sweep, …) */
  skills: string[];
  /** clone URL (clone-on-demand); optional if the checkout already exists */
  cloneUrl?: string;
  /** advisory sweep-frequency hint (minutes); the scheduler / P6 enforces it, not the driver */
  cadenceMinutes?: number;
}

export interface DeploymentConfig {
  /** runner identity carried into every comment's identity line */
  runner: string;
  /** AGENTLOOP_ROOT for the runs; defaults to this plugin's own location */
  agentloopRoot?: string;
  /** where per-repo checkouts live; a repo's checkout is <checkoutBase>/<owner>__<name> */
  checkoutBase: string;
  /** which repos this deployment covers: "all" (of the catalog) or an explicit slug list */
  cover: "all" | string[];
  /** seconds to wait between runs in --run mode (default 30) — API-burst courtesy */
  staggerSeconds?: number;
  /** override the unattended prompt dir (default: this plugin's fleet/prompts). A
   *  deployment can ship its own per-skill prompts (e.g. a dry-run variant for a smoke). */
  promptDir?: string;
  /**
   * Permission posture for the headless run. **Deliberately not hardcoded** — it is a
   * per-deployment blast-radius decision, not the driver's to make.
   *
   *  - "acceptEdits" (DEFAULT, safest): auto-accept file edits; every other tool needs the
   *    REPO's own .claude/settings.json allowlist, and a command that misses it is DENIED
   *    (headless has no human to ask). MEASURED CAVEAT: a checkout this driver just created
   *    is an UNTRUSTED workspace, and Claude Code ignores permissions.allow in an untrusted
   *    workspace ("Ignoring N permissions.allow entry … not been trusted") — so on a fresh
   *    checkout this posture runs only what the read-only sandbox auto-approves, allowlist
   *    or not. Safe, but frequently not workable; pre-trust the path to make it useful.
   *  - "skip": --dangerously-skip-permissions — UNRESTRICTED tool access. An autonomous
   *    fix-and-PR sweep often needs it (it runs the repo's arbitrary build/test commands,
   *    which no allowlist enumerates); this is what the proven cron routines use, and it is
   *    the practical posture for fresh checkouts. Real blast radius: only for an isolated,
   *    disposable checkout on a runner you trust. MEASURED: a permissions.deny rule in the
   *    repo's settings.json IS still enforced under this flag — so hard guardrails (never
   *    merge, never publish) belong in `deny`, where they survive this posture.
   *  - "default": no flag; strictest, mostly useful for debugging.
   */
  permissionMode?: "acceptEdits" | "skip" | "default";
  /**
   * How to materialize each repo's working tree. Default { mode: "clone" }.
   * Prefer { mode: "worktree", baseDir } on a machine that already has the repos cloned
   * (e.g. baseDir "/Users/you/Develop/arcblock" → reuse .../arc, .../did via git worktree
   * — shares the object store, no duplicate clone, isolated from your dev checkout).
   */
  checkout?: CheckoutPolicy;
  /** per-slug overrides applied on top of the catalog entry (skills, defaultBranch, …) */
  overrides?: Record<string, Partial<RepoEntry>>;
}

export interface PlannedRun {
  slug: string;
  skill: string; // agentloop:<name>
  skillLocal: string; // <name>
  checkoutPath: string;
  branch: string;
  cloneUrl?: string;
  root: string;
  runner: string;
  promptPath: string;
  policy: CheckoutPolicy;
  permFlags: string[];
  command: string; // readable dry-run representation
}

const NS = "agentloop";

/** CLI flags for a deployment's permission posture (see DeploymentConfig.permissionMode). */
export function permissionFlags(mode: DeploymentConfig["permissionMode"]): string[] {
  if (mode === "skip") return ["--dangerously-skip-permissions"];
  if (mode === "default") return [];
  return ["--permission-mode", "acceptEdits"]; // default
}

/** owner/name → a filesystem-safe checkout dir name. */
export function checkoutDir(base: string, slug: string): string {
  return `${base.replace(/\/+$/, "")}/${slug.replace("/", "__")}`;
}

/** Resolve which catalog repos this deployment covers, applying overrides. */
export function resolveCovered(catalog: RepoEntry[], cfg: DeploymentConfig): RepoEntry[] {
  const wanted = cfg.cover === "all" ? new Set(catalog.map((r) => r.slug)) : new Set(cfg.cover);
  const unknown =
    cfg.cover === "all" ? [] : [...wanted].filter((s) => !catalog.some((r) => r.slug === s));
  if (unknown.length) {
    // Loud, not silent: covering a repo the catalog doesn't know is a config bug.
    throw new Error(`deployment covers repos absent from the catalog: ${unknown.join(", ")}`);
  }
  return catalog
    .filter((r) => wanted.has(r.slug))
    .map((r) => ({ ...r, ...(cfg.overrides?.[r.slug] ?? {}) }));
}

function pluginRoot(cfg: DeploymentConfig): string {
  return (cfg.agentloopRoot ?? new URL("..", import.meta.url).pathname).replace(/\/+$/, "");
}

/** Build the invocation plan: one entry per (repo × skill). */
export function planRuns(catalog: RepoEntry[], cfg: DeploymentConfig, only?: string): PlannedRun[] {
  const root = pluginRoot(cfg);
  const permFlags = permissionFlags(cfg.permissionMode);
  const raw = cfg.checkout ?? { mode: "clone" };
  const policy: CheckoutPolicy =
    raw.mode === "worktree" ? { ...raw, baseDir: expandHome(raw.baseDir) } : raw;
  const promptDir = (
    cfg.promptDir ? expandHome(cfg.promptDir) : new URL("prompts", import.meta.url).pathname
  ).replace(/\/+$/, "");
  const repos = resolveCovered(catalog, cfg).filter((r) => !only || r.slug === only);
  const plan: PlannedRun[] = [];
  for (const r of repos) {
    const checkoutPath = checkoutDir(expandHome(cfg.checkoutBase), r.slug);
    for (const s of r.skills) {
      const promptPath = `${promptDir}/${s}.md`;
      // --add-dir <root> is REQUIRED, not cosmetic: Bash/Read are sandboxed to the
      // worktree, so without it the skills' own runtime scripts (which live at
      // <root>/skills/**/scripts/*.ts, outside the checkout) are unreachable and any
      // step that shells out to them hard-fails. Found by the first live arc smoke.
      const command =
        `cd ${checkoutPath} && ARC_UNATTENDED=1 AGENTLOOP_ROOT=${root} ARC_AGENT_RUNNER=${cfg.runner} ` +
        `claude -p --plugin-dir ${root} --add-dir ${root} ${permFlags.join(" ")} @${s}.md`;
      plan.push({
        permFlags,
        slug: r.slug,
        skill: `${NS}:${s}`,
        skillLocal: s,
        checkoutPath,
        branch: r.defaultBranch,
        cloneUrl: r.cloneUrl,
        root,
        runner: cfg.runner,
        promptPath,
        policy,
        command,
      });
    }
  }
  return plan;
}

/** Load a skill's unattended prompt and substitute {{RUNNER}}. */
export async function renderPrompt(promptPath: string, runner: string): Promise<string> {
  const tpl = await Bun.file(promptPath).text();
  return tpl.replaceAll("{{RUNNER}}", runner);
}

const realSh: Sh = (cmd) => {
  const p = Bun.spawnSync(["bash", "-c", cmd]);
  const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
  return { code: p.exitCode ?? 1, out };
};

/** Live-run one planned invocation: fresh checkout, then the skill headless. */
export async function executeRun(
  run: PlannedRun,
  sh: Sh = realSh,
): Promise<{ ok: boolean; detail: string }> {
  const co = ensureCheckout({
    path: run.checkoutPath,
    slug: run.slug,
    branch: run.branch,
    cloneUrl: run.cloneUrl,
    policy: run.policy,
    exists: existsSync,
    sh,
  });
  if (!co.ok) return { ok: false, detail: `checkout ${co.action}: ${co.detail}` };
  const prompt = await renderPrompt(run.promptPath, run.runner);
  // Flags that are REQUIRED for an unattended run (all three found the hard way):
  //  --add-dir <root>            Bash/Read are sandboxed to the checkout; without it the
  //                              skills' scripts under <root>/skills/**/scripts/ are
  //                              unreachable and any step shelling out to them fails.
  //  run.permFlags               the DEPLOYMENT's permission posture (see
  //                              DeploymentConfig.permissionMode) — headless has no human
  //                              to approve a tool call, so anything missing the repo's
  //                              allowlist is DENIED (that's how the live smoke lost
  //                              Step 0's sync and Step 4's claim check). Which trade-off
  //                              to accept is the deployment's call, not the driver's.
  //  ARC_UNATTENDED=1            arms the repo hook that hard-denies AskUserQuestion /
  //                              Workflow / EnterPlanMode (which would hang the run).
  const proc = Bun.spawnSync(
    ["claude", "-p", prompt, "--plugin-dir", run.root, "--add-dir", run.root, ...run.permFlags],
    {
      cwd: run.checkoutPath,
      env: {
        ...process.env,
        ARC_UNATTENDED: "1",
        AGENTLOOP_ROOT: run.root,
        ARC_AGENT_RUNNER: run.runner,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return { ok: proc.exitCode === 0, detail: `checkout ${co.action}; claude exit ${proc.exitCode}` };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const cfgPath = arg("--config");
  if (!cfgPath) {
    console.error(
      "usage: bun fleet/driver.ts --config <deployment.json> [--catalog <repos.json>] [--only <slug>] [--run]",
    );
    process.exit(2);
  }
  const catalogPath = arg("--catalog") ?? new URL("repos.json", import.meta.url).pathname;
  const only = arg("--only");
  const run = argv.includes("--run");

  const cfg: DeploymentConfig = JSON.parse(await Bun.file(cfgPath).text());
  const catalog: RepoEntry[] = JSON.parse(await Bun.file(catalogPath).text());
  const plan = planRuns(catalog, cfg, only);

  console.log(
    `# agentloop fleet — runner=${cfg.runner}, cover=${cfg.cover === "all" ? "all" : cfg.cover.join(",")}`,
  );
  console.log(
    `# ${plan.length} run(s) across ${new Set(plan.map((p) => p.slug)).size} repo(s). Claiming is per-item via GitHub labels.`,
  );

  if (!run) {
    for (const p of plan) console.log(`\n[${p.slug} · ${p.skill}]\n${p.command}`);
    console.log("\n(dry-run — pass --run to execute serially with a stagger.)");
    process.exit(0);
  }

  const stagger = (cfg.staggerSeconds ?? 30) * 1000;
  let failed = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    console.log(`\n▶ [${p.slug} · ${p.skill}] (${i + 1}/${plan.length})`);
    const res = await executeRun(p);
    console.log(`  ${res.ok ? "✓" : "✗"} ${res.detail}`);
    if (!res.ok) failed++;
    if (i < plan.length - 1 && stagger > 0) await Bun.sleep(stagger);
  }
  console.log(`\nDone: ${plan.length - failed}/${plan.length} ok, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}
