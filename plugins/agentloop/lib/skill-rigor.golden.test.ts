#!/usr/bin/env bun
/**
 * Rigor golden — the executable rules a skill's SKILL.md must keep (arc#7105).
 *
 * The token diet (#7105) moves incident narrative, playbooks and FAQ out of SKILL.md
 * into on-demand `reference/*.md`. A reference file is only read "when X"; a rule that
 * governs every run must therefore stay in SKILL.md itself. These assertions pin those
 * rules to the SKILL.md text (never to a reference file), so a diet that moves a rule
 * out of the always-loaded body — or drops it — goes red here.
 *
 * Sources of the list: the task brief for #7105 (independent review before gate,
 * batched fixes + one gate, reviewers never run merge-gate, only the merger runs
 * merge-gate right before merge-verified-pr.sh, no pre-merge in the PR loop, ≤2 heavy
 * gates, bot-clean before merge, flaky red ⇒ root cause or --blocked-by, accept-path /
 * positive-control / mutation-check laws, security panel) and the P2 "section C"
 * must-keep table of PR #7111 (≤3 review rounds, compact-findings before any fixer,
 * catch-net independence; record-change-set and assert-no-live-children are pinned by
 * their own tests next to those scripts).
 *
 * Patterns are deliberately loose on wording (a rule may be re-phrased) but anchored on
 * the load-bearing tokens (script names, "only the merger", "2", "--blocked-by", …).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN = join(import.meta.dir, "..");
const SKILLS = join(PLUGIN, "skills");
/** The one shared home of the bot / inline review receipt protocol (was epic-conductor §6). */
const SHARED_PROTOCOL = "reference/review-receipt-protocol.md";
/** The one shared home of the headless Factory-run rule (arc#7617). */
const SHARED_HEADLESS = "reference/headless-factory-run.md";
const skill = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

interface Rule {
  id: string;
  /** every pattern must match the SKILL.md body */
  all: RegExp[];
}

