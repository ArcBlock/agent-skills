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
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { type CheckoutPolicy, ensureCheckout, type Sh } from "./checkout.ts";
import {
  acquire,
  ensureLockDir,
  realLockIO,
  release,
  runLockPath,
  withFileLock,
} from "./runlock.ts";

/**
 * Expand a leading `~` to the real home dir. Required: the shell expands `~` but
 * node's existsSync does NOT, so a literal `~/...` path would make the checkout probe
 * always report "missing" and re-attempt `worktree add` every round.
 */
export const expandHome = (p: string): string => (p.startsWith("~/") ? homedir() + p.slice(1) : p);

/**
 * Which CLI drives a run. The fleet was born claude-only; codex support was added after a
 * live probe proved a REAL sweep — create files → commit → push → open a draft PR, with the
 * verification gate run and honestly attributed — runs end-to-end on `codex exec` using the
 * SAME shipped prompt, unchanged. The two CLIs differ in only a handful of flags (see
 * buildArgv); everything else in the driver (checkout, reap, TEE, the run-report contract,
 * the per-(repo,skill) lock) is engine-agnostic.
 *
 * The one real asymmetry is plugin loading: claude takes `--plugin-dir <root>` per invocation
 * (zero install), whereas `codex exec` loads only GLOBALLY-installed plugins (`codex plugin
 * add`). A codex deployment must therefore have the plugin installed and `agentloopRoot`
 * pointed at that install — wiring the installer to guarantee that is a later step; this type
 * only picks the CLI and its dialect.
 */
export interface EngineConfig {
  /** "claude" (default) or "codex". */
  kind: "claude" | "codex";
  /** Override the binary name/path. Default = kind ("claude" / "codex"). */
  bin?: string;
  /**
   * Model for this engine's headless run — ENGINE-SPECIFIC (claude: `claude-opus-4-8`;
   * codex: its own ids). This is why model cannot live once at the deployment level: the two
   * id namespaces don't overlap. When omitted for claude, the legacy `DeploymentConfig.model`
   * still applies (back-compat); codex has no legacy fallback.
   */
  model?: string;
}

/** An EngineConfig with every field resolved: kind's default bin, effective model. */
export interface ResolvedEngine {
  kind: EngineConfig["kind"];
  bin: string;
  model?: string;
}

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
   * Maximum active workers per skill for THIS repo. The skill decides what a worker means;
   * issue-sweep uses it as the number of concurrently active issues. Values must be integers
   * in [1,16]. Omit a skill to use that skill's own default.
   */
  skillConcurrency?: Record<string, number>;
  /**
   * Command run inside the checkout after it is materialized, before the skill starts —
   * dependency install, almost always. A fresh checkout has no `node_modules`, and nothing
   * else installs them: the hand-written routines only worked because their clones had been
   * installed once, by hand, long ago. Skip this and the first actionable item dies on a
   * missing dependency instead of a real finding. Cheap on a warm tree (seconds), so it
   * runs every round rather than only on create.
   */
  setupCommand?: string;
  /**
   * Other catalog repos this one must be able to READ while it works — mounted read-only
   * beside the checkouts and passed to the skill as extra `--add-dir` roots.
   *
   * The case that forced it: a content/blocklet repo (arcblock-site) whose "toolchain" is
   * another repo's CLI. Its agent has to follow that repo's conventions and copy its example
   * blocklets, but a fleet checkout is sandboxed to itself — so the agent was guessing at
   * conventions it could not read. Cheap to fix (a shallow clone of arc is ~157 MB) and the
   * quality difference is the whole point of the loop.
   *
   * Each slug MUST exist in the catalog (that is where its cloneUrl/branch come from);
   * an unknown slug throws rather than silently mounting nothing.
   *
   * Materialized at `<checkoutBase>/.reference/<owner>__<name>`, ALWAYS in clone mode even
   * when the deployment's own checkout policy is `worktree`: a worktree would hang the
   * reference off the developer's own clone, and an unattended `--dangerously-skip-permissions`
   * agent must never be handed a writable path into a human's working tree. One copy is
   * shared by every repo that references it; each round resets it, so anything the agent
   * scribbles there is discarded rather than accumulated.
   */
  referenceRepos?: string[];
  /**
   * Override the deployment's engine for THIS repo — e.g. run one repo on codex while the
   * rest stay on claude, to compare them under a live schedule. Falls back to
   * `DeploymentConfig.engine`, then claude. See EngineConfig.
   */
  engine?: EngineConfig;
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
  /**
   * Seconds to space apart each repo's START in --run mode (default 30) — API-burst courtesy so
   * N repos don't hit GitHub at the same instant (exhausting the shared primary quota / tripping
   * the secondary concurrency limit). Applies in BOTH modes: serial waits this long BETWEEN runs;
   * parallel launches repo i at i*stagger while every round still runs concurrently. `0` = launch
   * all at once (the old no-spacing behavior).
   */
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
  /**
   * Default CLI engine for every run of this deployment. Omit for claude — the original,
   * unchanged behaviour. A repo can override via `RepoEntry.engine`. See EngineConfig for the
   * claude/codex asymmetry (notably: a codex deployment needs the plugin globally installed).
   */
  engine?: EngineConfig;
  /**
   * Model for the headless run, e.g. `claude-opus-4-8`. Omit to use the CLI default.
   * LEGACY / claude-only: with no `engine`, or `engine.kind === "claude"` and no
   * `engine.model`, this is the claude model. For codex, set `engine.model` instead — the id
   * namespaces don't overlap, so a single shared field can't serve both.
   */
  model?: string;
  /** Where run logs go (per-(repo,skill) .log + fleet.jsonl). Default <checkoutBase>/logs. */
  logDir?: string;
  /**
   * Run the covered repos of ONE skill concurrently instead of serially. The repos of a
   * skill are independent (each sweeps its own repo's issues/PRs), so a slow arc must not
   * block did/site. Each run still writes to its own per-(repo,skill) log; state + summary
   * are written after the barrier so the reads/writes never race. Costs: N concurrent
   * headless sessions + N times the API burst against a shared token (a GitHub App token
   * with per-installation limits is the real headroom fix — see fleet README P5).
   */
  parallel?: boolean;
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
  /** The resolved engine driving this run (repo override → deployment default → claude). */
  engine: ResolvedEngine;
  permFlags: string[];
  modelFlags: string[];
  setupCommand?: string;
  cadenceMinutes?: number;
  concurrency?: number;
  /** Read-only repos mounted beside the checkouts and handed to the skill as extra roots. */
  referenceRepos: { slug: string; branch: string; cloneUrl?: string; path: string }[];
  command: string; // readable dry-run representation
}

