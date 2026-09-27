#!/usr/bin/env bun
/**
 * lint-skill-budget (#7105): the real skill tree is within budget, and the lint is not
 * blind — it sees every SKILL.md (positive control), an empty enumeration is red, and a
 * deliberately oversize fixture is red for the stated reason.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGETS,
  DESCRIPTION_CAP,
  frontmatterDescription,
  lintSkillBudget,
  listSkills,
  type SkillFile,
} from "./lint-skill-budget.ts";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");

const fake = (name: string, body: string, description = "Short trigger text."): SkillFile => ({
  name,
  path: join("/nonexistent", name, "SKILL.md"),
  text: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
});

describe("lint-skill-budget", () => {
  test("positive control: the lint enumerates every skill directory that has a SKILL.md", () => {
    const onDisk = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const seen = listSkills(SKILLS_DIR).map((s) => s.name);
    expect(onDisk.length).toBeGreaterThanOrEqual(15);
    expect(seen).toEqual(onDisk);
    const r = lintSkillBudget(listSkills(SKILLS_DIR));
    expect(r.rows.length).toBe(onDisk.length);
    expect(r.descriptionsTotal).toBeGreaterThan(0);
  });

  test("ACCEPT: the real skill tree is within every byte budget", () => {
    const r = lintSkillBudget(listSkills(SKILLS_DIR));
    expect(r.findings).toEqual([]);
  });

  test("REJECT: an empty enumeration is red, never green", () => {
    const r = lintSkillBudget([], { budgets: {} });
    expect(r.skills).toBe(0);
    expect(r.findings.join("\n")).toMatch(/found 0 SKILL\.md/);
    const missingDir = listSkills(join(tmpdir(), "no-such-skills-dir-7105"));
    expect(lintSkillBudget(missingDir, { budgets: {} }).findings.length).toBeGreaterThan(0);
  });

  test("REJECT: a deliberately oversize SKILL.md is red and names the skill and cap", () => {
    const r = lintSkillBudget([fake("big", "x".repeat(2_000))], {
      budgets: { big: 1_000 },
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatch(/^big\/SKILL\.md is \d+ B > cap 1000 B$/);
    // ACCEPT arm of the same fixture: under its cap it is green.
    expect(
      lintSkillBudget([fake("big", "x".repeat(500))], { budgets: { big: 1_000 } }).findings,
    ).toEqual([]);
  });

  test("REJECT: the default cap applies to a skill without its own budget", () => {
    const r = lintSkillBudget([fake("other", "y".repeat(300))], { budgets: {}, defaultCap: 200 });
    expect(r.findings[0]).toMatch(/other\/SKILL\.md is \d+ B > cap 200 B/);
  });

  test("REJECT: a budget naming a skill that does not exist is red (stale budget table)", () => {
    const r = lintSkillBudget([fake("a", "body")], { budgets: { ghost: 10 } });
    expect(r.findings.join("\n")).toMatch(/BUDGETS names "ghost"/);
  });

  test("REJECT: an overlong or missing description is red", () => {
    const long = lintSkillBudget([fake("d", "body", "z".repeat(DESCRIPTION_CAP + 1))], {
      budgets: {},
    });
    expect(long.findings.join("\n")).toMatch(/d description is \d+ B > cap/);
    const none = lintSkillBudget(
      [{ name: "n", path: "/x/n/SKILL.md", text: "---\nname: n\n---\nbody" }],
      { budgets: {} },
    );
    expect(none.findings.join("\n")).toMatch(/no frontmatter description/);
  });

  test("frontmatterDescription reads inline and folded forms", () => {
    expect(frontmatterDescription("---\nname: a\ndescription: one line\n---\n")).toBe("one line");
    expect(
      frontmatterDescription("---\nname: a\ndescription: >-\n  folded\n  text\nother: 1\n---\n"),
    ).toBe("folded text");
  });

  test("REJECT: a missing linked reference and an unlinked reference file are both red", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-budget-"));
    mkdirSync(join(root, "s", "reference"), { recursive: true });
    writeFileSync(join(root, "s", "reference", "orphan.md"), "# orphan\n");
    writeFileSync(
      join(root, "s", "SKILL.md"),
      "---\nname: s\ndescription: d\n---\nWhen X, read [reference/gone.md](reference/gone.md).\n",
    );
    const r = lintSkillBudget(listSkills(root), { budgets: {} });
    expect(r.findings.join("\n")).toMatch(/links missing reference\/gone\.md/);
    expect(r.findings.join("\n")).toMatch(/reference\/orphan\.md is not linked/);
    // ACCEPT arm: link the orphan, drop the dangling link → green.
    writeFileSync(
      join(root, "s", "SKILL.md"),
      "---\nname: s\ndescription: d\n---\nWhen X, read [reference/orphan.md](reference/orphan.md).\n",
    );
    expect(lintSkillBudget(listSkills(root), { budgets: {} }).findings).toEqual([]);
  });

  test("the #7105 target skills all carry an explicit budget", () => {
    for (const name of [
      "issue-review",
      "issue-sweep",
      "pr-sweep",
      "pr-review",
      "build-phases",
      "epic-conductor",
      "land",
      "design-review",
      "issue-sweep-batch",
    ]) {
      expect(BUDGETS[name]).toBeGreaterThan(0);
    }
  });
});
