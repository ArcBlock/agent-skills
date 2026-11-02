/**
 * The factory's explicit `arc` CLI (agent-factory#20).
 *
 * A host's global `~/.local/bin/arc` is someone else's choice: ArcBlock/arc#10371
 * points it at the desktop's stable CLI. A factory call site that resolves `arc`
 * from PATH would then silently run that build against the factory ledger. So
 * the factory's CLI is resolved from explicit sources only, in this order:
 *
 *   1. `ARC_BIN`  — an operator / test override (the arc repo's
 *      `scripts/arc-cli.ts` convention), taken as given;
 *   2. `ARC_CLI`  — the CLI the launching host declared to its run (#9181).
 *      Only an executable absolute path is trusted; anything else is refused,
 *      never replaced by PATH;
 *   3. the factory shim `$HOME/.arc-factory/bin/arc` — the supervisor's default
 *      `--shim`, which runs the factory's slot build and binds `-i factory`
 *      unless the caller names an instance.
 *
 * Nothing else. No source → `argv: null` with a reason that names each place
 * probed; the caller fails closed (or degrades, saying why). `which arc` is
 * deliberately not a source.
 *
 * Same result shape as the arc repo's `resolveArcCli` (`argv` prefix for
 * `spawnArc`), so callers swap the resolver and keep the spawner.
 */
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The factory shim, relative to `$HOME` (factory-supervisor `--home` default `~/.arc-factory`, `--shim` `<home>/bin/arc`). */
export const FACTORY_SHIM_RELATIVE_PATH = ".arc-factory/bin/arc";

export interface FactoryArcCliResolution {
  /** spawn argv prefix; null when no explicit CLI resolves. */
  argv: string[] | null;
  source: "ARC_BIN" | "ARC_CLI" | "factory-shim" | "none";
  /** Set when `source === "none"`. */
  reason?: string;
}

export interface FactoryArcCliProbes {
  env?: Record<string, string | undefined>;
  /** Executable regular file? Default: `node:fs` X_OK on a file. */
  isExecutable?: (path: string) => boolean;
}

function defaultIsExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where the factory shim lives for this `$HOME` (undefined when HOME is unset). */
export function factoryShimPath(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const home = env.HOME?.trim();
  return home ? join(home, FACTORY_SHIM_RELATIVE_PATH) : undefined;
}

export function resolveFactoryArcCli(probes: FactoryArcCliProbes = {}): FactoryArcCliResolution {
  const env = probes.env ?? process.env;
  const isExecutable = probes.isExecutable ?? defaultIsExecutable;

  const bin = env.ARC_BIN?.trim();
  if (bin) return { argv: [bin], source: "ARC_BIN" };

  const declared = env.ARC_CLI?.trim();
  if (declared) {
    if (isAbsolute(declared) && isExecutable(declared))
      return { argv: [declared], source: "ARC_CLI" };
    return {
      argv: null,
      source: "none",
      reason: `ARC_CLI=${declared} is not an executable absolute path (refused; PATH's arc is not used — agent-factory#20)`,
    };
  }

  const shim = factoryShimPath(env);
  if (shim && isExecutable(shim)) return { argv: [shim], source: "factory-shim" };

  return {
    argv: null,
    source: "none",
    reason:
      `no explicit factory arc CLI: ARC_BIN and ARC_CLI are unset and the factory shim ${shim ?? "$HOME/.arc-factory/bin/arc"} ` +
      "is not an executable file. PATH's arc is never used for the factory (agent-factory#20): " +
      "set ARC_BIN / ARC_CLI or install the factory shim",
  };
}