const NS = "agentloop";

/** Validate and return one repo×skill worker limit. Undefined means the skill's own default. */
export function resolveSkillConcurrency(entry: RepoEntry, skill: string): number | undefined {
  const value = entry.skillConcurrency?.[skill];
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 16)) {
    throw new Error(
      `${entry.slug}.skillConcurrency["${skill}"] must be an integer between 1 and 16`,
    );
  }
  return value;
}

/** CLI flags for a deployment's permission posture (see DeploymentConfig.permissionMode). */
export function permissionFlags(mode: DeploymentConfig["permissionMode"]): string[] {
  if (mode === "skip") return ["--dangerously-skip-permissions"];
  if (mode === "default") return [];
  return ["--permission-mode", "acceptEdits"]; // default
}

/** codex's dialect of the same postures. "skip" == claude's --dangerously-skip-permissions:
 *  unrestricted, no approval prompts — the posture the proven routines use and the only one a
 *  fresh checkout can actually work under (VERIFIED by the write-back probe). The others map
 *  to codex's sandbox policy; `codex exec` is non-interactive, so approvals never block. */
export function codexPermissionFlags(mode: DeploymentConfig["permissionMode"]): string[] {
  if (mode === "skip") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (mode === "default") return ["-s", "read-only"];
  return ["-s", "workspace-write"]; // acceptEdits (default)
}

/** Permission flags for a resolved engine + posture. */
export function enginePermissionFlags(
  kind: ResolvedEngine["kind"],
  mode: DeploymentConfig["permissionMode"],
): string[] {
  return kind === "codex" ? codexPermissionFlags(mode) : permissionFlags(mode);
}

/** Model flags for a resolved engine (claude: `--model`, codex: `-m`). */
export function engineModelFlags(engine: ResolvedEngine): string[] {
  if (!engine.model) return [];
  return engine.kind === "codex" ? ["-m", engine.model] : ["--model", engine.model];
}

/** Resolve the effective engine for a repo: repo override → deployment default → claude.
 *  The legacy top-level `cfg.model` is honoured ONLY for claude with no explicit
 *  `engine.model` — that is the one place it ever meant "the claude model"; codex has no
 *  such legacy fallback. */
export function resolveEngine(
  cfg: DeploymentConfig,
  repo?: Pick<RepoEntry, "engine">,
): ResolvedEngine {
  const e = repo?.engine ?? cfg.engine ?? { kind: "claude" as const };
  const model = e.model ?? (e.kind === "claude" ? cfg.model : undefined);
  return { kind: e.kind, bin: e.bin ?? e.kind, model };
}

/** The real spawn argv for one run — SINGLE SOURCE OF TRUTH for both executeRun's spawn and
 *  the dry-run command string. claude and codex differ in only these flags:
 *   - claude loads the plugin per-invocation with `--plugin-dir <root>` and passes the prompt
 *     via `-p`; codex has no plugin-dir flag (its plugin is installed globally) and takes the
 *     prompt as `exec`'s positional argument.
 *   - `--add-dir` is IDENTICAL on both — it grants the skill's own scripts under <root> plus
 *     each read-only reference repo.
 *   - permission/model flags are each engine's dialect (permFlags/modelFlags, precomputed). */
export function buildArgv(
  engine: ResolvedEngine,
  o: {
    prompt: string;
    root: string;
    refPaths: string[];
    permFlags: string[];
    modelFlags: string[];
  },
): string[] {
  const refAddDirs = o.refPaths.flatMap((p) => ["--add-dir", p]);
  if (engine.kind === "codex") {
    return [
      engine.bin,
      "exec",
      o.prompt,
      "--add-dir",
      o.root,
      ...refAddDirs,
      ...o.permFlags,
      ...o.modelFlags,
    ];
  }
  return [
    engine.bin,
    "-p",
    o.prompt,
    "--plugin-dir",
    o.root,
    "--add-dir",
    o.root,
    ...refAddDirs,
    ...o.permFlags,
    ...o.modelFlags,
  ];
}

/** owner/name (× skill, if the deployment wants a tree per routine) → a safe checkout dir. */
export function checkoutDir(base: string, slug: string, skill?: string): string {
  const leaf = slug.replace("/", "__") + (skill ? `__${skill}` : "");
  return `${base.replace(/\/+$/, "")}/${leaf}`;
}

/** Where a read-only reference repo is mounted. Under a dot-dir so it can never collide
 *  with a real checkout leaf (`<owner>__<name>[__<skill>]`), and one copy is shared by
 *  every repo that references it. */
export function referenceDir(base: string, slug: string): string {
  return `${base.replace(/\/+$/, "")}/.reference/${slug.replace("/", "__")}`;
}

/** Resolve a repo's `referenceRepos` slugs against the FULL catalog (not the covered set —
 *  a reference need not itself be swept). Unknown slug throws: a silently-unmounted
 *  reference would degrade the run's quality with no signal, which is the failure mode
 *  this whole field exists to remove. */
