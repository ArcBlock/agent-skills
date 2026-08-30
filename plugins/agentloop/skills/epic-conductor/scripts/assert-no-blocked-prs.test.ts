/**
 * Conductor closeout exit gate (ArcBlock/arc#5595) — the ARTIFACT-side sibling of
 * `assert-no-live-children.test.ts`.
 *
 * Accept-path iron law is the spine of this file: this is a GATE, and "refuse
 * always" satisfies every reject test. Three ACCEPT arms therefore come first —
 * no PRs, PRs with no attribution claim, and (the load-bearing one) a PR whose
 * cited witness issue is now CLOSED. Without that last arm the gate would be a
 * permanent blocker and every reject test below would still be green.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyEpicPrs,
  type EpicPr,
  formatBlockingFailure,
  formatUnavailable,
  ghIssueState,
  ghListEpicPrs,
  ghReadEvidence,
  type IssueFact,
  isRepoSlug,
  LIST_LIMIT,
  main,
  PRECONDITION_LABEL,
  readWitness,
  readWitnessFromTexts,
  WITNESS_PRECISION_HEADLINE,
} from "./assert-no-blocked-prs.ts";

const SCRIPT = fileURLToPath(new URL("./assert-no-blocked-prs.ts", import.meta.url));
const SKILL = fileURLToPath(new URL("../SKILL.md", import.meta.url));

/** Verbatim shape of `renderAttributionSection()` (.claude/verify/attribution.ts). */
const ADMITTED = (issue: number): string =>
  [
    "## Verification",
    "",
    "| check | result |",
    "| --- | --- |",
    "| Tests | ❌ |",
    "",
    "### Attribution — foreign red (`PREEXISTING`)",
    "",
    "> ✅ **Overall verdict: PASS — and the red rows above are still red.**",
    "",
    "- **Class**: `PREEXISTING` — a red that is not this change's own.",
    `- **Blocked by**: #${issue} — verified to exist and be OPEN when this ran.`,
    "- **Machine-verified, both conditions, for every failure**:",
  ].join("\n");

/** Verbatim shape of `renderRefusalNotice()` for the `issue` precondition. */
const REFUSED_NAMING_ISSUE = (issue: number): string =>
  [
    "### Attribution — foreign red (`PREEXISTING`)",
    "",
    "> ⚠️ **Attribution was claimed and REFUSED.** ❌ attribution refused — precondition " +
      `\`issue\` (the witness issue exists and is open): issue #${issue} is not open (CLOSED)`,
  ].join("\n");

/** A refusal that never names a number — the gate must NOT guess. */
const REFUSED_NAMELESS = [
  "### Attribution — foreign red (`PREEXISTING`)",
  "",
  "> ⚠️ **Attribution was claimed and REFUSED.** ❌ attribution refused — precondition " +
    "`build` (this change touches no build input): packages/core/src/x.ts is a build input",
].join("\n");

/**
 * The sticky marker (`lib/comment.ts` MARKER_PREFIX) that identifies a comment as
 * the GATE'S OWN verification report. Only marker-bearing comments are evidence.
 */
const MARKER = "<!-- verification-report sha=deadbeef0 result=FAIL -->";

/** A real gate comment: the sticky verification report, marker and all. */
const MARKED = (body: string): string => `${MARKER}\n\n${body}`;

/**
 * The same report delivered through MCP, which HTML-escapes the marker
 * (`comment.ts:50-69`, #4283). Must still be recognised, or the filter becomes a
 * fail-open for every gh-less session.
 */
const MCP_MARKED = (body: string): string =>
  `${MARKER.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n\n${body}`;

const pr = (number: number, title = "some work"): EpicPr => ({
  number,
  title,
  url: `https://github.com/ArcBlock/arc/pull/${number}`,
});

const open = (): IssueFact => ({ available: true, exists: true, open: true, detail: "OPEN" });
const closed = (): IssueFact => ({ available: true, exists: true, open: false, detail: "CLOSED" });
const unreachable = (): IssueFact => ({ available: false, detail: "gh CLI not found on PATH" });

