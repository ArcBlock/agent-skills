#!/usr/bin/env bun
/**
 * R2 admission golden — `needs-human-confirm` is reserved for an R2 decision (arc nhc audit,
 * 2026-10-25: 43 of 44 labelled items were not R2).
 *
 * The rule lives in ONE file (`reference/r2-admission.md`); every skill text that used to make
 * the label the default exit for "a decision is needed" now points at it. These assertions pin:
 *   - the rule file: the R2 list, the machine line `R2: <category>`, the jury, the 7-day re-judge,
 *     process legislation decided by the jury (only the R2 list and the merge-blocking classes stay R2);
 *   - the consumers: each carries the R2-only exit and none keeps an old default-exit phrase.
 * Patterns are anchored on load-bearing tokens, not on wording.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { R2_CATEGORIES } from "./r2-categories";

const PLUGIN = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(PLUGIN, rel), "utf8");

export const RULE_FILE = "reference/r2-admission.md";
/** The closed category vocabulary of the `R2: <category>` line (one source). */
export { R2_CATEGORIES };

interface Consumer {
  file: string;
  /** every pattern must match */
  all: RegExp[];
  /** no phrase may appear (whitespace-normalized): the old default exit / "a person decides" text */
  none: string[];
}

/** Points at the one rule file (relative link from wherever the consumer sits). */
const LINKS_RULE = /r2-admission\.md/;