export function resolveReferences(
  entry: RepoEntry,
  catalog: RepoEntry[],
  base: string,
): { slug: string; branch: string; cloneUrl?: string; path: string }[] {
  return (entry.referenceRepos ?? []).map((slug) => {
    const ref = catalog.find((c) => c.slug === slug);
    if (!ref)
      throw new Error(
        `${entry.slug} declares referenceRepos "${slug}", which is not in the catalog — ` +
          `add it (cloneUrl + defaultBranch) or drop the reference`,
      );
    return {
      slug,
      branch: ref.defaultBranch,
      cloneUrl: ref.cloneUrl,
      path: referenceDir(base, slug),
    };
  });
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
    // Engine is a per-repo axis (RepoEntry.engine overrides the deployment default), so its
    // permission/model dialect is resolved here, once per repo, not once for the whole plan.
    const engine = resolveEngine(cfg, r);
    const permFlags = enginePermissionFlags(engine.kind, cfg.permissionMode);
    const modelFlags = engineModelFlags(engine);
    // The CLI-specific head of the readable dry-run command (the argv itself is built by
    // buildArgv in executeRun — this string just has to match its shape for auditing).
    const cliHead =
      engine.kind === "codex"
        ? `${engine.bin} exec --add-dir ${root}`
        : `${engine.bin} -p --plugin-dir ${root} --add-dir ${root}`;
    for (const s of r.skills) {
      const concurrency = resolveSkillConcurrency(r, s);
      const checkoutPath = checkoutDir(
        expandHome(cfg.checkoutBase),
        r.slug,
        cfg.checkoutPerSkill ? s : undefined,
      );
      const promptPath = `${promptDir}/${s}.md`;
      // Shown in the dry-run so the plan is auditable, but NEVER the values: envFile is
      // where the tokens are.
      const envNote = [
        cfg.envFile ? `. ${cfg.envFile}` : "",
        ...Object.keys(cfg.env ?? {}).map((k) => `${k}=…`),
        ...Object.keys(cfg.skillEnv?.[s] ?? {}).map((k) => `${k}=…`),
	...(concurrency === undefined ? [] : [`AGENTLOOP_SKILL_CONCURRENCY=${concurrency}`]),
      ]
        .filter(Boolean)
        .join(" ");
      // --add-dir <root> is REQUIRED, not cosmetic: Bash/Read are sandboxed to the
      // worktree, so without it the skills' own runtime scripts (which live at
      // <root>/skills/**/scripts/*.ts, outside the checkout) are unreachable and any
      // step that shells out to them hard-fails. Found by the first live arc smoke.
      const referenceRepos = resolveReferences(r, catalog, expandHome(cfg.checkoutBase));
      const refFlags = referenceRepos.flatMap((ref) => ["--add-dir", ref.path]);
      const command =
        `cd ${checkoutPath} && ${envNote ? `${envNote} ` : ""}ARC_UNATTENDED=1 AGENTLOOP_ROOT=${root} ARC_AGENT_RUNNER=${cfg.runner} ` +
        `${cliHead} ${refFlags.join(" ")}${refFlags.length ? " " : ""}${[...permFlags, ...modelFlags].join(" ")} @${s}.md`;
      plan.push({
        referenceRepos,
        engine,
        permFlags,
        modelFlags,
        setupCommand: r.setupCommand,
        cadenceMinutes: r.cadenceMinutes,
	concurrency,
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

/** Load a skill's unattended prompt and substitute repo×run values. */
export async function renderPrompt(
  promptPath: string,
  runner: string,
  concurrency = 3,
): Promise<string> {
  const tpl = await Bun.file(promptPath).text();
  return tpl.replaceAll("{{RUNNER}}", runner).replaceAll("{{CONCURRENCY}}", String(concurrency));
}

// ── process hygiene ─────────────────────────────────────────────────────────
// A round's job ends when the round ends. Nothing it started may outlive it.
//
// It did, for a long time. `await proc.exited` waits for `claude` and nothing else, so
// anything claude's Bash tool started — a `bun test` that blew past its own 2-minute
// timeout, a `pnpm dev` server — was re-parented to init and ran forever. Measured on a
// live fleet: 18h and 29h, ~1.5 cores burned, while the rounds that spawned them recorded
// `outcome=ok, exitCode=0`. No crash, no signal, nothing to notice.

/** PIDs whose cwd is inside `path`. One `lsof` over the process table — NOT `lsof +D`,
 *  which walks the directory tree and is unusable on a multi-GB checkout. */
export function pidsWithCwdUnder(path: string, sh: Sh = realSh): number[] {
  const prefix = path.replace(/\/+$/, "");
  const r = sh(`lsof -d cwd -Fpn 2>/dev/null || true`);
  const out: number[] = [];
  let pid = 0;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith("n") && pid) {
      const cwd = line.slice(1);
      if (cwd === prefix || cwd.startsWith(`${prefix}/`)) out.push(pid);
    }
  }
  return [...new Set(out)];
}

/** PPID of `pid`, or 0 if it is gone. */
export const ppidOf = (pid: number, sh: Sh = realSh): number =>
  Number(sh(`ps -o ppid= -p ${pid} 2>/dev/null | tr -d ' '`).out.trim()) || 0;

/**
 * What is STILL in the checkout once the round's own tree has finished dying.
 *
 * A single post-reap sample overcounts. Measured on a live fleet: rounds reported 1–2
 * "survivors" that were an MCP server and a `bash …/triage.sh` shutting down normally — gone
 * seconds later, nothing leaked. That is worse than not measuring: a residue signal that
 * cries wolf gets ignored, and the 15-process leak it exists to catch gets ignored with it.
 *
 * So: poll until the set stops shrinking, or until `maxWaitMs`. A process that is exiting
 * disappears within a poll or two; one that is genuinely stuck is still there at the end, and
 * only that is reported.
 */
export async function settleResidual(
  checkoutPath: string,
  sh: Sh = realSh,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  maxWaitMs = 8000,
  stepMs = 700,
  stableSteps = 3,
): Promise<number[]> {
  let prev = pidsWithCwdUnder(checkoutPath, sh);
  if (!prev.length) return prev;
  // "Unchanged for one step" is NOT enough, and assuming it was cost a false positive against
  // real processes: a `sleep 2` still counting down looks identical to something wedged — the
  // set is stable the whole time it is alive. Only sustained stability distinguishes them, so
  // require several consecutive quiet steps before calling anything a leak.
  let quiet = 0;
  for (let waited = 0; waited < maxWaitMs; waited += stepMs) {
    await sleep(stepMs);
    const now = pidsWithCwdUnder(checkoutPath, sh);
    if (!now.length) return now;
    const same = now.length === prev.length && now.every((p, i) => p === prev[i]);
    quiet = same ? quiet + 1 : 0;
    prev = now;
    if (quiet >= stableSteps) return now;
  }
  return prev;
}

/**
 * Kill leftovers from EARLIER rounds in this checkout — the safety net under the group reap.
 *
 * The group reap only covers processes this driver started. It cannot cover a round whose
 * driver was `kill -9`'d (no `finally` runs), nor anything left by a driver older than the
 * reap itself. Those survive as re-parented orphans and are what actually accumulated here.
 *
 * This one kills processes it did not start, so every guard below is load-bearing:
 *
 *  1. CALL ONLY WHILE HOLDING THE (repo,skill) LOCK. That is what makes "anything alive in
 *     this checkout is dead weight" true — the lock is what guarantees no *live* round of
 *     this same checkout exists. Called without it, this would kill a working sweep.
 *  2. Scope by CHECKOUT PATH, never by process name. `pkill -f "bun test"` would reach
 *     another repo's healthy round, and has form: it once killed a long-running daemon.
 *  3. Only `PPID == 1`. A live round's processes have a live driver as parent (verified on
 *     the running fleet); orphans are exactly the re-parented ones.
 *  4. Never this process. The driver's own cwd is never inside a checkout (cron starts it
 *     in $HOME — verified), but a cheap identity check beats relying on that.
 *
 * Returns what it killed and what it deliberately spared, so a round can report both.
 */
export function reapOrphans(
  checkoutPath: string,
  sh: Sh = realSh,
  kill: (pid: number, sig: NodeJS.Signals) => void = (p, s) => process.kill(p, s),
  selfPid: number = process.pid,
): { killed: number[]; spared: { pid: number; why: string }[] } {
  const killed: number[] = [];
  const spared: { pid: number; why: string }[] = [];
  for (const pid of pidsWithCwdUnder(checkoutPath, sh)) {
    if (pid === selfPid) {
      spared.push({ pid, why: "self" });
      continue;
    }
    const parent = ppidOf(pid, sh);
    if (parent !== 1) {
      spared.push({ pid, why: `live parent ${parent}` });
      continue;
    }
    try {
      kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      spared.push({ pid, why: "vanished" });
    }
  }
  return { killed, spared };
}

/**
 * Kill the round's process group — every descendant, at any depth, in one signal.
 *
 * Requires the child to have been spawned `detached` (its own group). Measured: without it
 * the grandchildren share the DRIVER's group, so `kill(-pgid)` would kill the driver too —
 * group-reaping is not merely ineffective there, it is unsafe. The guard below refuses that
 * case rather than trusting the caller.
 */
export async function reapGroup(
  pid: number,
  log: (s: string) => void,
  kill: (target: number, sig: NodeJS.Signals) => void = (t, s) => process.kill(t, s),
  ownPgid: number = process.pid,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  graceMs = 2000,
): Promise<void> {
  if (pid === ownPgid) {
    log(`# reap SKIPPED — child shares the driver's process group (pid ${pid})\n`);
    return;
  }
  try {
    kill(-pid, "SIGTERM"); // negative pid = the whole group
  } catch {
    return; // ESRCH: group already empty — the normal, healthy path
  }
  // The waits are not politeness, they are correctness for the residue count that follows.
  // Signalling then counting immediately reports processes that ARE dying as survivors:
  // a live round did exactly that on the first day, flagged one, and the pid was gone by the
  // time anyone looked. A residue signal that cries wolf gets ignored, which costs more than
  // the leak it was built to expose.
  await sleep(graceMs); // let SIGTERM be handled — a clean exit beats a killed one
  try {
    kill(-pid, "SIGKILL"); // whatever ignored SIGTERM
  } catch {
    return; // everything went down on TERM
  }
  await sleep(250); // SIGKILL is immediate, but the table needs a moment to reflect it
}

const realSh: Sh = (cmd, env) => {
  const p = Bun.spawnSync(["bash", "-c", cmd], env ? { env } : undefined);
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

// A run is stamped at its START (the cron-fire time), and consecutive hourly fires are ~60min
// apart — but cron scheduling, load, and bun startup add seconds of jitter, so elapsed can be
// 59:58 at the next fire. Without slack, `cadence 60` + an hourly cron would read 59.97 < 60 →
// "not due" → skip to every OTHER hour (arc 60 silently becomes 120). A few minutes of slack
// absorbs the jitter without meaningfully shifting the cadence (arc runs at ~58min, still hourly).
export const CADENCE_SLACK_MIN = 3;

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
  return remaining <= CADENCE_SLACK_MIN
    ? { due: true, remainingMin: 0 }
    : { due: false, remainingMin: Math.ceil(remaining) };
}

const statePath = (checkoutBase: string): string =>
  `${expandHome(checkoutBase).replace(/\/+$/, "")}/.fleet-state.json`;

// ── observability ─────────────────────────────────────────────────────────────
// Two layers, because a single `--skill issue-sweep` covers many repos and the old
// "one redirect per cron line" mixes them into one undifferentiated file:
//   - a per-(repo,skill) .log  → the full run output, isolated, greppable, appended;
//   - fleet.jsonl              → one structured line per run, so `tail`/`jq` gives
//                                health across every repo and round at a glance.
export interface LogPaths {
  runLog: string;
  summary: string;
}
export function logPaths(logDir: string, slug: string, skill: string): LogPaths {
  const base = expandHome(logDir).replace(/\/+$/, "");
  return {
    runLog: `${base}/${slug.replace("/", "__")}__${skill}.log`,
    summary: `${base}/fleet.jsonl`,
  };
}

/** Default log dir sits beside the checkouts, mirroring ~/.arc-routines/logs. */
export const defaultLogDir = (checkoutBase: string): string =>
  `${expandHome(checkoutBase).replace(/\/+$/, "")}/logs`;

/**
 * Mount guard (pure part): is checkoutBase reachable at all?
 *
 * When checkoutBase lives on an external disk (`/Volumes/<name>/…`) and that disk is not
 * mounted (unplugged / asleep), a scheduled round otherwise dies deep inside with a cryptic
 * `Permission denied` from `mkdir` under root-owned /Volumes — looking like a permissions
 * bug, not "your disk isn't here", and repeating cryptically every hour. This turns that
 * into one plain-English reason. It is a NO-OP for an internal path (always reachable), so
 * it costs nothing until you actually move the fleet to an external volume.
 */
export function checkoutBaseStatus(
  checkoutBase: string,
  exists: (p: string) => boolean,
): { ok: boolean; reason?: string } {
  const base = expandHome(checkoutBase).replace(/\/+$/, "");
  const vol = base.match(/^(\/Volumes\/[^/]+)/);
  if (vol && !exists(vol[1])) {
    return {
      ok: false,
      reason: `external volume ${vol[1]} is not mounted (disk unplugged or asleep?)`,
    };
  }
  // General: some existing ancestor must exist for `mkdir -p` to have somewhere to attach.
  let p = base;
  while (p && p !== "/" && !exists(p)) p = p.slice(0, p.lastIndexOf("/")) || "/";
  if (!exists(p)) return { ok: false, reason: `no existing parent directory for ${base}` };
  return { ok: true };
}

export interface RunRecord {
  ts: string; // ISO
  runner: string;
  slug: string;
  skill: string;
  /**
   * `skipped-cadence` / `skipped-locked` are recorded, not just printed. A round that did
   * not happen is a fact about the fleet: without it "why has blockchain not moved all day"
   * and "how often does a 60-minute cadence actually collide with a 114-minute round" are
   * both unanswerable, and the second is exactly the question raising a cadence creates.
   */
  outcome:
    | "ok"
    | "failed"
    | "checkout-failed"
    | "setup-failed"
    | "skipped-cadence"
    | "skipped-locked";
  exitCode: number | null;
  ms: number;
  detail: string;
  /** Correlates this row with its `==== <runId> ====` segment in the per-(repo,skill) log.
   *  Timestamps alone stop being a reliable join the moment rounds run concurrently. */
  runId?: string;
  /**
   * Processes still living in the checkout AFTER the round reaped its own process group.
   * Non-zero means something escaped the reap (re-parented itself, or predates this driver
   * version) and is now burning the machine unattended.
   *
   * This field exists because the leak that motivated it was INVISIBLE: rounds reported
   * `outcome=ok, exitCode=0` while leaving a `bun test` at 98% CPU for 18h and a `pnpm dev`
   * tree for 29h. Every signal said healthy. Reaping fixes the leaks we know about; counting
   * is what makes the next unknown one show up on its own.
   *
   * ALWAYS written for an executed round, including `0`. Omitting the healthy value would
   * make "measured, clean" and "old driver that never measured" the same observation — the
   * same silence this field was added to break.
   */
  residualProcs?: number;
  /**
   * What the round actually DID, self-reported by the skill (see RUN_REPORT_ENV).
   *
   * The mechanical fields above answer "did the plumbing work" — and answered it 182 times
   * with the identical string `checkout reset; claude exit 0`. They cannot distinguish a
   * round that opened three PRs from one that ran 114 minutes and produced nothing; both
   * are `outcome: ok`. That distinction lived only in free prose at the tail of a 228 KB
   * append-only log.
   *
   * Reported through a file rather than parsed back out of that prose on purpose: the
   * wording differs every round, so a parser would be fragile in the silent way — it would
   * return nothing and look like a quiet day.
   */
  produced?: RunProduct;
}

/** Structured, machine-readable "what happened" written by the skill at end of run. */
export interface RunProduct {
  prsOpened?: number[];
  prsMerged?: number[];
  issuesClosed?: number[];
  issuesOpened?: number[];
  commentsPosted?: number;
  /** True when the round deliberately did nothing — a healthy quiet round, not a failure. */
  noop?: boolean;
  /** One line, for humans skimming a report. */
  summary?: string;
}

/** Env var naming the file a skill writes its RunProduct to. */
export const RUN_REPORT_ENV = "AGENTLOOP_RUN_REPORT";
export const summaryLine = (r: RunRecord): string => JSON.stringify(r);

/**
 * Roll a log once it passes `maxBytes`, keeping ONE previous generation as `<name>.1`.
 *
 * Append-only per-(repo,skill) logs are where a round's real narrative lives, so they are
 * worth keeping — but at 24 rounds/day they only grow. One generation is the deliberate
 * trade: enough to still hold the previous round when something breaks mid-round, bounded
 * enough that the fleet cannot fill a disk it does not own.
 */
export function rotateIfLarge(
  path: string,
  maxBytes = 5_000_000,
  stat: (p: string) => number | undefined = (p) => (existsSync(p) ? statSync(p).size : undefined),
  move: (from: string, to: string) => void = (f, t) => renameSync(f, t),
): boolean {
  const size = stat(path);
  if (size === undefined || size < maxBytes) return false;
  try {
    move(path, `${path}.1`); // rename over any older generation
    return true;
  } catch {
    return false; // rotation is hygiene, never a reason to fail a round
  }
}

/** Short, sortable, collision-free enough for one host: `<base36 ms>-<4 hex>`. */
export const newRunId = (now: number, rand = Math.random): string =>
  `${now.toString(36)}-${Math.floor(rand() * 0x10000)
    .toString(16)
    .padStart(4, "0")}`;

/**
 * Read (and consume) the structured report a skill left behind.
 *
 * Consumed — deleted after reading — so a round that writes nothing cannot inherit the
 * previous round's report and silently look productive. Absent or malformed yields
 * undefined rather than throwing: a skill that never learned this contract must still be
 * able to complete a round, it just reports no product.
 */
export function readRunProduct(
  path: string,
  exists: (p: string) => boolean = existsSync,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
  remove: (p: string) => void = (p) => unlinkSync(p),
): RunProduct | undefined {
  if (!exists(path)) return undefined;
  let raw: string;
  try {
    raw = read(path);
  } finally {
    try {
      remove(path);
    } catch {
      /* best effort — a stale file is caught by the next round's delete */
    }
  }
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as RunProduct) : undefined;
  } catch {
    return undefined;
  }
}

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
 * Source a shell env file and return the variables the file ASSIGNS, with their post-source
 * values.
 *
 * NOT a diff against the current environment. A diff breaks when the file was already sourced
 * upstream — e.g. a cron line that does `. env` before invoking the driver: the vars are then
 * already present, the before/after diff is empty, and the "0 vars" guard wrongly aborts a
 * round that actually HAS credentials (observed live: the first fleet cron fire). We instead
 * read the names the file assigns (parsed from its `export FOO=` / `FOO=` lines) and report
 * each name's value after sourcing — idempotent regardless of the parent env. Sourcing happens
 * in the CURRENT env, so `PATH=$PATH:…`-style appends still resolve correctly.
 */
