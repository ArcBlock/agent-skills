#!/usr/bin/env bun
/**
 * record-change-set.sh — the skill step that puts a PR's head on the repo's
 * work ledger (ArcBlock/arc#6920, C1 of epic #6900).
 *
 * Two halves, both needed:
 *
 * 1. The script, run for real against a temp git repo with a fake `gh` and a
 *    fake ledger entry on PATH. It hands the entry the PR, the pushed head,
 *    the PR's base oid, the changed files (three-dot, no rename folding) and
 *    the member work when named; it waits a bounded time for GitHub to see the
 *    push; it retries a failing entry a bounded number of times; and when it
 *    finally fails it fails LOUDLY (non-zero + a named stop line) — a silent
 *    continue is the defect this issue exists to remove.
 *
 * 2. The positive control on the skills (#6920 acceptance 3): every
 *    PR-opening skill must invoke this script after `gh pr create` and at
 *    EVERY push site (enumerated from the skill text, not the first match),
 *    and say a non-zero exit stops the run. Deleting the step anywhere turns
 *    this red. The detector is proven able to see (accept on the real skills)
 *    and able to miss (reject on texts with a step cut out or a push site
 *    added) — otherwise "the step is there" and "the detector is blind" would
 *    be the same green.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "record-change-set.sh");
const PLUGIN = join(import.meta.dir, "..");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function sh(cwd: string, cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

interface World {
  root: string;
  repo: string;
  bin: string;
  log: string;
  /** fake-arc's own log (preflight-probe tests, arc#7081). */
  arcLog: string;
  head: string;
  /** The PR base branch tip GitHub reports (main moved after the branch point). */
  baseOid: string;
}

/**
 * origin with main; a feature branch with an add, a rename and a non-ASCII
 * path; then main moves on (a commit the branch does not have), so the PR's
 * baseRefOid is NOT the merge-base — a two-dot diff would list main's file.
 */
function world(): World {
  const root = mkdtempSync(join(tmpdir(), "record-cs-"));
  tmpDirs.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const log = join(root, "entry.log");
  const arcLog = join(root, "arc-entry.log");
  sh(root, ["git", "init", "-q", "--bare", "-b", "main", origin]);
  sh(root, ["git", "clone", "-q", origin, repo]);
  sh(repo, ["git", "config", "user.email", "t@example.invalid"]);
  sh(repo, ["git", "config", "user.name", "T"]);
  // Rename detection ON (git's default; pinned so a host config cannot hide
  // whether the script itself passes --no-renames).
  sh(repo, ["git", "config", "diff.renames", "true"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  writeFileSync(join(repo, "old-name.ts"), "export const a = 1;\n".repeat(20));
  sh(repo, ["git", "add", "-A"]);
  sh(repo, ["git", "commit", "-q", "-m", "seed"]);
  sh(repo, ["git", "push", "-q", "origin", "main"]);
  sh(repo, ["git", "checkout", "-q", "-b", "feat/x"]);
  sh(repo, ["mkdir", "-p", "src/deep dir"]);
  writeFileSync(join(repo, "src/deep dir/变更.ts"), "export {};\n");
  writeFileSync(join(repo, "src/a.ts"), "export {};\n");
  sh(repo, ["git", "mv", "old-name.ts", "new-name.ts"]);
  sh(repo, ["git", "add", "-A"]);
  sh(repo, ["git", "commit", "-q", "-m", "change"]);
  const head = sh(repo, ["git", "rev-parse", "HEAD"]);
  // main moves on after the branch point.
  sh(repo, ["git", "checkout", "-q", "main"]);
  writeFileSync(join(repo, "main-only.ts"), "export {};\n");
  sh(repo, ["git", "add", "-A"]);
  sh(repo, ["git", "commit", "-q", "-m", "main moves"]);
  sh(repo, ["git", "push", "-q", "origin", "main"]);
  const baseOid = sh(repo, ["git", "rev-parse", "HEAD"]);
  sh(repo, ["git", "checkout", "-q", "feat/x"]);

  sh(root, ["mkdir", "-p", bin]);
  // Fake gh: answers `gh pr view [<pr>] --json <field> -q .<field>` from env.
  // FAKE_STALE_HEADS=n → the first n headRefOid answers are a stale sha
  // (GitHub not yet caught up with the push).
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -eu
[ "$1 $2" = "pr view" ] || { echo "fake gh: unexpected $*" >&2; exit 2; }
case "$*" in
  *headRefOid*)
    n=$(cat "${root}/head-calls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${root}/head-calls"
    if [ "$n" -le "\${FAKE_STALE_HEADS:-0}" ]; then echo "${"0".repeat(40)}"; else echo "\${FAKE_PR_HEAD}"; fi ;;
  *baseRefOid*) echo "\${FAKE_BASE_OID}" ;;
  *baseRefName*) echo "main" ;;
  *url*) echo "https://github.com/acme/widget/pull/42" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
