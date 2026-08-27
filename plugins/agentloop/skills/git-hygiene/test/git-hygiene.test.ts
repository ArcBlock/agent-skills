import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "git-hygiene.sh");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("inventory consumes the complete worktree porcelain stream under pipefail (arc#4920)", () => {
  const repo = mkdtempSync(join(tmpdir(), "git-hygiene-"));
  dirs.push(repo);
  const remote = mkdtempSync(join(tmpdir(), "git-hygiene-origin-"));
  dirs.push(remote);
  expect(spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]).status).toBe(
    0,
  );
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  expect(git(["init", "-q", "--initial-branch=main"]).status).toBe(0);
  expect(git(["config", "user.email", "test@example.invalid"]).status).toBe(0);
  expect(git(["config", "user.name", "Test"]).status).toBe(0);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  expect(git(["add", "README.md"]).status).toBe(0);
  expect(git(["commit", "-qm", "initial"]).status).toBe(0);
  expect(git(["remote", "add", "origin", remote]).status).toBe(0);
  expect(git(["push", "-qu", "origin", "main"]).status).toBe(0);
  // More than one row reproduces the old upstream-write-after-awk-exit shape.
  const peer = `${repo}-peer`;
  dirs.push(peer);
  expect(git(["worktree", "add", "-q", "-b", "peer", peer, "HEAD"]).status).toBe(0);

  // The original two-worktree fixture fits in the pipe buffer, so the old
  // early-exit awk can appear to pass. Wrap only `git worktree list --porcelain`
  // and append enough valid-looking rows to make a live producer hit SIGPIPE.
  // The marker makes the noise happen only for ROOT discovery: inventory's
  // actual worktree pass still sees the real, small fixture.
  const bin = mkdtempSync(join(tmpdir(), "git-hygiene-bin-"));
  dirs.push(bin);
  const marker = join(bin, "porcelain-noise-consumed");
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const wrapper = join(bin, "git");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
if [ "$1" = worktree ] && [ "$2" = list ] && [ "$3" = --porcelain ]; then
  "${realGit}" "$@"
  if [ ! -e "$GIT_HYGIENE_TEST_NOISE_MARKER" ]; then
    : > "$GIT_HYGIENE_TEST_NOISE_MARKER"
    i=0
    while [ "$i" -lt 5000 ]; do
      printf 'worktree /tmp/git-hygiene-noise-%s\\nHEAD %040d\\n\\n' "$i" "$i"
      i=$((i + 1))
    done
  fi
else
  exec "${realGit}" "$@"
fi
`,
  );
  chmodSync(wrapper, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GIT_HYGIENE_TEST_NOISE_MARKER: marker,
  };

  const legacy = spawnSync(
    "bash",
    [
      "-o",
      "pipefail",
      "-c",
      "git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}'",
    ],
    { cwd: repo, encoding: "utf8", env, maxBuffer: 16 << 20 },
  );
  expect(legacy.status).toBe(141);

  rmSync(marker);
  const result = spawnSync("bash", [SCRIPT, "inventory", repo], {
    encoding: "utf8",
    env,
    maxBuffer: 16 << 20,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("=== worktrees ===");
  expect(result.stdout).toContain(repo);
  expect(result.stdout).toContain(peer);
  // The primary-worktree skip must not make `set -e` abort on the next
  // linked-worktree row.  Reaching the terminal inventory marker proves the
  // classifier consumed the whole real stream, rather than only listing it.
  expect(result.stdout).toContain("=== SAFE worktrees (eligible for remove) ===");
  expect(result.stdout).toContain("Done inventory.");
});