export function loadEnvFile(path: string, sh: Sh = realSh): Record<string, string> {
  const p = expandHome(path);
  const q = `'${p.replace(/'/g, `'\\''`)}'`;
  const probe = sh(`[ -r ${q} ] && echo yes || echo no`);
  if (probe.out.trim() !== "yes") throw new Error(`envFile not readable: ${p}`);
  // names the file assigns → NUL-delimited `name=value` after sourcing (bash indirect ${!n})
  const r = sh(
    `set -a; . ${q} >/dev/null 2>&1 || exit 9; ` +
      `for n in $(grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' ${q} | ` +
      `sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=.*//' | sort -u); do ` +
      `printf '%s=%s\\0' "$n" "\${!n}"; done`,
  );
  if (r.code !== 0) throw new Error(`envFile could not be sourced: ${p}`);
  return parseEnv0(r.out);
}

/** `ArcBlock/arc` → `AGENTLOOP_REF_ARCBLOCK_ARC`. A repo-profile is committed and read on
 *  every machine, so it can never name the mount path (it differs per deployment — an
 *  external disk here, a home dir there). It names this variable instead. */
export const referenceEnvKey = (slug: string): string =>
  `AGENTLOOP_REF_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/** Env for one run: process env < envFile < deployment env < per-skill env. */
export function runEnv(
  run: Pick<
    PlannedRun,
    "skillLocal" | "checkoutPath" | "root" | "runner" | "concurrency" | "setupCommand"
  > & {
    referenceRepos?: PlannedRun["referenceRepos"];
  },
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
  if (run.concurrency !== undefined) merged.AGENTLOOP_SKILL_CONCURRENCY = String(run.concurrency);
  if (run.setupCommand) merged.AGENTLOOP_SETUP_COMMAND = run.setupCommand;
  for (const ref of run.referenceRepos ?? []) merged[referenceEnvKey(ref.slug)] = ref.path;
  // Beside the checkout, never inside it: an in-tree file would dirty `git status` and
  // disarm the repo's own push/verify gates — the same reason the fleet marker lives out.
  merged[RUN_REPORT_ENV] = `${run.checkoutPath.replace(/\/+$/, "")}.run-report.json`;
  return merged;
}

/** Live-run one planned invocation: fresh checkout, then the skill headless.
 *  `mirror` tees the skill's output to stdout too (serial mode); parallel mode passes false
 *  so N repos' outputs don't interleave into unreadable garbage — each still gets its own
 *  per-(repo,skill) log, which is the clean source. */
export async function executeRun(
  run: PlannedRun,
  cfg: DeploymentConfig,
  sh: Sh = realSh,
  mirror = true,
): Promise<{
  ok: boolean;
  detail: string;
  logPath: string;
  exitCode: number | null;
  ms: number;
  residualProcs?: number;
}> {
  const started = Date.now();
  const { runLog } = logPaths(
    cfg.logDir ?? defaultLogDir(cfg.checkoutBase),
    run.slug,
    run.skillLocal,
  );
  mkdirSync(runLog.slice(0, runLog.lastIndexOf("/")), { recursive: true });
  rotateIfLarge(runLog); // before opening: 24 rounds/day only ever grows this file
  const fd = openSync(runLog, "a");
  const write = (s: string) => writeSync(fd, s);
  const runId = newRunId(started);
  write(
    `\n==== ${new Date(started).toISOString()} · run=${runId} · ${run.slug} · ${run.skill} · runner=${run.runner} ====\n`,
  );
  const finish = (r: {
    ok: boolean;
    detail: string;
    exitCode: number | null;
    residualProcs?: number;
    produced?: RunProduct;
  }) => {
    const ms = Date.now() - started;
    const res = r.residualProcs ? ` · ⚠ ${r.residualProcs} residual proc(s)` : "";
    const prod = r.produced?.summary ? ` · ${r.produced.summary}` : "";
    write(`---- ${r.ok ? "OK" : "FAIL"} · ${r.detail}${res}${prod} · ${ms}ms ----\n`);
    closeSync(fd);
    return { ...r, logPath: runLog, ms, runId };
  };

  // ONE env for the WHOLE run — checkout, setupCommand and the skill must all see the same
  // thing. Computed first because the checkout runs first: every step left to inherit the
  // driver's own environment is a step a deployment's `env` silently does not reach, and that
  // failure is invisible (the step "succeeds", just against the wrong config — a store-dir on
  // another disk, a registry, a proxy — so nothing errors and you find out much later).
  // runEnv starts FROM process.env, so this is a superset: nothing the git/install commands
  // inherit today (PATH, HOME, SSH_AUTH_SOCK) is lost. `sh` here (not shEnv) is deliberate —
  // loadEnvFile bootstraps the very env we are building.
  const env = runEnv(run, cfg, process.env, sh);
  const shEnv: Sh = (cmd) => sh(cmd, env);
  const reportPath = env[RUN_REPORT_ENV];
  // Clear any leftover before the round: a stale report would be read as THIS round's work.
  if (existsSync(reportPath)) unlinkSync(reportPath);

  const co = ensureCheckout({
    path: run.checkoutPath,
    slug: run.slug,
    branch: run.branch,
    cloneUrl: run.cloneUrl,
    policy: run.policy,
    exists: existsSync,
    sh: shEnv,
  });
  if (!co.ok)
    return finish({ ok: false, detail: `checkout ${co.action}: ${co.detail}`, exitCode: null });
  write(`# checkout ${co.action}\n`);

  // Read-only references, materialized BEFORE the skill so `--add-dir` points at a real tree.
  // A failure here is FATAL, deliberately: the repo declared it needs this to work, and a
  // round that quietly proceeds without it produces plausible-looking output written blind —
  // exactly the silent degradation the strict "declare ⇒ execute" rule exists to prevent.
  for (const ref of run.referenceRepos) {
    const rc = ensureCheckout({
      path: ref.path,
      slug: ref.slug,
      branch: ref.branch,
      cloneUrl: ref.cloneUrl,
      policy: { mode: "clone" }, // never worktree — see RepoEntry.referenceRepos
      exists: existsSync,
      sh: shEnv,
    });
    if (!rc.ok)
      return finish({
        ok: false,
        detail: `reference ${ref.slug} ${rc.action}: ${rc.detail}`,
        exitCode: null,
      });
    write(`# reference ${ref.slug} ${rc.action} → ${ref.path}\n`);
  }
  // Dependencies BEFORE the skill: a fresh tree has none, and a sweep that dies on a missing
  // module reads as "the gate is broken" rather than "nobody installed anything".
  if (run.setupCommand) {
    const st = sh(`cd ${run.checkoutPath} && ${run.setupCommand}`, env);
    write(`# setup: ${run.setupCommand}\n${st.out}`);
    if (st.code !== 0) {
      return finish({ ok: false, detail: `setup failed: ${tailOf(st.out)}`, exitCode: st.code });
    }
  }
  const prompt = await renderPrompt(run.promptPath, run.runner, run.concurrency ?? 3);
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
  // Bun.spawn (streaming), not spawnSync, so output is TEE'd live to stdout AND captured to
  // the per-run log. A single --skill invocation covers many repos; without a per-(repo,skill)
  // file their output is one undifferentiated blob and you cannot tell which repo did what.
  const proc = Bun.spawn(
    buildArgv(run.engine, {
      prompt,
      root: run.root,
      refPaths: run.referenceRepos.map((ref) => ref.path),
      permFlags: run.permFlags,
      modelFlags: run.modelFlags,
    }),
    {
      cwd: run.checkoutPath,
      env,
      stdin: "ignore", // cron has no stdin; a read would block the round forever
      stdout: "pipe",
      stderr: "pipe",
      // Own process group, so the round's whole descendant tree can be reaped with one
      // signal below. Without it those descendants sit in the DRIVER's group and killing
      // the group would kill the driver — see reapGroup.
      detached: true,
    },
  );
  const tee = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    for await (const chunk of stream) {
      if (mirror) process.stdout.write(chunk); // live (serial mode); off in parallel to avoid interleave
      writeSync(fd, chunk); // the isolated per-run log — always the clean source
    }
  };
  let exitCode: number | null = null;
  try {
    await Promise.all([tee(proc.stdout), tee(proc.stderr)]);
    exitCode = await proc.exited;
  } finally {
    // `finally`, not the happy path: a round that throws leaks exactly like one that
    // succeeds, and the leak we found came from rounds that SUCCEEDED.
    await reapGroup(proc.pid, write);
  }
  // Counted after the reap AND after the tree has stopped shedding — a process mid-exit is
  // not a leak, and reporting it as one is how this signal would lose its credibility.
  const residual = await settleResidual(run.checkoutPath, sh);
  if (residual.length)
    write(`# ⚠ ${residual.length} process(es) survived the reap: ${residual.join(", ")}\n`);
  const produced = readRunProduct(reportPath);
  write(
    produced
      ? `# produced ${JSON.stringify(produced)}\n`
      : `# produced (none reported — skill wrote no ${RUN_REPORT_ENV})\n`,
  );
  return finish({
    ok: exitCode === 0,
    residualProcs: residual.length,
    produced,
    detail: `checkout ${co.action}; ${run.engine.kind} exit ${exitCode}`,
    exitCode,
  });
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

  const baseStatus = checkoutBaseStatus(cfg.checkoutBase, existsSync);

  if (!run) {
    for (const { p, due, remainingMin } of gated) {
      const tag = due ? "" : `  [cadence: skip, due in ${remainingMin}m]`;
      console.log(`\n[${p.slug} · ${p.skill}]${tag}\n${p.command}`);
    }
    const due = gated.filter((g) => g.due).length;
    if (!baseStatus.ok) console.log(`\n# ⚠ checkoutBase unavailable: ${baseStatus.reason}`);
    console.log(
      `\n(dry-run — ${due}/${plan.length} due now. Pass --run to execute; --force ignores cadence.)`,
    );
    process.exit(0);
  }

  // Mount guard: fail LOUD and early, before any checkout, if checkoutBase's disk is gone.
  // A distinct exit code (3) lets cron tell "disk not mounted" apart from "sweep failed".
  if (!baseStatus.ok) {
    console.error(`✗ checkoutBase not available — ${baseStatus.reason}. Skipping round.`);
    process.exit(3);
  }
  try {
    mkdirSync(expandHome(cfg.checkoutBase), { recursive: true });
    // PID-unique probe: overlapping invocations must not remove each other's probe and
    // mistake the ENOENT for "not writable" (that would false-exit-3 the whole round).
    const probe = `${expandHome(cfg.checkoutBase).replace(/\/+$/, "")}/.fleet-write-probe.${process.pid}`;
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch (e) {
    console.error(
      `✗ checkoutBase ${cfg.checkoutBase} exists but is not writable — ${(e as Error).message}. Skipping round.`,
    );
    process.exit(3);
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

  // Shared-file write plumbing. Declared HERE, above its first user: `recordSkip` runs during
  // cadence filtering, which happens before the run loop — a TDZ crash the unit tests could
  // not see, because they exercise the pure helpers and never the main loop. Caught by
  // actually running the driver.
  const pid = process.pid;
  const stateLockPath = `${sPath}.lock`;
  const nowMs = () => Date.now();
  const sleepSync = (ms: number) => Bun.sleepSync(ms);
  const logDir = expandHome(cfg.logDir ?? defaultLogDir(cfg.checkoutBase));
  const { summary } = logPaths(logDir, "x/y", "z");

  /** A round that did NOT happen is a fact worth keeping — printing it only to the cron log
   *  makes "why has this repo not moved" and "how often does the cadence collide" both
   *  unanswerable from data. Same file, same shape, zero duration. */
  const recordSkip = (
    p: PlannedRun,
    outcome: "skipped-cadence" | "skipped-locked",
    detail: string,
  ): void => {
    withFileLock(stateLockPath, pid, realLockIO, nowMs, sleepSync, () => {
      appendFileSync(
        summary,
        `${summaryLine({
          ts: new Date(Date.now()).toISOString(),
          runner: cfg.runner,
          slug: p.slug,
          skill: p.skillLocal,
          outcome,
          exitCode: null,
          ms: 0,
          detail,
        })}\n`,
      );
    });
  };

  const dueRuns = gated.filter((g) => g.due).map((g) => g.p);
  const skipped = gated.length - dueRuns.length;
  if (skipped) {
    for (const g of gated.filter((g) => !g.due)) {
      recordSkip(g.p, "skipped-cadence", `within cadence, due in ${g.remainingMin}m`);
      console.log(
        `# skip [${g.p.slug} · ${g.p.skill}] — within cadence, due in ${g.remainingMin}m`,
      );
    }
  }

  console.log(`# logs → ${logDir}/  (per-(repo,skill) .log + fleet.jsonl)`);

  const outcomeOf = (detail: string, ok: boolean): RunRecord["outcome"] =>
    ok
      ? "ok"
      : detail.startsWith("checkout")
        ? "checkout-failed"
        : detail.startsWith("setup")
          ? "setup-failed"
          : "failed";

  // Per-repo run locks live here; overlapping invocations coexist by skipping a repo whose
  // lock a LIVE invocation still holds (see runlock.ts). The cron no longer serializes whole
  // invocations, so shared-file writes (state stamps + fleet.jsonl) are guarded per-write.
  const lockDir = `${expandHome(cfg.checkoutBase).replace(/\/+$/, "")}/.locks`;
  ensureLockDir(lockDir);

  // Record one finished run. The summary append + cadence stamp touch SHARED files, so with
  // overlapping invocations they run under a short cross-process lock (advisory: a contended
  // stamp that times out just reruns that repo next fire — never a deadlock).
  const record = (p: PlannedRun, res: Awaited<ReturnType<typeof executeRun>>): boolean => {
    console.log(
      `  ${res.ok ? "✓" : "✗"} [${p.slug} · ${p.skill}] ${res.detail}  (${Math.round(res.ms / 1000)}s → ${res.logPath})`,
    );
    withFileLock(stateLockPath, pid, realLockIO, nowMs, sleepSync, () => {
      appendFileSync(
        summary,
        `${summaryLine({
          ts: new Date(now).toISOString(),
          runner: cfg.runner,
          slug: p.slug,
          skill: p.skillLocal,
          outcome: outcomeOf(res.detail, res.ok),
          exitCode: res.exitCode,
          ms: res.ms,
          detail: res.detail,
          runId: res.runId,
          // Always, including 0 — see RunRecord.residualProcs.
          residualProcs: res.residualProcs ?? 0,
          ...(res.produced ? { produced: res.produced } : {}),
        })}\n`,
      );
      if (res.ok) recordRun(sPath, p.slug, p.skillLocal, now); // stamp only on success → a failed round retries next cron
    });
    return res.ok;
  };

  // One run under its per-repo lock: skip (locked=true) if a live invocation already runs this
  // repo; otherwise execute and ALWAYS release the lock, even on failure.
  type RunOutcome = {
    p: PlannedRun;
    res?: Awaited<ReturnType<typeof executeRun>>;
    locked?: boolean;
  };
  const runOne = async (p: PlannedRun): Promise<RunOutcome> => {
    const lockPath = runLockPath(lockDir, p.slug, p.skillLocal);
    if (!acquire(lockPath, pid, Date.now(), realLockIO)) return { p, locked: true };
    try {
      // Only now — holding the lock is the precondition that makes this safe (see reapOrphans).
      const orphans = reapOrphans(p.checkoutPath, realSh);
      if (orphans.killed.length)
        console.log(
          `# reaped ${orphans.killed.length} orphan(s) from an earlier round in ${p.slug} · ${p.skillLocal}: ${orphans.killed.join(", ")}`,
        );
      return { p, res: await executeRun(p, cfg, realSh, !cfg.parallel) };
    } catch (err) {
      return {
        p,
        res: {
          ok: false,
          detail: `driver error: ${(err as Error).message}`,
          logPath: "",
          exitCode: null,
          ms: 0,
        },
      };
    } finally {
      release(lockPath, pid, realLockIO);
    }
  };

  let failed = 0;
  let lockSkipped = 0;
  const finish = (o: RunOutcome): void => {
    if (o.locked) {
      recordSkip(o.p, "skipped-locked", "another invocation holds the per-repo lock");
      console.log(
        `# skip [${o.p.slug} · ${o.p.skill}] — already running in another invocation (per-repo lock held)`,
      );
      lockSkipped++;
      return;
    }
    if (o.res && !record(o.p, o.res)) failed++;
  };

  if (cfg.parallel) {
    // Repos of one skill are INDEPENDENT — run them concurrently. Each writes only to its own
    // per-(repo,skill) log (mirror=false) so N outputs don't interleave; the per-repo lock
    // skips any repo a still-running earlier invocation owns.
    //
    // Stagger the STARTS (not the durations): repo i is launched i*stagger later, so every round
    // still overlaps for its full lifetime, but the front-loaded GitHub bursts each round makes at
    // t0 (issue/PR list, label reads) are spread over staggerSeconds instead of firing at the same
    // instant across all repos — that simultaneous burst is what exhausts the shared primary quota
    // and trips the secondary concurrency limit. `staggerSeconds: 0` restores the old all-at-once.
    const stagger = (cfg.staggerSeconds ?? 30) * 1000;
    console.log(
      `# parallel: launching up to ${dueRuns.length} repo(s) concurrently` +
        (stagger > 0 && dueRuns.length > 1 ? `, staggering each start by ${stagger / 1000}s` : "") +
        ` (per-repo lock skips any already running)`,
    );
    const settled = await Promise.all(
      dueRuns.map(async (p, i) => {
        if (i > 0 && stagger > 0) await Bun.sleep(i * stagger);
        return runOne(p);
      }),
    );
    for (const o of settled) finish(o);
  } else {
    const stagger = (cfg.staggerSeconds ?? 30) * 1000;
    for (let i = 0; i < dueRuns.length; i++) {
      console.log(`\n▶ [${dueRuns[i].slug} · ${dueRuns[i].skill}] (${i + 1}/${dueRuns.length})`);
      finish(await runOne(dueRuns[i]));
      if (i < dueRuns.length - 1 && stagger > 0) await Bun.sleep(stagger);
    }
  }
  const ranCount = dueRuns.length - lockSkipped;
  console.log(
    `\nDone: ${ranCount - failed}/${ranCount} ok, ${failed} failed${lockSkipped ? `, ${lockSkipped} skipped (running)` : ""}${skipped ? `, ${skipped} skipped (cadence)` : ""}. Summary: ${summary}`,
  );
  process.exit(failed ? 1 : 0);
}
