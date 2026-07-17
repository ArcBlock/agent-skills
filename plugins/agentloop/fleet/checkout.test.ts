#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import {
  type CheckoutPolicy,
  ensureCheckout,
  FLEET_MARKER,
  markerFor,
  type Sh,
} from "./checkout.ts";

/** record every shell command, return code 0 by default (or 1 for a command containing `fail`). */
function recorder(fail?: string): { sh: Sh; cmds: string[] } {
  const cmds: string[] = [];
  const sh: Sh = (cmd) => {
    cmds.push(cmd);
    return fail && cmd.includes(fail) ? { code: 1, out: "boom" } : { code: 0, out: "" };
  };
  return { sh, cmds };
}
const existsSet = (present: string[]) => (p: string) => present.includes(p);
const CLONE: CheckoutPolicy = { mode: "clone" };
const WT = (baseDir: string): CheckoutPolicy => ({ mode: "worktree", baseDir });

describe("ensureCheckout — clone mode", () => {
  it("clones (shallow, branch) + drops the marker when missing", () => {
    const { sh, cmds } = recorder();
    const r = ensureCheckout({
      path: "/co/x",
      slug: "o/x",
      branch: "main",
      cloneUrl: "git@h:o/x.git",
      policy: CLONE,
      exists: existsSet([]),
      sh,
    });
    expect(r).toEqual({ action: "cloned", ok: true });
    expect(cmds[0]).toBe("git clone --depth 1 --branch main git@h:o/x.git /co/x");
    // The marker is recorded BESIDE the tree — an in-tree one dirties git status forever
    // and arc's tools/pre-push.sh then refuses every push the sweep tries to make.
    expect(cmds[1]).toContain(markerFor("/co/x"));
    expect(cmds[1]).not.toContain(`/co/x/${FLEET_MARKER}`);
  });

  it("skips when missing and no cloneUrl", () => {
    const { sh } = recorder();
    const r = ensureCheckout({
      path: "/co/x",
      slug: "o/x",
      branch: "main",
      policy: CLONE,
      exists: existsSet([]),
      sh,
    });
    expect(r.ok).toBe(false);
    expect(r.action).toBe("skipped");
  });

  it("fetch+reset+clean when it is OUR checkout (marker present)", () => {
    const { sh, cmds } = recorder();
    const r = ensureCheckout({
      path: "/co/x",
      slug: "o/x",
      branch: "main",
      policy: CLONE,
      exists: existsSet(["/co/x/.git", `/co/x/${FLEET_MARKER}`]),
      sh,
    });
    expect(r).toEqual({ action: "reset", ok: true });
    expect(cmds.filter((c) => c.startsWith("git"))).toEqual([
      "git -C /co/x fetch --depth 1 origin main",
      "git -C /co/x checkout -q main",
      "git -C /co/x reset --hard origin/main",
      "git -C /co/x clean -fdq",
    ]);
  });
});

