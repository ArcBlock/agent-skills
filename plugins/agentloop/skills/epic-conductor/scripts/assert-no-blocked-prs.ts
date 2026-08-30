#!/usr/bin/env bun
/**
 * Conductor CLOSEOUT exit gate (ArcBlock/arc#5595).
 *
 *   > A conductor may not close out while it still owns a PR that is blocked by
 *   > a foreign red whose referenced issue is still open.
 *
 * ## Why this exists
 *
 * #5593 made the conductor the OWNER of foreign-red-blocked PRs. But a conductor
 * has a lifetime: when the epic closes it is gone, and any still-hanging blocked
 * PR instantly becomes unowned again — precisely the thing #5593 was preventing.
 *
 * §9 Closeout already has the PROCESS-side half of that discipline
 * (`assert-no-live-children.ts`: no worker is still running). This is the
 * ARTIFACT-side half. One rule, two halves:
 *
 *   **a conductor must not exit on unfinished state it created.**
 *
 * Same family, same ergonomics as its sibling: one epic number in, exit 0 only
 * when nothing is holding, every refusal naming what held it.
 *
 * ## What it reads
 *
 * Open PRs labelled `epic:<n>`, and the attribution evidence #5534 / PR #5598
 * writes into each PR's verification comment
 * (`renderAttributionSection()` in `.claude/verify/attribution.ts`,
 * `docs/architecture/verification-result-taxonomy.md` §5.3):
 *
 *     ### Attribution — foreign red (`PREEXISTING`)
 *     - **Blocked by**: #5530 — verified to exist and be OPEN when this ran.
 *
 * That `#5530` is the WITNESS ISSUE. If it is still open, the foreign red this
 * conductor took ownership of is still live, and closeout is refused.
 *
 * ## ⚠️ The inherited weakness, stated in full — do not paper over it
 *
 * The witness issue is a **HUMAN-SUPPLIED** input. The attribution gate
 * machine-checks only that it EXISTS and is OPEN; it never checks that the issue
 * has any causal relation to the reds it is cited for. The independent review of
 * PR #5598 confirmed this end-to-end: **any open issue passes.**
 *
 * ⟹ **This gate's precision is capped by the witness's precision.** It cannot be
 * fixed here — it is a property of the evidence format (recorded on #5534, and in
 * the conductor comment on #5595).
 *
 * The consequence is honoured in the OUTPUT, not hidden: every refusal prints the
 * witness issue number and the literal state it relied on, plus how to overturn
 * it, so "the gate thinks you're done" can be checked by a human at a glance. A
 * limited-precision judgement must not speak with certain-sounding output.
 *
 * ## Fail-closed
 *
 * Anything that cannot be CHECKED is a refusal, never a pass, and the refusal
 * names WHICH precondition was unavailable — same spec as the #5593 attribution
 * threshold. "Couldn't check" is never "clear"; folding it into "clear" is the
 * exact disease this epic is about.
 *
 * There is deliberately **no bypass flag**. The escape from a fail-closed refusal
 * is to resolve the PR itself (merge it, or close it) — after which it is no
 * longer an open PR and the gate has nothing to hold.
 *
 * ## Scope
 *
 * Conductor closeout ONLY. It does not widen `requireStickyGate`'s accept set,
 * does not touch merge-gate semantics, and introduces no `pass:=true` /
 * `blocking:=false` / `skipped:=` downgrade path.
 *
 *   bun assert-no-blocked-prs.ts --epic <n> [--repo owner/name]
 *
 * Exit 0 = clear · 1 = a witness issue is still open · 2 = usage, or a
 * precondition could not be checked (fail-closed).
 */
import { decodeHtmlEntities, MARKER_PREFIX } from "../../../lib/comment.ts";
import { run, stripAnsi } from "../../../lib/report.ts";

type Runner = (cmd: string) => { code: number; out: string };

/** One open PR carrying the epic's label. */
export interface EpicPr {
  number: number;
  title: string;
  url: string;
}

export type PrListFact = { available: true; prs: EpicPr[] } | { available: false; detail: string };

/**
 * What a PR's attribution evidence says about a witness issue.
 *
 * Four values, deliberately. `unreadable` (evidence present, no number in it)
 * and `unavailable` (the evidence could not be fetched) must never collapse into
 * `none` — that fold is how a gate requiring evidence decays into one that
 * passes whenever it fails to look.
 */
