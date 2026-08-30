#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import { claimLinkedIssues, extractLinkedIssueNumbers } from "./linked-issue-claim.ts";

const ok = (out = "") => ({ code: 0, out, ms: 0 });

describe("extractLinkedIssueNumbers", () => {
  it("accepts the three PR-body declarations from the claim contract", () => {
    expect(
      extractLinkedIssueNumbers("Part of #5471\n\nFixes #5409\nCloses #4057\nPart of #5471"),
    ).toEqual(["5471", "5409", "4057"]);
  });

  it("rejects bare mentions and bodies without a declaration", () => {
    expect(extractLinkedIssueNumbers("No linked work. See #5471 for context.")).toEqual([]);
    expect(extractLinkedIssueNumbers("")).toEqual([]);
  });
});

describe("claimLinkedIssues", () => {
  it("positive: Part of #N adds the processing label and a PR-pointing comment", () => {
    const calls: Array<{ cmd: string; input?: string }> = [];
    const runner = (cmd: string, _env = {}, input?: string) => {
      calls.push({ cmd, input });
      if (cmd.includes("/issues/5471 --jq")) return ok("false\n");
      if (cmd.includes("/issues/5471/comments")) return ok("");
      return ok("created");
    };

    expect(claimLinkedIssues("742", "Part of #5471\n", runner)).toEqual({
      issues: ["5471"],
      claimed: ["5471"],
      ok: true,
    });
    expect(calls.some(({ cmd }) => cmd.includes("/issues/5471/labels"))).toBe(true);
    const posted = calls.find(({ cmd }) => cmd.includes("-X POST") && cmd.includes("/comments"));
    expect(posted?.input).toContain("PR #742");
    expect(posted?.input).toContain("linked-issue-claim pr=742");
  });

  it("negative: a PR body without issue declarations produces no issue writes and no error", () => {
    const calls: string[] = [];
    const runner = (cmd: string) => {
      calls.push(cmd);
      throw new Error(`unexpected issue operation: ${cmd}`);
    };

    expect(claimLinkedIssues("742", "Improve verification diagnostics only.\n", runner)).toEqual({
      issues: [],
      claimed: [],
      ok: true,
    });
    expect(calls).toHaveLength(0);
  });

  it("is idempotent: a repeated run updates one marker comment and does not relabel", () => {
    const writes: string[] = [];
    let labelled = false;
    let commentId: string | undefined;
    const runner = (cmd: string, _env = {}, input?: string) => {
      if (cmd.includes("/issues/5471 --jq")) return ok(`${labelled}\n`);
      if (cmd.includes("/issues/5471/labels")) {
        labelled = true;
        writes.push("label");
        return ok();
      }
      if (cmd.includes("/issues/5471/comments") && cmd.includes("--jq")) {
        return ok(commentId ? `${commentId}\n` : "");
      }
      if (cmd.includes("-X POST") && cmd.includes("/comments")) {
        commentId = "991";
        writes.push(`post:${input}`);
        return ok();
      }
      if (cmd.includes("-X PATCH") && cmd.includes("comments/991")) {
        writes.push(`patch:${input}`);
        return ok();
      }
      throw new Error(`unexpected command: ${cmd}`);
    };

    expect(claimLinkedIssues("742", "Fixes #5471\n", runner).ok).toBe(true);
    expect(claimLinkedIssues("742", "Fixes #5471\n", runner).ok).toBe(true);
    expect(writes.filter((write) => write === "label")).toHaveLength(1);
    expect(writes.filter((write) => write.startsWith("post:"))).toHaveLength(1);
    expect(writes.filter((write) => write.startsWith("patch:"))).toHaveLength(1);
  });
});
