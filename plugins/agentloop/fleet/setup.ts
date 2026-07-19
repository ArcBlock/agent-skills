#!/usr/bin/env bun
/**
 * agentloop fleet — one-command setup/reconcile (LOCAL path).
 *
 * Turns "answer a few questions" into a running fleet: it generates/reconciles the
 * two config files (`deployment.json` + `repos.json`) and installs an idempotent
 * crontab marker-block that wires the fleet `driver.ts` (one row per skill; the
 * driver fans out to every covered repo). The interactive `/agentloop:fleet-setup`
 * skill is a thin wrapper that collects answers and calls this. It is also runnable
 * directly for scripted / reproducible bootstrap.
 *
 *   bun fleet/setup.ts --runner me [--repos-json <path>] [--env-file <p>] [--local]
 *     (default) DRY-RUN: print the config + crontab block it WOULD write; no writes.
 *     --apply : actually write the config, mkdir dirs, and reconcile the crontab.
 *
 * Design: pure core (buildDeployment / buildCatalog / renderCronBlock /
 * reconcileCrontab …) is exported and unit-tested; the CLI wires it with the side
 * effects (fs, crontab). Reconcile is idempotent — re-running is the upgrade path,
 * and it PRESERVES fields the user hand-added (skillEnv, extra env, cloneUrl).
 *
 * NOTE: the fleet's default posture is `permissionMode: "skip"`
 * (--dangerously-skip-permissions), which BYPASSES workspace-trust and the
 * allowlist — so unlike /setup-routines this installer needs no trust-dialog or
 * native-toolchain allowlist edits (native tools already run under skip). Those are
 * only relevant to the acceptEdits posture; see fleet/README.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { DeploymentConfig, RepoEntry } from "./driver.ts";
import { expandHome } from "./driver.ts";

// ── marker + fixed shape (mirrors the proven `# agentloop-fleet:` crontab block) ──
export const CRON_MARKER = "agentloop-fleet";
export const CRON_BEGIN = `# ${CRON_MARKER}:begin`;
export const CRON_END = `# ${CRON_MARKER}:end`;

/** Base cron minute per skill; the runner stagger offset is added on top. Two 30-min
 *  apart lanes match the proven block (issue :09, pr :39); unknown skills get spread
 *  deterministic slots so a repo with more skills still doesn't stack them on :00. */
export const SKILL_BASE_MIN: Record<string, number> = {
  "issue-sweep": 9,
  "pr-sweep": 39,
};
export function skillBaseMinute(skill: string, allSkills: string[]): number {
  if (skill in SKILL_BASE_MIN) return SKILL_BASE_MIN[skill];
  // Deterministic fallback: spread the non-standard skills across the hour, avoiding
  // the two reserved lanes, by index.
  const i = [...allSkills].sort().indexOf(skill);
  return (17 + i * 11) % 55;
}

/** Deterministic per-runner minute offset (like /setup-routines' cksum%13) so several
 *  teammates' fleets don't all fire on the same minute. Not required to match cksum —
 *  only to be stable per runner. */
export function staggerOffset(runner: string, mod = 13): number {
  let h = 0;
  for (const ch of runner) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % mod;
}

export interface SetupInput {
  runner: string;
  configDir: string; // where deployment.json + repos.json live (e.g. ~/.agentloop-fleet)
  agentloopRoot: string; // ABSOLUTE plugin dir (driver.ts lives at <root>/fleet/driver.ts)
  bunPath: string; // absolute bun (cron PATH may not have it)
  os: "Darwin" | "Linux";
  cronPath: string; // PATH= line for the crontab block
  envFile?: string;
  model?: string;
  permissionMode?: DeploymentConfig["permissionMode"];
  checkout?: DeploymentConfig["checkout"];
  checkoutBase?: string;
  checkoutPerSkill?: boolean;
  parallel?: boolean;
  staggerSeconds?: number;
  logDir?: string;
  env?: Record<string, string>;
  skillEnv?: DeploymentConfig["skillEnv"];
  cover?: DeploymentConfig["cover"];
  repos?: RepoEntry[]; // the catalog (incoming); merged per-slug with any existing
}

