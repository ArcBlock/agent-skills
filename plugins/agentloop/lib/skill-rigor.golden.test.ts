#!/usr/bin/env bun
/**
 * Rigor golden — the few executable rules a skill's SKILL.md must keep (arc#7105, arc#7729).
 *
 * A reference file is only read "when X"; a rule that governs every run must stay in the
 * always-loaded SKILL.md. These assertions pin those rules to the SKILL.md text, so a diet that
 * moves a rule out of the body — or drops it — goes red here.
 *
 * Since #7729 the loop is: the changed package's tests, one clean-context review (P0–P2 fixed in
 * one batch, P3 → noted, not filed (issue-closure law: never close and leave tails); a correctness + security panel for auth / exec / secrets / sandbox),
 * PR, merge; a factory run stops at ready to merge (#7662) and the host merger merges (#8182). Patterns are loose on wording but
 * anchored on the load-bearing tokens.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN = join(import.meta.dir, "..");
const SKILLS = join(PLUGIN, "skills");
/** The one shared home of the headless Factory-run rule (arc#7617, arc#7662). */
const SHARED_HEADLESS = "reference/headless-factory-run.md";
const skill = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

interface Rule {
  id: string;
  /** every pattern must match the SKILL.md body */
  all: RegExp[];
}

const PACKAGE_TESTS: Rule = {
  id: "changed-package-tests",
  all: [/changed package's tests/i, /--filter <pkg> test/],
};
const SECURITY_PANEL: Rule = {
  id: "security-panel",
  all: [/`correctness` \+ `security`/, /reproduc\w+ the exploit/i],
};
/**
 * Issue-closure law (2026-10-10): a P3 is noted in the PR body, never filed; an issue closes only when
 * its outcome holds. The old "P3 → a follow-up issue" made every merge leave more issues behind.
 */
const P3_NOT_FILED: Rule = { id: "p3-noted-not-filed", all: [/P0–P2/, /P3 → noted, not filed/] };
const NO_TAILS: Rule = {
  id: "close-on-outcome-no-tails",
  all: [/issue-closure-discipline\.md/, /[Nn]ever close it and (file|leave)/],
};
const RECORD_CHANGE_SET: Rule = {
  id: "record-change-set-after-push",
  all: [/record-change-set\.sh --entry/, /no `\|\| true`/],
};

/** skill → rules its SKILL.md must carry */
export const RIGOR: Record<string, Rule[]> = {
  land: [
    PACKAGE_TESTS,
    SECURITY_PANEL,
    P3_NOT_FILED,
    NO_TAILS,
    RECORD_CHANGE_SET,
    {
      id: "factory-run-stops-at-ready-to-merge",
      all: [/ARC_CODE_AGENT_RUN_ID/, /ready to merge — host merger/],
    },
    { id: "review-by-a-different-agent", all: [/\*\*different\*\* subagent/] },
    { id: "one-batch", all: [/one batch/i] },
    { id: "merge-script", all: [/merge-verified-pr\.sh <PR#>/] },
    { id: "rebase-only-on-conflict", all: [/Rebase only when `mergeable=CONFLICTING`/] },
    { id: "epic-managed-is-not-an-epic-signal", all: [/`epic-managed` is not a criterion/] },
    { id: "factory-pr-not-merged-unattended", all: [/factory run delivered/, /`ready-to-merge`/] },
    { id: "never-no-verify", all: [/never `--no-verify`/] },
  ],
  "epic-conductor": [
    PACKAGE_TESTS,
    SECURITY_PANEL,
    P3_NOT_FILED,
    NO_TAILS,
    RECORD_CHANGE_SET,
    {
      id: "factory-run-stops-at-ready-to-merge",
      all: [/ARC_CODE_AGENT_RUN_ID/, /ready to merge — host\s+merger/],
    },
    { id: "no-live-children", all: [/assert-no-live-children\.ts/] },
    { id: "member-did-not-epic", all: [/member DID, never the epic/] },
    { id: "labels-at-create", all: [/`epic-managed`/, /`agent:hold`/] },
    { id: "compact-before-fix", all: [/compact-findings\.ts/] },
    {
      id: "headless-no-background",
      all: [/ARC_CODE_AGENT_RUN_ID/, /tests in the foreground/i, /block-poll child/],
    },
    { id: "factory-child-pr-needs-ready-to-merge", all: [/`ready-to-merge`/] },
  ],
  "pr-review": [
    SECURITY_PANEL,
    { id: "never-merges", all: [/never merges/i] },
    { id: "runs-package-tests", all: [/changed package's tests/i] },
    { id: "p0-p2-block", all: [/P0–P2 block/] },
    P3_NOT_FILED,
    { id: "findings-in-own-diff", all: [/`merge-base\.\.head`/] },
    { id: "crashed-reviewer-not-a-pass", all: [/never a pass/] },
    { id: "verdict-marker-first-line", all: [/`<!-- pr-review-verdict -->`/, /`Verdict: /] },
    // agent-factory#157: the host merger reads only a never-edited canonical v1 MERGE, and any
    // later writer comment stales it.
    {
      id: "verdict-new-comment-not-patch",
      all: [/new\*\* comment per round, never a PATCH/, /lib\/verdict\.ts/],
    },
    { id: "nothing-after-merge", all: [/after a MERGE: a later comment stales it/] },
  ],
  "pr-sweep": [
    { id: "hold-never-merges", all: [/`agent:hold` never merges/] },
    { id: "epic-managed-skipped", all: [/Drop `epic-managed` PRs/] },
    { id: "red-tier-never-auto-merge", all: [/never auto-merge/] },
    { id: "change-request-is-not-approval", all: [/change request is not an approval/] },
    { id: "factory-pr-never-auto-merged", all: [/not a factory-run PR/, /host merger/] },
    // agent-factory#157: a writer comment after the canonical MERGE stales it; the sweep must
    // notice and re-post, or the MERGE is dead forever, silently.
    // #174 follow-up: the merger measures staleness from the OLDEST relied-on lens's MERGE
    // (judgeAdhocVerdicts `since = min(...)`), so the sweep must check each lens.
    {
      id: "stale-merge-is-needs-review-per-lens",
      all: [/at or after the latest canonical MERGE of any relied-on lens/],
    },
    { id: "stale-merge-reposted-per-lens", all: [/re-post the MERGE of each stale lens/] },
    { id: "keeper-notes-before-verdict", all: [/before the keeper's verdict/] },
    {
      id: "no-factory-runner-to-summary",
      all: [/needs a runner with the factory"[^.]*run summary/],
    },
  ],
  "issue-review": [
    { id: "lock-acquire-release", all: [/`agent:processing`/, /acquire/, /release/] },
    { id: "sweep-trace-machine-marker", all: [/<!-- sweep-trace:/] },
    { id: "silence-rule", all: [/对人类输入必须回应/] },
  ],
  "issue-sweep": [
    {
      id: "deterministic-branch-claim-check",
      all: [/claude\/issue-<N>/, /gh pr list --state open/],
    },
    { id: "marker-based-human-detection", all: [/machine marker/i, /sweep-trace/] },
    { id: "epic-managed-and-hold", all: [/`epic-managed`/, /`agent:hold`/] },
  ],
};

/** Returns the ids of rules whose patterns do not all match `text`. */
export function missingRules(text: string, rules: Rule[]): string[] {
  return rules.filter((r) => !r.all.every((re) => re.test(text))).map((r) => r.id);
}

describe("rigor golden: executable rules stay in SKILL.md (#7105, #7729)", () => {
  test("positive control: every pinned SKILL.md is really read and every rule list is non-empty", () => {
    const names = Object.keys(RIGOR);
    expect(names.length).toBe(6);
    for (const name of names) {
      expect({ name, bytes: skill(name).length > 2000 }).toEqual({ name, bytes: true });
      expect(RIGOR[name]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  for (const [name, rules] of Object.entries(RIGOR)) {
    test(`ACCEPT: ${name} SKILL.md carries every pinned rule`, () => {
      expect({ name, missing: missingRules(skill(name), rules) }).toEqual({ name, missing: [] });
    });
  }

  test("REJECT: a SKILL.md reduced to a pointer loses every rule (the matcher is not vacuous)", () => {
    const pointerOnly = "# x\n\nWhen merging, read reference/merge.md.\n";
    for (const [name, rules] of Object.entries(RIGOR)) {
      expect({ name, missing: missingRules(pointerOnly, rules).length }).toEqual({
        name,
        missing: rules.length,
      });
    }
  });

  test("shared headless rule (#7617, #7662): ONE reference file, and every consumer points at it", () => {
    const shared = readFileSync(join(PLUGIN, SHARED_HEADLESS), "utf8");
    expect(shared).toMatch(/ARC_CODE_AGENT_RUN_ID/);
    expect(shared).toMatch(/run_in_background/);
    expect(shared).toMatch(/\/dev\/code-agents\/<child>/);
    expect(shared).toMatch(/needs resume/);
    // the poll whitelists terminal statuses: a failed read / unknown status is an error,
    // never "settled"; it reads the real `arc --json afs read` envelope
    expect(shared).toMatch(/exited \| failed \| stopped \| safety-invalidated\)/);
    expect(shared).toMatch(/jq -er '\.data\.content\.status'/);
    expect(shared).toMatch(/\*\) echo "ERROR/);
    expect(shared).not.toMatch(/\[0\]'/); // the old first-match selector that read null as settled
    expect(shared).toMatch(/for _ in 1 2 3 4 5; do/);
    expect(shared).toMatch(/DEADLINE/);
    expect(shared).toMatch(/paused counts as live/);
    // merge authority in a Factory run: the rule, the hard refusal, the override, the stamp
    expect(shared).toMatch(/## Merge authority/);
    expect(shared).toMatch(/host merger/);
    expect(shared).not.toMatch(/human decision/);
    expect(shared).toMatch(/exit 3/);
    expect(shared).toMatch(/ARC_FACTORY_ALLOW_SELF_MERGE=1/);
    expect(shared).toMatch(/arc-factory-merge/);
    for (const name of ["epic-conductor", "land"]) {
      expect({ name, links: skill(name).includes(`../../${SHARED_HEADLESS}`) }).toEqual({
        name,
        links: true,
      });
    }
  });

  test("REJECT (#174 follow-up): pr-sweep no longer measures staleness from the LAST MERGE only", () => {
    // security MERGE -> writer note -> correctness MERGE: nothing is newer than the last MERGE,
    // yet the merger reads verdict-stale from the security MERGE. The last-MERGE wording misses it.
    expect(skill("pr-sweep")).not.toMatch(/newer than the last canonical MERGE/);
    const ref = readFileSync(join(SKILLS, "pr-review", "reference", "verdict-comment.md"), "utf8");
    expect(ref).toMatch(/security MERGE → writer note → correctness MERGE/);
    expect(ref).not.toMatch(/newer\s+than the last canonical MERGE/);
  });

  test("pr-review verdict reference (agent-factory#157): Step 6 links it, and it carries the lens and liveness rules", () => {
    expect(skill("pr-review")).toMatch(/\(reference\/verdict-comment\.md\)/);
    const ref = readFileSync(join(SKILLS, "pr-review", "reference", "verdict-comment.md"), "utf8");
    // a correctness MERGE never goes up over a non-MERGE security verdict on the same head
    expect(ref).toMatch(/non-MERGE `lens=security` verdict at the same head/);
    expect(ref).toMatch(/do not post a correctness MERGE/);
    // P3-only findings are a MERGE with the notes in its evidence (only MERGE arms the merger)
    expect(ref).toMatch(/P3-only[^\n]*`MERGE`/);
  });

  test("REJECT: deleting the lines that state a rule from the real SKILL.md is seen (mutation)", () => {
    // Drop every whole line carrying any of the rule's patterns (the way a diet would cut a
    // paragraph); the rule must then read as missing.
    let seen = 0;
    for (const [name, rules] of Object.entries(RIGOR)) {
      const text = skill(name);
      for (const rule of rules) {
        const mutated = text
          .split("\n")
          .filter((line) => !rule.all.some((re) => re.test(line)))
          .join("\n");
        expect({ name, id: rule.id, caught: missingRules(mutated, [rule]) }).toEqual({
          name,
          id: rule.id,
          caught: [rule.id],
        });
        seen++;
      }
    }
    expect(seen).toBeGreaterThanOrEqual(35);
  });
});

/**
 * Detects an unbounded whole-file `cat $var` or `Read` inside a shell `for` / `while` loop without
 * a byte/line bound (`head -c`, `head -n`, `sed -n`, `wc -c`, `stat`) in the loop body (arc#4321).
 */
export function unboundedLoopFileReadProblem(text: string): string | null {
  const loopRe = /\b(?:for\s+\w+\s+in\b[\s\S]*?|while\s+[^\n]+)\bdo\b([\s\S]*?)\bdone\b/g;
  for (const m of text.matchAll(loopRe)) {
    const body = m[1] ?? "";
    const hasUnboundedCat =
      /\bcat\s+["']?\$\{?\w+\}?["']?(?!\s*\|?\s*(?:head|sed)\b)/.test(body) ||
      /\bRead\b[^\n]*\b(?:unknown-size|entire file|all files)\b/i.test(body);
    const hasSizeGuard = /\b(?:head\s+-[cn]|sed\s+-n|wc\s+-[cl]|stat\s+-)\b/.test(body);
    if (hasUnboundedCat && !hasSizeGuard) {
      return `unbounded file read in loop without size/line guard: ${body.trim().slice(0, 80)}`;
    }
  }
  return null;
}

describe("skill authoring hygiene & context budget golden (#4321, #4323, #4328)", () => {
  test("ACCEPT: plugin AGENTS.md pins pressure-test rules and subagent file-reading context budget (#4321)", () => {
    const agentsMd = readFileSync(join(PLUGIN, "AGENTS.md"), "utf8");
    const rules: Rule[] = [
      { id: "real-violation-before-rule", all: [/先有具体失败再加规则/, /真实违规/] },
      {
        id: "quote-rationalization-and-golden",
        all: [/直接封死借口原文/, /skill-rigor\.golden\.test\.ts/],
      },
      {
        id: "description-trigger-only",
        all: [/`description` 只写触发条件/, /不.*把步骤摘要写进 `description`/],
      },
      {
        id: "subagent-file-read-context-budget",
        all: [/不在循环里无上限读未知大小文件/, /head -c/, /sed -n/],
      },
    ];
    expect(missingRules(agentsMd, rules)).toEqual([]);
  });

  test("ACCEPT: land frontmatter description states triggers only without step summary (#4321)", () => {
    const landText = skill("land");
    const fm = landText.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(fm).toMatch(/"finish this"/);
    expect(fm).not.toMatch(/implement\s*→\s*package tests\s*→/);
  });

  test("ACCEPT/REJECT: subagent file-reading context budget detector (#4321)", () => {
    const badSnippet = ["for f in docs/plans/*.md; do", '  cat "$f"', "done"].join("\n");
    expect(unboundedLoopFileReadProblem(badSnippet)).toMatch(/unbounded file read in loop/);

    const goodHeadSnippet = ["for f in docs/plans/*.md; do", '  head -c 4096 "$f"', "done"].join(
      "\n",
    );
    expect(unboundedLoopFileReadProblem(goodHeadSnippet)).toBeNull();

    const goodGuardSnippet = [
      "for f in docs/plans/*.md; do",
      '  [ "$(wc -c < "$f")" -le 8192 ] && cat "$f"',
      "done",
    ].join("\n");
    expect(unboundedLoopFileReadProblem(goodGuardSnippet)).toBeNull();

    for (const dir of readdirSync(SKILLS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const body = skill(dir.name);
      expect({ skill: dir.name, problem: unboundedLoopFileReadProblem(body) }).toEqual({
        skill: dir.name,
        problem: null,
      });
    }
    const fleetPromptsDir = join(PLUGIN, "fleet", "prompts");
    for (const entry of readdirSync(fleetPromptsDir)) {
      if (!entry.endsWith(".md")) continue;
      const body = readFileSync(join(fleetPromptsDir, entry), "utf8");
      expect({ prompt: entry, problem: unboundedLoopFileReadProblem(body) }).toEqual({
        prompt: entry,
        problem: null,
      });
    }
  });

  test("ACCEPT/REJECT: build-phases and land Stuck sections require root-cause trace before fix (#4323)", () => {
    const rootCauseRule: Rule = {
      id: "stuck-root-cause-before-fix",
      all: [/Stuck/i, /root cause/i, /input\s*→\s*state\s*→\s*failure site/],
    };
    for (const name of ["build-phases", "land"]) {
      const text = skill(name);
      expect({ name, missing: missingRules(text, [rootCauseRule]) }).toEqual({ name, missing: [] });
      const mutated = text
        .split("\n")
        .filter((line) => !/input\s*→\s*state\s*→\s*failure site/.test(line))
        .join("\n");
      expect({ name, caught: missingRules(mutated, [rootCauseRule]) }).toEqual({
        name,
        caught: ["stuck-root-cause-before-fix"],
      });
    }
  });

  test("ACCEPT: approved lesson-ledger read pointers stay in design-review, pr-review, epic-conductor, and land (#4328)", () => {
    const ledgerRule: Rule = {
      id: "approved-lesson-ledger-pointer",
      all: [/<lesson_ledger_dir>\/absorbed\.yaml/, /candidates\/pending\//],
    };
    for (const name of ["design-review", "pr-review", "epic-conductor", "land"]) {
      expect({ name, missing: missingRules(skill(name), [ledgerRule]) }).toEqual({
        name,
        missing: [],
      });
    }
    expect(skill("design-review")).toMatch(/\*\*Lessons read:\*\*/);
  });
});
