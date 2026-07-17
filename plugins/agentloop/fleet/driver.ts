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
 *   bun fleet/driver.ts --config <deployment.json> [--catalog <repos.json>] [--only <slug>] [--skill <name>] [--run]
 *     (default) dry-run: print the plan (which repos × skills, and the exact command)
 *     --only   : one repo;  --skill : one skill (so cron can give each routine its own cadence)
 *     --run    : ensure a fresh checkout, install deps (setupCommand), then run headless
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  /** Effective sweep frequency for THIS repo. One frequent cron can cover many repos at
   *  different rates: the driver skips a (repo,skill) that ran within cadenceMinutes, tracked
   *  in <checkoutBase>/.fleet-state.json (stamped on success). `--force` ignores it. */
  cadenceMinutes?: number;
  /**
   * Command run inside the checkout after it is materialized, before the skill starts —
   * dependency install, almost always. A fresh checkout has no `node_modules`, and nothing
   * else installs them: the hand-written routines only worked because their clones had been
   * installed once, by hand, long ago. Skip this and the first actionable item dies on a
   * missing dependency instead of a real finding. Cheap on a warm tree (seconds), so it
   * runs every round rather than only on create.
   */
  setupCommand?: string;
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
  /**
   * A shell file sourced before every run — this is where CREDENTIALS live
   * (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, …). NOT optional in practice for a scheduled
   * deployment: cron hands a job a nearly-empty environment, so without this a nightly run
   * has no auth at all and every `gh` call fails. The file is sourced in bash and only the
   * variables it CHANGES are taken, so `PATH=$PATH:…`-style lines work.
   */
  envFile?: string;
  /** Extra env applied to every run of this deployment. */
  env?: Record<string, string>;
  /**
   * Per-skill env, keyed by skill local name (`issue-sweep`). This is how two concurrent
   * routines avoid colliding: give each its own daemon ports and state dir, exactly as the
   * hand-written cron block did (issue-sweep :4910/:8797, pr-sweep :4920/:8807). `{{CHECKOUT}}`
   * expands to that run's checkout path.
   */
  skillEnv?: Record<string, Record<string, string>>;
  /** Model for the headless run, e.g. `claude-opus-4-8`. Omit to use the CLI default. */
  model?: string;
  /**
   * Give each (repo × skill) its own checkout — `<base>/<owner>__<name>__<skill>` — instead
   * of one shared tree per repo. Prefer this whenever a repo runs more than one skill on a
   * schedule: with a shared tree the skills must run serially in one driver invocation, and
   * two 30-minute sweeps chained past an hourly cadence lock out the next round. Separate
   * trees let cron schedule them independently (`--skill`), which is what the hand-written
   * block did with its own per-routine clones. Costs one working tree per skill.
   */
  checkoutPerSkill?: boolean;
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
  modelFlags: string[];
  setupCommand?: string;
  cadenceMinutes?: number;
  command: string; // readable dry-run representation
}

const NS = "agentloop";

/** CLI flags for a deployment's permission posture (see DeploymentConfig.permissionMode). */
export function permissionFlags(mode: DeploymentConfig["permissionMode"]): string[] {
  if (mode === "skip") return ["--dangerously-skip-permissions"];
  if (mode === "default") return [];
  return ["--permission-mode", "acceptEdits"]; // default
}