const j = (dir: string, leaf: string): string => `${dir.replace(/\/+$/, "")}/${leaf}`;

/** Absolute paths derived from the config dir (single source of truth for both the
 *  generated deployment.json and the crontab rows that reference it). */
export function paths(input: Pick<SetupInput, "configDir" | "logDir">) {
  const dir = expandHome(input.configDir).replace(/\/+$/, "");
  return {
    dir,
    deployment: j(dir, "deployment.json"),
    catalog: j(dir, "repos.json"),
    checkoutsDefault: j(dir, "checkouts"),
    logDir: input.logDir ? expandHome(input.logDir) : j(dir, "logs"),
    lock: (skill: string) => j(dir, `${skill}.lock`),
  };
}

/** Reconcile a deployment config: existing user file as the base, apply only the
 *  fields this run explicitly provides, fill defaults where neither has a value.
 *  So re-running never wipes a hand-added skillEnv / extra env. */
export function buildDeployment(
  input: SetupInput,
  existing: Partial<DeploymentConfig> = {},
): DeploymentConfig {
  const p = paths(input);
  const explicit: Partial<DeploymentConfig> = {};
  const set = <K extends keyof DeploymentConfig>(k: K, v: DeploymentConfig[K] | undefined) => {
    if (v !== undefined) explicit[k] = v;
  };
  set("runner", input.runner);
  set("agentloopRoot", input.agentloopRoot);
  set("checkoutBase", input.checkoutBase);
  set("checkout", input.checkout);
  set("checkoutPerSkill", input.checkoutPerSkill);
  set("cover", input.cover);
  set("permissionMode", input.permissionMode);
  set("model", input.model);
  set("envFile", input.envFile);
  set("env", input.env);
  set("skillEnv", input.skillEnv);
  set("parallel", input.parallel);
  set("staggerSeconds", input.staggerSeconds);
  set("logDir", input.logDir);
  const defaults: DeploymentConfig = {
    runner: input.runner,
    agentloopRoot: input.agentloopRoot,
    checkoutBase: p.checkoutsDefault,
    cover: "all",
    permissionMode: "skip",
    checkoutPerSkill: true,
    parallel: true,
    staggerSeconds: 20,
    env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" },
    logDir: p.logDir,
  };
  return { ...defaults, ...existing, ...explicit };
}

/** Reconcile the catalog: merge incoming repos per-slug over existing, preserving
 *  fields the incoming entry omits (cloneUrl / setupCommand a user may have set). If
 *  no incoming repos are given, keep the existing catalog untouched. */
export function buildCatalog(
  incoming: RepoEntry[] | undefined,
  existing: RepoEntry[] = [],
): RepoEntry[] {
  if (!incoming || incoming.length === 0) return existing;
  const bySlug = new Map(existing.map((r) => [r.slug, r]));
  for (const r of incoming) {
    const prev = bySlug.get(r.slug) ?? ({} as RepoEntry);
    bySlug.set(r.slug, { ...prev, ...r });
  }
  return [...bySlug.values()];
}

/** The distinct skills across the covered repos, in a stable order — one crontab row
 *  each (the driver fans that skill out to every repo declaring it). */
export function coveredSkills(repos: RepoEntry[], cover: DeploymentConfig["cover"]): string[] {
  const covered =
    cover === "all" || cover === undefined
      ? repos
      : repos.filter((r) => (cover as string[]).includes(r.slug));
  const set = new Set<string>();
  for (const r of covered) for (const s of r.skills) set.add(s);
  return [...set].sort();
}

/** A cloud routine to create/update — one per (repo × skill), because a cloud routine
 *  covers ONE repo (its own environment/checkout); the setup skill batch-materializes
 *  these via RemoteTrigger from the same catalog. Canonical name is the reconcile key. */