/* ------------------------------------------------------------------ *
 * 1. Evidence reading
 * ------------------------------------------------------------------ */

describe("readWitness — what the attribution evidence actually says", () => {
  test("ACCEPT: an admitted attribution section in a gate comment yields its witness", () => {
    expect(readWitness(MARKED(ADMITTED(5530)))).toEqual({ kind: "witness", issue: 5530 });
  });

  test("ACCEPT: an MCP-escaped marker is still the gate's own comment (#4283)", () => {
    // Without this the provenance filter would reject every report posted by a
    // gh-less session — a filter that rejects everything is its own fail-open,
    // because `none` would then be the answer for a real blocked PR.
    expect(readWitness(MCP_MARKED(ADMITTED(5530)))).toEqual({ kind: "witness", issue: 5530 });
  });

  test("ACCEPT: a cross-repo `owner/repo#123` reference still yields the number", () => {
    const text = MARKED(ADMITTED(1).replace("#1 —", "ArcBlock/arc#5530 —"));
    expect(readWitness(text)).toEqual({ kind: "witness", issue: 5530 });
  });

  test("ACCEPT: a refusal notice that names the issue yields it too", () => {
    expect(readWitness(MARKED(REFUSED_NAMING_ISSUE(5530)))).toEqual({
      kind: "witness",
      issue: 5530,
    });
  });

  test("ACCEPT: an ordinary comment carries no attribution evidence", () => {
    expect(readWitness("LGTM, merging after the gate. Related: #5530")).toEqual({ kind: "none" });
  });

  test("ACCEPT: a gate comment with no attribution section is no claim, not an error", () => {
    expect(readWitness(`${MARKER}\n\n## Verification\n\n| Tests | ✅ |`)).toEqual({ kind: "none" });
  });

  test("REJECT: an attribution section with NO marker is `unreadable`, never trusted", () => {
    // A flat-pasted section in an ordinary comment is not the gate's own output.
    const got = readWitness(ADMITTED(7002));
    expect(got.kind).toBe("unreadable");
    expect(JSON.stringify(got)).not.toMatch(/"issue":\s*\d/);
  });

  test("REJECT: evidence present but nameless is `unreadable`, never guessed", () => {
    const got = readWitness(MARKED(REFUSED_NAMELESS));
    expect(got.kind).toBe("unreadable");
    // It must not have latched onto any `#nnn`-shaped noise elsewhere in the text.
    expect(JSON.stringify(got)).not.toMatch(/"issue":\s*\d/);
  });

  test("REJECT: the fallback scan stops at the next heading, not the report tail", () => {
    // `### Full Logs` etc. follow the attribution section in a real report and are
    // full of `#nnn`-shaped noise. Grabbing one of those as the witness would
    // invent a fact.
    const withTail = MARKED(
      [REFUSED_NAMELESS, "", "### Full Logs", "", "- see issue #999 and #1234"].join("\n"),
    );
    const got = readWitness(withTail);
    expect(got.kind).toBe("unreadable");
    expect(JSON.stringify(got)).not.toMatch(/"issue":\s*\d/);
  });

  test("the newest gate comment wins over an older one", () => {
    const got = readWitnessFromTexts([
      "nothing here",
      MARKED(ADMITTED(1000)),
      MARKED(ADMITTED(2000)),
    ]);
    expect(got).toEqual({ kind: "witness", issue: 2000 });
  });

  test("ACCEPT: a PR with only ordinary comments reads as `none`", () => {
    expect(readWitnessFromTexts(["hi", "ship it"])).toEqual({ kind: "none" });
  });
});

