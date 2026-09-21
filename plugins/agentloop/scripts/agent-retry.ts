#!/usr/bin/env bun
/**
 * CLI over the agent-death classifier + retry ledger (arc#6204).
 *
 *   record  --agent <id> --target <key> --brief-file <p> [--wip <ref>] --summary-file <p>
 *   due     [--now <epoch>]        list records ripe for re-dispatch
 *   bump    --target <key>         CLAIM one for re-dispatch (counts an attempt)
 *   resolve --target <key>         mark done (call after the retry lands)
 *
 * The ledger lives under `.git/agentloop/`, next to the verification evidence,
 * so it is per-repo, durable across sessions, and never committed.
 *
 * ## Two things every command does, and why
 *
 * **Every load/mutate/save runs inside a cross-process lock.** Without it the
 * ledger has a lost-update race in exactly the scenario it exists for: several
 * agents die on the SAME limit at the same moment, each `record` reads the same
 * snapshot, appends, and rewrites the whole file, and the last writer silently
 * deletes the others. One session had four simultaneous deaths on one limit;
 * measured with two concurrent recorders, 10 of 12 rounds lost a record and every
 * process exited 0. The lock is `lib/strict-file-lock.ts`, which THROWS rather
 * than proceeding unguarded — see its docblock for why the advisory lock next
 * door (`fleet/runlock.ts`) is not the right one here.
 *
 * **Every command first sweeps stale claims.** `bump` takes a record out of the
 * dispatchable set; a re-dispatcher killed by the very limit it was waiting out
 * would otherwise leave its record claimed forever. The sweep persists, and
 * `due` reports `reclaimed=` so "nothing was stuck" and "the sweep never ran"
 * are different lines.
 *
 * On every path that REPORTS, `due` prints `scanned=`, `pending=`, `inFlight=`
 * and `reclaimed=` — including when nothing is due. An empty ledger and a full
 * one with nothing ripe both show zero due records, and the first case means the
 * RECORDER never fired, the more urgent of the two. Printing only "nothing to
 * retry" would make them the same line.
 *
 * The two paths that print no `scanned=` are the ones that print no report at
 * all and exit non-zero instead: an unreadable ledger (2) and a lock we could not
 * take (3). Those are loud by construction, which is the property that matters —
 * neither can be mistaken for "scanned nothing, all clear".
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  claimRecord,
  classifyAgentDeath,
  dueRecords,
  type ReclaimedClaim,
  type RetryClaim,
  type RetryRecord,
  reclaimStaleClaims,
  recordFor,
} from "../lib/agent-retry.ts";
import { evaluateOwnerLiveness, readProcessStartTime } from "../lib/pid-liveness.ts";
import {
  DEFAULT_LOCK_WAIT_MS,
  LockUnavailableError,
  withStrictFileLock,
} from "../lib/strict-file-lock.ts";

function gitDir(): string {
  return execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
}
function ledgerPath(): string {
  // The override exists so this CLI is exercisable outside a checkout (the
  // two-process race tests need a scratch ledger); the default is the real one.
  return process.env.AGENTLOOP_RETRY_LEDGER ?? join(gitDir(), "agentloop", "retry-ledger.json");
}
function load(): RetryRecord[] {
  const p = ledgerPath();
  if (!existsSync(p)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // A corrupt ledger must not read as an empty one — that is the same
    // two-states-one-colour defect this whole module exists to remove.
    console.error(
      `✗ retry ledger at ${p} is unreadable. Fix or move it; refusing to treat it as empty.`,
    );
    process.exit(2);
  }
  if (!Array.isArray(parsed)) {
    console.error(`✗ retry ledger at ${p} is not a JSON array. Refusing to treat it as empty.`);
    process.exit(2);
  }
  // Records written before the claim state exist in live ledgers; give them the
  // field rather than letting `undefined` read as a claim.
  return (parsed as RetryRecord[]).map((r) => ({ ...r, claim: r.claim ?? null }));
}
/**
 * Write the whole ledger ATOMICALLY — temp file then `renameSync`.
 *
 * `lib/strict-file-lock.ts` argues at length that a two-syscall publication is
 * unacceptable for the LOCK file, and the ledger deserves the same argument: a
 * SIGKILL during a plain `writeFileSync` truncates it, `load` then exits 2 on
 * every command, and the casualty is the whole retry queue rather than one
 * record. The lock serialises writers; it does nothing about a writer that dies
 * mid-write.
 */