describe("ensureCheckout — worktree mode", () => {
  it("adds a detached worktree off the base clone (shared object store) + marker", () => {
    const { sh, cmds } = recorder();
    const r = ensureCheckout({
      path: "/fleet/ArcBlock__arc",
      slug: "ArcBlock/arc",
      branch: "main",
      policy: WT("/Users/me/Develop/arcblock"),
      exists: existsSet(["/Users/me/Develop/arcblock/arc/.git"]),
      sh,
    });
    expect(r).toEqual({ action: "worktree", ok: true });
    expect(cmds[0]).toBe("git -C /Users/me/Develop/arcblock/arc fetch --quiet origin main");
    expect(cmds[1]).toBe(
      "git -C /Users/me/Develop/arcblock/arc worktree add --detach --force /fleet/ArcBlock__arc origin/main",
    );
    expect(cmds[2]).toContain(markerFor("/fleet/ArcBlock__arc"));
    expect(cmds[2]).not.toContain(`/fleet/ArcBlock__arc/${FLEET_MARKER}`);
  });

  it("skips (helpfully) when the base clone doesn't exist", () => {
    const { sh } = recorder();
    const r = ensureCheckout({
      path: "/fleet/o__x",
      slug: "o/x",
      branch: "main",
      policy: WT("/base"),
      exists: existsSet([]),
      sh,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("base clone not found at /base/x");
  });

  it("resets an EXISTING our-worktree to the tip (no re-add)", () => {
    const { sh, cmds } = recorder();
    const r = ensureCheckout({
      path: "/fleet/o__x",
      slug: "o/x",
      branch: "main",
      policy: WT("/base"),
      exists: existsSet(["/base/x/.git", "/fleet/o__x/.git", `/fleet/o__x/${FLEET_MARKER}`]),
      sh,
    });
    expect(r).toEqual({ action: "reset", ok: true });
    expect(cmds).toContain("git -C /fleet/o__x reset --hard origin/main");
    expect(cmds.some((c) => c.includes("worktree add"))).toBe(false);
  });
});

describe("ensureCheckout — safety (both modes)", () => {
  it("REFUSES any git tree lacking the fleet marker (clone mode)", () => {
    const { sh, cmds } = recorder();
    const r = ensureCheckout({
      path: "/dev/arc",
      slug: "ArcBlock/arc",
      branch: "main",
      policy: CLONE,
      exists: existsSet(["/dev/arc/.git"]),
      sh,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("refusing to touch a non-fleet checkout");
    expect(cmds).toEqual([]);
  });

  it("REFUSES a foreign tree in worktree mode too", () => {
    const { sh, cmds } = recorder();
    const r = ensureCheckout({
      path: "/dev/arc",
      slug: "ArcBlock/arc",
      branch: "main",
      policy: WT("/base"),
      exists: existsSet(["/dev/arc/.git"]),
      sh,
    });
    expect(r.ok).toBe(false);
    expect(cmds).toEqual([]);
  });

  it("surfaces a failing step", () => {
    const { sh } = recorder("reset --hard");
    const r = ensureCheckout({
      path: "/co/x",
      slug: "o/x",
      branch: "main",
      policy: CLONE,
      exists: existsSet(["/co/x/.git", `/co/x/${FLEET_MARKER}`]),
      sh,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("reset --hard");
  });
});

describe("marker lives OUTSIDE the working tree (measured: an in-tree marker disarms the host repo's gates)", () => {
  it("puts the marker beside the checkout, never inside it", () => {
    expect(markerFor("/co/ArcBlock__arc")).toBe("/co/.agentloop-fleet-markers/ArcBlock__arc");
    expect(markerFor("/co/ArcBlock__arc/")).toBe("/co/.agentloop-fleet-markers/ArcBlock__arc");
  });

  it("NEVER writes anything into the tree — that is what dirtied git status and blocked every push", () => {
    const cmds: string[] = [];
    const sh: Sh = (c) => {
      cmds.push(c);
      return { code: 0, out: "" };
    };
    ensureCheckout({
      path: "/co/ArcBlock__arc",
      slug: "ArcBlock/arc",
      branch: "main",
      policy: { mode: "worktree", baseDir: "/dev" },
      exists: (p) => p === "/dev/arc/.git", // base exists; fleet tree does not yet
      sh,
    });
    // The old driver ran `touch /co/ArcBlock__arc/.agentloop-fleet` here. arc's
    // tools/pre-push.sh exits 1 on a dirty tree, so the sweep could never land its PR.
    expect(cmds.some((c) => /touch\s+\S*\/co\/ArcBlock__arc\/\.agentloop-fleet/.test(c))).toBe(
      false,
    );
    expect(cmds.some((c) => c.includes("/co/.agentloop-fleet-markers/ArcBlock__arc"))).toBe(true);
  });

  it("still recognizes a tree marked by an older driver, and heals it", () => {
    const cmds: string[] = [];
    const sh: Sh = (c) => {
      cmds.push(c);
      return { code: 0, out: "" };
    };
    const r = ensureCheckout({
      path: "/co/x",
      slug: "o/x",
      branch: "main",
      policy: { mode: "worktree", baseDir: "/dev" },
      // legacy in-tree marker only — must NOT be mistaken for a foreign tree
      exists: (p) => p === "/co/x/.git" || p === "/dev/x/.git" || p === "/co/x/.agentloop-fleet",
      sh,
    });
    expect(r.ok).toBe(true);
    expect(cmds.some((c) => c.includes("rm -f '/co/x/.agentloop-fleet'"))).toBe(true);
  });

  it("an unmarked foreign tree is still refused (the guard survives the move)", () => {
    const r = ensureCheckout({
      path: "/co/mine",
      slug: "o/x",
      branch: "main",
      policy: { mode: "worktree", baseDir: "/dev" },
      exists: (p) => p === "/co/mine/.git" || p === "/dev/x/.git",
      sh: () => ({ code: 0, out: "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/refusing to touch a non-fleet checkout/);
  });
});