`,
  );
  // Fake ledger entry: logs argv (the --files-from path as <FILE>, since it is a
  // temp file) + that file's content; the first FAKE_ENTRY_FAIL_TIMES calls exit 5.
  // A bare "-" value is logged as-is: the real CLI's yargs reads a separated
  // \`--files-from -\` as a stray positional ("Unknown command"), found by
  // running the step on #7072 — the list must travel as a file.
  writeFileSync(
    join(bin, "fake-ledger"),
    `#!/usr/bin/env bash
out=(); file=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--files-from" ] && [ "$a" != "-" ]; then file="$a"; out+=("<FILE>"); else out+=("$a"); fi
  prev="$a"
done
{ printf 'ARGV'; printf ' [%s]' "\${out[@]}"; printf '\\n'; [ -n "$file" ] && cat "$file"; } >> "${log}"
n=$(cat "${root}/entry-calls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${root}/entry-calls"
if [ "$n" -le "\${FAKE_ENTRY_FAIL_TIMES:-0}" ]; then echo "fake-ledger: transient failure" >&2; exit 5; fi
echo "fake-ledger: recorded"
`,
  );
  // Fake `arc`: exercises the rollout-order preflight (arc#7081). Every
  // shape below was measured against the REAL binaries (this worktree's
  // build, and ~/.arc/current/arc @ 2.0.0-beta.48 — see the PR body), not
  // guessed:
  //   --version                     -> a version string for the N/A message
  //   work changeset (bare, no --help, arc#7081 F2) -> the preflight probe.
  //                                     FAKE_ARC_SUPPORTS_CHANGESET=1 answers like a new
  //                                     arc ("Not enough non-option arguments", exit 5, no
  //                                     "Unknown command"); unset/0 answers like an arc that
  //                                     has "work" but not "work changeset" yet (pre-#7072
  //                                     main) — its own "Unknown command: \"work changeset\""
  //                                     verdict, exit 5. FAKE_ARC_HELP_CRASH=1 answers with an
  //                                     unrelated non-zero failure (no "Unknown command"), to
  //                                     prove that is NOT read as N/A. FAKE_ARC_ZERO_BUT_UNKNOWN=1
  //                                     answers "Unknown command" text but exit 0 — a probe that
  //                                     LOOKS like a hit by grep alone; the real detector must
  //                                     require rc!=0 too (F3, guards a grep-only mutant).
  //   FAKE_ARC_BETA48=1              -> the real 2.0.0-beta.48 shape (measured, arc#7081 F1):
  //                                     `--help` on ANY path (this predates #6384, commit
  //                                     9152d07ea / v2.0.0-beta.51) succeeds with the ROOT
  //                                     help — no "Unknown command" anywhere — so a probe
  //                                     that still used --help would misread this arc as
  //                                     "recognized" and never reach N/A (the bug the
  //                                     reviewer reproduced end-to-end with the real
  //                                     binary). The bare path (no --help) correctly fails
  //                                     "Unknown command: \"work\"", exit 5 — because on
  //                                     beta.48 not even `arc work` is a registered command.
  //   work changeset record ...     -> the real record, independent of the flags above;
  //                                     FAKE_ARC_RECORD_FAIL_TIMES makes the first N calls fail
  //                                     (e.g. "daemon down"), like fake-ledger's transient-failure knob.
  writeFileSync(
    join(bin, "fake-arc"),
    `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = "--version" ]; then
  if [ "\${FAKE_ARC_VERSION_FAIL:-0}" = "1" ]; then
    echo "fake-arc: --version not implemented on this old build" >&2
    exit 64
  fi
  echo "arc version 9.9.9 (fake)"
  exit 0
