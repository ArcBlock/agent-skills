/**
 * test-audit — turn a tree sweep into a small number of actionable issues.
 *
 * ## Why grouping is the whole design
 *
 * A sweep of this repo produces ~108 findings. Filing 108 issues is not a
 * backlog, it is a denial-of-service on the backlog, and the predecessor skill's
 * entire issue story was three lines of prose telling an agent to "check GitHub
 * for an existing open issue with the same file+pattern" — a per-FINDING key,
 * which is exactly the 108-issue outcome, and keyed on a line number so it
 * would also re-file everything after any reformat.
 *
 * Findings are grouped by `(rule × owning unit)` instead: one issue says
 * "`catch-swallow` in `providers/basic/did-space`, 6 sites", with every site
 * and its witness in the body. That is one unit of work for one owner, which is
 * what an issue is supposed to be.
 *
 * ## Writing to GitHub is opt-in
 *
 * `draftIssues` only renders. `publishIssues` upserts, and is reachable only
 * through an explicit `--create` — filing issues is a side effect on a shared
 * surface that other people then have to triage, so it is never the default.
 * Both paths carry the `test-audit-key` marker, which is what makes a re-run
 * edit the existing issue instead of filing a duplicate.
 */
import type { Adapter } from "./adapter.ts";
import { defaultGroupOf } from "./adapter.ts";
import type { Finding } from "./rules.ts";

/** Label every issue this module files, so the upsert lookup is a cheap listing. */
export const ISSUE_LABEL = "test-audit";

export interface IssueDraft {
  /** Stable dedup key: one issue per rule per owning unit. */
  key: string;
  title: string;
  body: string;
  findings: Finding[];
}

/** What to do about each rule, in the words the fix actually needs. */
const REMEDY: Record<string, { problem: string; fix: string; accept: string }> = {
  only: {
    problem: "`.only` is committed, so every other test in the file is silently skipped.",
    fix: "Remove the `.only`.",
    accept: "`test-audit scan --rule only` reports 0 for this package.",
  },
  "no-assertions": {
    problem:
      "The test executes code but asserts nothing about the result, so it stays green through any behavioural regression.",
    fix: "Assert the property the test's title claims. If the real claim is only 'this does not throw', say so in the title and pair it with a reject-path test — otherwise delete the test.",
    accept:
      "Each listed test asserts an observable outcome, and breaking the code under test turns it red.",
  },
  "catch-swallow": {
    problem:
      "The assertions live only in `catch`. If the code stops throwing, the catch never runs and the test passes having asserted nothing.",
    fix: "Add a guard to the `try` — `expect.unreachable()` after the call — or move to `expect(() => …).toThrow(…)`.",
    accept:
      "Making the code under test stop throwing turns each listed test red. `test-audit scan --rule catch-swallow` reports 0 for this package.",
  },
  "empty-catch": {
    problem:
      "An assertion sits inside a `try` whose `catch {}` swallows its failure, so the assertion can never fail the test.",
    fix: "Move the assertion out of the `try`, or handle the error explicitly instead of swallowing it.",
    accept: "Breaking the asserted property turns each listed test red.",
  },
  "test-disabled": {
    problem: "A test was changed to `.skip`/`.todo`, so the suite is green by exclusion.",
    fix: "Fix and re-enable it, or delete it and say why the behaviour no longer needs covering.",
    accept: "No `.skip`/`.todo` remains, or each one links an issue explaining the deferral.",
  },
  "test-removed": {
    problem:
      "A test disappeared and no surviving test in the file resembles it. Intentional if the behaviour went too; a silent coverage drop if it did not.",
    fix: "Confirm the behaviour was removed. If it still exists, restore coverage.",
    accept: "Each listed deletion is either matched by a behaviour deletion or has coverage back.",
  },
  "assertion-weakened": {
    problem:
      "A surviving test traded semantic assertions for shape-only ones — a loosened assertion passes without the behaviour being right.",
    fix: "Restore the semantic assertion, or state why the weaker one is now the correct contract.",
    accept: "Each listed test asserts the value, not merely its shape.",
  },
};

/**
 * A group smaller than this rolls up into one per-rule issue instead of getting
 * its own.
 *
 * Grouping by `(rule × package)` alone still produced 52 drafts for 108
 * findings — an average of two sites per issue, which is filing paperwork, not
 * scheduling work. The threshold keeps an issue meaning "one package, one
 * defect class, enough of it to be worth a sitting", and sweeps the long tail
 * of one-offs into a single reviewable list per rule.
 */
const MIN_GROUP = 3;

