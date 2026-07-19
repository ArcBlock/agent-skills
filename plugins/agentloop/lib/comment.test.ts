#!/usr/bin/env bun
/**
 * Tests for the --comment delivery mechanism (issue #745). Hermetic: the `run`
 * dependency is injected, so no `gh` / network is touched.
 */
import { describe, expect, it } from "bun:test";
import {
  type CommentArgs,
  deliverComment,
  MARKER_PREFIX,
  parseCommentArgs,
  postComment,
  resolvePr,
  stickyBody,
} from "./comment.ts";

const MARKER = MARKER_PREFIX;
const SHA = "abc1234567890def";
const RESULT = "PASS" as const;

const ok = (out = "") => ({ code: 0, out, ms: 0 });
const fail = (out = "") => ({ code: 1, out, ms: 0 });

describe("parseCommentArgs", () => {
  it("is a no-op when the flag is absent", () => {
    expect(parseCommentArgs(["--json"])).toEqual({ post: false, pr: undefined, dryRun: false });
  });

  it("bare --comment posts with auto-detected PR", () => {
    expect(parseCommentArgs(["--comment"])).toEqual({ post: true, pr: undefined, dryRun: false });
  });

  it("--comment <pr#> takes the following numeric arg", () => {
    expect(parseCommentArgs(["--comment", "742"])).toEqual({
      post: true,
      pr: "742",
      dryRun: false,
    });
  });

  it("--comment=<pr#> parses the inline value", () => {
    expect(parseCommentArgs(["--comment=742"])).toEqual({ post: true, pr: "742", dryRun: false });
  });

  it("does not swallow a non-numeric following arg", () => {
    expect(parseCommentArgs(["--comment", "--json"])).toEqual({
      post: true,
      pr: undefined,
      dryRun: false,
    });
  });

  it("--comment-dry-run sets dryRun", () => {
    expect(parseCommentArgs(["--comment-dry-run", "9"])).toEqual({
      post: true,
      pr: "9",
      dryRun: true,
    });
  });

  it("--dry-run is a canonical alias of --comment-dry-run", () => {
    expect(parseCommentArgs(["--dry-run", "9"])).toEqual({ post: true, pr: "9", dryRun: true });
    expect(parseCommentArgs(["--dry-run"])).toEqual({ post: true, pr: undefined, dryRun: true });
    expect(parseCommentArgs(["--dry-run=742"])).toEqual({ post: true, pr: "742", dryRun: true });
  });
});

describe("stickyBody", () => {
  it("prepends the upsert marker with sha and result", () => {
    const b = stickyBody("## Report\nok", SHA, RESULT);
    expect(b.startsWith(MARKER)).toBe(true);
    expect(b).toContain(`sha=${SHA}`);
    expect(b).toContain("result=PASS");
    expect(b).toContain("## Report");
  });
});

describe("resolvePr", () => {
  it("returns the explicit value without calling gh", () => {
    let called = false;
    const spy = () => {
      called = true;
      return ok("");
    };
    expect(resolvePr("742", spy)).toBe("742");
    expect(called).toBe(false);
  });

  it("auto-detects the current branch PR when no explicit value", () => {
    expect(resolvePr(undefined, () => ok("742\n"))).toBe("742");
  });

  it("returns undefined when no PR is found", () => {
    expect(resolvePr(undefined, () => fail(""))).toBeUndefined();
  });
});