function save(records: RetryRecord[]): void {
  const p = ledgerPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(tmp, p);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];

/**
 * `--now`, validated.
 *
 * Unvalidated, `Number("2026-09-11T00:00:00Z")` is NaN, and NaN poisons this CLI
 * in two directions at once: `notBefore <= NaN` is false, so every ripe record is
 * silently hidden while `due` still exits 0 and prints its reassuring
 * `scanned=1 pending=1 … due=0`; and `record` persists `notBefore: null` before
 * crashing on `new Date(NaN)`, after which `null <= now` is TRUE and the record
 * retries immediately, straight back into the limit. Since every other line here
 * prints ISO timestamps, passing one back is the natural mistake.
 */
function resolveNow(): number {
  const raw = arg("now");
  if (raw === undefined) return Date.now();
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(
      `✗ --now must be epoch milliseconds, got ${JSON.stringify(raw)}. ` +
        "An unparseable value would hide every ripe record while still exiting 0.",
    );
    process.exit(2);
  }
  return n;
}
const now = resolveNow();

/**
 * How long to wait for a contended ledger lock before failing loudly.
 *
 * Overridable because the default is a policy, not a fact: an operator wanting a
 * shorter fail-fast, and the CLI's own tests (which must not spend 10s proving
 * that a held lock is refused), both need to move it. An unparseable or
 * non-positive value falls back to the default rather than becoming NaN, since
 * `waited >= NaN` is false and the wait would never end — the same trap as
 * `--now`, one layer down.
 */
function lockWaitMs(): number {
  const raw = process.env.AGENTLOOP_RETRY_LOCK_WAIT_MS;
  if (raw === undefined) return DEFAULT_LOCK_WAIT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `⚠ AGENTLOOP_RETRY_LOCK_WAIT_MS=${JSON.stringify(raw)} is not a positive number of ` +
        `milliseconds; using the default ${DEFAULT_LOCK_WAIT_MS}ms.`,
    );
    return DEFAULT_LOCK_WAIT_MS;
  }
  return n;
}

/**
 * Build the claim a `bump` stamps.
 *
 * `holderPid` is the process that will actually carry out the re-dispatch, and
 * the caller has to name it, because THIS process is not it. `bump` is one `bun`
 * invocation that exits in milliseconds; anchoring the claim on it makes every
 * claim look dead on the very next poll — measured while fixing this, and that
 * is the duplicate-dispatch bug restored, now wearing a claim. So there is no
 * default and no guess (guessing `process.ppid` would silently be a transient
 * shell in the common `bash -c` case). Without it the claim is UNANCHORED and
 * only the lease can recover it; `due` and `bump` both say so out loud.
 */
function buildClaim(holderPid: number | undefined): RetryClaim {
  if (holderPid === undefined) return { at: now };
  const started = readProcessStartTime(holderPid);
  return {
    pid: holderPid,
    processStartedAt: started?.ms,
    startTimeSource: started?.source,
    startedAt: new Date(now).toISOString(),
    at: now,
  };
}

const holderLiveness = (claim: RetryClaim) => {
  const v = evaluateOwnerLiveness(claim);
  return { alive: v.alive, detail: v.detail ?? v.reason };
};

/** How an in-flight record's holder reads in a report. */
function describeHolder(rec: RetryRecord): string {
  const c = rec.claim;
  if (!c) return "no claim recorded (it will be reclaimed on the next poll)";
  const since = new Date(c.at).toISOString();
  if (c.pid === undefined)
    return `UNANCHORED claim since ${since} — no holder pid, so only the lease can recover it`;
  return `pid ${c.pid} since ${since} (${holderLiveness(c).detail})`;
}

/**
 * Load → sweep stale claims → hand the records to `fn`, all inside one
 * cross-process lock. `fn` calls {@link save} when it changes anything.
 */