export interface CloudRoutineSpec {
  canonicalName: string; // "arc issue-sweep hourly" — RemoteTrigger reconcile key
  slug: string;
  skill: string;
  cron: string; // "17 * * * *"
  promptPath: string; // <agentloopRoot>/fleet/prompts/<skill>.md, rendered with {{RUNNER}}
  model?: string;
}

/** The covered repos for a deployment (all catalog repos, or the explicit cover subset). */
export function coveredRepos(repos: RepoEntry[], cover: DeploymentConfig["cover"]): RepoEntry[] {
  return cover === "all" || cover === undefined
    ? repos
    : repos.filter((r) => (cover as string[]).includes(r.slug));
}

/** The cloud materialization plan for the catalog: one routine per (repo × skill), with a
 *  per-(runner,repo) staggered minute so N routines don't all hit GitHub on the same minute.
 *  The actual RemoteTrigger create/update calls are the skill's (an MCP tool, not a script). */
export function buildCloudPlan(input: SetupInput, repos: RepoEntry[]): CloudRoutineSpec[] {
  const specs: CloudRoutineSpec[] = [];
  for (const r of coveredRepos(repos, input.cover)) {
    const off = staggerOffset(`${input.runner}:${r.slug}`);
    const name = r.slug.split("/").pop() as string;
    for (const skill of r.skills) {
      const min = (skillBaseMinute(skill, r.skills) + off) % 60;
      specs.push({
        canonicalName: `${name} ${skill} hourly`,
        slug: r.slug,
        skill,
        cron: `${min} * * * *`,
        promptPath: `${input.agentloopRoot.replace(/\/+$/, "")}/fleet/prompts/${skill}.md`,
        model: input.model,
      });
    }
  }
  return specs;
}

/** One crontab row for a skill: lock → source envFile → run the driver for that skill
 *  (which handles checkout/install/cadence/parallel per repo) → release lock. Mirrors
 *  the proven block; shlock on macOS (no flock binary), flock on Linux. */
export function renderCronRow(input: SetupInput, skill: string, minute: number): string {
  const p = paths(input);
  const driver = `${input.agentloopRoot.replace(/\/+$/, "")}/fleet/driver.ts`;
  const run = `${input.bunPath} ${driver} --config ${p.deployment} --catalog ${p.catalog} --skill ${skill} --run`;
  const src = input.envFile ? `. ${expandHome(input.envFile)}; ` : "";
  const log = `${p.logDir}/cron-${skill}.log`;
  const lock = p.lock(skill);
  if (input.os === "Darwin") {
    return `${minute} * * * * { /usr/bin/shlock -f ${lock} -p $$ && { ${src}${run}; rm -f ${lock}; }; } >> ${log} 2>&1`;
  }
  return `${minute} * * * * flock -n ${lock} bash -lc '${src}${run}' >> ${log} 2>&1`;
}

/** The full begin..end crontab block (header + PATH + one row per skill). */
export function renderCronBlock(input: SetupInput, repos: RepoEntry[]): string {
  const skills = coveredSkills(repos, input.cover);
  const off = staggerOffset(input.runner);
  const coverSummary =
    input.cover === "all" || input.cover === undefined
      ? repos.map((r) => r.slug.split("/").pop()).join("/")
      : (input.cover as string[]).map((s) => s.split("/").pop()).join("/");
  const cadence = repos.map((r) => r.cadenceMinutes ?? "∞").join("/");
  const rows = skills.map((s) => renderCronRow(input, s, (skillBaseMinute(s, skills) + off) % 60));
  return [
    `${CRON_BEGIN} (runner:${input.runner} · cover=${coverSummary} · cadence ${cadence} · plugin=${input.agentloopRoot})`,
    `PATH=${input.cronPath}`,
    ...rows,
    CRON_END,
  ].join("\n");
}

/** Strip our managed block from a crontab, returning the remainder + whether a block
 *  was present. NEVER touches other lines (a user's own cron / other marker blocks). */
