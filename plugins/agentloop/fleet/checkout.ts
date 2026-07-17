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
 * Safety in BOTH modes: we record a marker for trees WE create and refuse to
 * `reset --hard`/`clean` any tree that lacks it — a mis-pointed path can never nuke your
 * dev checkout. The marker lives BESIDE the checkout, not inside it (see markerFor): an
 * in-tree marker dirties `git status` forever and thereby disarms the host repo's own
 * push/verify gates. (In worktree mode the dev checkout is the *base*, never the fleet
 * tree, and git worktrees are isolated by design, so it is doubly safe.)
 */
export type Sh = (cmd: string) => { code: number; out: string };

export type CheckoutPolicy = { mode: "clone" } | { mode: "worktree"; baseDir: string }; // base clone per repo = <baseDir>/<repo-name>

export interface CheckoutResult {
  action: "cloned" | "worktree" | "reset" | "skipped";
  ok: boolean;
  detail?: string;
}

/** Legacy in-tree marker name. Still RECOGNIZED (and cleaned up) — never created. */
export const FLEET_MARKER = ".agentloop-fleet";

/**
 * Where the "this driver created this tree" marker lives: **beside** the checkout, never
 * inside it — `<checkoutBase>/.agentloop-fleet-markers/<leaf>`.
 *
 * An in-tree marker is untracked and not gitignored, so it makes `git status` dirty
 * FOREVER, which silently disarms the host repo's own gates. Measured on arc during the
 * first live pre-flight: `tools/pre-push.sh` refuses to push a dirty tree, and
 * `pre-pr.ts` only writes its `.verify/<sha>.md` cache when the tree is clean — so a
 * sweep could triage, fix, verify, and then be unable to land the PR it just produced.
 * The marker also could not survive its own housekeeping: `git clean -fdq` (which
 * resetExisting runs) deletes an untracked in-tree marker, after which the very next
 * round would see an unmarked tree and refuse to touch its own checkout.
 */
export const markerFor = (path: string): string => {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0
    ? `${p}.agentloop-fleet-marker`
    : `${p.slice(0, i)}/.agentloop-fleet-markers/${p.slice(i + 1)}`;
};

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
  // Accept the legacy in-tree marker so trees created by an older driver are still ours;
  // claim() then heals them by moving the marker out of the working tree.
  const isOurs = exists(markerFor(path)) || exists(`${path}/${FLEET_MARKER}`);

  const claim = () => {
    sh(`mkdir -p "$(dirname '${markerFor(path)}')" && touch '${markerFor(path)}'`);
    sh(`rm -f '${path}/${FLEET_MARKER}'`); // heal: an in-tree marker would dirty the tree
  };

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
      claim();
      return { action: "worktree", ok: true };
    }
    claim(); // also heals a legacy in-tree marker on an existing tree
    return resetExisting(path, branch, sh);
  }

  // clone mode
  if (!hasTree) {
    if (!cloneUrl)
      return { action: "skipped", ok: false, detail: `no checkout at ${path} and no cloneUrl` };
    const r = sh(`git clone --depth 1 --branch ${branch} ${cloneUrl} ${path}`);
    if (r.code !== 0) return { action: "cloned", ok: false, detail: r.out.trim() };
    claim();
    return { action: "cloned", ok: true };
  }
  const f = sh(`git -C ${path} fetch --depth 1 origin ${branch}`);
  if (f.code !== 0) return { action: "reset", ok: false, detail: `fetch failed: ${f.out.trim()}` };
  sh(`git -C ${path} checkout -q ${branch}`);
  claim();
  return resetExisting(path, branch, sh);
}
