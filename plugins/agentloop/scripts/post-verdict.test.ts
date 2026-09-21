/**
 * post-verdict — the one call site pr-review Step 6 uses to upsert the
 * canonical verdict comment (arc#6404 / aside#1514).
 *
 * A jq `contains("<!-- pr-review-verdict -->")` in SKILL.md selected a comment
 * that only *quoted* the marker in a table cell and PATCHed it away. Prose
 * already said "don't paste the marker"; that did not stop the skill's own
 * example code from doing the same thing. The deliverable is this script
 * wrapping `postOnce`, plus tests that the skill no longer ships the unanchored
 * lookup.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERDICT_MARKER, VERDICT_MARKER_PREFIX } from "../lib/comment.ts";
import { parseArgs, postVerdict, verdictBodyOpensWithMarker } from "./post-verdict.ts";

const SCRIPT = fileURLToPath(new URL("./post-verdict.ts", import.meta.url));

const ok = (out = "") => ({ code: 0, out, ms: 0 });

const realVerdict = `${VERDICT_MARKER}
> 🤖 AI Agent PR Review @ host · runner:x · skill:pr-review

## 裁定：MERGE —— 针对 HEAD abcdef1
`;

const asideDemo = `> Demo that quoting the marker is not a verdict.

| # | marker | kind |
|---|---|---|
| 2 | \`${VERDICT_MARKER}\` | this verdict |
`;

describe("verdictBodyOpensWithMarker", () => {
  it("ACCEPT: first non-empty line is the marker", () => {
    expect(verdictBodyOpensWithMarker(realVerdict)).toBe(true);
  });

  it("REJECT: aside#1514 table quote is not a verdict body", () => {
    expect(verdictBodyOpensWithMarker(asideDemo)).toBe(false);
  });

  it("REJECT: identity header pushing the marker to line 2", () => {
    expect(verdictBodyOpensWithMarker(`> 🤖 AI Agent\n\n${VERDICT_MARKER}\nbody`)).toBe(false);
  });

  it("ACCEPT: MCP-escaped first line still counts", () => {
    const escaped = realVerdict.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(escaped.startsWith("<!--")).toBe(false);
    expect(verdictBodyOpensWithMarker(escaped)).toBe(true);
  });
});

describe("postVerdict", () => {
  it("refuses a quoted-only body without calling gh (would otherwise PATCH the demo)", () => {
    let called = false;
    const res = postVerdict("1514", asideDemo, () => {
      called = true;
      return ok("999");
    });
    expect(res.ok).toBe(false);
    expect(res.out).toMatch(/first non-empty line/);
    expect(called).toBe(false);
  });

  it("ACCEPT: PATCHes when the anchored lookup returns a numeric id", () => {
    const cmds: string[] = [];
    const res = postVerdict("1514", realVerdict, (cmd) => {
      cmds.push(cmd);
      if (cmd.includes("--jq")) return ok("42\n");
      return ok("updated");
    });
    expect(res).toEqual({ ok: true, out: "updated" });
    expect(cmds.some((c) => c.includes("-X PATCH") && c.includes("comments/42"))).toBe(true);
    expect(cmds.some((c) => c.includes("-X POST"))).toBe(false);
  });

  it("ACCEPT: POSTs when lookup is empty — quoted comments must not become the PATCH target", () => {
    const cmds: string[] = [];
    const res = postVerdict("1514", realVerdict, (cmd) => {
      cmds.push(cmd);
      if (cmd.includes("--jq")) return ok("");
      return ok("created");
    });
    expect(res).toEqual({ ok: true, out: "created" });
    expect(cmds.some((c) => c.includes("-X POST"))).toBe(true);
    expect(cmds.some((c) => c.includes("-X PATCH"))).toBe(false);
  });

  it("lookup command is first-line anchored test(), not contains()", () => {
    let jq = "";
    postVerdict("1514", realVerdict, (cmd) => {
      if (cmd.includes("--jq")) jq = cmd;
      return ok("");
    });
    expect(jq).toContain('split("\\n")');
    expect(jq).toContain(`test("^${VERDICT_MARKER_PREFIX}")`);
    expect(jq).not.toContain("contains(");
  });
});

describe("script is the engine wrapper, not a second lookup", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("calls postOnce with VERDICT_MARKER_PREFIX", () => {
    expect(src).toMatch(/postOnce\([\s\S]*VERDICT_MARKER_PREFIX/);
  });

  it("does not implement its own contains() lookup", () => {
    expect(code).not.toMatch(/contains\(/);
  });
});

describe("parseArgs", () => {
  it("ACCEPT: --pr and --body-file", () => {
    expect(parseArgs(["--pr", "1514", "--body-file", "draft.md"])).toEqual({
      ok: true,
      pr: "1514",
      bodyFile: "draft.md",
    });
  });

  it("REJECT: missing --pr", () => {
    expect(parseArgs(["--body-file", "draft.md"]).ok).toBe(false);
  });

  it("REJECT: non-numeric --pr (must not reach gh)", () => {
    expect(parseArgs(["--pr", "../etc", "--body-file", "draft.md"]).ok).toBe(false);
  });

  it("REJECT: missing --body-file", () => {
    expect(parseArgs(["--pr", "1"]).ok).toBe(false);
  });
});

describe("CLI", () => {
  const runCli = (
    args: string[],
    opts: { body?: string; pathEnv?: string } = {},
  ): { code: number; stdout: string; stderr: string } => {
    const dir = mkdtempSync(join(tmpdir(), "post-verdict-"));
    try {
      if (opts.body !== undefined) writeFileSync(join(dir, "draft.md"), opts.body);
      const p = Bun.spawnSync(["bun", SCRIPT, ...args], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: opts.pathEnv ?? process.env.PATH,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: p.exitCode ?? 1,
        stdout: p.stdout.toString("utf8"),
        stderr: p.stderr.toString("utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("usage: missing flags exits 64", () => {
    const r = runCli([]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/usage:/);
  });

  it("REJECT: quoted-only body exits 2 and never PATCHes", () => {
    const dir = mkdtempSync(join(tmpdir(), "post-verdict-gh-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash
echo "gh must not be called for a quoted-only body" >&2
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "draft.md"), asideDemo);
    try {
      const p = Bun.spawnSync(
        ["bun", SCRIPT, "--pr", "1514", "--body-file", join(dir, "draft.md")],
        {
          cwd: dir,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString("utf8")).toMatch(/first non-empty line/);
      expect(p.stderr.toString("utf8")).not.toMatch(/must not be called/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