describe("postComment", () => {
  it("POSTs a new comment when no marker comment exists", () => {
    const cmds: string[] = [];
    const runner = (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("--jq")) return ok(""); // no existing marker comment
      return ok("created");
    };
    expect(postComment("742", "## Report", SHA, RESULT, runner)).toEqual({
      ok: true,
      out: "created",
    });
    expect(cmds.some((c) => c.includes("-X POST"))).toBe(true);
    expect(cmds.some((c) => c.includes("-X PATCH"))).toBe(false);
  });

  it("PATCHes the existing marker comment (upsert, no spam)", () => {
    const cmds: string[] = [];
    const runner = (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("--jq")) return ok("123456\n"); // existing comment id
      return ok("updated");
    };
    expect(postComment("742", "## Report", SHA, RESULT, runner)).toEqual({
      ok: true,
      out: "updated",
    });
    expect(cmds.some((c) => c.includes("-X PATCH") && c.includes("comments/123456"))).toBe(true);
    expect(cmds.some((c) => c.includes("-X POST"))).toBe(false);
  });

  it("upsert query uses `test` (not `startswith`) so a marker embedded mid-body is still found (#1246)", () => {
    // Regression: a reviewer hand-wrote `> 🤖 AI Agent PR Review ...\n\n<!-- verification-report ... -->`,
    // pushing the marker off line 1. `startswith` missed it and a duplicate comment got posted.
    const cmds: string[] = [];
    const runner = (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("--jq")) return ok("999\n");
      return ok("updated");
    };
    expect(postComment("742", "## Report", SHA, RESULT, runner)).toEqual({
      ok: true,
      out: "updated",
    });
    const jqCmd = cmds.find((c) => c.includes("--jq"));
    expect(jqCmd).toContain("test(");
    expect(jqCmd).not.toContain("startswith(");
    expect(cmds.some((c) => c.includes("-X PATCH") && c.includes("comments/999"))).toBe(true);
  });

  it("surfaces the raw gh output on failure (e.g. a proxy rejection reason)", () => {
    const runner = (cmd: string) =>
      cmd.includes("--jq")
        ? ok("")
        : fail('{"message":"Request body exhausted the comment-filter work budget."}');
    const res = postComment("742", "## Report", SHA, RESULT, runner);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("comment-filter work budget");
  });

  it("falls back to POST (not a bogus PATCH) when the lookup call itself fails, e.g. rate-limited (#1592)", () => {
    // Regression: when the `--jq` lookup call is rate-limited, `gh api` exits non-zero
    // and prints an error message on stdout/stderr. The old code never checked the
    // lookup's exit code, so that error text was trimmed and treated as a real comment
    // id, producing a PATCH against a garbage id instead of falling back to POST.
    const cmds: string[] = [];
    const runner = (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("--jq")) {
        return fail("gh: API rate limit exceeded for installation ID 12345678.");
      }
      return ok("created");
    };
    const res = postComment("742", "## Report", SHA, RESULT, runner);
    expect(res).toEqual({ ok: true, out: "created" });
    expect(cmds.some((c) => c.includes("-X POST"))).toBe(true);
    expect(cmds.some((c) => c.includes("-X PATCH"))).toBe(false);
  });

  it("falls back to POST when the lookup succeeds but returns a non-numeric value", () => {
    // Defense in depth: even if the lookup call exits 0, only trust a numeric id.
    const cmds: string[] = [];
    const runner = (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("--jq")) return ok("not-a-valid-id");
      return ok("created");
    };
    const res = postComment("742", "## Report", SHA, RESULT, runner);
    expect(res).toEqual({ ok: true, out: "created" });
    expect(cmds.some((c) => c.includes("-X POST"))).toBe(true);
    expect(cmds.some((c) => c.includes("-X PATCH"))).toBe(false);
  });

  it("retries once with the Full Logs section stripped on a comment-filter work-budget rejection (#1922)", () => {
    const reportWithLogs =
      "## Verification Report\n\n| Check | Result |\n|---|---|\n| Build | PASS |" +
      "\n\n### Full Logs\n\n<details><summary>Build — output</summary>\n\n```\nlots of build output here\n```\n</details>" +
      "\n\n<sub>Generated by the `verification` skill — numbers measured by the scripts, not hand-filled.</sub>";
    let postAttempts = 0;
    const postedBodies: string[] = [];
    const runner = (cmd: string, _env?: Record<string, string>, input?: string) => {
      if (cmd.includes("--jq")) return ok(""); // no existing marker comment
      if (!cmd.includes("gh api -X")) return ok(""); // e.g. resolveGhRepoEnv's `git remote` lookup
      postAttempts++;
      if (input) postedBodies.push(JSON.parse(input).body);
      // First attempt (full report, includes "Full Logs") is rejected; retry
      // with the section stripped succeeds.
      if (postAttempts === 1) {
        return fail('{"message":"Request body exhausted the comment-filter work budget."}');
      }
      return ok("created");
    };
    const res = postComment("742", reportWithLogs, SHA, RESULT, runner);
    expect(res).toEqual({ ok: true, out: "created" });
    expect(postAttempts).toBe(2);
    expect(postedBodies[0]).toContain("### Full Logs\n\n<details>");
    expect(postedBodies[1]).not.toContain("<details>");
    expect(postedBodies[1]).toContain("Omitted");
  });

  it("does NOT retry when the report has nothing to trim (avoids repeating an identical failing call)", () => {
    let postAttempts = 0;
    const runner = (cmd: string) => {
      if (cmd.includes("--jq")) return ok("");
      if (!cmd.includes("gh api -X")) return ok("");
      postAttempts++;
      return fail('{"message":"Request body exhausted the comment-filter work budget."}');
    };
    const res = postComment("742", "## Report", SHA, RESULT, runner);
    expect(res.ok).toBe(false);
    expect(postAttempts).toBe(1);
  });
});

describe("deliverComment", () => {
  const report = "## Verification Report\nPASS";

  it("no-ops when --comment absent (plain runs unchanged)", () => {
    let called = false;
    const res = deliverComment(
      { post: false, dryRun: false } as CommentArgs,
      report,
      SHA,
      RESULT,
      () => {
        called = true;
        return ok();
      },
    );
    expect(res.posted).toBe(false);
    expect(called).toBe(false);
  });

  it("dry-run resolves but does not POST/PATCH", () => {
    const cmds: string[] = [];
    const res = deliverComment(
      { post: true, pr: "742", dryRun: true },
      report,
      SHA,
      RESULT,
      (c) => {
        cmds.push(c);
        return ok();
      },
    );
    expect(res).toEqual({ posted: true, reason: "dry-run" });
    expect(cmds.some((c) => c.includes("-X POST") || c.includes("-X PATCH"))).toBe(false);
  });

  it("reports no-pr when the PR cannot be resolved", () => {
    const res = deliverComment(
      { post: true, pr: undefined, dryRun: false },
      report,
      SHA,
      RESULT,
      () => fail(),
    );
    expect(res).toEqual({ posted: false, reason: "no-pr" });
  });

  it("surfaces a post failure instead of passing silently", () => {
    const runner = (cmd: string) => (cmd.includes("--jq") ? ok("") : fail("boom"));
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      SHA,
      RESULT,
      runner,
    );
    expect(res).toEqual({ posted: false, reason: "post-failed" });
  });

  it("posts successfully with an explicit PR", () => {
    const runner = (cmd: string) => (cmd.includes("--jq") ? ok("") : ok("created"));
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      SHA,
      RESULT,
      runner,
    );
    expect(res).toEqual({ posted: true });
  });
});