/** skill → rules its SKILL.md must carry */
export const RIGOR: Record<string, Rule[]> = {
  "epic-conductor": [
    { id: "review-before-gate", all: [/review BEFORE the first gate run/i] },
    {
      id: "batched-fix-single-gate",
      all: [/one batch/i, /ONE gate|gates once|gate once/i],
    },
    { id: "reviewer-never-runs-gate", all: [/never runs a gate/i] },
    {
      id: "only-merger-runs-merge-gate-before-merge",
      all: [/Only the merger runs[^\n]{0,80}merge-verified-pr\.sh/i],
    },
    {
      id: "no-pre-merge-in-pr-loop",
      all: [/never `<pre_merge_entry>`|not part of the PR loop/i],
    },
    { id: "max-2-heavy-gates", all: [/at most 2 heavy gates/i] },
    {
      id: "bot-clean-before-merge",
      all: [/bot-clean\.ts/, /pre-merge `bot-clean\.ts` check|bot-clean once/i],
    },
    {
      id: "flaky-red-root-cause-or-blocked-by",
      all: [/exactly two ways forward/i, /--blocked-by/],
    },
    { id: "accept-path-law", all: [/accept-path iron law/i] },
    {
      id: "security-panel",
      all: [/`correctness`/, /`security`/, /reproduce[^\n]{0,60}(exploit|security property)/i],
    },
    { id: "review-round-cap-3", all: [/Round cap per PR: 3/i, /pr-review-round\.ts/] },
    { id: "compact-findings-before-fixer", all: [/compact-findings\.ts/] },
    {
      id: "catch-net-independence",
      all: [/never write, edit or "?confirm"? a catch-net verdict/i],
    },
    {
      // arc#7617 — a headless Factory run has no next turn
      id: "headless-no-background",
      all: [/ARC_CODE_AGENT_RUN_ID/, /in the foreground/i, /\/dev\/code-agents\/<child>/],
    },
  ],
  land: [
    { id: "review-before-gate", all: [/review 在第一次跑闸之前做/] },
    { id: "reviewer-never-runs-gate", all: [/不跑任何闸/] },
    { id: "batched-fix-single-gate", all: [/一次修完/, /跑\*\*一次\*\* `verification_entry`/] },
    {
      id: "only-merger-runs-merge-gate-before-merge",
      all: [/merge-gate 只由合并者跑[^\n]{0,40}`merge-verified-pr\.sh`/],
    },
    { id: "no-pre-merge-in-pr-loop", all: [/`pre_merge_entry` 不在本 skill 的流程里/] },
    { id: "max-2-heavy-gates", all: [/同时最多 2 个重闸/] },
    { id: "bot-clean-before-merge", all: [/合并前先跑\*\*一次\*\* bot 检查/, /bot-clean\.ts/] },
    { id: "flaky-red-root-cause-or-blocked-by", all: [/二分找根因/, /--blocked-by/] },
    { id: "accept-path-law", all: [/accept-path 铁律/] },
    { id: "mutation-check", all: [/变异验证/] },
    { id: "security-panel", all: [/correctness \+ security 双人 panel/] },
    { id: "review-round-cap-3", all: [/review 轮次上限：\*\*3 轮\*\*/, /pr-review-round\.ts/] },
    { id: "compact-findings-before-fixer", all: [/compact-findings\.ts/] },
    {
      id: "record-change-set-after-push",
      all: [/record-change-set\.sh --entry/, /不许 `\|\| true`/],
    },
    { id: "epic-managed-is-not-an-epic-signal", all: [/`epic-managed` 不是 epic 判据/] },
    {
      // arc#7617 — a headless Factory run has no next turn
      id: "headless-no-background",
      all: [/ARC_CODE_AGENT_RUN_ID/, /闸在前台跑完/, /\/dev\/code-agents\/<child>/],
    },
  ],
  "issue-review": [
    { id: "lock-acquire-release", all: [/`agent:processing`/, /acquire/, /release/] },
    { id: "sweep-trace-machine-marker", all: [/<!-- sweep-trace:/] },
    { id: "silence-gate", all: [/对人类输入必须回应/] },
  ],
  "pr-review": [
    { id: "reviewer-never-runs-gate", all: [/reviewer 只读事实,从不跑闸/] },
    {
      id: "only-merger-runs-merge-gate-before-merge",
      all: [/`<merge_gate_entry>` \*\*只由合并者\*\*/, /merge-verified-pr\.sh/],
    },
    { id: "no-pre-merge-in-pr-loop", all: [/`pre-merge` 不在 PR 流程里/] },
    {
      id: "flaky-red-root-cause-or-blocked-by",
      all: [/出路只有两条/, /--blocked-by/, /禁止盲目重跑/],
    },
    { id: "bot-clean-script", all: [/bot-clean\.ts/, /botFindings=/, /vendorsSeen=/] },
    { id: "review-round-count-by-script", all: [/pr-review-round\.ts/] },
  ],
  "pr-sweep": [
    { id: "reviewer-never-runs-gate", all: [/\*\*reviewer 不跑闸\*\*/] },
    {
      id: "only-merger-runs-merge-gate-before-merge",
      all: [/只在合并这一步、紧接着 `merge-verified-pr\.sh` 之前跑/],
    },
    { id: "no-pre-merge-in-pr-loop", all: [/为了「刷新」去跑 `<pre_merge_entry> --comment`/] },
    { id: "max-2-heavy-gates", all: [/同一台机器最多 2 个/] },
    { id: "bot-clean-before-merge", all: [/合并前跑一次\*\* pr-review 的 `bot-clean\.ts`/] },
    { id: "flaky-red-root-cause-or-blocked-by", all: [/不盲目重跑、不调超时洗绿/, /--blocked-by/] },
    { id: "epic-managed-excluded", all: [/`epic-managed`/] },
    { id: "hold-never-merges", all: [/`agent:hold`[^\n]{0,80}never merge/i] },
  ],
  "issue-sweep": [
    { id: "max-2-heavy-gates", all: [/重闸另算,同一台机器最多 2 个/] },
    {
      id: "deterministic-branch-claim-check",
      all: [/claude\/issue-<N>/, /gh pr list --state open/],
    },
    { id: "marker-based-human-detection", all: [/machine marker/i, /sweep-trace/] },
    { id: "epic-managed-and-hold", all: [/`epic-managed`/, /`agent:hold`/] },
  ],
  "build-phases": [{ id: "repo-gate-once-at-end", all: [/the repo gate once at the end/i] }],
  verification: [
    // arc#7617 — the gate a headless Factory run needs is run to its result in this turn
    { id: "headless-gate-in-foreground", all: [/ARC_CODE_AGENT_RUN_ID/, /in the foreground/i] },
  ],
};

