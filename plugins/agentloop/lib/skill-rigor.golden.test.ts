#!/usr/bin/env bun
/**
 * Rigor golden — the few executable rules a skill's SKILL.md must keep (arc#7105, arc#7729).
 *
 * A reference file is only read "when X"; a rule that governs every run must stay in the
 * always-loaded SKILL.md. These assertions pin those rules to the SKILL.md text, so a diet that
 * moves a rule out of the body — or drops it — goes red here.
 *
 * Since #7729 the loop is: the changed package's tests, one clean-context review (P0–P2 fixed in
 * one batch, P3 → an issue; a correctness + security panel for auth / exec / secrets / sandbox),
 * PR, merge; a factory run stops at ready to merge (#7662). Patterns are loose on wording but
 * anchored on the load-bearing tokens.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
const P3_TO_ISSUE: Rule = { id: "p3-to-issue", all: [/P0–P2/, /P3 → a follow-up issue/] };
const RECORD_CHANGE_SET: Rule = {
  id: "record-change-set-after-push",
  all: [/record-change-set\.sh --entry/, /no `\|\| true`/],
};

/** skill → rules its SKILL.md must carry */
export const RIGOR: Record<string, Rule[]> = {
  land: [
    PACKAGE_TESTS,
    SECURITY_PANEL,
    P3_TO_ISSUE,
    RECORD_CHANGE_SET,
    {
      id: "factory-run-stops-at-ready-to-merge",
      all: [/ARC_CODE_AGENT_RUN_ID/, /ready to merge, human decision/],
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
    P3_TO_ISSUE,
    RECORD_CHANGE_SET,
    {
      id: "factory-run-stops-at-ready-to-merge",
      all: [/ARC_CODE_AGENT_RUN_ID/, /ready to merge, human\s+decision/],
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
    { id: "crashed-reviewer-not-a-pass", all: [/never a pass/] },
    { id: "verdict-marker-first-line", all: [/`<!-- pr-review-verdict -->`/, /`Verdict: /] },
  ],
  "pr-sweep": [
    { id: "hold-never-merges", all: [/`agent:hold` never merges/] },
    { id: "epic-managed-skipped", all: [/Drop `epic-managed` PRs/] },
    { id: "red-tier-never-auto-merge", all: [/never auto-merge/] },
    { id: "change-request-is-not-approval", all: [/change request is not an approval/] },
    { id: "factory-pr-never-auto-merged", all: [/not a factory-run PR/, /`needs-human-confirm`/] },
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
