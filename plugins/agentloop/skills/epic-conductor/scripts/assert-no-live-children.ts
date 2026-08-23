/**
 * Conductor watchdog (ArcBlock/arc#4605): exit 0 only when none of the hired
 * agent ids are live. Live = process-table `status=running` AND (remote hire
 * or local pid still alive). Factory cockpit rows persist `pid=-1`
 * (`REMOTE_RUN_PID`); those running rows are live — do not `kill(-1, 0)`.
 * Ghost only for a local pid>1 whose process is dead.
 *
 * Reuses the code-agents process-table row shape (`id`, `status`, `pid`,
 * `remoteId`, `capabilities.launch`, `cwd`, `startedAt`, `exitedAt`). Does
 * not talk to the :4900 cockpit.
 *
 *   bun assert-no-live-children.ts --runs-dir DIR [--ids id1,id2]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUN_JSON_RE = /^agent-[a-f0-9]+\.json$/;

/** Subset of `AgentRun` in providers/runtime/code-agents. */
export interface ProcessTableRow {
  id: string;
  status: string;
  pid: number;
  cwd?: string;
  startedAt?: string;
  exitedAt?: string;
  remoteId?: string;
  capabilities?: { launch?: string };
}

export type ChildKind = "live" | "ghost" | "settled" | "missing";

export interface ChildVerdict {
  id: string;
  kind: ChildKind;
  status: string;
  pid?: number;
  cwd?: string;
}

export type PidAlive = (pid: number) => boolean;

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cockpit manager row: not a posix pid. Never probe with `kill(pid, 0)`. */
export function isRemoteHireRow(row: ProcessTableRow): boolean {
  return row.pid === -1 || Boolean(row.remoteId) || row.capabilities?.launch === "remote";
}

export function classifyHiredChildren(
  rows: ProcessTableRow[],
  hiredIds: string[],
  isAlive: PidAlive = isPidAlive,
): ChildVerdict[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hiredIds.map((id) => {
    const rec = byId.get(id);
    if (!rec) return { id, kind: "missing", status: "missing" };
    if (rec.status !== "running") {
      return { id, kind: "settled", status: rec.status, pid: rec.pid, cwd: rec.cwd };
    }
    if (isRemoteHireRow(rec)) {
      return { id, kind: "live", status: rec.status, pid: rec.pid, cwd: rec.cwd };
    }
    if (isAlive(rec.pid)) {
      return { id, kind: "live", status: rec.status, pid: rec.pid, cwd: rec.cwd };
    }
    return { id, kind: "ghost", status: rec.status, pid: rec.pid, cwd: rec.cwd };
  });
}

export function formatLiveChildrenFailure(live: ChildVerdict[]): string {
  const named = live.map((c) => {
    const bits = [c.id];
    if (c.pid !== undefined) bits.push(`pid=${c.pid}`);
    if (c.cwd) bits.push(`cwd=${c.cwd}`);
    return bits.join(" ");
  });
  return `live hired children still running: ${named.join("; ")} — end_turn / close session is forbidden`;
}

export function formatGhostChildren(ghosts: ChildVerdict[]): string {
  const ids = ghosts.map((g) => g.id).join(", ");
  return `ghost hired children (status=running, pid dead): ${ids}`;
}

export function loadRunsDir(dir: string): ProcessTableRow[] {
  const names = readdirSync(dir);
  const rows: ProcessTableRow[] = [];
  for (const name of names) {
    if (!RUN_JSON_RE.test(name)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const row = parseRow(parsed);
    if (row) rows.push(row);
  }
  return rows;
}

function parseRow(value: unknown): ProcessTableRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
  if (typeof rec.status !== "string") return undefined;
  const pid = rec.pid;
  const row: ProcessTableRow = {
    id: rec.id,
    status: rec.status,
    pid: typeof pid === "number" && Number.isInteger(pid) ? pid : 0,
  };
  if (typeof rec.cwd === "string") row.cwd = rec.cwd;
  if (typeof rec.startedAt === "string") row.startedAt = rec.startedAt;
  if (typeof rec.exitedAt === "string") row.exitedAt = rec.exitedAt;
  if (typeof rec.remoteId === "string" && rec.remoteId) row.remoteId = rec.remoteId;
  const caps = rec.capabilities;
  if (caps && typeof caps === "object" && !Array.isArray(caps)) {
    const launch = (caps as Record<string, unknown>).launch;
    if (typeof launch === "string") row.capabilities = { launch };
  }
  return row;
}

export function parseArgs(argv: string[]): { runsDir?: string; ids?: string[] } {
  let runsDir: string | undefined;
  let ids: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--runs-dir") {
      runsDir = argv[++i];
      continue;
    }
    if (arg.startsWith("--runs-dir=")) {
      runsDir = arg.slice("--runs-dir=".length);
      continue;
    }
    if (arg === "--ids") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        ids = [];
      } else {
        i++;
        ids = next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      continue;
    }
    if (arg.startsWith("--ids=")) {
      ids = arg
        .slice("--ids=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { runsDir, ids };
}

function usage(): never {
  console.error("usage: assert-no-live-children.ts --runs-dir DIR [--ids id1,id2]");
  process.exit(2);
}

export function main(argv = process.argv.slice(2), isAlive: PidAlive = isPidAlive): number {
  const { runsDir, ids } = parseArgs(argv);
  if (ids && ids.length === 0) {
    console.log("ok: no live hired children");
    return 0;
  }
  if (!runsDir) usage();
  let rows: ProcessTableRow[];
  try {
    rows = loadRunsDir(runsDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`assert-no-live-children: cannot read runs-dir: ${message}`);
    return 2;
  }
  const hiredIds = ids ?? rows.map((r) => r.id);
  const verdicts = classifyHiredChildren(rows, hiredIds, isAlive);
  const live = verdicts.filter((v) => v.kind === "live");
  const ghosts = verdicts.filter((v) => v.kind === "ghost");
  if (ghosts.length > 0) console.log(formatGhostChildren(ghosts));
  if (live.length > 0) {
    console.error(formatLiveChildrenFailure(live));
    return 1;
  }
  console.log("ok: no live hired children");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
