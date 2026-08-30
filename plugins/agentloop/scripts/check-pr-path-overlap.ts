#!/usr/bin/env bun
import { posix } from "node:path";

export interface OpenPrPathSet {
  number: number;
  title: string;
  headRefName: string;
  isDraft: boolean;
  files: string[];
}

export interface AllowedPathOverlap {
  number: number;
  title: string;
  isDraft: boolean;
  shared: string[];
}

type Result =
  | { prPathOverlap: "clean"; openPrs: number; allowedPaths: string[] }
  | {
      prPathOverlap: "overlap";
      openPrs: number;
      allowedPaths: string[];
      overlaps: AllowedPathOverlap[];
    }
  | { prPathOverlap: "unavailable"; reason: string };

function normalizeAllowedPath(raw: string): string {
  const candidate = raw.trim().replaceAll("\\", "/");
  if (!candidate || candidate.startsWith("/") || candidate.includes("*")) {
    throw new Error(`invalid allowedPaths entry: ${raw}`);
  }
  const normalized = posix.normalize(candidate).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`allowedPaths must be a repo-relative file or directory prefix: ${raw}`);
  }
  return normalized;
}

export function parseAllowedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("allowedPaths must be a non-empty array");
  }
  const paths = value.map((entry) => {
    if (typeof entry !== "string") throw new Error("allowedPaths entries must be strings");
    return normalizeAllowedPath(entry);
  });
  return [...new Set(paths)].sort();
}

/** A concrete PR file overlaps when it equals, or is contained by, a declared prefix. */
export function diagnoseAllowedPathOverlap(
  rawAllowedPaths: string[],
  openPrs: OpenPrPathSet[],
  currentBranch = "",
): AllowedPathOverlap[] {
  const allowedPaths = parseAllowedPaths(rawAllowedPaths);
  const overlaps: AllowedPathOverlap[] = [];
  for (const pr of openPrs) {
    if (currentBranch && pr.headRefName === currentBranch) continue;
    const shared = [
      ...new Set(
        pr.files.filter((file) =>
          allowedPaths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
        ),
      ),
    ].sort();
    if (shared.length > 0) {
      overlaps.push({
        number: pr.number,
        title: pr.title,
        isDraft: pr.isDraft,
        shared,
      });
    }
  }
  return overlaps.sort((a, b) => a.number - b.number);
}

function spawn(args: string[], cwd: string): { code: number; out: string } {
  try {
    const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString() };
  } catch {
    return { code: 127, out: "" };
  }
}

export function checkPrPathOverlap(runArgsJson: string, cwd?: string): Result {
  let allowedPaths: string[];
  let runCwd: string | undefined;
  try {
    const runArgs = JSON.parse(runArgsJson) as { allowedPaths?: unknown; cwd?: unknown };
    allowedPaths = parseAllowedPaths(runArgs.allowedPaths);
    runCwd = typeof runArgs.cwd === "string" && runArgs.cwd.trim() ? runArgs.cwd : undefined;
  } catch (error) {
    return {
      prPathOverlap: "unavailable",
      reason: `allowed-paths-uncheckable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const effectiveCwd = cwd ?? runCwd ?? process.cwd();

  const listed = spawn(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,title,headRefName,changedFiles,files,isDraft",
    ],
    effectiveCwd,
  );
  if (listed.code !== 0 || !listed.out.trim()) {
    return { prPathOverlap: "unavailable", reason: "open-pr-list-unavailable" };
  }

  let openPrs: OpenPrPathSet[];
  try {
    const raw = JSON.parse(listed.out) as Array<{
      number: number;
      title: string;
      headRefName: string;
      isDraft: boolean;
      changedFiles?: number;
      files?: Array<{ path: string }>;
    }>;
    if (!Array.isArray(raw)) throw new Error("not an array");
    if (
      raw.length >= 1000 ||
      raw.some(
        (pr) =>
          !Number.isInteger(pr.changedFiles) ||
          !Array.isArray(pr.files) ||
          pr.files.length !== pr.changedFiles,
      )
    ) {
      return { prPathOverlap: "unavailable", reason: "open-pr-files-incomplete" };
    }
    openPrs = raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      isDraft: pr.isDraft,
      files: (pr.files ?? []).map((file) => file.path),
    }));
  } catch {
    return { prPathOverlap: "unavailable", reason: "open-pr-list-unparseable" };
  }

  const branch = spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], effectiveCwd);
  const currentBranch = branch.code === 0 ? branch.out.trim() : "";
  const overlaps = diagnoseAllowedPathOverlap(allowedPaths, openPrs, currentBranch);
  return overlaps.length > 0
    ? { prPathOverlap: "overlap", openPrs: openPrs.length, allowedPaths, overlaps }
    : { prPathOverlap: "clean", openPrs: openPrs.length, allowedPaths };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runArgsIndex = args.indexOf("--run-args");
  const cwdIndex = args.indexOf("--cwd");
  const runArgsJson = runArgsIndex >= 0 ? args[runArgsIndex + 1] : undefined;
  const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;
  const result = runArgsJson
    ? checkPrPathOverlap(runArgsJson, cwd)
    : ({ prPathOverlap: "unavailable", reason: "run-args-missing" } satisfies Result);
  console.log(JSON.stringify(result));
  process.exit(result.prPathOverlap === "clean" ? 0 : result.prPathOverlap === "overlap" ? 10 : 2);
}
