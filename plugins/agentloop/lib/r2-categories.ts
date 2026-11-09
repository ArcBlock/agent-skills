/**
 * The closed R2 category vocabulary of the `R2: <category>` line — one list
 * for every consumer (the R2 admission golden test, issue-sweep's golden lib,
 * issue-sweep-batch's needs-human-confirm admission). It mirrors the token
 * table of {@link R2_RULE_FILE}; `r2-categories.test.ts` pins them equal, so
 * a row added to the rule file turns the test red until this list follows.
 */

/** The rule file, relative to the plugin root. */
export const R2_RULE_FILE = "reference/r2-admission.md";

/**
 * agent-factory#24 — six categories: what agents must not decide on their own.
 * `release`, `deploy-prod`, `r2-list` and `merge-criteria` left the list: they
 * go through review and the jury (the R2 boundary lane), announced afterwards.
 */
export const R2_CATEGORIES = Object.freeze([
  "breaking",
  "external-commitment",
  "market",
  "permission",
  "spend",
  "data-delete",
] as const);
export type R2Category = (typeof R2_CATEGORIES)[number];

/** The tokens of the rule file's table (rows `| \`token\` | … |`), in order; the header row excluded. */
export function r2CategoriesFromTable(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\|\s*`([a-z0-9-]+)`\s*\|/.exec(line.trim());
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}