fi
# Real arc accepts its own global options (e.g. --instance/-i) BEFORE the
# subcommand path, both space-separated and --opt=value (verified against the
# real binary, arc#7081 Codex finding 2 + F4). Mirror both forms here so a
# test can declare an entry with a leading global option.
if [ "\${1:-}" = "--instance" ]; then shift 2; fi
if [ "\${1:-}" = "--standalone" ]; then shift 1; fi
case "\${1:-}" in
  --instance=*|--home=*|--view=*) shift 1 ;;
esac
if [ "\${FAKE_ARC_BETA48:-0}" = "1" ]; then
  is_help=0
  for a in "$@"; do [ "$a" = "--help" ] && is_help=1; done
  if [ "$is_help" = "1" ]; then
    echo "arc <command> [options] (fake root help — beta.48 shape, predates #6384)"
    exit 0
  fi
  if [ "\${1:-}" = "work" ]; then
    if [ "\${2:-}" = "changeset" ] && [ -z "\${3:-}" ]; then echo "PROBE" >> "${arcLog}"; fi
    echo "ERROR: Unknown command: \\"work\\"" >&2
    exit 5
  fi
fi
if [ "\${1:-}" = "work" ] && [ "\${2:-}" = "changeset" ] && [ -z "\${3:-}" ]; then
  # The bare preflight probe (arc#7081 F2 — no --help, see script header).
  echo "PROBE" >> "${arcLog}"
  if [ "\${FAKE_ARC_HELP_CRASH:-0}" = "1" ]; then
    echo "fake-arc: boom (unrelated crash)" >&2
    exit 3
  fi
  if [ "\${FAKE_ARC_ZERO_BUT_UNKNOWN:-0}" = "1" ]; then
    echo "Unknown command: \\"work changeset\\" (fake anomaly: exit 0 — F3)"
    exit 0
  fi
  if [ "\${FAKE_ARC_SUPPORTS_CHANGESET:-0}" = "1" ]; then
    echo "ERROR: Not enough non-option arguments: got 0, need at least 1" >&2
    exit 5
  fi
  echo "ERROR: Unknown command: \\"work changeset\\"" >&2
  exit 5
fi
if [ "\${1:-}" = "work" ] && [ "\${2:-}" = "changeset" ] && [ "\${3:-}" = "record" ]; then
  # An old arc that lacks the whole \`work changeset\` tree fails the SAME way
  # on the real record invocation as it does on the bare probe above (the
  # subcommand simply is not registered) — mirrored here so a test can prove
  # the preflight is what stands between an old arc and the retry loop, not
  # a coincidence of this fake's record branch always succeeding.
  if [ "\${FAKE_ARC_SUPPORTS_CHANGESET:-0}" != "1" ]; then
    echo "ERROR: Unknown command: \\"work changeset record\\"" >&2
    exit 5
  fi
  shift 3
  out=(); file=""; prev=""
  for a in "$@"; do
    if [ "$prev" = "--files-from" ] && [ "$a" != "-" ]; then file="$a"; out+=("<FILE>"); else out+=("$a"); fi
    prev="$a"
  done
  { printf 'ARGV'; printf ' [%s]' "\${out[@]}"; printf '\\n'; [ -n "$file" ] && cat "$file"; } >> "${arcLog}"
  n=$(cat "${root}/arc-entry-calls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${root}/arc-entry-calls"
  if [ "$n" -le "\${FAKE_ARC_RECORD_FAIL_TIMES:-0}" ]; then
    echo "fake-arc: daemon down" >&2
    exit 7
  fi
  echo "fake-arc: recorded"
  exit 0
fi
echo "fake-arc: unexpected args: $*" >&2
exit 2
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "fake-ledger"), 0o755);
  chmodSync(join(bin, "fake-arc"), 0o755);
  return { root, repo, bin, log, arcLog, head, baseOid };
}