export type WitnessRead =
  | { kind: "none" }
  | { kind: "witness"; issue: number }
  | { kind: "unreadable"; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * Answer to "does the witness issue exist, and is it open?".
 *
 * Three-valued for the same reason as `IssueFact` in `.claude/verify/attribution.ts`
 * (which this mirrors rather than imports — that module is repo-local, this script
 * ships in the tree mirrored to `ArcBlock/agent-skills`): `available: false` means
 * the QUESTION could not be asked, and is not the same as a "no".
 */
export type IssueFact =
  | { available: true; exists: boolean; open?: boolean; detail: string }
  | { available: false; detail: string };

export type ClosePrecondition = "gh" | "prs" | "evidence" | "issue";

export const PRECONDITION_LABEL: Record<ClosePrecondition, string> = {
  gh: "the gh CLI can answer at all",
  prs: "the epic's open PR list can be read",
  evidence: "each open PR's attribution evidence can be read",
  issue: "each cited witness issue's state can be read",
};

export type PrKind = "clear" | "released" | "blocking" | "unknown";

export interface PrVerdict {
  pr: number;
  title: string;
  url: string;
  kind: PrKind;
  /** the witness issue this verdict relied on, when there was one */
  witness?: number;
  /** the literal state string the verdict relied on — printed, never inferred */
  witnessState?: string;
  detail: string;
  precondition?: ClosePrecondition;
}

/* ------------------------------------------------------------------ *
 * Evidence reading — pure
 * ------------------------------------------------------------------ */

/**
 * The heading `renderAttributionSection()` / `renderRefusalNotice()` both emit.
 * Matched without its `(`PREEXISTING`)` suffix so a later cosmetic edit to the
 * suffix cannot silently turn this gate into a no-op.
 */
export const ATTRIBUTION_HEADING_RE = /^#{2,4}\s+Attribution\s+—\s+foreign red/m;

/** `- **Blocked by**: #5530` / `- **Blocked by**: ArcBlock/arc#5530` */
const ADMITTED_WITNESS_RE = /\*\*Blocked by\*\*:\s*(?:[\w.-]+\/[\w.-]+)?#(\d+)/;

/** The refusal notice's prose form, e.g. "issue #5530 is not open (CLOSED)". */
const REFUSED_WITNESS_RE = /\bissue #(\d+)\b/;

/** Any markdown heading — used to bound the attribution section (see below). */
const ANY_HEADING_RE = /^#{1,6}\s/m;

/**
 * Is this text the GATE'S OWN comment?
 *
 * ## Why provenance is checked at all (PR #5615 review, P1)
 *
 * This script is the FIRST consumer to read attribution evidence back out of
 * GitHub text. `attribution.ts` takes its witness from `--blocked-by` on argv and
 * never parses a comment, so the evidence channel did not exist before — this
 * script creates it, and an unauthenticated channel is this script's own new
 * attack surface, not an inherited one.
 *
 * Demonstrated live in review: real evidence citing an OPEN issue, plus one
 * ordinary comment flat-pasting an old section citing a CLOSED one, flipped the
 * gate from exit 1 to **exit 0**. That is the fail-open direction — the exact
 * thing this gate exists to prevent — and it needs no malice: an agent
 * re-posting a previous round's report, or a human quoting one for the record,
 * both produce it.
 *
 * So evidence is only ever taken from a comment carrying the sticky
 * `MARKER_PREFIX` that the verification engine itself writes.
 *
 * `decodeHtmlEntities` FIRST: an MCP-delivered comment arrives with the marker
 * escaped to `&lt;!-- verification-report` (`comment.ts:50-69`, #4283). Matching
 * the raw body would make every gh-less session's report invisible — and
 * "invisible" would mean `none`, which is a fail-open of its own.
 */
export function isGateComment(text: string): boolean {
  return decodeHtmlEntities(text).includes(MARKER_PREFIX);
}

/** Does this text contain an attribution section at all? */
export function hasAttributionSection(text: string): boolean {
  return ATTRIBUTION_HEADING_RE.test(decodeHtmlEntities(text));
}

/**
 * Read ONE text for attribution evidence.
 *
 * - no heading ⇒ `none` — an ordinary comment mentioning `#5530` is not evidence;
 * - heading but not the gate's own comment ⇒ `unreadable`, **never** `none`;
 * - heading, ours, but no number ⇒ `unreadable`, never a guess.
 *
 * The last two are both fail-closed on purpose: a refusal notice for e.g. the
 * `build` precondition names no issue, and the honest answer is "this PR claimed
 * attribution and I cannot tell about what" — not silence.
 */
export function readWitness(text: string): WitnessRead {
  const decoded = decodeHtmlEntities(text);
  if (!ATTRIBUTION_HEADING_RE.test(decoded)) return { kind: "none" };
  if (!decoded.includes(MARKER_PREFIX)) {
    return {
      kind: "unreadable",
      detail:
        "an attribution section appears in a comment that is not the gate's own " +
        `verification report (no \`${MARKER_PREFIX}\` marker) — unsigned text is not evidence`,
    };
  }
  // Bound the scan to THIS section. `text.slice(headingIndex)` would run to the
  // end of the report, where `### Full Logs` and history markers are full of
  // `#nnn`-shaped noise the fallback regex would happily adopt as the witness.
  const start = decoded.search(ATTRIBUTION_HEADING_RE);
  const rest = decoded.slice(start);
  const afterHeading = rest.indexOf("\n");
  const nextHeading = afterHeading < 0 ? -1 : rest.slice(afterHeading).search(ANY_HEADING_RE);
  const section = nextHeading < 0 ? rest : rest.slice(0, afterHeading + nextHeading);

  const admitted = section.match(ADMITTED_WITNESS_RE);
  if (admitted?.[1]) return { kind: "witness", issue: Number(admitted[1]) };
  const refused = section.match(REFUSED_WITNESS_RE);
  if (refused?.[1]) return { kind: "witness", issue: Number(refused[1]) };
  return {
    kind: "unreadable",
    detail: "an attribution section is present but names no witness issue",
  };
}

/**
 * Read a PR's comments oldest-first and decide what its evidence says.
 *
 * Precedence is the whole point:
 *
 * 1. among the GATE'S OWN comments, the newest evidence wins (the report is
 *    upserted, so a later run supersedes an earlier one);
 * 2. if none of them carries evidence but some UNSIGNED text looks like it does,
 *    the answer is `unreadable` (exit 2) — not `none`. Silently ignoring an
 *    impostor is the same fail-open as believing it;
 * 3. otherwise `none`.
 *
 * Step 1 outranking step 2 is what keeps a stray paste from jamming a PR whose
 * real evidence is right there.
 */
export function readWitnessFromTexts(texts: string[]): WitnessRead {
  let found: WitnessRead = { kind: "none" };
  for (const text of texts) {
    if (!isGateComment(text)) continue;
    const read = readWitness(text);
    if (read.kind !== "none") found = read;
  }
  if (found.kind !== "none") return found;

  const impostor = texts.find((t) => !isGateComment(t) && hasAttributionSection(t));
  if (impostor !== undefined) return readWitness(impostor);
  return { kind: "none" };
}

/* ------------------------------------------------------------------ *
 * Classification — pure
 * ------------------------------------------------------------------ */

export function classifyEpicPrs(
  prs: EpicPr[],
  readEvidence: (pr: EpicPr) => WitnessRead,
  probeIssue: (issue: number) => IssueFact,
): PrVerdict[] {
  return prs.map((pr) => {
    const base = { pr: pr.number, title: pr.title, url: pr.url };
    const evidence = readEvidence(pr);

    if (evidence.kind === "none") {
      return { ...base, kind: "clear", detail: "no attribution evidence on this PR" };
    }
    if (evidence.kind === "unreadable" || evidence.kind === "unavailable") {
      return {
        ...base,
        kind: "unknown",
        precondition: "evidence",
        detail: evidence.detail,
      };
    }

    const fact = probeIssue(evidence.issue);
    if (!fact.available) {
      return {
        ...base,
        kind: "unknown",
        witness: evidence.issue,
        precondition: "issue",
        detail: `issue #${evidence.issue} could not be read (${fact.detail})`,
      };
    }
    if (!fact.exists) {
      // A cited issue that does not exist is not "no red" — it is evidence that
      // does not resolve. Fail-closed, exactly like an unreachable probe.
      return {
        ...base,
        kind: "unknown",
        witness: evidence.issue,
        precondition: "issue",
        detail: `issue #${evidence.issue} does not exist (${fact.detail})`,
      };
    }
    if (fact.open) {
      return {
        ...base,
        kind: "blocking",
        witness: evidence.issue,
        witnessState: fact.detail,
        detail: `witness issue #${evidence.issue} is still open`,
      };
    }
    return {
      ...base,
      kind: "released",
      witness: evidence.issue,
      witnessState: fact.detail,
      detail: `witness issue #${evidence.issue} is closed`,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Rendering — the half that keeps the judgement overturnable
 * ------------------------------------------------------------------ */

/** Printed verbatim on every refusal AND on every release. Asserted by tests. */
export const WITNESS_PRECISION_HEADLINE =
  "⚠️ this verdict is only as precise as the witness issue it read";

const WITNESS_PRECISION_BODY = [
  `   ${WITNESS_PRECISION_HEADLINE}`,
  "   The witness issue is a HUMAN-SUPPLIED input. The attribution gate machine-checks only",
  "   that it EXISTS and is OPEN — never that it has any causal relation to the reds it is",
  "   cited for; any open issue passes (#5534 evidence format, confirmed by the #5598 review).",
].join("\n");

export function formatBlockingFailure(blocking: PrVerdict[], epic: number): string {
  const rows = blocking.map(
    (v) =>
      `  - PR #${v.pr} ${v.url} — "${v.title}"\n` +
      `      witness issue #${v.witness} state=${v.witnessState}`,
  );
  const first = blocking[0];
  const overturn = first
    ? [
        `   To overturn: read #${first.witness} yourself. If it has nothing to do with PR #${first.pr}'s`,
        "   red, this refusal is wrong on the facts and the fix is to correct that PR's attribution",
        "   evidence — not to work around this gate. If it IS the right issue, the foreign red is",
        "   still live and this epic still owns it: clear it, or merge/close the PR, then re-run.",
      ].join("\n")
    : "";
  return [
    `❌ closeout refused — epic #${epic} still owns ${blocking.length} open PR(s) blocked by a` +
      " foreign red whose witness issue is still open:",
    ...rows,
    "",
    WITNESS_PRECISION_BODY,
    overturn,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatUnavailable(unknown: PrVerdict[], epic: number): string {
  const rows = unknown.map(
    (v) =>
      `  - PR #${v.pr} ${v.url} — precondition \`${v.precondition}\`` +
      ` (${PRECONDITION_LABEL[v.precondition ?? "evidence"]}): ${v.detail}`,
  );
  return [
    `❌ closeout refused — epic #${epic}: a precondition could not be checked.`,
    '   Fail-closed by design: "couldn\'t check" is never "clear", and this gate has no bypass.',
    ...rows,
    "",
    "   Resolve by making the fact readable (auth `gh`, restore network), or by resolving the",
    "   PR itself — a merged or closed PR is no longer an open PR and this gate stops holding.",
  ].join("\n");
}

export function formatPreconditionFailure(
  precondition: ClosePrecondition,
  detail: string,
  epic: number,
): string {
  return [
    `❌ closeout refused — epic #${epic}: precondition \`${precondition}\`` +
      ` (${PRECONDITION_LABEL[precondition]}) is unavailable: ${detail}`,
    '   Fail-closed by design: "couldn\'t check" is never "clear".',
  ].join("\n");
}

export function formatReleased(released: PrVerdict[]): string {
  return released
    .map(
      (v) =>
        `ℹ released: PR #${v.pr} cites witness issue #${v.witness}, now state=${v.witnessState}` +
        " — this gate no longer holds closeout for it.\n" +
        "   A closed witness is not proof the red is gone; it is only the fact this gate reads.\n" +
        WITNESS_PRECISION_BODY,
    )
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Real-world probes — `gh`
 * ------------------------------------------------------------------ */

const shell: Runner = (cmd) => {
  const r = run(cmd);
  return { code: r.code, out: stripAnsi(r.out) };
};

export function ghAvailable(runner: Runner = shell): { available: boolean; detail: string } {
  const which = runner("command -v gh >/dev/null 2>&1 && echo yes || echo no");
  if (which.out.trim() !== "yes") return { available: false, detail: "gh CLI not found on PATH" };
  return { available: true, detail: "gh CLI is on PATH" };
}

/**
 * `--repo` is the ONLY caller-controlled value that reaches a shell (`run()` is
 * `bash -c`). The adversarial pass found this live: `--repo 'x/y; touch /tmp/X'`
 * created the file, and failing closed on the VERDICT is no comfort once the
 * command has already run.
 *
 * So the value is validated against the GitHub slug shape and REFUSED outright
 * otherwise — no escaping, no quoting-and-hoping. A slug has exactly one `/` and
 * only `[A-Za-z0-9._-]` either side, which contains no shell metacharacter.
 */
export function isRepoSlug(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/**
 * The guard lives HERE, at the sink, not at one caller.
 *
 * `main()` also rejects a bad `--repo` early so the operator gets a readable
 * message, but the gh helpers below are exported: a future caller that never
 * goes through `main()` must still be covered, rather than the invariant living
 * three layers away and relying on "remember to validate first" (PR #5615
 * review, P2).
 */
const repoFlag = (repo?: string): string => {
  if (repo === undefined) return "";
  if (!isRepoSlug(repo)) {
    throw new Error(
      `--repo must be an owner/name slug, got ${JSON.stringify(repo)} — this value reaches a shell`,
    );
  }
  return ` --repo ${repo}`;
};

const firstLine = (text: string, max = 160): string =>
  (text.trim().split("\n")[0] ?? "no output").slice(0, max);

/**
 * Page size for the PR listing. Hitting it exactly is treated as TRUNCATION and
 * fails closed: a silently capped list would hide the PRs past the cap and
 * report a clear exit 0 — fail-open, the wrong direction for this gate.
 */
export const LIST_LIMIT = 200;

export function ghListEpicPrs(
  epic: number,
  repo: string | undefined,
  runner: Runner = shell,
): PrListFact {
  const flag = repoFlag(repo);
  const r = runner(
    `gh pr list${flag} --label "epic:${epic}" --state open --json number,title,url --limit ${LIST_LIMIT} 2>&1`,
  );
  if (r.code !== 0)
    return { available: false, detail: `gh could not answer (${firstLine(r.out)})` };
  try {
    const parsed = JSON.parse(r.out.trim()) as unknown;
    if (!Array.isArray(parsed))
      return { available: false, detail: "gh returned a non-list payload" };
    const prs: EpicPr[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object")
        return { available: false, detail: "unrecognised PR row" };
      const rec = row as Record<string, unknown>;
      if (typeof rec.number !== "number")
        return { available: false, detail: "PR row has no number" };
      prs.push({
        number: rec.number,
        title: typeof rec.title === "string" ? rec.title : "",
        url: typeof rec.url === "string" ? rec.url : "",
      });
    }
    if (prs.length >= LIST_LIMIT) {
      return {
        available: false,
        detail:
          `the open-PR listing was truncated at --limit ${LIST_LIMIT}; PRs beyond it were never ` +
          "checked, and an unchecked PR is not a clear one",
      };
    }
    return { available: true, prs };
  } catch {
    return { available: false, detail: "gh returned unparseable JSON for the PR list" };
  }
}

export function ghReadEvidence(
  repo: string | undefined,
  runner: Runner = shell,
): (pr: EpicPr) => WitnessRead {
  return (pr) => {
    // `--json comments` only: the PR BODY is author prose, not the gate's output,
    // so it is not an evidence channel (PR #5615 review, P1).
    const r = runner(`gh pr view ${pr.number}${repoFlag(repo)} --json number,comments 2>&1`);
    if (r.code !== 0) {
      return {
        kind: "unavailable",
        detail: `gh could not read PR #${pr.number} (${firstLine(r.out)})`,
      };
    }
    let parsed: { comments?: unknown };
    try {
      parsed = JSON.parse(r.out.trim()) as { comments?: unknown };
    } catch {
      return { kind: "unavailable", detail: `gh returned unparseable JSON for PR #${pr.number}` };
    }
    const texts: string[] = [];
    if (Array.isArray(parsed.comments)) {
      for (const c of parsed.comments) {
        if (c && typeof c === "object") {
          const body = (c as Record<string, unknown>).body;
          if (typeof body === "string") texts.push(body);
        }
      }
    }
    return readWitnessFromTexts(texts);
  };
}

export function ghIssueState(
  repo: string | undefined,
  runner: Runner = shell,
): (issue: number) => IssueFact {
  return (issue) => {
    const r = runner(`gh issue view ${issue}${repoFlag(repo)} --json number,state 2>&1`);
    if (r.code !== 0) {
      const text = r.out.trim();
      if (/could not resolve to an? issue|not found|no issue found/i.test(text)) {
        return { available: true, exists: false, detail: "gh reports no such issue" };
      }
      return { available: false, detail: `gh could not answer (${firstLine(text)})` };
    }
    try {
      const parsed = JSON.parse(r.out.trim()) as { number?: number; state?: string };
      if (typeof parsed.number !== "number" || typeof parsed.state !== "string") {
        return { available: false, detail: "gh returned an unrecognised issue payload" };
      }
      return {
        available: true,
        exists: true,
        open: parsed.state.toUpperCase() === "OPEN",
        detail: parsed.state.toUpperCase(),
      };
    } catch {
      return { available: false, detail: "gh returned unparseable JSON for the issue" };
    }
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export function parseArgs(argv: string[]): { epic?: number; repo?: string } {
  let epic: number | undefined;
  let repo: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--epic") {
      const v = argv[++i];
      if (v !== undefined && /^#?\d+$/.test(v.trim())) epic = Number(v.trim().replace(/^#/, ""));
      continue;
    }
    if (arg.startsWith("--epic=")) {
      const v = arg.slice("--epic=".length).trim();
      if (/^#?\d+$/.test(v)) epic = Number(v.replace(/^#/, ""));
      continue;
    }
    if (arg === "--repo") {
      repo = argv[++i];
      continue;
    }
    if (arg.startsWith("--repo=")) repo = arg.slice("--repo=".length);
  }
  return { epic, repo };
}

export interface Deps {
  listPrs: (epic: number, repo?: string) => PrListFact;
  readEvidence: (pr: EpicPr) => WitnessRead;
  probeIssue: (issue: number) => IssueFact;
}

export function main(argv = process.argv.slice(2), deps?: Deps): number {
  const { epic, repo } = parseArgs(argv);
  if (epic === undefined) {
    console.error("usage: assert-no-blocked-prs.ts --epic <n> [--repo owner/name]");
    return 2;
  }
  // Refused BEFORE any shell is built — see `isRepoSlug`.
  if (repo !== undefined && !isRepoSlug(repo)) {
    console.error(
      `❌ closeout refused — --repo must be an owner/name slug, got ${JSON.stringify(repo)}.` +
        " This value reaches a shell; it is refused, not escaped.",
    );
    return 2;
  }

  let resolved = deps;
  if (!resolved) {
    const gh = ghAvailable();
    if (!gh.available) {
      console.error(formatPreconditionFailure("gh", gh.detail, epic));
      return 2;
    }
    resolved = {
      listPrs: (n, r) => ghListEpicPrs(n, r),
      readEvidence: ghReadEvidence(repo),
      probeIssue: ghIssueState(repo),
    };
  }

  const list = resolved.listPrs(epic, repo);
  if (!list.available) {
    console.error(formatPreconditionFailure("prs", list.detail, epic));
    return 2;
  }

  const verdicts = classifyEpicPrs(list.prs, resolved.readEvidence, resolved.probeIssue);
  const blocking = verdicts.filter((v) => v.kind === "blocking");
  const unknown = verdicts.filter((v) => v.kind === "unknown");
  const released = verdicts.filter((v) => v.kind === "released");

  if (released.length > 0) console.log(formatReleased(released));

  // Unavailability is reported FIRST and independently of the blocking set: a
  // run that could not check everything has not cleared anything, even if the
  // part it could check came back green.
  if (unknown.length > 0) {
    console.error(formatUnavailable(unknown, epic));
    if (blocking.length > 0) console.error(formatBlockingFailure(blocking, epic));
    return 2;
  }
  if (blocking.length > 0) {
    console.error(formatBlockingFailure(blocking, epic));
    return 1;
  }

  console.log(
    `ok: epic #${epic} owns no open PR blocked by an open witness issue` +
      ` (${list.prs.length} open PR(s) checked, ${released.length} released)`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