/** owner/name (× skill, if the deployment wants a tree per routine) → a safe checkout dir. */
export function checkoutDir(base: string, slug: string, skill?: string): string {
  const leaf = slug.replace("/", "__") + (skill ? `__${skill}` : "");
  return `${base.replace(/\/+$/, "")}/${leaf}`;
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
export function planRuns(
  catalog: RepoEntry[],
  cfg: DeploymentConfig,
  only?: string,
  onlySkill?: string,
): PlannedRun[] {
  const root = pluginRoot(cfg);
  const permFlags = permissionFlags(cfg.permissionMode);
  const raw = cfg.checkout ?? { mode: "clone" };
  const policy: CheckoutPolicy =
    raw.mode === "worktree" ? { ...raw, baseDir: expandHome(raw.baseDir) } : raw;
  const promptDir = (
    cfg.promptDir ? expandHome(cfg.promptDir) : new URL("prompts", import.meta.url).pathname
  ).replace(/\/+$/, "");
  const repos = resolveCovered(catalog, cfg)
    .filter((r) => !only || r.slug === only)
    .map((r) => ({ ...r, skills: r.skills.filter((s) => !onlySkill || s === onlySkill) }))
    .filter((r) => r.skills.length);
  const plan: PlannedRun[] = [];
  for (const r of repos) {
    for (const s of r.skills) {
      const checkoutPath = checkoutDir(
        expandHome(cfg.checkoutBase),
        r.slug,
        cfg.checkoutPerSkill ? s : undefined,
      );
      const promptPath = `${promptDir}/${s}.md`;
      const modelFlags = cfg.model ? ["--model", cfg.model] : [];
      // Shown in the dry-run so the plan is auditable, but NEVER the values: envFile is
      // where the tokens are.
      const envNote = [
        cfg.envFile ? `. ${cfg.envFile}` : "",
        ...Object.keys(cfg.env ?? {}).map((k) => `${k}=…`),
        ...Object.keys(cfg.skillEnv?.[s] ?? {}).map((k) => `${k}=…`),
      ]
        .filter(Boolean)
        .join(" ");
      // --add-dir <root> is REQUIRED, not cosmetic: Bash/Read are sandboxed to the
      // worktree, so without it the skills' own runtime scripts (which live at
      // <root>/skills/**/scripts/*.ts, outside the checkout) are unreachable and any
      // step that shells out to them hard-fails. Found by the first live arc smoke.
      const command =
        `cd ${checkoutPath} && ${envNote ? `${envNote} ` : ""}ARC_UNATTENDED=1 AGENTLOOP_ROOT=${root} ARC_AGENT_RUNNER=${cfg.runner} ` +
        `claude -p --plugin-dir ${root} --add-dir ${root} ${[...permFlags, ...modelFlags].join(" ")} @${s}.md`;
      plan.push({
        permFlags,
        modelFlags,
        setupCommand: r.setupCommand,
        cadenceMinutes: r.cadenceMinutes,
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

// ── cadence ─────────────────────────────────────────────────────────────────
// cadenceMinutes lets ONE cron cover many repos at DIFFERENT effective frequencies
// (arc every 60, a quiet repo every 240). The cron fires often; the driver decides per
// (repo,skill) whether enough time has passed. Without this the field was decorative and a
// single hourly cron swept every repo every hour regardless of what the catalog declared.
export type RunState = Record<string, number>; // "<slug>::<skill>" -> last successful run, epoch ms
export const stateKey = (slug: string, skill: string): string => `${slug}::${skill}`;

/** Due now, or how many minutes remain until this (repo,skill) is due again. */
export function cadenceDue(
  run: Pick<PlannedRun, "slug" | "skillLocal" | "cadenceMinutes">,
  state: RunState,
  nowMs: number,
): { due: boolean; remainingMin: number } {
  if (!run.cadenceMinutes || run.cadenceMinutes <= 0) return { due: true, remainingMin: 0 };
  const last = state[stateKey(run.slug, run.skillLocal)];
  if (last === undefined) return { due: true, remainingMin: 0 }; // never run → run now
  const remaining = run.cadenceMinutes - (nowMs - last) / 60_000;
  return remaining <= 0
    ? { due: true, remainingMin: 0 }
    : { due: false, remainingMin: Math.ceil(remaining) };
}

const statePath = (checkoutBase: string): string =>
  `${expandHome(checkoutBase).replace(/\/+$/, "")}/.fleet-state.json`;

function readState(path: string): RunState {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as RunState;
  } catch {
    return {}; // a corrupt state file must not wedge the fleet — treat as "everything due"
  }
}

function recordRun(path: string, slug: string, skill: string, nowMs: number): void {
  const s = readState(path);
  s[stateKey(slug, skill)] = nowMs;
  writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
}

const tailOf = (s: string, n = 400): string => (s.length > n ? `…${s.slice(-n)}` : s).trim();

const parseEnv0 = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const kv of s.split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
};

/**
 * Source a shell env file and return ONLY the variables it changed.
 *
 * Sourced in bash rather than parsed, so `export`, quoting and `PATH=$PATH:…` all behave;
 * diffed against the same shell's baseline so we import the file's intent and not bash's
 * own noise (PWD, SHLVL, _). Throws on a missing/unreadable file: a scheduled deployment
 * that silently ran without its credentials would look like a working sweep that decided
 * there was nothing to do.
 */
export function loadEnvFile(path: string, sh: Sh = realSh): Record<string, string> {
  const p = expandHome(path);
  const q = `'${p.replace(/'/g, `'\\''`)}'`;
  const probe = sh(`[ -r ${q} ] && echo yes || echo no`);
  if (probe.out.trim() !== "yes") throw new Error(`envFile not readable: ${p}`);
  const before = parseEnv0(sh(`env -0`).out);
  const after = sh(`set -a; . ${q} >/dev/null 2>&1 || exit 9; env -0`);
  if (after.code !== 0) throw new Error(`envFile could not be sourced: ${p}`);
  const delta: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseEnv0(after.out))) {
    if (before[k] !== v && k !== "_") delta[k] = v;
  }
  return delta;
}

/** Env for one run: process env < envFile < deployment env < per-skill env. */
export function runEnv(
  run: Pick<PlannedRun, "skillLocal" | "checkoutPath" | "root" | "runner">,
  cfg: DeploymentConfig,
  base: Record<string, string | undefined> = process.env,
  sh: Sh = realSh,
): Record<string, string> {
  const expand = (v: string) => v.replaceAll("{{CHECKOUT}}", run.checkoutPath);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) merged[k] = v;
  if (cfg.envFile) Object.assign(merged, loadEnvFile(cfg.envFile, sh));
  for (const [k, v] of Object.entries(cfg.env ?? {})) merged[k] = expand(v);
  for (const [k, v] of Object.entries(cfg.skillEnv?.[run.skillLocal] ?? {})) merged[k] = expand(v);
  // Driver-owned, last word: identity + the unattended hook arming.
  merged.ARC_UNATTENDED = "1";
  merged.AGENTLOOP_ROOT = run.root;
  merged.ARC_AGENT_RUNNER = run.runner;
  return merged;
}

/** Live-run one planned invocation: fresh checkout, then the skill headless. */
export async function executeRun(
  run: PlannedRun,
  cfg: DeploymentConfig,
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
  // Dependencies BEFORE the skill: a fresh tree has none, and a sweep that dies on a missing
  // module reads as "the gate is broken" rather than "nobody installed anything".
  if (run.setupCommand) {
    const st = sh(`cd ${run.checkoutPath} && ${run.setupCommand}`);
    if (st.code !== 0) {
      return { ok: false, detail: `setup failed (${run.setupCommand}): ${tailOf(st.out)}` };
    }
  }
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
    [
      "claude",
      "-p",
      prompt,
      "--plugin-dir",
      run.root,
      "--add-dir",
      run.root,
      ...run.permFlags,
      ...run.modelFlags,
    ],
    {
      cwd: run.checkoutPath,
      env: runEnv(run, cfg, process.env, sh),
      stdin: "ignore", // cron has no stdin; a read would block the round forever
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
      "usage: bun fleet/driver.ts --config <deployment.json> [--catalog <repos.json>] [--only <slug>] [--skill <name>] [--run]",
    );
    process.exit(2);
  }
  const catalogPath = arg("--catalog") ?? new URL("repos.json", import.meta.url).pathname;
  const only = arg("--only");
  // --skill lets cron schedule each routine on its own cadence (:09 issue-sweep, :39 pr-sweep)
  // instead of chaining every skill of a repo into one invocation.
  const onlySkill = arg("--skill");
  const run = argv.includes("--run");

  const cfg: DeploymentConfig = JSON.parse(await Bun.file(cfgPath).text());
  const catalog: RepoEntry[] = JSON.parse(await Bun.file(catalogPath).text());
  const plan = planRuns(catalog, cfg, only, onlySkill);

  console.log(
    `# agentloop fleet — runner=${cfg.runner}, cover=${cfg.cover === "all" ? "all" : cfg.cover.join(",")}`,
  );
  console.log(
    `# ${plan.length} run(s) across ${new Set(plan.map((p) => p.slug)).size} repo(s). Claiming is per-item via GitHub labels.`,
  );

  // Cadence gate: a repo declaring cadenceMinutes is skipped if it ran too recently, so one
  // frequent cron can cover many repos at their own frequencies. `--force` overrides (manual run).
  const force = argv.includes("--force");
  const now = Number(process.env.FLEET_NOW_MS) || Date.now();
  const sPath = statePath(cfg.checkoutBase);
  const state = readState(sPath);
  const gated = plan.map((p) => ({ p, ...cadenceDue(p, force ? {} : state, now) }));

  if (!run) {
    for (const { p, due, remainingMin } of gated) {
      const tag = due ? "" : `  [cadence: skip, due in ${remainingMin}m]`;
      console.log(`\n[${p.slug} · ${p.skill}]${tag}\n${p.command}`);
    }
    const due = gated.filter((g) => g.due).length;
    console.log(
      `\n(dry-run — ${due}/${plan.length} due now. Pass --run to execute; --force ignores cadence.)`,
    );
    process.exit(0);
  }

  // Fail fast, LOUD, before touching a checkout: a scheduled round that ran without its
  // credentials looks exactly like a healthy sweep that found nothing to do.
  if (cfg.envFile) {
    const loaded = loadEnvFile(cfg.envFile);
    const names = Object.keys(loaded);
    console.log(
      `# envFile ${cfg.envFile} → ${names.length} var(s): ${names.join(", ") || "(none)"}`,
    );
    if (!names.length) throw new Error(`envFile set no variables: ${cfg.envFile}`);
  }

  const dueRuns = gated.filter((g) => g.due).map((g) => g.p);
  const skipped = gated.length - dueRuns.length;
  if (skipped) {
    for (const g of gated.filter((g) => !g.due)) {
      console.log(
        `# skip [${g.p.slug} · ${g.p.skill}] — within cadence, due in ${g.remainingMin}m`,
      );
    }
  }

  const stagger = (cfg.staggerSeconds ?? 30) * 1000;
  let failed = 0;
  for (let i = 0; i < dueRuns.length; i++) {
    const p = dueRuns[i];
    console.log(`\n▶ [${p.slug} · ${p.skill}] (${i + 1}/${dueRuns.length})`);
    const res = await executeRun(p, cfg);
    console.log(`  ${res.ok ? "✓" : "✗"} ${res.detail}`);
    if (res.ok)
      recordRun(sPath, p.slug, p.skillLocal, now); // stamp only on success → a failed round retries next cron
    else failed++;
    if (i < dueRuns.length - 1 && stagger > 0) await Bun.sleep(stagger);
  }
  console.log(
    `\nDone: ${dueRuns.length - failed}/${dueRuns.length} ok, ${failed} failed${skipped ? `, ${skipped} skipped (cadence)` : ""}.`,
  );
  process.exit(failed ? 1 : 0);
}