function withLedger<T>(fn: (records: RetryRecord[], reclaimed: ReclaimedClaim[]) => T): T {
  // The lock lives beside the ledger, so its directory has to exist BEFORE the
  // lock is taken — `save` creating it is too late (found by the first run of
  // the two-process repro against the fixed CLI: ENOENT on the lock temp file).
  mkdirSync(dirname(ledgerPath()), { recursive: true });
  return withStrictFileLock(
    `${ledgerPath()}.lock`,
    `agent-retry ${cmd ?? "?"}`,
    () => {
      const records = load();
      const { reclaimed } = reclaimStaleClaims(records, now, holderLiveness);
      if (reclaimed.length > 0) save(records);
      return fn(records, reclaimed);
    },
    { waitMs: lockWaitMs() },
  );
}

function main(): void {
  if (cmd === "record") {
    const agentId = arg("agent");
    const target = arg("target");
    const briefFile = arg("brief-file");
    const summaryFile = arg("summary-file");
    if (!agentId || !target || !briefFile || !summaryFile) {
      console.error(
        "usage: record --agent <id> --target <key> --brief-file <p> --summary-file <p> [--wip <ref>]\n" +
          "  --summary-file must hold the HARNESS's death text VERBATIM, never your paraphrase\n" +
          "  of it. The classifier keys on the harness's own notice; a retelling like\n" +
          '  "worker died: HTTP 429 from the provider" is prose, and lands on needs-a-human.',
      );
      process.exit(2);
    }
    const death = classifyAgentDeath(readFileSync(summaryFile, "utf8"), now);
    if (!death.retryable) {
      // A NON-RETRYABLE death is still a death, and it gets a row.
      //
      // It used to get none, with a note in the PR saying `record`'s own output
      // distinguished the two cases. It does not, on the surface that matters:
      // `due` is what the conductor polls, and after a run where every agent
      // failed at its task it printed `scanned=0` plus "⚠ the ledger is EMPTY …
      // the recorder did not fire" — byte-identical to a recorder that never ran,
      // and asserting the wrong one of the two. That is this module's opening
      // sentence turned on itself, on the metrology surface it was built to cure.
      // A disclosure does not fix a colour collision; a distinct row does.
      //
      // The row is `needs-human`: never `due`, never claimable, always counted in
      // `scanned` and reported under needsHuman with its reason.
      withLedger((records, reclaimed) => {
        for (const rec of reclaimed) console.log(`↺ reclaimed ${rec.target} (${rec.reason})`);
        console.log(`✋ NOT retryable (${death.kind}): ${death.reason}`);
        const existing = records.find((r) => r.target === target);
        if (existing && existing.status !== "resolved") {
          if (existing.status === "in-flight") {
            console.log(
              `   ${target} already has an in-flight retry; leaving its claim alone. ${describeHolder(existing)}`,
            );
            return;
          }
          existing.status = "needs-human";
          existing.claim = null;
          existing.reason = `${death.reason} [${death.kind}]`;
          save(records);
          console.log(`   marked the existing ${target} record needs-human. Not retryable.`);
          return;
        }
        records.push({
          ...recordFor({
            agentId,
            target,
            brief: readFileSync(briefFile, "utf8"),
            notBefore: now,
            wipRef: arg("wip") ?? null,
            reason: `${death.reason} [${death.kind}]`,
            now,
          }),
          status: "needs-human",
        });
        save(records);
        console.log(
          `   recorded ${target} as needs-human. It will NEVER be retried automatically — ` +
            "but `due` now counts it, so a run of real task failures no longer looks " +
            "like a recorder that never fired.",
        );
      });
      return;
    }
    withLedger((records) => {
      // A death report for an in-flight target IS the outcome of that claim, and
      // releasing it here is the FAST way back to pending — much faster than the
      // liveness sweep or the lease ceiling.
      //
      // But only when the reporter is entitled to. An earlier draft released the
      // claim unconditionally, and review showed what that costs: a duplicate or
      // late death report about an ALREADY-RETRIED generation un-claims a retry
      // that is still running, and after `notBefore` the target is dispatched a
      // second time — the very defect the claim state was added to prevent. So
      // the claim is released when the reporter names it (`--holder-pid` matching
      // the claim) or when its holder is provably not alive, and otherwise the
      // record keeps its claim and the report says so.
      const existing = records.find(
        (r) => r.target === target && (r.status === "pending" || r.status === "in-flight"),
      );
      if (existing) {
        existing.notBefore = Math.max(existing.notBefore, death.resetAt ?? now);
        existing.wipRef = arg("wip") ?? existing.wipRef;
        const claim = existing.status === "in-flight" ? existing.claim : null;
        let note = "";
        if (claim) {
          const reporterPid =
            arg("holder-pid") === undefined ? undefined : Number(arg("holder-pid"));
          const ownedByReporter = reporterPid !== undefined && reporterPid === claim.pid;
          const holderGone = claim.pid !== undefined && !holderLiveness(claim).alive;
          if (ownedByReporter || holderGone) {
            existing.status = "pending";
            existing.claim = null;
            note = ownedByReporter
              ? " (claim released — you are its holder)"
              : " (claim released — its holder is gone)";
          } else {
            note =
              ` — claim KEPT: ${describeHolder(existing)}. Pass --holder-pid to release your own` +
              " claim; otherwise the sweep releases it when that holder dies.";
          }
        }
        save(records);
        console.log(
          `↻ updated ${claim ? "in-flight" : "pending"} record for ${target}; ` +
            `notBefore=${new Date(existing.notBefore).toISOString()}${note}`,
        );
        return;
      }
      records.push(
        recordFor({
          agentId,
          target,
          brief: readFileSync(briefFile, "utf8"),
          notBefore: death.resetAt ?? now,
          wipRef: arg("wip") ?? null,
          reason: `${death.reason} [${death.resetSource}]`,
          now,
        }),
      );
      save(records);
      console.log(
        `✓ recorded ${target}; retry at ${new Date(death.resetAt ?? now).toISOString()} (${death.resetSource})`,
      );
    });
  } else if (cmd === "due") {
    withLedger((records, reclaimed) => {
      const r = dueRecords(records, now);
      // scanned/pending/inFlight/reclaimed are printed unconditionally — see the header.
      console.log(`ledger=${ledgerPath()}`);
      console.log(
        `scanned=${r.scanned} pending=${r.pending} inFlight=${r.inFlight} ` +
          `reclaimed=${reclaimed.length} due=${r.due.length} needsHuman=${r.needsHuman.length}`,
      );
      if (r.scanned === 0) {
        // This assertion is only safe because a NON-RETRYABLE death now records a
        // `needs-human` row. Before that, a run where every agent failed at its
        // task produced this exact output — and it says the recorder did not
        // fire, which was the wrong one of the two. `scanned === 0` now means no
        // death of ANY kind was ever recorded.
        console.log("⚠ the ledger is EMPTY — no death of any kind was recorded, retryable or not.");
        console.log("  If an agent died recently, the RECORDER did not fire. That is a different");
        console.log("  problem from 'nothing to retry', and a more urgent one.");
      }
      for (const rec of reclaimed) {
        console.log(`↺ reclaimed ${rec.target} (${rec.reason}): ${rec.detail}`);
      }
      // Named, not merely counted: "held by a live pid" and "held by nothing
      // checkable" are different situations with very different recovery times,
      // and `inFlight=1` alone renders them the same.
      for (const rec of records) {
        if (rec.status === "in-flight")
          console.log(`⏳ IN FLIGHT ${rec.target} — ${describeHolder(rec)}`);
      }
      for (const rec of r.due) {
        console.log(`\n--- DUE ${rec.target} (attempt ${rec.attempts + 1}/${rec.maxAttempts}) ---`);
        console.log(`agent=${rec.agentId} wip=${rec.wipRef ?? "(none)"} reason=${rec.reason}`);
        console.log(rec.brief);
        console.log(
          `\n(claim it before dispatching: agent-retry.ts bump --target ${rec.target} — an ` +
            "unclaimed record is handed to the next poll too)",
        );
      }
      // Two different reasons a record needs a human, and they are not the same
      // situation: one spent its retries, the other was never retryable at all.
      for (const rec of r.needsHuman) {
        const why =
          rec.status === "needs-human"
            ? "classified NOT retryable — it was never a capacity limit"
            : `${rec.attempts}/${rec.maxAttempts} attempts spent`;
        console.log(`\n✋ NEEDS HUMAN ${rec.target}: ${why}`);
        console.log(`   agent=${rec.agentId} wip=${rec.wipRef ?? "(none)"} reason=${rec.reason}`);
      }
    });
  } else if (cmd === "bump" || cmd === "resolve") {
    const target = arg("target");
    if (!target) {
      console.error(
        cmd === "bump"
          ? "usage: bump --target <key> [--holder-pid <pid of the process running the retry>]"
          : "usage: resolve --target <key>",
      );
      process.exit(2);
    }
    const holderPidRaw = arg("holder-pid");
    const holderPid = holderPidRaw === undefined ? undefined : Number(holderPidRaw);
    if (
      cmd === "bump" &&
      holderPid !== undefined &&
      (!Number.isInteger(holderPid) || holderPid < 1)
    ) {
      console.error(`✗ --holder-pid must be a positive integer, got ${holderPidRaw}`);
      process.exit(2);
    }
    const code = withLedger((records) => {
      if (cmd === "bump") {
        // Only a PENDING record can be claimed. A second bump on an in-flight
        // record is a duplicate dispatch, so it is refused rather than counted.
        const rec = records.find((r) => r.target === target && r.status === "pending");
        if (!rec) {
          const claimed = records.find((r) => r.target === target && r.status === "in-flight");
          if (claimed)
            console.error(
              `✗ ${target} is already in flight (claimed by pid ${claimed.claim?.pid ?? "?"} at ` +
                `${claimed.claim ? new Date(claimed.claim.at).toISOString() : "?"}). ` +
                "Refusing to dispatch it twice.",
            );
          else console.error(`✗ no pending record for ${target}`);
          return 1;
        }
        if (rec.attempts >= rec.maxAttempts) {
          // The cap is enforced HERE too, not only in `due`'s presentation.
          // Review measured `✓ claimed … (attempt 4/3)` exit 0 on a record at
          // 3/3: `due` was reporting needsHuman while a direct `bump` walked
          // straight past it, which makes the cap advice rather than a limit.
          console.error(
            `✗ ${target} has spent its attempt budget (${rec.attempts}/${rec.maxAttempts}). ` +
              "This needs a human, not another retry. Raise maxAttempts in the ledger " +
              "deliberately if that is the call.",
          );
          return 1;
        }
        claimRecord(rec, buildClaim(holderPid));
        save(records);
        console.log(
          `✓ claimed ${target} (attempt ${rec.attempts}/${rec.maxAttempts}, status=${rec.status}). ` +
            "It is OUT of `due` until you resolve it or the claim dies.",
        );
        console.log(`  holder: ${describeHolder(rec)}`);
        if (holderPid === undefined)
          console.log(
            "  ⚠ no --holder-pid: if this retry dies, the record waits out the lease ceiling " +
              "before it is offered again. Pass the pid of the process running the retry.",
          );
        return 0;
      }
      const rec = records.find(
        (r) => r.target === target && (r.status === "pending" || r.status === "in-flight"),
      );
      if (!rec) {
        console.error(`✗ no pending or in-flight record for ${target}`);
        return 1;
      }
      rec.status = "resolved";
      rec.claim = null;
      save(records);
      console.log(`✓ resolve ${target} (attempts=${rec.attempts}, status=${rec.status})`);
      return 0;
    });
    if (code !== 0) process.exit(code);
  } else {
    console.error("usage: agent-retry.ts <record|due|bump|resolve> …");
    process.exit(2);
  }
}

try {
  main();
} catch (e) {
  if (e instanceof LockUnavailableError) {
    // Exit 3, distinct from "no such record" (1) and "bad usage" (2): a caller
    // must be able to tell "someone else is mid-write, try again" from "your
    // request was wrong".
    console.error(`✗ ${e.message}`);
    process.exit(3);
  }
  throw e;
}
