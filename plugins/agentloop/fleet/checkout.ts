#!/usr/bin/env bun
/**
 * fleet checkout lifecycle — give each covered repo a fresh, ISOLATED working tree.
 *
 * Two modes:
 *   - worktree (preferred for a local/dev machine): reuse an EXISTING clone's object
 *     store via `git worktree add` — no duplicate clone, shares objects with your dev
 *     checkout, own isolated working dir. This is the `~/.arc-routines/wt` model.
 *   - clone (for cloud / ephemeral runners with no base clone): a fresh shallow clone.
 *
 * Safety in BOTH modes: we drop an `.agentloop-fleet` marker in trees WE create and
 * refuse to `reset --hard`/`clean` any tree that lacks it — a mis-pointed path can never
 * nuke your dev checkout. (In worktree mode the dev checkout is the *base*, never the
 * fleet tree, and git worktrees are isolated by design, so it is doubly safe.)
 */
export type Sh = (cmd: string) => { code: number; out: string };

export type CheckoutPolicy = { mode: "clone" } | { mode: "worktree"; baseDir: string }; // base clone per repo = <baseDir>/<repo-name>

export interface CheckoutResult {
  action: "cloned" | "worktree" | "reset" | "skipped";
  ok: boolean;
  detail?: string;
}

export const FLEET_MARKER = ".agentloop-fleet";

export interface EnsureOpts {
  /** the fleet working dir for this repo (e.g. <checkoutBase>/<owner>__<name>) */
  path: string;
  /** owner/name — used in worktree mode to locate the base clone */
  slug: string;
  branch: string;
  cloneUrl?: string;
  policy: CheckoutPolicy;
  /** existence probe (injected for tests); real caller passes fs.existsSync */
  exists: (p: string) => boolean;
  /** shell runner (injected for tests) */
  sh: Sh;
}

const repoName = (slug: string) => slug.split("/").pop() ?? slug;

function resetExisting(path: string, branch: string, sh: Sh): CheckoutResult {
  for (const c of [`git -C ${path} reset --hard origin/${branch}`, `git -C ${path} clean -fdq`]) {
    const r = sh(c);
    if (r.code !== 0)
      return { action: "reset", ok: false, detail: `\`${c}\` failed: ${r.out.trim()}` };
  }
  return { action: "reset", ok: true };
}

/**
 * Ensure `path` is a clean checkout of `origin/<branch>`. Returns what it did.
 * Existing OUR-marked trees are reset --hard + cleaned; foreign trees are refused.
 */
export function ensureCheckout(opts: EnsureOpts): CheckoutResult {
  const { path, slug, branch, cloneUrl, policy, exists, sh } = opts;
  const hasTree = exists(`${path}/.git`); // a worktree's .git is a FILE; existsSync sees both
  const isOurs = exists(`${path}/${FLEET_MARKER}`);

  if (hasTree && !isOurs) {
    return {
      action: "skipped",
      ok: false,
      detail: `${path} is a git tree without the ${FLEET_MARKER} marker — refusing to touch a non-fleet checkout`,
    };
  }

  if (policy.mode === "worktree") {
    const base = `${policy.baseDir.replace(/\/+$/, "")}/${repoName(slug)}`;
    if (!exists(`${base}/.git`)) {
      return {
        action: "skipped",
        ok: false,
        detail: `worktree mode: base clone not found at ${base} — clone it there, or use "mode":"clone"`,
      };
    }
    // Fetch into the SHARED object store (the base clone), then point the worktree at the tip.
    const f = sh(`git -C ${base} fetch --quiet origin ${branch}`);
    if (f.code !== 0)
      return { action: "worktree", ok: false, detail: `fetch failed: ${f.out.trim()}` };
    if (!hasTree) {
      // Detached at origin/branch — the sweep skills branch off (claude/issue-<N>); a
      // detached HEAD also sidesteps "branch already checked out in the base worktree".
      const w = sh(`git -C ${base} worktree add --detach --force ${path} origin/${branch}`);
      if (w.code !== 0)
        return { action: "worktree", ok: false, detail: `worktree add failed: ${w.out.trim()}` };
      sh(`touch ${path}/${FLEET_MARKER}`);
      return { action: "worktree", ok: true };
    }
    return resetExisting(path, branch, sh);
  }

  // clone mode
  if (!hasTree) {
    if (!cloneUrl)
      return { action: "skipped", ok: false, detail: `no checkout at ${path} and no cloneUrl` };
    const r = sh(`git clone --depth 1 --branch ${branch} ${cloneUrl} ${path}`);
    if (r.code !== 0) return { action: "cloned", ok: false, detail: r.out.trim() };
    sh(`touch ${path}/${FLEET_MARKER}`);
    return { action: "cloned", ok: true };
  }
  const f = sh(`git -C ${path} fetch --depth 1 origin ${branch}`);
  if (f.code !== 0) return { action: "reset", ok: false, detail: `fetch failed: ${f.out.trim()}` };
  sh(`git -C ${path} checkout -q ${branch}`);
  return resetExisting(path, branch, sh);
}
