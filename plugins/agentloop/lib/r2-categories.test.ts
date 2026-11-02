import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { R2_CATEGORIES as SWEEP } from "../skills/issue-sweep/test/sweep-golden/lib";
import { R2_CATEGORIES as NHC } from "../skills/issue-sweep-batch/scripts/nhc-admission";
import { R2_CATEGORIES, R2_RULE_FILE, r2CategoriesFromTable } from "./r2-categories";

const rule = readFileSync(join(import.meta.dir, "..", R2_RULE_FILE), "utf8");

describe("R2 categories — one source, pinned to the rule file's table", () => {
  test("the table is parsed (positive control: at least 10 tokens, the header row excluded)", () => {
    const table = r2CategoriesFromTable(rule);
    expect(table.length).toBeGreaterThanOrEqual(10);
    expect(table).not.toContain("R2: <category>");
  });

  test("the module's list equals the table, in order", () => {
    expect([...R2_CATEGORIES]).toEqual(r2CategoriesFromTable(rule));
  });

  test("every consumer uses the one list (same array, not a copy)", () => {
    // The golden test's file (not imported: that would run its tests twice) re-exports it.
    const golden = readFileSync(join(import.meta.dir, "r2-admission.golden.test.ts"), "utf8");
    expect(golden).toMatch(/import \{[^}]*R2_CATEGORIES[^}]*\} from "\.\/r2-categories"/);
    expect(golden).not.toMatch(/R2_CATEGORIES = \[/);
    expect(NHC).toBe(R2_CATEGORIES);
    expect(SWEEP).toBe(R2_CATEGORIES);
  });

  test("REJECT: a table row added to the rule file shows up, so a stale list goes red", () => {
    const extended = rule.replace("| `spend` |", "| `new-token` | something new |\n| `spend` |");
    expect(r2CategoriesFromTable(extended)).toContain("new-token");
    expect(r2CategoriesFromTable(extended)).not.toEqual([...R2_CATEGORIES]);
  });
});