export function stripCronBlock(crontab: string): { without: string; had: boolean } {
  const lines = crontab.length ? crontab.split("\n") : [];
  const out: string[] = [];
  let inBlock = false;
  let had = false;
  for (const line of lines) {
    if (line.startsWith(CRON_BEGIN)) {
      inBlock = true;
      had = true;
      continue;
    }
    if (inBlock) {
      if (line.startsWith(CRON_END)) inBlock = false;
      continue;
    }
    out.push(line);
  }
  // Drop a trailing blank the split may leave, then normalize to end with one newline.
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return { without: out.join("\n"), had };
}

/** Reconcile: existing crontab minus our old block, plus the fresh block. */
export function reconcileCrontab(
  existing: string,
  block: string,
): { next: string; replaced: boolean } {
  const { without, had } = stripCronBlock(existing);
  const body = without.trim().length ? `${without.trimEnd()}\n\n` : "";
  return { next: `${body}${block}\n`, replaced: had };
}

// ── side-effecting CLI ────────────────────────────────────────────────────────
function readJson<T>(path: string): T | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
}

function detectBunPath(): string {
  // The path the current bun was launched from; falls back to a common location.
  return process.execPath || `${homedir()}/.bun/bin/bun`;
}

function detectAgentloopRoot(): string {
  const marketplace = `${homedir()}/.claude/plugins/marketplaces/arcblock-agent-skills/plugins/agentloop`;
  if (existsSync(`${marketplace}/.claude-plugin/plugin.json`)) return marketplace;
  return new URL("..", import.meta.url).pathname.replace(/\/+$/, "");
}

function detectCronPath(bunPath: string): string {
  const dirs = [
    `${homedir()}/.local/bin`,
    `${homedir()}/Library/pnpm`,
    bunPath.slice(0, bunPath.lastIndexOf("/")),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs)].join(":");
}

/** Parse a compact --repos spec: "slug=skill,skill@cadence;slug=skill@cadence".
 *  cloneUrl/setupCommand are NOT in the compact form (special chars) — reconcile
 *  preserves those from an existing repos.json, or pass --repos-json for full control. */
