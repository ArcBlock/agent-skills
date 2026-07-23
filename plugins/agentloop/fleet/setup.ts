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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  type DeploymentConfig,
  type EngineConfig,
  expandHome,
  type RepoEntry,
  resolveSkillConcurrency,
} from "./driver.ts";

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
  /** Engine for the generated deployment (default claude). For codex, `agentloopRoot` MUST
   *  point at the codex cache install — the CLI resolves that via detectCodexPluginRoot. */
  engine?: EngineConfig;
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
  set("engine", input.engine);
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
    skillEnv: defaultSkillEnv(),
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
  concurrency: number;
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
	concurrency: resolveSkillConcurrency(r, skill) ?? 3,
      });
    }
  }
  return specs;
}

/** One crontab row for a skill: source envFile → run the driver for that skill (which
 *  handles checkout/install/cadence/parallel per repo). NO cron-level lock: the driver now
 *  holds a per-(repo,skill) lock itself (see fleet/runlock.ts), so overlapping invocations
 *  coexist — a still-running slow repo is skipped while the others run. This is what stops a
 *  2h blockchain run from starving arc's next fire. (Before, a cron-wide shlock serialized
 *  whole invocations and a lone slow repo blocked everyone.) OS-independent now. */
export function renderCronRow(input: SetupInput, skill: string, minute: number): string {
  const p = paths(input);
  const driver = `${input.agentloopRoot.replace(/\/+$/, "")}/fleet/driver.ts`;
  const run = `${input.bunPath} ${driver} --config ${p.deployment} --catalog ${p.catalog} --skill ${skill} --run`;
  const src = input.envFile ? `. ${expandHome(input.envFile)}; ` : "";
  const log = `${p.logDir}/cron-${skill}.log`;
  return `${minute} * * * * { ${src}${run}; } >> ${log} 2>&1`;
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

/** Compare two `x.y.z` versions numerically. >0 if a is newer. Non-numeric parts sort as 0. */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Where `codex plugin add agentloop@…` installed the plugin, as the CURRENT (highest-semver)
 *  version — that is the one `codex exec` loads. Unlike claude's `--plugin-dir`, codex has NO
 *  per-invocation plugin dir: it loads only globally-installed plugins, and it keeps old
 *  version dirs around, so a fixed path goes stale on the next `codex plugin add`. Returning
 *  the current install lets a codex deployment set `agentloopRoot` to it, keeping the prompt +
 *  the skill's own scripts (both read from agentloopRoot) on the SAME version codex runs —
 *  no skew. `undefined` = not installed (the CLI turns that into a loud, actionable error).
 *  `home` is injectable for tests. Couples to codex's cache layout by necessity; isolated here. */
export function detectCodexPluginRoot(home: string = homedir()): string | undefined {
  const base = `${home}/.codex/plugins/cache`;
  if (!existsSync(base)) return undefined;
  const found: { dir: string; ver: string }[] = [];
  for (const mkt of readdirSync(base)) {
    const pdir = `${base}/${mkt}/agentloop`;
    if (!existsSync(pdir)) continue;
    for (const ver of readdirSync(pdir)) {
      if (existsSync(`${pdir}/${ver}/.claude-plugin/plugin.json`))
        found.push({ dir: `${pdir}/${ver}`, ver });
    }
  }
  if (!found.length) return undefined;
  found.sort((a, b) => cmpSemver(b.ver, a.ver)); // highest first
  return found[0].dir;
}

/** Strip ANSI/terminal escape sequences and pick the last absolute path a probe printed.
 *  `bash -lc` sources the user's profile, and profiles routinely write to stdout before
 *  our command runs — colour resets (`ESC ( B ESC [ m` from a theme), banners, version
 *  managers announcing themselves. `.trim()` does NOT remove control chars, so that junk
 *  used to be baked straight into the crontab PATH, turning real dirs into unresolvable
 *  ones (`\x1b(B\x1b[m/Users/…/node/bin`) and defeating the whole point of probing. */
export function parseProbedPath(stdout: string): string | undefined {
  return (
    stdout
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
      .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\([A-Za-z0-9]|[@-Z\\-_])/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("/"))
      .pop() ?? undefined
  );
}

/** Dir of an executable as a login shell resolves it (`-l` sources the profile, so a
 *  version-manager like nvm/fnm — which puts `node` under ~/.nvm/…/bin, NOT a standard
 *  dir — is found). Returns undefined if the tool isn't on PATH. */
function whichDir(cmd: string): string | undefined {
  const r = Bun.spawnSync(["bash", "-lc", `command -v ${cmd} 2>/dev/null`]);
  const p = parseProbedPath(new TextDecoder().decode(r.stdout));
  return p?.includes("/") ? p.slice(0, p.lastIndexOf("/")) : undefined;
}