function run(w: World, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: w.repo,
    env: {
      ...process.env,
      PATH: `${w.bin}:${process.env.PATH}`,
      FAKE_PR_HEAD: w.head,
      FAKE_BASE_OID: w.baseOid,
      RECORD_CS_POLL_S: "0.05",
      RECORD_CS_RETRY_SLEEP_S: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function entryLog(w: World): string {
  try {
    return readFileSync(w.log, "utf8");
  } catch {
    return "";
  }
}

const argvLines = (w: World) =>
  entryLog(w)
    .split("\n")
    .filter((l) => l.startsWith("ARGV"));

describe("record-change-set.sh — ACCEPT", () => {
  test("hands the entry the PR, the pushed head, the PR base oid and the changed files", () => {
    const w = world();
    const r = run(w, ["--entry", "fake-ledger --skip-outside-run"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("fake-ledger: recorded");
    expect(argvLines(w)).toEqual([
      `ARGV [--skip-outside-run] [--pr] [https://github.com/acme/widget/pull/42] [--head] [${w.head}] [--base] [${w.baseOid}] [--files-from] [<FILE>]`,
    ]);
    const files = entryLog(w)
      .split("\n")
      .filter((l) => l && !l.startsWith("ARGV"));
    // F5: a rename is two paths (--no-renames); F6: three-dot — main's own
    // commit after the branch point is not this PR's change.
    expect(files.sort()).toEqual(
      ["new-name.ts", "old-name.ts", "src/a.ts", "src/deep dir/变更.ts"].sort(),
    );
    expect(files).not.toContain("main-only.ts");
  });

  test("an explicit --pr is used as given; --work names the member work", () => {
    const w = world();
    const member = "did:uuid:2b3c4d5e-6b5a-4938-8271-605f4e3d2c1b";
    const r = run(w, [
      "--entry",
      "fake-ledger",
      "--pr",
      "https://github.com/acme/widget/pull/7",
      "--work",
      member,
    ]);
    expect(r.code).toBe(0);
    expect(argvLines(w)[0]).toContain("[--pr] [https://github.com/acme/widget/pull/7]");
    expect(argvLines(w)[0]).toContain(`[--work] [${member}]`);
  });

  test("F4: waits (bounded) for GitHub to see the push, then records", () => {
    const w = world();
    const r = run(w, ["--entry", "fake-ledger"], { FAKE_STALE_HEADS: "3" });
    expect(r.code).toBe(0);
    expect(argvLines(w)).toHaveLength(1);
    expect(Number(readFileSync(join(w.root, "head-calls"), "utf8"))).toBe(4);
  });

  test("F4: a transient ledger failure is retried (bounded); the same files go each time", () => {
    const w = world();
    const r = run(w, ["--entry", "fake-ledger"], { FAKE_ENTRY_FAIL_TIMES: "2" });
    expect(r.code).toBe(0);
    expect(argvLines(w)).toHaveLength(3);
    expect(entryLog(w).split("src/a.ts").length - 1).toBe(3);
    expect(r.err).toContain("retrying");
  });

  for (const [label, args] of [
    ["entry `none`", ["--entry", "none"]],
    ["empty entry (key present, no value)", ["--entry", ""]],
    ["no --entry at all (key missing from the profile)", []],
    ["an unsubstituted placeholder", ["--entry", "<change_set_record_entry>"]],
  ] as const) {
    test(`F10: ${label} → "not recorded", success, nothing called`, () => {
      const w = world();
      const r = run(w, [...args]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Change Set: not recorded");
      expect(entryLog(w)).toBe("");
    });
  }
});

describe("record-change-set.sh — REJECT (loud, named)", () => {
  test("a failing ledger entry fails after the bounded retries, with a STOP line", () => {
    const w = world();
    const r = run(w, ["--entry", "fake-ledger"], { FAKE_ENTRY_FAIL_TIMES: "99" });
    expect(r.code).toBe(5);
    expect(argvLines(w)).toHaveLength(3);
    expect(r.err).toContain("CHANGE SET NOT RECORDED");
    expect(r.err).toContain("stop");
  });

  test("local HEAD that never becomes the PR head → refused after the wait, entry never called", () => {
    const w = world();
    const r = run(w, ["--entry", "fake-ledger"], {
      FAKE_PR_HEAD: "f".repeat(40),
      RECORD_CS_HEAD_WAIT_S: "0.3",
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("is not the PR head");
    expect(entryLog(w)).toBe("");
  });

  test("F6: a PR base oid that cannot be fetched → a named failure, entry never called", () => {
    const w = world();
    const r = run(w, ["--entry", "fake-ledger"], { FAKE_BASE_OID: "e".repeat(40) });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("cannot fetch the PR base");
    expect(entryLog(w)).toBe("");
  });

  test("an unknown flag → usage error", () => {
    const w = world();
    const r = run(w, ["--bogus"]);
    expect(r.code).toBe(64);
  });
});

// ── rollout-order preflight (arc#7081) ──────────────────────────────────────
// C1 (#6920, PR #7072) made this step fail-closed: a real record failure now
// stops the run. That is correct EXCEPT when the installed `arc` predates
// `work changeset` entirely — every host that has not yet upgraded would then
// stop every land / epic-conductor run the moment agentloop ships the caller
// side. The preflight below must tell those two situations apart precisely.

function arcLog(w: World): string {
  try {
    return readFileSync(w.arcLog, "utf8");
  } catch {
    return "";
  }
}

const ARC_ENTRY = "fake-arc work changeset record --skip-outside-run";

describe("record-change-set.sh — preflight: old vs new arc (arc#7081)", () => {
  test("(a) old arc (lacks `work changeset`) → N/A, exit 0, the real record is never attempted", () => {
    const w = world();
    const r = run(w, ["--entry", ARC_ENTRY], { FAKE_ARC_SUPPORTS_CHANGESET: "0" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Change Set: not recorded");
    expect(r.out).toContain("N/A");
    expect(r.out).toContain("9.9.9"); // the installed version, read for the message
    expect(r.out).toContain("work changeset"); // names the lacking subcommand
    // positive control: the probe itself ran (not skipped en route to N/A)
    expect(arcLog(w)).toContain("PROBE");
    // the real record path (and GitHub) were never touched
    expect(arcLog(w)).not.toContain("ARGV");
    expect(existsSync(join(w.root, "head-calls"))).toBe(false);
  });

  test("(b) new arc (supports `work changeset`) → probe passes, real record proceeds and succeeds", () => {
    const w = world();
    const r = run(w, ["--entry", ARC_ENTRY], { FAKE_ARC_SUPPORTS_CHANGESET: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("fake-arc: recorded");
    expect(r.out).not.toContain("not recorded");
    expect(arcLog(w)).toContain("PROBE");
    expect(arcLog(w)).toContain("ARGV");
    expect(arcLog(w)).toContain("src/a.ts");
  });

  test("(c) new arc failing a REAL record (daemon down) stays fail-closed, not mistaken for N/A", () => {
    const w = world();
    const r = run(w, ["--entry", ARC_ENTRY], {
      FAKE_ARC_SUPPORTS_CHANGESET: "1",
      FAKE_ARC_RECORD_FAIL_TIMES: "99",
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("CHANGE SET NOT RECORDED");
    // the reason must not be conflated with the N/A path
    expect(r.out + r.err).not.toContain("N/A");
    expect(r.out + r.err).not.toContain("lacks");
  });

  test("probe failing for an unrelated reason (not the CLI's own 'Unknown command' verdict) is not read as N/A", () => {
    const w = world();
    // a NEW arc (supports the real command) whose --help probe happens to
    // crash for an unrelated reason — distinct from an old arc, where BOTH
    // --help and the real record fail with "Unknown command".
    const r = run(w, ["--entry", ARC_ENTRY], {
      FAKE_ARC_SUPPORTS_CHANGESET: "1",
      FAKE_ARC_HELP_CRASH: "1",
    });
    // the help probe crashed for a reason that is NOT "unknown subcommand", so
    // the script must fall through unchanged rather than guess N/A — and the
    // real record path (independent of the crashed probe) succeeds here.
    expect(r.code).toBe(0);
    expect(r.out).toContain("fake-arc: recorded");
    expect(r.out).not.toContain("N/A");
  });

  test("(d) arc missing entirely stays fail-closed — the existing default policy already treats a missing binary that way, and the preflight must not soften it", () => {
    const w = world();
    const r = run(w, ["--entry", "no-such-arc-binary work changeset record --skip-outside-run"]);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).not.toContain("N/A");
    expect(r.err).toContain("CHANGE SET NOT RECORDED");
  });

  // ── Codex review findings on PR #7143 (both reproduced against the real
  // script before this fix, confirmed red; see the PR thread) ────────────────

  test("(e) an old arc whose --version itself fails must still land on N/A, not a stop — version text is diagnostic only", () => {
    const w = world();
    const r = run(w, ["--entry", ARC_ENTRY], {
      FAKE_ARC_SUPPORTS_CHANGESET: "0",
      FAKE_ARC_VERSION_FAIL: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Change Set: not recorded");
    expect(r.out).toContain("N/A");
    expect(r.out).toContain("unknown version");
    expect(arcLog(w)).not.toContain("ARGV");
  });

  test("(f) a leading global option before the subcommand path (e.g. `arc --instance x work changeset record ...`) is still recognized — old arc still lands on N/A, not the full fail-closed retry loop", () => {
    const w = world();
    const r = run(
      w,
      ["--entry", "fake-arc --instance demo-instance work changeset record --skip-outside-run"],
      { FAKE_ARC_SUPPORTS_CHANGESET: "0" },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Change Set: not recorded");
    expect(r.out).toContain("N/A");
    expect(r.out).toContain("work changeset");
    // positive control: the probe ran, and the real record (which — mirroring
    // a genuinely old arc — would ALSO fail "Unknown command" and burn the
    // full 3-attempt retry loop before this fix — see the red/green note in
    // the PR) was never reached.
    expect(arcLog(w)).toContain("PROBE");
    expect(arcLog(w)).not.toContain("ARGV");
    expect(existsSync(join(w.root, "head-calls"))).toBe(false);
  });

  test("(f-twin) the same leading global option on a NEW arc still records for real (accept-path twin)", () => {
    const w = world();
    const r = run(
      w,
      ["--entry", "fake-arc --instance demo-instance work changeset record --skip-outside-run"],
      { FAKE_ARC_SUPPORTS_CHANGESET: "1" },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("fake-arc: recorded");
    expect(arcLog(w)).toContain("PROBE");
    expect(arcLog(w)).toContain("ARGV");
  });

  // ── independent review findings on PR #7143 (F1/F2/F3/F4) ─────────────────
  // F1 was a real correctness bug reproduced end-to-end against the actual
  // installed ~/.arc/current/arc @ 2.0.0-beta.48 (predates #6384, commit
  // 9152d07ea / v2.0.0-beta.51): `arc work changeset --help` prints the ROOT
  // help and exits 0 on that build, so a probe using --help reads
  // "recognized" and the run still ends in STOP on that exact host — the one
  // #7081 names. F2 fixes it: probe the bare path, no --help.

  test("F1/F2: a beta.48-shaped arc (whose --help wrongly succeeds with root help) still lands on N/A via the bare-path probe", () => {
    const w = world();
    const r = run(w, ["--entry", ARC_ENTRY], { FAKE_ARC_BETA48: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Change Set: not recorded");
    expect(r.out).toContain("N/A");
    expect(r.out).toContain("lacks work changeset");
    // positive control: the bare probe ran (not skipped), and neither the
    // real record nor GitHub were ever touched.
    expect(arcLog(w)).toContain("PROBE");
    expect(arcLog(w)).not.toContain("ARGV");
    expect(existsSync(join(w.root, "head-calls"))).toBe(false);
  });

  test('F3: a probe that exits 0 while its own text still contains "Unknown command" is NOT read as N/A (guards a grep-only mutant that drops the rc check)', () => {
    const w = world();
    const r = run(w, ["--entry", ARC_ENTRY], {
      FAKE_ARC_SUPPORTS_CHANGESET: "1",
      FAKE_ARC_ZERO_BUT_UNKNOWN: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("N/A");
    // the real record ran despite the probe's text matching "unknown command"
    expect(r.out).toContain("fake-arc: recorded");
    expect(arcLog(w)).toContain("PROBE");
    expect(arcLog(w)).toContain("ARGV");
  });

  test("F4: the --opt=value form of a leading global option is also recognized (old arc → N/A)", () => {
    const w = world();
    const r = run(
      w,
      ["--entry", "fake-arc --instance=demo-instance work changeset record --skip-outside-run"],
      { FAKE_ARC_SUPPORTS_CHANGESET: "0" },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Change Set: not recorded");
    expect(r.out).toContain("N/A");
    expect(arcLog(w)).toContain("PROBE");
    expect(arcLog(w)).not.toContain("ARGV");
  });

  test("F4-twin: --opt=value on a NEW arc still records for real (accept-path twin)", () => {
    const w = world();
    const r = run(
      w,
      ["--entry", "fake-arc --instance=demo-instance work changeset record --skip-outside-run"],
      { FAKE_ARC_SUPPORTS_CHANGESET: "1" },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("fake-arc: recorded");
    expect(arcLog(w)).toContain("PROBE");
    expect(arcLog(w)).toContain("ARGV");
  });

  test("F10 twins still hold: `none` / empty / placeholder entries skip the preflight too (never invoke a binary)", () => {
    const w = world();
    const r = run(w, ["--entry", "none"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Change Set: not recorded");
    expect(r.out).not.toContain("N/A");
  });

  test("too few positional tokens to form a probe (1 segment) skips the preflight, unaffected — same as the ACCEPT suite's fake-ledger entries", () => {
    const w = world();
    // "fake-ledger" alone has 1 positional token; the preflight requires >= 3
    // and must not fire, falling straight through to the unchanged fail-closed
    // record path (this is exactly what the ACCEPT suite above already relies
    // on — restated here as an explicit discrimination case).
    const r = run(w, ["--entry", "fake-ledger"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fake-ledger: recorded");
  });
});

// ── positive control on the skills (#6920 acceptance 3, F7) ─────────────────

/** The step every PR-opening skill must carry, verbatim modulo the profile key. */
const STEP = 'record-change-set.sh --entry "<change_set_record_entry>"';
/** Anything naming the step (the full command, or a back-reference to it). */
const MENTION = /record-change-set/;

/** Lines that talk about pushing to a PR branch (or rewriting it). */
const PUSH_WORD = /\bpush(es|ed)?\b|\brebase\b|推送/i;
/**
 * Lines matching PUSH_WORD that are NOT a push site — each with its reason.
 * Growing this list is a review-visible decision, not a silent escape.
 */
const NOT_A_PUSH_SITE: ReadonlyArray<[RegExp, string]> = [
  [/push 前|before push/i, "a precondition before pushing, not a push"],
  [/never pushes/i, "a read-only step that must not push"],
  [/after open \/ ready \/ push/i, "describes when bots post, not a push"],
  [/short-wait|short wait/i, "the bot wait window after a push, not a push"],
  [/sha churn|纯 sha churn/i, "round counting for reviews, not a push"],
  [/pushing a later unrelated commit cannot close/i, "thread-resolution rule, not a push"],
];

/** Every push-site line with no step mention in its list item / paragraph. */
export function unrecordedPushSites(skill: string): string[] {
  const lines = skill.split("\n");
  const blockOf = (i: number): string => {
    const isStart = (l: string) => /^\s*([-*]|\d+\.)\s/.test(l) || /^#/.test(l);
    let a = i;
    while (a > 0 && lines[a]!.trim() !== "" && !isStart(lines[a]!)) a--;
    let b = i + 1;
    while (b < lines.length && lines[b]!.trim() !== "" && !isStart(lines[b]!)) b++;
    return lines.slice(a, b).join("\n");
  };
  const missing: string[] = [];
  lines.forEach((line, i) => {
    if (!PUSH_WORD.test(line)) return;
    if (NOT_A_PUSH_SITE.some(([re]) => re.test(line))) return;
    if (!MENTION.test(blockOf(i))) missing.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return missing;
}

/** What the detector reads a skill for; `undefined` means "the step is there". */
export function changeSetStepProblem(skill: string): string | undefined {
  const at = skill.indexOf(STEP);
  if (at < 0) return "no record-change-set step";
  const created = skill.indexOf("gh pr create");
  if (created < 0 || created > at) return "record-change-set step is not after gh pr create";
  for (const line of skill.split("\n")) {
    if (line.includes("record-change-set.sh") && /\|\|\s*(true|:)\b|;\s*true\b/.test(line)) {
      return "record-change-set step swallows its failure";
    }
  }
  const near = skill.slice(at, at + 1200);
  if (!/non-zero|非零/i.test(near)) return "record-change-set step does not say a failure stops";
  const unrecorded = unrecordedPushSites(skill);
  if (unrecorded.length > 0) return `push site(s) without the step: ${unrecorded.join(" | ")}`;
  return undefined;
}

const PR_OPENING_SKILLS = ["skills/land/SKILL.md", "skills/epic-conductor/SKILL.md"];

describe("PR-opening skills record the Change Set at every push (positive control)", () => {
  test("ACCEPT: the detector sees the step and every push site in every PR-opening skill", () => {
    for (const rel of PR_OPENING_SKILLS) {
      const text = readFileSync(join(PLUGIN, rel), "utf8");
      expect(text.length).toBeGreaterThan(1000); // the file was really read
      expect({ rel, problem: changeSetStepProblem(text) }).toEqual({ rel, problem: undefined });
    }
  });

  test("ACCEPT: the push-site enumerator is not vacuous (it finds sites in the real skills)", () => {
    for (const rel of PR_OPENING_SKILLS) {
      const text = readFileSync(join(PLUGIN, rel), "utf8");
      const sites = text
        .split("\n")
        .filter((l) => PUSH_WORD.test(l) && !NOT_A_PUSH_SITE.some(([re]) => re.test(l)));
      expect(sites.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("REJECT: cutting the step out of a skill is seen (the detector is not blind)", () => {
    for (const rel of PR_OPENING_SKILLS) {
      const text = readFileSync(join(PLUGIN, rel), "utf8");
      const cut = text.split(STEP).join("true # removed");
      expect(changeSetStepProblem(cut)).toBe("no record-change-set step");
    }
  });

  test("REJECT: a later push site without the step is seen, not only the first occurrence", () => {
    for (const rel of PR_OPENING_SKILLS) {
      const text = readFileSync(join(PLUGIN, rel), "utf8");
      const added = `${text}\n\n- After rebasing on main, force-push the PR branch and re-run the gate.\n`;
      expect(changeSetStepProblem(added)).toMatch(/^push site\(s\) without the step: .*force-push/);
    }
  });

  test("REJECT: removing the step from one later push site is seen", () => {
    const text = readFileSync(join(PLUGIN, "skills/epic-conductor/SKILL.md"), "utf8");
    const fixerLine = text.split("\n").find((l) => l.startsWith("- The fixer:"))!;
    expect(fixerLine).toContain("record-change-set");
    const cut = text.replace(fixerLine, fixerLine.replace(/record-change-set[^;]*;/, ""));
    expect(changeSetStepProblem(cut)).toMatch(/^push site\(s\) without the step: .*The fixer/);
  });

  test("REJECT: a step that swallows its failure is not the step", () => {
    const swallowed = `gh pr create ...\n${STEP} --pr <url> || true\nafter every push; non-zero stops`;
    expect(changeSetStepProblem(swallowed)).toBe("record-change-set step swallows its failure");
    const unstated = `gh pr create ...\n${STEP} --pr <url>\n`;
    expect(changeSetStepProblem(unstated)).toBe(
      "record-change-set step does not say a failure stops",
    );
  });

  test("epic-conductor's step names the member work (F1)", () => {
    const text = readFileSync(join(PLUGIN, "skills/epic-conductor/SKILL.md"), "utf8");
    const at = text.indexOf(STEP);
    expect(text.slice(at, at + 200)).toContain("--work <member work DID>");
  });
});
