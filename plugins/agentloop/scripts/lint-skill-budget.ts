#!/usr/bin/env bun
/**
 * lint-skill-budget — byte budget for every agentloop SKILL.md (arc#7105).
 *
 * A SKILL.md body is loaded on every invocation of that skill, and every skill's
 * frontmatter `description` is loaded in every session. Both only ever grew: incident
 * narratives, playbooks and FAQ piled into the always-loaded body until the big skills
 * were 60–80 KB. #7105 moved that prose into on-demand `reference/*.md`; this lint keeps
 * it from growing back.
 *
 * Checks (deterministic, zero model):
 *   1. each SKILL.md ≤ its cap (a per-skill cap from BUDGETS, else DEFAULT_CAP);
 *   2. each frontmatter description ≤ DESCRIPTION_CAP, and their sum ≤ DESCRIPTIONS_TOTAL_CAP;
 *   3. every `reference/*.md` a SKILL.md links exists, and every file in a skill's
 *      `reference/` is linked from its SKILL.md (an unlinked reference is never read).
 *
 * Positive control (度量正控): the enumeration itself is checked. Zero SKILL.md found,
 * a BUDGETS entry naming a skill that does not exist, or a SKILL.md without a
 * description is a finding — "counted 0" never reads as green.
 *
 * Run: bun scripts/lint-skill-budget.ts [skillsDir]   (exit 0 = within budget, 1 = over / broken)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Per-skill caps in bytes (decimal KB, as in arc#7105). Skills not listed get DEFAULT_CAP.
 * These are the issue targets, not the size last reached. Never raise a cap to make a
 * diet pass; move prose into reference/ until the file fits.
 */
export const BUDGETS: Record<string, number> = {
  "issue-review": 25_000, // ≤25 KB
  "issue-sweep": 22_000, // ≤22 KB
  "pr-sweep": 20_000, // ≤20 KB
  "pr-review": 20_000, // ≤20 KB
  "build-phases": 15_000, // ≤15 KB
  "epic-conductor": 18_000, // ≤18 KB
  land: 15_000, // ≤15 KB
  "design-review": 12_000, // ≤12 KB
  "issue-sweep-batch": 18_000, // issue says 瘦身; pinned at 18 KB (about 40% off the 30 KB body)
};
/** Cap for every other SKILL.md (the largest un-dieted skill was 16.2 KB at #7105). */
export const DEFAULT_CAP = 17_000;
/** One skill's frontmatter description, bytes. */
export const DESCRIPTION_CAP = 450;
/** All descriptions together (they load in every session), bytes. */
export const DESCRIPTIONS_TOTAL_CAP = 6_000;

export interface SkillFile {
  name: string;
  path: string;
  text: string;
}

export interface BudgetReport {
  skills: number;
  descriptionsTotal: number;
  findings: string[];
  rows: Array<{ name: string; bytes: number; cap: number; description: number }>;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Frontmatter `description` value (single-line or folded `>-` / `|` block). */
export function frontmatterDescription(text: string): string | undefined {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const lines = (fm[1] ?? "").split("\n");
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at === -1) return undefined;
  const inline = (lines[at] ?? "").replace(/^description:\s*/, "");
  if (inline && !/^[>|][-+]?\s*$/.test(inline)) return inline.trim();
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l)) break;
    body.push(l.trim());
  }
  const joined = body.join(" ").trim();
  return joined || undefined;
}

export function listSkills(skillsDir: string): SkillFile[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((d) => statSync(join(skillsDir, d)).isDirectory())
    .map((d) => ({ name: d, path: join(skillsDir, d, "SKILL.md") }))
    .filter((s) => existsSync(s.path))
    .map((s) => ({ ...s, text: readFileSync(s.path, "utf8") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Relative `.md` links under a `reference/` directory, as written in the SKILL.md. */
export function referenceLinks(text: string): string[] {
  return [...text.matchAll(/\]\(((?:\.\.?\/)*[^)\s#]*reference\/[^)\s#]+\.md)(?:#[^)]*)?\)/g)].map(
    (m) => m[1] ?? "",
  );
}

export function lintSkillBudget(
  skills: SkillFile[],
  opts: { budgets?: Record<string, number>; defaultCap?: number } = {},
): BudgetReport {
  const budgets = opts.budgets ?? BUDGETS;
  const defaultCap = opts.defaultCap ?? DEFAULT_CAP;
  const findings: string[] = [];
  const rows: BudgetReport["rows"] = [];

  if (skills.length === 0) {
    findings.push("found 0 SKILL.md — a broken scan, not an empty plugin (度量正控)");
  }
  const names = new Set(skills.map((s) => s.name));
  for (const name of Object.keys(budgets)) {
    if (!names.has(name)) findings.push(`BUDGETS names "${name}" but no such SKILL.md was found`);
  }

  let descriptionsTotal = 0;
  for (const s of skills) {
    const size = bytes(s.text);
    const cap = budgets[s.name] ?? defaultCap;
    if (size > cap) findings.push(`${s.name}/SKILL.md is ${size} B > cap ${cap} B`);

    const desc = frontmatterDescription(s.text);
    const dBytes = desc ? bytes(desc) : 0;
    if (!desc) findings.push(`${s.name}/SKILL.md has no frontmatter description`);
    else if (dBytes > DESCRIPTION_CAP)
      findings.push(`${s.name} description is ${dBytes} B > cap ${DESCRIPTION_CAP} B`);
    descriptionsTotal += dBytes;
    rows.push({ name: s.name, bytes: size, cap, description: dBytes });

    const dir = dirname(s.path);
    const linked = new Set<string>();
    for (const href of referenceLinks(s.text)) {
      const abs = resolve(dir, href);
      linked.add(abs);
      if (!existsSync(abs)) findings.push(`${s.name}/SKILL.md links missing ${href}`);
    }
    const refDir = join(dir, "reference");
    if (existsSync(refDir)) {
      for (const f of readdirSync(refDir).filter((f) => f.endsWith(".md"))) {
        if (!linked.has(resolve(refDir, f)))
          findings.push(`${s.name}/reference/${f} is not linked from its SKILL.md (never read)`);
      }
    }
  }
  if (descriptionsTotal > DESCRIPTIONS_TOTAL_CAP) {
    findings.push(
      `all descriptions total ${descriptionsTotal} B > cap ${DESCRIPTIONS_TOTAL_CAP} B (loaded every session)`,
    );
  }
  return { skills: skills.length, descriptionsTotal, findings, rows };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "..", "skills");
  const r = lintSkillBudget(listSkills(dir));
  for (const row of r.rows) {
    const flag = row.bytes > row.cap ? "OVER" : "ok";
    console.log(
      `${flag.padEnd(4)} ${row.name.padEnd(22)} ${row.bytes} / ${row.cap} B · desc ${row.description} B`,
    );
  }
  console.log(
    `skills=${r.skills} descriptions=${r.descriptionsTotal}/${DESCRIPTIONS_TOTAL_CAP} B findings=${r.findings.length}`,
  );
  for (const f of r.findings) console.log(`✗ ${f}`);
  process.exit(r.findings.length === 0 ? 0 : 1);
}