/** PATH= line for the crontab block. cron starts with a bare PATH, so the block must name
 *  every dir the driver + its children need. CRITICAL: probe node/pnpm/git/claude with
 *  `command -v` (not just standard dirs) — nvm/fnm put `node` under a version-manager dir,
 *  and a hardcoded list would drop it, so `pnpm install` (the driver's setupCommand) would
 *  die with "node: command not found" on every repo. Mirrors /setup-routines Step 3c. */
function detectCronPath(bunPath: string): string {
  const dirs = [
    `${homedir()}/.local/bin`,
    `${homedir()}/Library/pnpm`,
    bunPath.slice(0, bunPath.lastIndexOf("/")),
    whichDir("node"),
    whichDir("pnpm"),
    whichDir("git"),
    whichDir("claude"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((d): d is string => Boolean(d));
  return [...new Set(dirs)].join(":");
}

/** Parse a compact --repos spec: "slug=skill,skill@cadence;slug=skill@cadence".
 *  cloneUrl/setupCommand are NOT in the compact form (special chars) — reconcile
 *  preserves those from an existing repos.json, or pass --repos-json for full control. */
/**
 * Per-skill isolation defaults, applied to a config that has none.
 *
 * Two skills sweeping the same repo concurrently each boot that repo's dev daemon, and with
 * one port pair between them the second one dies on a bound port — a failure that looks like
 * a broken sweep rather than a config gap. Isolating the port pair and the daemon home costs
 * nothing for repos that run no daemon (unset variables they never read), so it is the
 * default rather than a question, and `buildDeployment` preserves any hand-tuned value.
 *
 * `{{CHECKOUT}}` is expanded per run by the driver, giving each tree its own daemon state.
 */
export const defaultSkillEnv = (): DeploymentConfig["skillEnv"] => ({
  "issue-sweep": {
    ARC_HOME: "{{CHECKOUT}}/.arc-home",
    ARC_SERVICE_PORT: "4910",
    ARC_WORKER_PORT: "8797",
  },
  "pr-sweep": {
    ARC_HOME: "{{CHECKOUT}}/.arc-home",
    ARC_SERVICE_PORT: "4920",
    ARC_WORKER_PORT: "8807",
  },
});

/** Credentials the cron rows source. `derive` returns the value or "" if unobtainable. */
export const ENV_KEYS: { key: string; derive: string; how: string }[] = [
  {
    key: "GH_TOKEN",
    // Already on the machine if the human has ever used `gh` — no reason to make them paste it.
    derive: "gh auth token 2>/dev/null",
    how: "gh auth login",
  },
  {
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    // Deliberately NOT derived: `claude setup-token` is an interactive OAuth flow. A setup
    // script must not drive a human's browser login, and a token minted behind their back is
    // worse than one line of manual work.
    derive: "",
    how: "claude setup-token",
  },
];

/**
 * Create the credential file the cron rows source, filling in what the machine can already
 * answer and leaving an obvious hole for what it cannot.
 *
 * Onboarding is the point. Warning "create this file before the first fire" leaves a teammate
 * to discover the format from a README, and the failure mode when they get it wrong is a
 * fleet that runs and quietly does nothing — a round that sources 0 vars is the one shape the
 * driver already aborts loudly on, precisely because it used to be silent.
 *
 * NEVER overwrites an existing file, and never echoes a value — the caller prints only which
 * keys are present, which is enough to know what is left to do.
 */
export function scaffoldEnvFile(
  path: string,
  exists: (p: string) => boolean = existsSync,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
  write: (p: string, body: string) => void = (p, body) => writeFileSync(p, body, { mode: 0o600 }),
  run: (cmd: string) => string = (cmd) => {
    const r = Bun.spawnSync(["bash", "-c", cmd]);
    return new TextDecoder().decode(r.stdout).trim();
  },
): string[] {
  const out: string[] = [];
  if (exists(path)) {
    const body = read(path);
    const missing = ENV_KEYS.filter((k) => !new RegExp(`^\\s*export\\s+${k.key}=`, "m").test(body));
    out.push(
      missing.length
        ? `⚠ ${path} exists but sets no ${missing.map((m) => m.key).join(", ")} — add it (${missing.map((m) => m.how).join("; ")}) or the fleet aborts on its first fire.`
        : `✓ ${path} already sets ${ENV_KEYS.map((k) => k.key).join(", ")}`,
    );
    return out; // never touch a file holding someone's credentials
  }

  const lines = ["# agentloop fleet credentials — sourced by every cron row. Keep mode 600.", ""];
  const todo: typeof ENV_KEYS = [];
  for (const k of ENV_KEYS) {
    const v = k.derive ? run(k.derive) : "";
    if (v) lines.push(`export ${k.key}=${v}`);
    else {
      lines.push(`export ${k.key}=   # ← FILL: ${k.how}`);
      todo.push(k);
    }
  }
  write(path, `${lines.join("\n")}\n`);
  out.push(`✓ wrote ${path} (mode 600)`);
  for (const k of ENV_KEYS) {
    const done = !todo.includes(k);
    out.push(
      `   ${done ? "✓" : "→"} ${k.key}${done ? " (derived)" : `  RUN: ${k.how}, then paste it in`}`,
    );
  }
  return out;
}

export function parseReposSpec(spec: string): RepoEntry[] {
  const out: RepoEntry[] = [];
  for (const part of spec
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [slug, rest = ""] = part.split("=");
    // `<slug>=<skills>@<cadence>+<ref,ref>` — the `+` tail names other catalog repos this one
    // must be able to READ (see RepoEntry.referenceRepos). Optional and rare, so it is a
    // suffix rather than another positional field.
    const [head, refsCsv] = rest.split("+");
    const [skillsCsv, cadence] = head.split("@");
    const skills = skillsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const entry: RepoEntry = { slug: slug.trim(), defaultBranch: "main", skills };
    if (cadence) entry.cadenceMinutes = Number(cadence);
    const refs = (refsCsv ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (refs.length) entry.referenceRepos = refs;
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
      "usage: bun fleet/setup.ts --runner <name> [--repos-json <p> | --repos <spec>] [--env-file <p>] [--engine claude|codex] [--model <m>] [--local] [--apply]",
    );
    process.exit(2);
  }

  const configDir = arg("--config-dir") ?? "~/.agentloop-fleet";
  const bunPath = arg("--bun-path") ?? detectBunPath();

  // Engine + agentloopRoot resolve TOGETHER. codex loads only globally-installed plugins, so
  // its root is the codex cache install (not the claude marketplace clone) and there is nothing
  // to fall back to if it is missing — fail loud with the fix, exactly as claude would on a
  // missing marketplace. This alignment keeps the prompt + the skill's scripts (both read from
  // agentloopRoot) on the SAME version codex loads, so there is no cross-version skew.
  const engineKind = arg("--engine") as EngineConfig["kind"] | undefined;
  if (engineKind && engineKind !== "claude" && engineKind !== "codex") {
    console.error(`--engine must be "claude" or "codex" (got "${engineKind}")`);
    process.exit(2);
  }
  let agentloopRoot: string;
  let engine: EngineConfig | undefined;
  if (engineKind === "codex") {
    const codexRoot = arg("--agentloop-root") ?? detectCodexPluginRoot();
    if (!codexRoot) {
      console.error(
        "--engine codex, but no globally-installed agentloop plugin was found for codex.\n" +
          "codex has no per-invocation --plugin-dir; install the plugin once, then re-run setup:\n" +
          "  codex plugin marketplace add https://github.com/ArcBlock/agent-skills.git\n" +
          "  codex plugin add agentloop@arcblock-agent-skills",
      );
      process.exit(2);
    }
    agentloopRoot = codexRoot;
    engine = { kind: "codex", ...(arg("--model") ? { model: arg("--model") as string } : {}) };
  } else {
    agentloopRoot = arg("--agentloop-root") ?? detectAgentloopRoot();
    if (engineKind === "claude") engine = { kind: "claude" };
  }
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
    // For codex, --model belongs to engine.model (its own id namespace); don't also emit it as
    // the legacy claude-level model. For claude, --model stays the legacy field.
    model: engineKind === "codex" ? undefined : arg("--model"),
    engine,
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
  console.log(
    `# engine: ${deployment.engine?.kind ?? "claude"}  ·  agentloopRoot: ${agentloopRoot}`,
  );

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

  if (input.envFile)
    for (const line of scaffoldEnvFile(expandHome(input.envFile))) console.log(line);

  if (local) {
    // Invoke crontab DIRECTLY, never via `bash -lc`: a login shell sources the user's
    // profile, whose stdout chatter (colour resets, banners) would be captured as if it
    // were crontab content and then written back — crontab rejects the whole file with
    // `"-":0: bad minute`. crontab lives in a standard dir, so no profile is needed.
    const cur = Bun.spawnSync(["crontab", "-l"]);
    // No crontab yet → exit!=0 with empty stdout; that is "start from nothing", not an error.
    const existingCron = cur.exitCode === 0 ? new TextDecoder().decode(cur.stdout) : "";
    const { next, replaced } = reconcileCrontab(existingCron, block);
    const write = Bun.spawnSync(["crontab", "-"], { stdin: Buffer.from(next) });
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