export function draftIssues(findings: Finding[], adapter: Adapter): IssueDraft[] {
  const groupOf = adapter.groupOf ?? defaultGroupOf;
  const buckets = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = `${f.rule}/${groupOf(f.file)}`;
    buckets.set(k, [...(buckets.get(k) ?? []), f]);
  }

  // Long tail → one roll-up per rule, keyed so it upserts like any other.
  const keep: [string, Finding[]][] = [];
  const tail = new Map<string, Finding[]>();
  for (const [k, fs] of buckets) {
    if (fs.length >= MIN_GROUP) keep.push([k, fs]);
    else tail.set(fs[0]!.rule, [...(tail.get(fs[0]!.rule) ?? []), ...fs]);
  }
  for (const [rule, fs] of tail) keep.push([`${rule}/<scattered>`, fs]);

  return keep
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, fs]) => {
      const rule = fs[0]!.rule;
      const group = key.slice(rule.length + 1);
      const scattered = group === "<scattered>";
      const r = REMEDY[rule] ?? {
        problem: fs[0]!.message,
        fix: "See the witness on each site.",
        accept: `\`test-audit scan --rule ${rule}\` reports 0 for this package.`,
      };

      // Every site of one rule usually carries the same witness sentence.
      // Repeating it per line buries the paths it exists to support.
      const witnesses = new Set(fs.map((f) => f.witness));
      const shared = witnesses.size === 1 ? [...witnesses][0]! : "";

      const sites = fs
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
        .map((f) =>
          shared
            ? `- \`${f.file}:${f.line}\` — ${f.message}`
            : `- \`${f.file}:${f.line}\`\n  - ${f.message}\n  - witness: ${f.witness}`,
        )
        .join("\n");

      const scope = scattered
        ? `散落在 ${new Set(fs.map((f) => groupOf(f.file))).size} 个包，共 ${fs.length} 处（规则 \`${rule}\`）。`
        : `\`${group}\` 有 ${fs.length} 处（规则 \`${rule}\`）。`;

      const body = [
        `<!-- test-audit-key: ${key} -->`,
        "",
        "## 问题",
        "",
        `${r.problem}`,
        "",
        scope,
        "",
        "## 证据",
        "",
        ...(shared ? [`共同判据：${shared}`, ""] : []),
        sites,
        "",
        "## 方案",
        "",
        r.fix,
        "",
        "## 验收",
        "",
        r.accept,
        "",
        "---",
        "",
        "复现：",
        "",
        "```bash",
        `bun <plugin_root>/skills/test-audit/scripts/audit.ts scan --rule ${rule}`,
        "```",
        "",
        "> 开工前先核实这些位置在最新代码上仍然存在——本清单由一次扫描生成，可能已有部分被修掉。",
      ].join("\n");

      return {
        key,
        title: scattered
          ? `test-audit: ${rule} 零散 ${fs.length} 处（跨包）`
          : `test-audit: ${group} 有 ${fs.length} 处 ${rule}`,
        body,
        findings: fs,
      };
    });
}

// ---------------------------------------------------------------------------
// Optional publishing
// ---------------------------------------------------------------------------

function gh(args: string[], stdin?: string): { out: string; code: number } {
  const r = Bun.spawnSync(["gh", ...args], stdin ? { stdin: Buffer.from(stdin) } : {});
  const out = `${new TextDecoder().decode(r.stdout)}${new TextDecoder().decode(r.stderr)}`;
  return { out: out.trim(), code: r.exitCode };
}

export interface PublishResult {
  key: string;
  action: "created" | "updated" | "failed";
  issue?: number;
  detail?: string;
}

/**
 * Upsert one issue per draft, keyed on the `test-audit-key` marker in the body.
 *
 * Off by default and reachable only through an explicit `--create`: filing
 * issues is a side effect on a shared surface that other people then have to
 * triage, and "the tool did it on its own" is how a backlog fills with things
 * nobody chose.
 *
 * **The marker is the identity, not the title.** Titles carry a live count
 * (`有 12 处 catch-swallow`) that changes the moment anyone fixes one, so
 * matching on them would file a fresh duplicate every run — which is precisely
 * what the predecessor's per-finding, line-numbered dedup key would have done.
 * Matching on the marker means a re-run EDITS the issue that already exists,
 * and a group that has been fixed simply stops being drafted.
 */
export function publishIssues(drafts: IssueDraft[], repo: string): PublishResult[] {
  if (gh(["--version"]).code !== 0) {
    return drafts.map((d) => ({
      key: d.key,
      action: "failed" as const,
      detail: "gh CLI unavailable",
    }));
  }
  // Idempotent; an already-present label is not an error worth reporting.
  gh([
    "label",
    "create",
    ISSUE_LABEL,
    "-R",
    repo,
    "--description",
    "Filed by test-audit",
    "--color",
    "D4C5F9",
  ]);

  const existing = new Map<string, number>();
  const listed = gh([
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--label",
    ISSUE_LABEL,
    "--limit",
    "200",
    "--json",
    "number,body",
  ]);
  if (listed.code === 0 && listed.out.startsWith("[")) {
    for (const it of JSON.parse(listed.out) as { number: number; body: string }[]) {
      const m = /<!-- test-audit-key: (.+?) -->/.exec(it.body ?? "");
      if (m?.[1]) existing.set(m[1], it.number);
    }
  }

  return drafts.map((d) => {
    const found = existing.get(d.key);
    if (found) {
      const r = gh(["issue", "edit", String(found), "-R", repo, "--body-file", "-"], d.body);
      return r.code === 0
        ? { key: d.key, action: "updated" as const, issue: found }
        : { key: d.key, action: "failed" as const, issue: found, detail: r.out };
    }
    const r = gh(
      [
        "issue",
        "create",
        "-R",
        repo,
        "--title",
        d.title,
        "--label",
        ISSUE_LABEL,
        "--body-file",
        "-",
      ],
      d.body,
    );
    const num = Number(/\/issues\/(\d+)/.exec(r.out)?.[1] ?? 0) || undefined;
    return r.code === 0
      ? { key: d.key, action: "created" as const, issue: num }
      : { key: d.key, action: "failed" as const, detail: r.out };
  });
}