/** Returns the ids of rules whose patterns do not all match `text`. */
export function missingRules(text: string, rules: Rule[]): string[] {
  return rules.filter((r) => !r.all.every((re) => re.test(text))).map((r) => r.id);
}

describe("rigor golden: executable rules stay in SKILL.md (#7105)", () => {
  test("positive control: every pinned SKILL.md is really read and every rule list is non-empty", () => {
    const names = Object.keys(RIGOR);
    expect(names.length).toBeGreaterThanOrEqual(6);
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

  test("shared receipt protocol: ONE reference file, and every consumer points at it", () => {
    // epic-conductor §6 (bot / inline review receipt protocol) is extracted once; pr-review,
    // pr-sweep and land link it instead of carrying their own copy.
    const shared = readFileSync(join(PLUGIN, SHARED_PROTOCOL), "utf8");
    expect(shared.length).toBeGreaterThan(2000);
    expect(shared).toMatch(/bot-clean\.ts/);
    expect(shared).toMatch(/same-thread|in-thread/i);
    expect(shared).toMatch(/P1\s*\/\s*High/);
    expect(shared).toMatch(/REJECT/);
    expect(shared).toMatch(/pulls\/<n>\/comments\/<comment_id>\/replies/);
    for (const name of ["epic-conductor", "pr-review", "pr-sweep", "land"]) {
      expect({ name, links: skill(name).includes(`../../${SHARED_PROTOCOL}`) }).toEqual({
        name,
        links: true,
      });
    }
  });

  test("shared headless rule (#7617): ONE reference file, and every consumer points at it", () => {
    const shared = readFileSync(join(PLUGIN, SHARED_HEADLESS), "utf8");
    expect(shared).toMatch(/ARC_CODE_AGENT_RUN_ID/);
    expect(shared).toMatch(/run_in_background/);
    expect(shared).toMatch(/\/dev\/code-agents\/<child>/);
    expect(shared).toMatch(/needs resume/);
    // the poll whitelists terminal statuses: a failed read / null / unknown status is an
    // error, never "settled"; it reads the real `arc --json afs read` envelope
    expect(shared).toMatch(/exited \| failed \| stopped \| safety-invalidated\)/);
    expect(shared).toMatch(/jq -er '\.data\.content\.status'/);
    expect(shared).toMatch(/\*\) echo "ERROR/);
    expect(shared).not.toMatch(/\[0\]'/); // the old first-match selector that read null as settled
    // each call stays under the default 120 s tool timeout; a total deadline spans calls
    expect(shared).toMatch(/for _ in 1 2 3 4 5; do/);
    expect(shared).toMatch(/DEADLINE/);
    expect(shared).toMatch(/paused counts as live/);
    for (const name of ["epic-conductor", "land", "verification"]) {
      expect({ name, links: skill(name).includes(`../../${SHARED_HEADLESS}`) }).toEqual({
        name,
        links: true,
      });
    }
  });

  test("REJECT: deleting the lines that state a rule from the real SKILL.md is seen (mutation)", () => {
    // Drop every whole line carrying any of the rule's patterns (the way a diet would cut
    // a paragraph); the rule must then read as missing.
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
    expect(seen).toBeGreaterThanOrEqual(50);
  });
});