export function parseReposSpec(spec: string): RepoEntry[] {
  const out: RepoEntry[] = [];
  for (const part of spec
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [slug, rest = ""] = part.split("=");
    const [skillsCsv, cadence] = rest.split("@");
    const skills = skillsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const entry: RepoEntry = { slug: slug.trim(), defaultBranch: "main", skills };
    if (cadence) entry.cadenceMinutes = Number(cadence);
    out.push(entry);
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (k: string) => argv.includes(k);
  const apply = has("--apply");

  const runner = arg("--runner");
  if (!runner) {
    console.error(
      "usage: bun fleet/setup.ts --runner <name> [--repos-json <p> | --repos <spec>] [--env-file <p>] [--model <m>] [--local] [--apply]",
    );
    process.exit(2);
  }

  const configDir = arg("--config-dir") ?? "~/.agentloop-fleet";
  const bunPath = arg("--bun-path") ?? detectBunPath();
  const agentloopRoot = arg("--agentloop-root") ?? detectAgentloopRoot();
  const osName = (arg("--os") ?? (process.platform === "darwin" ? "Darwin" : "Linux")) as
    | "Darwin"
    | "Linux";
  const p = paths({ configDir, logDir: arg("--log-dir") });

  // Incoming catalog: --repos-json (full) wins, else --repos (compact), else reuse existing.
  const reposJsonPath = arg("--repos-json");
  const incoming = reposJsonPath
    ? (readJson<RepoEntry[]>(expandHome(reposJsonPath)) ?? [])
    : arg("--repos")
      ? parseReposSpec(arg("--repos") as string)
      : undefined;

  const existingDeployment = readJson<DeploymentConfig>(p.deployment) ?? {};
  const existingCatalog = readJson<RepoEntry[]>(p.catalog) ?? [];

  const checkoutBaseDir = arg("--checkout-base-dir");
  const input: SetupInput = {
    runner,
    configDir,
    agentloopRoot,
    bunPath,
    os: osName,
    cronPath: detectCronPath(bunPath),
    envFile: arg("--env-file"),
    model: arg("--model"),
    permissionMode: (arg("--permission-mode") as DeploymentConfig["permissionMode"]) ?? undefined,
    checkout: checkoutBaseDir ? { mode: "worktree", baseDir: checkoutBaseDir } : undefined,
    checkoutBase: arg("--checkout-base"),
    logDir: arg("--log-dir"),
    cover:
      arg("--cover") && arg("--cover") !== "all"
        ? (arg("--cover") as string).split(",")
        : arg("--cover") === "all"
          ? "all"
          : undefined,
    repos: incoming,
  };

  const deployment = buildDeployment(input, existingDeployment);
  const catalog = buildCatalog(incoming, existingCatalog);

  // Cloud plan mode: emit the per-(repo×skill) routine specs as JSON for the skill to
  // execute via RemoteTrigger. Pure output — no writes, no crontab.
  if (has("--emit-cloud-plan")) {
    const plan = buildCloudPlan(
      { ...input, cover: deployment.cover, model: deployment.model },
      catalog,
    );
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }

  const block = renderCronBlock({ ...input, cover: deployment.cover }, catalog);
  const local = has("--local");

  const skills = coveredSkills(catalog, deployment.cover);
  console.log(
    `# agentloop fleet setup — runner=${runner}, ${catalog.length} repo(s), skills=${skills.join(",")}`,
  );
  console.log(`# config dir: ${p.dir}  (deployment.json + repos.json)`);
  console.log(`# agentloopRoot: ${agentloopRoot}`);

  if (!apply) {
    console.log(`\n--- deployment.json (would write) ---\n${JSON.stringify(deployment, null, 2)}`);
    console.log(`\n--- repos.json (would write) ---\n${JSON.stringify(catalog, null, 2)}`);
    if (local) {
      const { replaced } = reconcileCrontab("", block);
      console.log(`\n--- crontab block (would ${replaced ? "replace" : "install"}) ---\n${block}`);
    } else {
      console.log("\n# (no --local: skipping crontab; pass --local to install the schedule)");
    }
    console.log(`\n(dry-run — pass --apply to write config${local ? " + install crontab" : ""}.)`);
    process.exit(0);
  }

  // apply
  mkdirSync(p.dir, { recursive: true });
  mkdirSync(deployment.logDir ? expandHome(deployment.logDir) : p.logDir, { recursive: true });
  writeFileSync(p.deployment, `${JSON.stringify(deployment, null, 2)}\n`);
  writeFileSync(p.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`✓ wrote ${p.deployment}`);
  console.log(`✓ wrote ${p.catalog}`);

  if (input.envFile && !existsSync(expandHome(input.envFile))) {
    console.log(
      `⚠ envFile ${input.envFile} not found — the cron rows source it for credentials; create it before the first fire (see fleet/README.md).`,
    );
  }

  if (local) {
    const cur = Bun.spawnSync(["bash", "-lc", "crontab -l 2>/dev/null || true"]);
    const existingCron = new TextDecoder().decode(cur.stdout);
    const { next, replaced } = reconcileCrontab(existingCron, block);
    const write = Bun.spawnSync(["bash", "-lc", "crontab -"], { stdin: Buffer.from(next) });
    if (write.exitCode !== 0) {
      console.error(`✗ crontab install failed: ${new TextDecoder().decode(write.stderr)}`);
      process.exit(1);
    }
    console.log(`✓ crontab block ${replaced ? "replaced" : "installed"} (${skills.length} row(s))`);
  } else {
    console.log("# (no --local: crontab not touched)");
  }
  console.log("\nDone. Re-run this command any time to reconcile (idempotent upgrade path).");
  process.exit(0);
}
