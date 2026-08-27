#!/usr/bin/env bun
/**
 * Tests for the --comment delivery mechanism (issue #745). Hermetic: the `run`
 * dependency is injected, so no `gh` / network is touched.
 */
import { describe, expect, it } from "bun:test";
import {
  attributeShaToPr,
  type CommentArgs,
  decodeHtmlEntities,
  deliverComment,
  HTML_DECODE_JQ,
  MARKER_PREFIX,
  makeMarker,
  parseCommentArgs,
  postComment,
  readDeliveredSha,
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

describe("decodeHtmlEntities", () => {
  it("decodes the 5 basic HTML entities MCP escapes", () => {
    expect(decodeHtmlEntities("&lt;!-- marker --&gt;")).toBe("<!-- marker -->");
    expect(decodeHtmlEntities("a &amp; b")).toBe("a & b");
    expect(decodeHtmlEntities("&quot;q&quot; &#39;s&#39;")).toBe(`"q" 's'`);
  });

  it("is a no-op on already-unescaped text (the `gh`-posted case)", () => {
    const body = stickyBody("## Report\nok", SHA, RESULT);
    expect(decodeHtmlEntities(body)).toBe(body);
  });

  it("decodes &amp; last so a hypothetical double-escaped &amp;lt; isn't mangled", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
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

  it("upsert query still uses `test` (not `startswith`), now anchored to the first non-empty line (#1246, narrowed by #3576)", () => {
    // #1246's original accommodation (match the marker anywhere via substring `test()`,
    // to survive a hand-written header pushing it off line 1) was intentionally narrowed
    // by #3576: a comment that only *quotes* the marker in prose was getting matched and
    // overwritten. The lookup is still `test()` (not `startswith`), but now scoped to the
    // comment's first non-empty line — see the real jq-behavior tests below for the actual
    // match/no-match semantics against sample comment bodies.
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
    expect(jqCmd).toContain('split("\\n")'); // first-line extraction, not a bare substring scan
    expect(cmds.some((c) => c.includes("-X PATCH") && c.includes("comments/999"))).toBe(true);
  });

  describe("marker lookup jq filter (#3576, real jq execution — no gh/network)", () => {
    // Runs the ACTUAL filter `postOnce` sends to `gh api --jq`, via a real local `jq`
    // binary, against crafted comment bodies. This is deliberately not a command-string
    // shape assertion: it proves the match/no-match behavior the issue asked for.
    const runJqLookup = (bodies: string[]): string => {
      const firstLineTest =
        `(.body // "" | split("\\n") | map(select(length > 0)) | (.[0] // "") | ${HTML_DECODE_JQ}) | ` +
        `test("^${MARKER}")`;
      const filter = `[.[] | select(${firstLineTest})][-1].id // empty`;
      const comments = bodies.map((body, i) => ({ id: i + 1, body }));
      const proc = Bun.spawnSync(["jq", filter], {
        stdin: Buffer.from(JSON.stringify(comments)),
        stdout: "pipe",
      });
      return proc.stdout.toString("utf8").trim();
    };

    it("accept: matches when the marker opens the comment's first line (real generator output)", () => {
      const body = stickyBody("## Verification Report\nPASS", SHA, RESULT);
      expect(runJqLookup([body])).toBe("1");
    });

    it("reject: does NOT match a comment that only quotes the marker in prose (#3576's real incident)", () => {
      const body =
        `> 🤖 AI Agent PR Review @ host · runner:x\n\n` +
        `## Verdict: APPROVE\n\n` +
        `The verification-report marker (\`${MARKER} sha=abc result=PASS -->\`) is cache-only, ` +
        `so I re-ran it manually.\n`;
      expect(runJqLookup([body])).toBe("");
    });

    it("reject: does NOT match #1246's old accommodation (header pushes marker to line 2) — the narrowed trade-off", () => {
      const body = `> 🤖 AI Agent PR Review @ host · runner:x\n\n${MARKER} sha=abc result=PASS -->\nbody`;
      expect(runJqLookup([body])).toBe("");
    });

    it("picks the LAST matching comment id when several genuine reports exist (upsert targets the latest)", () => {
      const older = stickyBody("older report", "sha1", "FAIL");
      const newer = stickyBody("newer report", "sha2", "PASS");
      const unrelated = "just a normal human comment, no marker at all";
      expect(runJqLookup([older, unrelated, newer])).toBe("3");
    });

    it("accept: matches an MCP-escaped marker (#4283 — `<` posted as `&lt;` when `gh` is 403'd)", () => {
      const body = stickyBody("## Verification Report\nPASS", SHA, RESULT)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      expect(body.startsWith(MARKER)).toBe(false); // sanity: this really is escaped
      expect(runJqLookup([body])).toBe("1");
    });
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

/** A commit on another branch entirely — the #5060 incident's shape. */
const FOREIGN_SHA = "4edf808af4edf808af4edf808af4edf808af4edf";
const PR_BRANCH = "fix/1234-thing";

interface StubOpts {
  prHead?: string;
  prBranch?: string;
  /** `gh pr view --json headRefOid` fails (no gh, no auth, no such PR) */
  viewFails?: boolean;
  /** ordered pairs for which `git merge-base --is-ancestor a b` succeeds */
  ancestors?: Array<[string, string]>;
  currentBranch?: string;
  shaBranches?: string;
  postOk?: boolean;
  /** sha the read-back finds on the PR; `null` = the read-back call itself fails */
  deliveredSha?: string | null;
  cmds?: string[];
}

/**
 * A `gh`/`git` stub covering every call `deliverComment` makes: the #5060 attribution
 * query, the upsert lookup, the POST/PATCH, and the post-delivery read-back.
 */
function stub(o: StubOpts = {}) {
  return (cmd: string) => {
    o.cmds?.push(cmd);
    if (cmd.includes("gh pr view") && cmd.includes("headRefOid"))
      return o.viewFails
        ? fail("could not resolve to a PullRequest")
        : ok(
            JSON.stringify({
              headRefOid: o.prHead ?? SHA,
              headRefName: o.prBranch ?? PR_BRANCH,
            }),
          );
    if (cmd.startsWith("git branch --contains")) return ok(`${o.shaBranches ?? PR_BRANCH}\n`);
    if (cmd.startsWith("git merge-base --is-ancestor")) {
      const m = cmd.match(/--is-ancestor (\S+) (\S+)/);
      const pair = (o.ancestors ?? []).some(([a, b]) => a === m?.[1] && b === m?.[2]);
      return pair ? ok() : fail();
    }
    if (cmd.includes("git rev-parse --abbrev-ref HEAD"))
      return ok(`${o.currentBranch ?? PR_BRANCH}\n`);
    if (cmd.includes("git remote get-url")) return ok("git@github.com:ArcBlock/arc.git\n");
    if (cmd.includes("--jq") && cmd.includes(".body"))
      return o.deliveredSha === null
        ? fail()
        : ok(`${makeMarker(o.deliveredSha ?? SHA, RESULT)}\n`);
    if (cmd.includes("--jq")) return ok(""); // upsert lookup: no existing sticky
    if (cmd.includes("-X POST") || cmd.includes("-X PATCH"))
      return (o.postOk ?? true) ? ok("created") : fail("boom");
    return ok();
  };
}

describe("attributeShaToPr (#5060)", () => {
  it("classifies the PR's own head as head", () => {
    expect(attributeShaToPr("742", SHA, stub()).relation).toBe("head");
  });

  it("classifies an ancestor of the PR head as behind", () => {
    const older = "0000000000000000000000000000000000000001";
    const a = attributeShaToPr("742", older, stub({ ancestors: [[older, SHA]] }));
    expect(a.relation).toBe("behind");
    expect(a.prHead).toBe(SHA);
  });

  it("classifies a descendant of the PR head as ahead (pre-push delivers before the ref update)", () => {
    const newer = "0000000000000000000000000000000000000002";
    expect(attributeShaToPr("742", newer, stub({ ancestors: [[SHA, newer]] })).relation).toBe(
      "ahead",
    );
  });

  it("classifies a rebased sha on the PR's own branch as branch, not foreign", () => {
    expect(attributeShaToPr("742", FOREIGN_SHA, stub({ currentBranch: PR_BRANCH })).relation).toBe(
      "branch",
    );
  });

  it("classifies an unrelated branch's sha as foreign and names both sides", () => {
    const a = attributeShaToPr(
      "5049",
      FOREIGN_SHA,
      stub({
        currentBranch: "factory/5018-independent-substrate",
        shaBranches: "factory/5018-independent-substrate",
        prBranch: "fix/5049-thing",
      }),
    );
    expect(a.relation).toBe("foreign");
    expect(a.detail).toContain("factory/5018-independent-substrate");
    expect(a.detail).toContain("fix/5049-thing");
  });

  it("is unknown when the PR head cannot be read", () => {
    expect(attributeShaToPr("742", SHA, stub({ viewFails: true })).relation).toBe("unknown");
  });
});

describe("readDeliveredSha (#5060)", () => {
  it("returns the sha in the marker GitHub actually holds", () => {
    expect(readDeliveredSha("742", stub({ deliveredSha: FOREIGN_SHA }))).toBe(FOREIGN_SHA);
  });

  it("returns undefined when the comment cannot be read back", () => {
    expect(readDeliveredSha("742", stub({ deliveredSha: null }))).toBeUndefined();
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
      stub({ cmds }),
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
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      SHA,
      RESULT,
      stub({ postOk: false }),
    );
    expect(res).toEqual({ posted: false, reason: "post-failed" });
  });

  // ── #5060 acceptance ──────────────────────────────────────────────────────
  // Arm 1 and arm 3 are the ones that stop an over-tightening: "refuse every
  // delivery" satisfies every reject assertion and is worse than the bug.

  it("arm 1 (accept): the correct sha is delivered to its own PR", () => {
    const cmds: string[] = [];
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      SHA,
      RESULT,
      stub({ cmds }),
    );
    expect(res).toEqual({ posted: true });
    expect(cmds.some((c) => c.includes("-X POST") || c.includes("-X PATCH"))).toBe(true);
  });

  it("arm 1 (accept): a not-yet-pushed descendant still delivers — the pre-push hook runs before the ref update", () => {
    const newer = "0000000000000000000000000000000000000002";
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      newer,
      RESULT,
      stub({ ancestors: [[SHA, newer]], deliveredSha: newer }),
    );
    expect(res).toEqual({ posted: true });
  });

  it("arm 2 (reject): a sha from another branch is refused, naming both sides", () => {
    const cmds: string[] = [];
    const errs: string[] = [];
    const restore = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.join(" "));
    };
    try {
      const res = deliverComment(
        { post: true, pr: "5049", dryRun: false },
        report,
        FOREIGN_SHA,
        RESULT,
        stub({
          cmds,
          currentBranch: "factory/5018-independent-substrate",
          shaBranches: "factory/5018-independent-substrate",
          prBranch: "fix/5049-thing",
        }),
      );
      expect(res).toEqual({ posted: false, reason: "pr-sha-foreign" });
    } finally {
      console.error = restore;
    }
    // The sticky it would have destroyed was never touched.
    expect(cmds.some((c) => c.includes("-X POST") || c.includes("-X PATCH"))).toBe(false);
    const said = errs.join("\n");
    expect(said).toContain("factory/5018-independent-substrate");
    expect(said).toContain("fix/5049-thing");
  });

  it("arm 3 (third state): an older sha on the PR's own branch is delivered, marked NOT-HEAD", () => {
    const older = "0000000000000000000000000000000000000001";
    const bodies: string[] = [];
    const base = stub({ ancestors: [[older, SHA]], deliveredSha: older });
    const runner = (cmd: string, _env?: Record<string, string>, input?: string) => {
      if (input) bodies.push(input);
      return base(cmd);
    };
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      older,
      RESULT,
      runner,
    );
    expect(res).toEqual({ posted: true });
    const posted = JSON.parse(bodies.at(-1) as string).body as string;
    // Marker still owns line 1 — merge-gate.ts finds the sticky by startswith.
    expect(posted.split("\n")[0].startsWith(MARKER_PREFIX)).toBe(true);
    expect(posted).toContain("NOT THE PR HEAD");
    expect(posted).toContain(report);
  });

  it("refuses when attribution cannot be established rather than overwriting blind", () => {
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      SHA,
      RESULT,
      stub({ viewFails: true }),
    );
    expect(res).toEqual({ posted: false, reason: "pr-sha-unverified" });
  });

  it("read-back: a sticky overwritten by another runner is reported NOT delivered", () => {
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      SHA,
      RESULT,
      stub({ deliveredSha: FOREIGN_SHA }),
    );
    expect(res).toEqual({ posted: false, reason: "readback-mismatch" });
  });

  it("read-back: an unreadable read-back only warns — a flaky read must not unland a report", () => {
    const res = deliverComment(
      { post: true, pr: "742", dryRun: false },
      report,
      SHA,
      RESULT,
      stub({ deliveredSha: null }),
    );
    expect(res).toEqual({ posted: true });
  });
});
