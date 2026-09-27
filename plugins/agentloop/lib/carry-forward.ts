/**
 * Evidence carry-forward across a delta that cannot change any verdict
 * (arc#7024 / arc#7019 proposal E).
 *
 * Evidence is keyed by commit. A review round that only rewords a document
 * produces a new commit, and the gate used to re-run in full for it — measured
 * at 12–25 minutes plus queueing per round (#7019 R3). When the ONLY files that
 * differ from the nearest verified ancestor are files the expensive checks
 * (the repo names them: `carryForwardChecks`) cannot observe, those checks'
 * PASS carries to the new commit. Every other check still runs on it — a
 * cheap whole-corpus lint that DOES read the doc judges it for real (review P1
 * on #7065: a carried whole-report PASS hid a lint that would have failed).
 *
 * The engine owns the mechanism (find the donor, diff, write the audit trail);
 * the consuming repo owns the judgement — which files "no check reads" is a
 * per-repo fact, supplied as `ScenarioConfig.carryForward`. No judge, no carry:
 * a repo that declares none behaves exactly as before.
 *
 * Fail-closed choices, each deliberate:
 *   - the NEAREST ancestor with any record decides; an older PASS never
 *     launders a newer FAIL;
 *   - only a full-scenario PASS is a donor (not PARTIAL, not NA — an NA never
 *     ran a check, so there is nothing to carry);
 *   - an undiffable donor is refused, never treated as an empty delta.
 */

export interface CarryDeltaFile {
  /** first letter of `git diff --name-status` (M/A/D/R/C/T) */
  status: string;
  path: string;
}

export interface CarryDelta {
  donor: string;
  files: CarryDeltaFile[];
}

/** What the planner needs to know about a donor record. */
export interface CarryDonorRecord {
  result: string;
  fullScenario: boolean;
}

/** `undefined` = eligible; a string = why not (shown to the reader). */
export type CarryJudge = (delta: CarryDelta) => string | undefined;

export type CarryPlan =
  | { kind: "carry"; donor: string; files: CarryDeltaFile[] }
  | { kind: "refused"; reason: string; donor?: string }
  | { kind: "none" };

export function planCarryForward(args: {
  /** HEAD's ancestors on this branch, nearest first, HEAD itself excluded */
  ancestors: readonly string[];
  recordFor: (sha: string) => CarryDonorRecord | undefined;
  deltaFor: (donor: string) => CarryDeltaFile[] | undefined;
  judge: CarryJudge;
}): CarryPlan {
  for (const sha of args.ancestors) {
    const record = args.recordFor(sha);
    if (!record) continue;
    if (record.result !== "PASS" || !record.fullScenario) {
      return {
        kind: "refused",
        donor: sha,
        reason: `nearest verified ancestor ${sha.slice(0, 12)} is ${record.fullScenario ? record.result : `a partial ${record.result}`}, not a full PASS`,
      };
    }
    const files = args.deltaFor(sha);
    if (!files) {
      return { kind: "refused", donor: sha, reason: `could not diff ${sha.slice(0, 12)}..HEAD` };
    }
    const reason = args.judge({ donor: sha, files });
    if (reason !== undefined) return { kind: "refused", donor: sha, reason };
    return { kind: "carry", donor: sha, files };
  }
  return { kind: "none" };
}

/** Parse `git diff --name-status -z` output. Renames/copies keep both paths. */
export function parseNameStatusZ(out: string): CarryDeltaFile[] {
  const fields = out.split("\0").filter(Boolean);
  const files: CarryDeltaFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const raw = fields[i++] ?? "";
    const status = raw.charAt(0);
    const first = fields[i++];
    if (!status || !first) break;
    files.push({ status, path: first });
    if (status === "R" || status === "C") {
      const second = fields[i++];
      if (second) files.push({ status, path: second });
    }
  }
  return files;
}

const NOTICE_FILE_LIMIT = 25;

/** The audit trail prepended to the donor's report. */
export function carryForwardNotice(args: {
  scenario: string;
  sha: string;
  donor: string;
  files: readonly CarryDeltaFile[];
  /** the check ids that were carried (not executed) */
  carried: readonly string[];
}): string {
  const shown = args.files.slice(0, NOTICE_FILE_LIMIT);
  const more = args.files.length - shown.length;
  const ids = args.carried.map((c) => `\`${c}\``).join(", ");
  return (
    `> ⏩ **Carried-forward evidence** — ${ids} did not run for \`${args.sha.slice(0, 12)}\`; ` +
    `every other check ran on this commit. The nearest verified ancestor \`${args.donor.slice(0, 12)}\` ` +
    `PASSED \`${args.scenario}\` at the same base, and the repo's judge accepted every one of the ` +
    `${args.files.length} file(s) changed since then as unobservable by ${ids}:\n` +
    shown.map((f) => `>   - \`${f.status}\` ${f.path}\n`).join("") +
    (more > 0 ? `>   - … and ${more} more\n` : "") +
    "> Force every check to run: re-run this scenario with `--no-carry-forward`.\n\n"
  );
}