/* ------------------------------------------------------------------ *
 * 1b. Evidence PROVENANCE. This script is the first consumer to read
 *     attribution evidence back out of GitHub text, so the channel is
 *     its own new attack surface — `attribution.ts` takes the witness
 *     from argv and never parses a comment.
 *
 *     The dangerous direction is fail-OPEN: an unauthenticated text
 *     flipping the gate from exit 1 to exit 0.
 * ------------------------------------------------------------------ */

describe("evidence provenance — an unsigned comment must not outrank the gate's own", () => {
  test("REJECT: a later flat-pasted section does NOT override the real evidence", () => {
    // Real report cites #7001; someone then re-posts an old section citing #7002.
    const got = readWitnessFromTexts([MARKED(ADMITTED(7001)), ADMITTED(7002)]);
    expect(got).toEqual({ kind: "witness", issue: 7001 });
  });

  test("fail-closed: an unsigned section with NO real evidence anywhere is `unreadable`", () => {
    // Never `none` — that would be the fail-open this whole rule exists to stop.
    const got = readWitnessFromTexts(["ship it", ADMITTED(7002)]);
    expect(got.kind).toBe("unreadable");
  });

  test("ACCEPT: real evidence alone still reads — the filter is not a blanket reject", () => {
    expect(readWitnessFromTexts(["ship it", MARKED(ADMITTED(7001))])).toEqual({
      kind: "witness",
      issue: 7001,
    });
  });

  test("a blockquoted paste was already inert, and stays inert", () => {
    const quoted = ADMITTED(7002)
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    expect(readWitnessFromTexts([MARKED(ADMITTED(7001)), quoted])).toEqual({
      kind: "witness",
      issue: 7001,
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2. Classification — ACCEPT arms first (the iron law)
 * ------------------------------------------------------------------ */

describe("classifyEpicPrs — ACCEPT arms (this gate must not be a permanent blocker)", () => {
  test("ACCEPT: an epic owning zero open PRs classifies nothing", () => {
    expect(classifyEpicPrs([], () => ({ kind: "none" }), open)).toEqual([]);
  });

  test("ACCEPT: an open PR with no attribution claim is `clear`", () => {
    const [v] = classifyEpicPrs([pr(1)], () => ({ kind: "none" }), open);
    expect(v?.kind).toBe("clear");
  });

  test("ACCEPT: an open PR whose witness issue is CLOSED is `released` — closeout allowed", () => {
    const [v] = classifyEpicPrs([pr(1)], () => ({ kind: "witness", issue: 5530 }), closed);
    expect(v?.kind).toBe("released");
    expect(v?.witness).toBe(5530);
    expect(v?.witnessState).toBe("CLOSED");
  });
});

describe("classifyEpicPrs — REJECT and fail-closed arms", () => {
  test("REJECT: an open PR whose witness issue is still OPEN blocks closeout", () => {
    const [v] = classifyEpicPrs([pr(5601)], () => ({ kind: "witness", issue: 5530 }), open);
    expect(v?.kind).toBe("blocking");
    expect(v?.witness).toBe(5530);
    expect(v?.witnessState).toBe("OPEN");
  });

  test("fail-closed: an unreachable witness issue is `unknown`, never `clear`", () => {
    const [v] = classifyEpicPrs([pr(1)], () => ({ kind: "witness", issue: 5530 }), unreachable);
    expect(v?.kind).toBe("unknown");
    expect(v?.precondition).toBe("issue");
  });

  test("fail-closed: a witness issue that does not exist is `unknown`, never `clear`", () => {
    const gone = (): IssueFact => ({ available: true, exists: false, detail: "no such issue" });
    const [v] = classifyEpicPrs([pr(1)], () => ({ kind: "witness", issue: 9 }), gone);
    expect(v?.kind).toBe("unknown");
    expect(v?.precondition).toBe("issue");
  });

  test("fail-closed: unreadable evidence is `unknown`, never `clear`", () => {
    const [v] = classifyEpicPrs([pr(1)], () => ({ kind: "unreadable", detail: "no number" }), open);
    expect(v?.kind).toBe("unknown");
    expect(v?.precondition).toBe("evidence");
  });

  test("fail-closed: evidence that could not be fetched is `unknown`, never `clear`", () => {
    const [v] = classifyEpicPrs(
      [pr(1)],
      () => ({ kind: "unavailable", detail: "gh pr view failed" }),
      open,
    );
    expect(v?.kind).toBe("unknown");
    expect(v?.precondition).toBe("evidence");
  });
});

/* ------------------------------------------------------------------ *
 * 3. The refusal must be overturnable at a glance (#5595 inherited weakness)
 * ------------------------------------------------------------------ */

describe("formatBlockingFailure — a limited-precision judgement must not sound certain", () => {
  const [blocking] = classifyEpicPrs(
    [pr(5601, "feat(core): thing")],
    () => ({ kind: "witness", issue: 5530 }),
    open,
  );
  const text = formatBlockingFailure(blocking ? [blocking] : [], 5560);

  test("names WHICH PR and WHICH witness issue, with the state it relied on", () => {
    expect(text).toContain("#5601");
    expect(text).toContain("#5530");
    expect(text).toMatch(/state=OPEN/);
  });

  test("states that the witness is human-supplied and only existence+openness is checked", () => {
    expect(text).toContain(WITNESS_PRECISION_HEADLINE);
    expect(text).toMatch(/human-supplied/i);
    expect(text).toMatch(/any open issue/i);
    expect(text).toMatch(/causal/i);
  });

  test("tells the reader how to overturn it, and never offers a bypass flag", () => {
    expect(text).toMatch(/read #5530/i);
    expect(text).not.toMatch(/--force|--skip|--no-verify|bypass this check/i);
  });
});

describe("formatUnavailable — a fail-closed refusal says WHICH precondition", () => {
  test("names the precondition and its human label", () => {
    const [v] = classifyEpicPrs([pr(7)], () => ({ kind: "witness", issue: 3 }), unreachable);
    const text = formatUnavailable(v ? [v] : [], 5560);
    expect(text).toContain("`issue`");
    expect(text).toContain(PRECONDITION_LABEL.issue);
    expect(text).toContain("gh CLI not found on PATH");
    expect(text).toMatch(/never/i);
  });
});

/* ------------------------------------------------------------------ *
 * 4. main() end-to-end over injected deps
 * ------------------------------------------------------------------ */

const deps = (over: Partial<Parameters<typeof main>[1]>): Parameters<typeof main>[1] => ({
  listPrs: () => ({ available: true, prs: [] }),
  readEvidence: () => ({ kind: "none" }),
  probeIssue: open,
  ...over,
});

describe("main — exit codes", () => {
  test("ACCEPT: exit 0 when the epic owns no open PR at all", () => {
    expect(main(["--epic", "5560"], deps({}))).toBe(0);
  });

  test("ACCEPT: exit 0 when open PRs carry no attribution claim", () => {
    const code = main(
      ["--epic", "5560"],
      deps({ listPrs: () => ({ available: true, prs: [pr(1), pr(2)] }) }),
    );
    expect(code).toBe(0);
  });

  test("ACCEPT: exit 0 when the only cited witness issue is CLOSED", () => {
    const code = main(
      ["--epic", "5560"],
      deps({
        listPrs: () => ({ available: true, prs: [pr(5601)] }),
        readEvidence: () => ({ kind: "witness", issue: 5530 }),
        probeIssue: closed,
      }),
    );
    expect(code).toBe(0);
  });

  test("REJECT: exit 1 when a cited witness issue is still OPEN", () => {
    const code = main(
      ["--epic", "5560"],
      deps({
        listPrs: () => ({ available: true, prs: [pr(5601)] }),
        readEvidence: () => ({ kind: "witness", issue: 5530 }),
        probeIssue: open,
      }),
    );
    expect(code).toBe(1);
  });

  test("fail-closed: exit 2 when the PR list itself cannot be read", () => {
    const code = main(
      ["--epic", "5560"],
      deps({ listPrs: () => ({ available: false, detail: "gh CLI not found on PATH" }) }),
    );
    expect(code).toBe(2);
  });

  test("usage: exit 2 with no --epic", () => {
    expect(main([], deps({}))).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * 4b. `--repo` reaches a shell. Adversarial layer found this one live:
 *     `--repo 'x/y; touch /tmp/PWNED'` created the file. Fail-closed on
 *     the VERDICT is not enough when the command already ran.
 * ------------------------------------------------------------------ */

describe("isRepoSlug — the only value that reaches the shell unquoted", () => {
  test("ACCEPT: ordinary owner/name slugs are admitted", () => {
    // Without these the gate could never target another repo and every
    // reject below would still pass.
    expect(isRepoSlug("ArcBlock/arc")).toBe(true);
    expect(isRepoSlug("AIGNE-io/afs")).toBe(true);
    expect(isRepoSlug("some.org/some.repo_1")).toBe(true);
  });

  test("REJECT: shell metacharacters, spaces, and non-slug shapes", () => {
    for (const bad of [
      "x/y; touch /tmp/PWNED",
      "x/y && id",
      "x/y`id`",
      "x/y$(id)",
      "x/y|id",
      "x/y\nid",
      "arc",
      "a/b/c",
      "",
      "-/-;",
    ]) {
      expect(isRepoSlug(bad)).toBe(false);
    }
  });

  test("REJECT: main() refuses a non-slug --repo before any shell runs", () => {
    const code = main(["--epic", "5560", "--repo", "x/y; touch /tmp/PWNED"], deps({}));
    expect(code).toBe(2);
  });

  test("ACCEPT: main() admits a well-formed --repo", () => {
    expect(main(["--epic", "5560", "--repo", "ArcBlock/arc"], deps({}))).toBe(0);
  });

  // The guard belongs at the SINK, not at one caller: the gh helpers are
  // exported, so a future caller that never goes through main() must still be
  // covered rather than relying on "remember to validate first".
  test("REJECT: the shell-building helper itself throws on a non-slug", () => {
    const runner = () => {
      throw new Error("the runner must never be reached");
    };
    expect(() => ghListEpicPrs(1, "x/y; id", runner)).toThrow(/slug/i);
    expect(() => ghIssueState("x/y; id", runner)(5)).toThrow(/slug/i);
    expect(() => ghReadEvidence("x/y; id", runner)(pr(1))).toThrow(/slug/i);
  });

  test("ACCEPT: the same helpers run normally for a real slug and for no repo", () => {
    const runner = (cmd: string) => ({ code: 0, out: cmd.includes("pr list") ? "[]" : "{}" });
    expect(ghListEpicPrs(1, "ArcBlock/arc", runner)).toEqual({ available: true, prs: [] });
    expect(ghListEpicPrs(1, undefined, runner)).toEqual({ available: true, prs: [] });
  });
});

/* ------------------------------------------------------------------ *
 * 5. CLI, over a real process boundary, with a stubbed `gh`
 * ------------------------------------------------------------------ */

const dirs: string[] = [];
function fakeGhDir(files: Record<string, string>): { bin: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), "blocked-prs-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const data = join(root, "data");
  mkdirSync(bin);
  mkdirSync(data);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(data, name), body);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "pr list") f="$FAKE_GH_DATA/pr-list.json" ;;',
      '  "pr view") f="$FAKE_GH_DATA/pr-$3.json" ;;',
      '  "issue view") f="$FAKE_GH_DATA/issue-$3.json" ;;',
      '  *) echo "gh: unexpected invocation: $*" >&2; exit 1 ;;',
      "esac",
      'if [ -f "$f" ]; then cat "$f"; else echo "gh: could not resolve to a resource" >&2; exit 1; fi',
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  return { bin, data };
}

function runCli(
  args: string[],
  files: Record<string, string>,
  opts: { noGh?: boolean } = {},
): { exitCode: number; stdout: string; stderr: string } {
  const { bin, data } = fakeGhDir(files);
  const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FAKE_GH_DATA: data,
      PATH: opts.noGh ? `${join(bin, "empty")}:/usr/bin:/bin` : `${bin}:/usr/bin:/bin`,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const prList = (numbers: number[]): string =>
  JSON.stringify(
    numbers.map((n) => ({
      number: n,
      title: `work ${n}`,
      url: `https://github.com/ArcBlock/arc/pull/${n}`,
    })),
  );

describe("CLI over a real `gh`-shaped boundary", () => {
  test("ACCEPT: no open epic PRs ⇒ exit 0", () => {
    const r = runCli(["--epic", "5560"], { "pr-list.json": "[]" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/ok:/);
  });

  test("ACCEPT: an open PR with no attribution comment ⇒ exit 0", () => {
    const r = runCli(["--epic", "5560"], {
      "pr-list.json": prList([5601]),
      "pr-5601.json": JSON.stringify({ number: 5601, body: "does a thing", comments: [] }),
    });
    expect(r.exitCode).toBe(0);
  });

  const blockedFixture = (state: string): Record<string, string> => ({
    "pr-list.json": prList([5601]),
    "pr-5601.json": JSON.stringify({
      number: 5601,
      body: "does a thing",
      comments: [{ body: MARKED(ADMITTED(5530)), createdAt: "2026-08-30T00:00:00Z" }],
    }),
    "issue-5530.json": JSON.stringify({ number: 5530, state }),
  });

  test("ACCEPT: witness issue CLOSED ⇒ exit 0 — the gate releases, it does not latch", () => {
    const r = runCli(["--epic", "5560"], blockedFixture("CLOSED"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("#5530");
    expect(r.stdout).toMatch(/CLOSED/);
  });

  test("REJECT: witness issue OPEN ⇒ exit 1, naming the PR and the witness", () => {
    const r = runCli(["--epic", "5560"], blockedFixture("OPEN"));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("#5601");
    expect(r.stderr).toContain("#5530");
    expect(r.stderr).toMatch(/state=OPEN/);
    expect(r.stderr).toContain(WITNESS_PRECISION_HEADLINE);
  });

  test("REASON: the refusal is caused by the witness state, not by a broken checker", () => {
    const refused = runCli(["--epic", "5560"], blockedFixture("OPEN"));
    const released = runCli(["--epic", "5560"], blockedFixture("CLOSED"));
    // Same fixture, one field flipped: 1 vs 0. A checker that is simply broken
    // cannot produce that difference.
    expect(refused.exitCode).toBe(1);
    expect(released.exitCode).toBe(0);
    // And the refusal is NOT the fail-closed branch wearing a reject costume.
    expect(refused.stderr).not.toMatch(
      /could not be checked|not found on PATH|unexpected invocation/,
    );
    expect(refused.exitCode).not.toBe(2);
  });

  test("fail-closed: `gh pr list` failing ⇒ exit 2 naming the `prs` precondition", () => {
    const r = runCli(["--epic", "5560"], {});
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("`prs`");
    expect(r.stderr).toContain(PRECONDITION_LABEL.prs);
  });

  test("fail-closed: a PR whose evidence cannot be fetched ⇒ exit 2 naming `evidence`", () => {
    const r = runCli(["--epic", "5560"], { "pr-list.json": prList([5601]) });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("`evidence`");
  });

  test("fail-closed: a cited witness issue that gh cannot resolve ⇒ exit 2 naming `issue`", () => {
    const r = runCli(["--epic", "5560"], {
      "pr-list.json": prList([5601]),
      "pr-5601.json": JSON.stringify({
        number: 5601,
        body: "",
        comments: [{ body: MARKED(ADMITTED(5530)), createdAt: "2026-08-30T00:00:00Z" }],
      }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("`issue`");
    expect(r.stderr).toContain("#5530");
  });

  test("REJECT (review exploit): a plain comment cannot flip the gate to exit 0", () => {
    // The exact fixture from the PR #5615 review: real evidence cites OPEN #7001,
    // and a later ordinary comment flat-pastes a section citing CLOSED #7002.
    // Before the provenance filter this returned exit 0.
    const r = runCli(["--epic", "5560"], {
      "pr-list.json": prList([5601]),
      "pr-5601.json": JSON.stringify({
        number: 5601,
        comments: [
          { body: MARKED(ADMITTED(7001)), createdAt: "2026-08-30T00:00:00Z" },
          {
            body: `FYI, quoting the last report:\n\n${ADMITTED(7002)}`,
            createdAt: "2026-08-30T01:00:00Z",
          },
        ],
      }),
      "issue-7001.json": JSON.stringify({ number: 7001, state: "OPEN" }),
      "issue-7002.json": JSON.stringify({ number: 7002, state: "CLOSED" }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("#7001");
    expect(r.stderr).not.toContain("#7002");
  });

  test("ACCEPT: the PR body is not evidence — only the gate's own comments are", () => {
    // An author pasting a section into the description must neither be believed
    // nor jam the gate; the real evidence in the comments decides.
    const r = runCli(["--epic", "5560"], {
      "pr-list.json": prList([5601]),
      "pr-5601.json": JSON.stringify({
        number: 5601,
        body: ADMITTED(7002),
        comments: [{ body: MARKED(ADMITTED(7001)), createdAt: "2026-08-30T00:00:00Z" }],
      }),
      "issue-7001.json": JSON.stringify({ number: 7001, state: "CLOSED" }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("#7001");
  });

  test("fail-closed: a truncated PR list is `unknown`, never a clear exit 0", () => {
    const many = Array.from({ length: LIST_LIMIT }, (_, i) => 6000 + i);
    const r = runCli(["--epic", "5560"], { "pr-list.json": prList(many) });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/truncat/i);
    expect(r.stderr).toContain("`prs`");
  });

  test("ADVERSARIAL: a `--repo` carrying a shell payload never executes it", () => {
    const canary = join(mkdtempSync(join(tmpdir(), "canary-")), "PWNED");
    dirs.push(canary);
    const r = runCli(["--epic", "5560", "--repo", `x/y; touch ${canary}`], {
      "pr-list.json": "[]",
    });
    expect(existsSync(canary)).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/repo/i);
  });

  const ghOnSystemPath = existsSync("/usr/bin/gh") || existsSync("/bin/gh");
  test.skipIf(ghOnSystemPath)(
    "fail-closed: no `gh` on PATH ⇒ exit 2 naming the `gh` precondition",
    () => {
      const r = runCli(["--epic", "5560"], { "pr-list.json": "[]" }, { noGh: true });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("`gh`");
      expect(r.stderr).toMatch(/gh CLI not found on PATH/);
    },
  );
});

/* ------------------------------------------------------------------ *
 * 6. The gate has to be INVOKED, not merely exist (#3142 host-gate discipline)
 * ------------------------------------------------------------------ */

describe("epic-conductor SKILL.md §9 wires the gate into Closeout", () => {
  const text = readFileSync(SKILL, "utf8");

  test("§9 Closeout invokes the script with --epic", () => {
    expect(text).toMatch(/assert-no-blocked-prs\.ts[\s\S]{0,160}--epic/);
  });

  test("it is stated as a HARD exit gate, exit 0 required", () => {
    expect(text).toMatch(/assert-no-blocked-prs[\s\S]{0,1200}[Ee]xit 0/);
  });

  test("the doc names the witness-precision weakness rather than hiding it", () => {
    expect(text).toMatch(/witness/i);
    expect(text).toMatch(/fail-closed/);
  });

  test("REJECT: the doc must not offer a bypass for this gate", () => {
    expect(text).not.toMatch(/skip assert-no-blocked-prs|assert-no-blocked-prs.*--force/i);
  });
});

process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