export const CONSUMERS: Consumer[] = [
  {
    file: "fleet/prompts/issue-sweep.md",
    all: [LINKS_RULE, /`R2: <category>`/, /review jury/, /portfolio/],
    none: [
      "When a human decision is genuinely needed, post it as a comment with the `needs-human-confirm` label",
    ],
  },
  {
    file: "fleet/prompts/pr-sweep.md",
    all: [LINKS_RULE, /`R2: <category>`/, /review jury/],
    none: ["When a human decision is genuinely needed, post it as a comment on the relevant PR"],
  },
  {
    file: "skills/issue-sweep/SKILL.md",
    all: [LINKS_RULE, /`R2: <category>`/, /defaults? to `research`/],
    none: [
      "需要人拍板的问题,照 [`design-review` Autonomous escalation]",
      "if it cannot be inferred, `needs-human-confirm`",
    ],
  },
  {
    file: "skills/issue-sweep/reference/candidates.md",
    all: [/`research`/],
    none: [
      "判不出类型 的也不静默跳过**:挂 `needs-human-confirm`",
      "判不出类型的也不静默跳过**:挂 `needs-human-confirm`",
    ],
  },
  {
    file: "skills/issue-review/SKILL.md",
    all: [LINKS_RULE, /reopen 条件/],
    none: ["删文件、搬目录、merge/close、改架构方向挂 `needs-human-confirm`"],
  },
  {
    file: "skills/issue-review/reference/principles.md",
    all: [/reopen 条件/, /可逆/],
    none: ["merge/close issue、改架构方向这类大动作或不可逆操作才挂 `needs-human-confirm` 等人"],
  },
  {
    file: "skills/issue-review/reference/doc-audit.md",
    all: [/reopen 条件/],
    none: [
      "保留 `needs-human-confirm`,作「审计完成,待人最终 close」信号",
      "PR merge、**close issue**、改架构方向的拍板",
    ],
  },
  {
    file: "skills/pr-review/SKILL.md",
    all: [/review jury/, LINKS_RULE],
    none: ["Any door fails → comment + `needs-human-confirm`"],
  },
  {
    file: "skills/pr-review/reference/fix-now.md",
    all: [/review jury/, /panel/],
    none: [
      "| **任一门不过**(security / 方向 A-B 未定 / 大改动 / 语义争议) | — | comment + `needs-human-confirm`",
    ],
  },
  {
    file: "skills/land/SKILL.md",
    all: [/ready to merge — host merger/, /host merger/],
    none: [
      "Merge authority is human",
      "ready to merge, human decision",
      "add `needs-human-confirm`",
    ],
  },
  {
    file: "skills/land/reference/factory-merge.md",
    all: [/host merger/],
    none: ["merges only when a person asked for it here"],
  },
  {
    file: "skills/land/reference/coherence.md",
    all: [/planner/],
    none: ["若有对应 issue/PR 就落成 comment 并挂 `needs-human-confirm`"],
  },
  {
    file: "skills/epic-conductor/SKILL.md",
    all: [/ready to merge — host\s+merger/],
    none: ["Merge authority is human", 'human decision"'],
  },
  {
    file: "skills/pr-sweep/SKILL.md",
    all: [/not a factory-run PR/, /host merger/],
    none: ["Those are a person's merge"],
  },
  {
    file: "reference/headless-factory-run.md",
    all: [/## Merge authority/, /host merger/, /exit 3/],
    none: [
      "Merge authority is human",
      "ready to merge, human decision",
      "and the `needs-human-confirm` label",
    ],
  },
  {
    file: "skills/factory-planner/reference/approve.md",
    all: [/review jury/, /R2 清单本身/, /build-break \/ data-loss \/ security/],
    none: ["改禁区或流程立法 |"],
  },
  {
    file: "skills/issue-sweep/reference/orchestration.md",
    all: [/只贴 R2 决定/, /交评判团/],
    none: [
      "`needs-human-confirm` 只贴真分叉(互斥且不可逆)",
      "**(c) 只有真正 human-only fork 才停**",
    ],
  },
  {
    file: "skills/issue-review/reference/idea.md",
    all: [/只贴给 R2 决定/],
    none: ["「A 和 B 互斥且都不可逆」才是"],
  },
  {
    file: "skills/design-review/SKILL.md",
    all: [/review jury/, LINKS_RULE],
    none: ["The human answers asynchronously on the issue; the next sweep picks it up."],
  },
  {
    file: "skills/factory-planner/reference/prerequisites.md",
    all: [/`denyHits`/, /R2 边界/],
    none: ["每个成员的 `allowedPaths` 和 `targetSurface` 都不与禁区相交（语义见下）"],
  },
];

/** Collapse every whitespace run (line breaks included) to one space. */
const norm = (t: string) => t.replace(/\s+/g, " ");

/** Ids (file names) of consumers whose `all` does not fully match or whose `none` appears. */
export function failingConsumers(texts: Record<string, string>, consumers: Consumer[]): string[] {
  return consumers
    .filter((c) => {
      const t = texts[c.file] ?? "";
      return (
        !c.all.every((re) => re.test(t)) || c.none.some((phrase) => norm(t).includes(norm(phrase)))
      );
    })
    .map((c) => c.file);
}

describe("R2 admission: the rule file (#5500, nhc audit R-7/R-11, C-2)", () => {
  const rule = read(RULE_FILE);

  test("positive control: the rule file is really read", () => {
    expect(rule.length).toBeGreaterThan(1500);
  });

  test("ACCEPT: every R2 category token is listed, in the machine line format", () => {
    for (const c of R2_CATEGORIES) {
      expect({ c, listed: rule.includes(`\`${c}\``) }).toEqual({ c, listed: true });
    }
    expect(rule).toMatch(/`R2: <category>`/);
    // the line sits after the identity line (agent comments start with it)
    expect(rule).toMatch(/身份行/);
  });

  test("ACCEPT: everything else goes to the jury / portfolio; triage failure defaults to research", () => {
    expect(rule).toMatch(/review jury/);
    expect(rule).toMatch(/portfolio/);
    expect(rule).toMatch(/`research`/);
    // the jury is the #9147 mechanism: ≥2 engines outside the coder set, security unanimous
    expect(rule).toMatch(/#9147/);
    expect(rule).toMatch(/至少两个/);
  });

  test("ACCEPT: a label older than 7 days is re-judged; keeping it as-is is not an outcome", () => {
    expect(rule).toMatch(/7 天/);
    expect(rule).toMatch(/A \/ B \/ D/);
    expect(rule).toMatch(/「维持 `needs-human-confirm`」不是合法结论/);
  });

  test("ACCEPT: process legislation is decided by the jury; the R2 list and the merge-blocking classes go through the boundary lane", () => {
    expect(rule).toMatch(/流程立法/);
    expect(rule).toMatch(/`r2-list`/);
    expect(rule).toMatch(/`merge-criteria`/);
    expect(rule).toMatch(/boundary lane/);
    expect(rule).toMatch(/build-break \/ data-loss \/ security/);
  });

  test("ACCEPT (agent-factory#24): the hard floor is in the rule file, refused outright, never a person's", () => {
    expect(rule).toMatch(/<!-- r2-hard-floor:begin -->[\s\S]*<!-- r2-hard-floor:end -->/);
    for (const c of [
      "oversight-substrate",
      "jury-bypass",
      "deploy-outside-channel",
      "floor-list",
    ]) {
      expect(rule).toContain(`\`${c}\``);
    }
    expect(rule).toMatch(/不交给人/);
    expect(rule).toMatch(/PR #N · git revert <sha>/);
    expect(rule).toMatch(/release-check\.sh/);
  });

  test("ACCEPT: closing an issue or deleting a file is reversible (evidence + reopen condition)", () => {
    expect(rule).toMatch(/reopen 条件/);
  });
});

describe("R2 admission: consumers carry the R2-only exit", () => {
  const texts = Object.fromEntries(CONSUMERS.map((c) => [c.file, read(c.file)]));

  test("positive control: every consumer is really read and the list is not empty", () => {
    expect(CONSUMERS.length).toBeGreaterThanOrEqual(20);
    for (const c of CONSUMERS) {
      expect({ file: c.file, read: (texts[c.file] ?? "").length > 500 }).toEqual({
        file: c.file,
        read: true,
      });
      expect({ file: c.file, arms: c.all.length > 0 && c.none.length > 0 }).toEqual({
        file: c.file,
        arms: true,
      });
    }
  });

  test("ACCEPT: every consumer passes", () => {
    expect(failingConsumers(texts, CONSUMERS)).toEqual([]);
  });

  test("REJECT (mutation): putting an old default-exit phrase back is seen, per consumer", () => {
    let seen = 0;
    for (const c of CONSUMERS) {
      for (const phrase of c.none) {
        const mutated = { ...texts, [c.file]: `${texts[c.file]}\n${phrase}\n` };
        expect({ file: c.file, phrase, caught: failingConsumers(mutated, [c]) }).toEqual({
          file: c.file,
          phrase,
          caught: [c.file],
        });
        seen++;
      }
    }
    expect(seen).toBeGreaterThanOrEqual(20);
  });

  test("REJECT (mutation): cutting the text that carries the new rule is seen, per consumer", () => {
    for (const c of CONSUMERS) {
      let mutated = texts[c.file] ?? "";
      for (const re of c.all) mutated = mutated.replace(new RegExp(re.source, "g"), "");
      expect({ file: c.file, caught: failingConsumers({ [c.file]: mutated }, [c]) }).toEqual({
        file: c.file,
        caught: [c.file],
      });
    }
  });
});
