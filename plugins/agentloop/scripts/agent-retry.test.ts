/**
 * CLI-level tests for the retry ledger (arc#6204).
 *
 * WHY THESE EXIST. Review pointed out that every invariant the CLI's own header
 * asserts lived in untested code — `due` always prints `scanned=`, `bump` refuses
 * a second claim, `record` releases a claim only when entitled to, the attempt cap
 * is a limit and not advice, legacy records load, a bad `--now` is refused. Four
 * of the findings in that review were defects in exactly this file. Reasoning
 * about a CLI is not the same as running it, so these run it.
 *
 * The ledger location comes from `AGENTLOOP_RETRY_LEDGER`, so nothing here ever
 * touches the real `.git`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./agent-retry.ts", import.meta.url).pathname;

// Coherent clock. `--now` drives BOTH the due filter and the claim lease, so the
// constants have to be realistic relative to each other: an ad-hoc tiny `--now`
// leaves a parsed reset instant in the far future (nothing is ever due), and an
// ad-hoc huge one blows past the 6h lease and reclaims a claim the test meant to
// hold. Both mistakes were made writing this file, and each looked like a bug in
// the code rather than in the fixture.
const T_SEED = 1757300000000; // 2025-09-08T04:13:20Z
const T_RIPE = 1757400000000; // past the summary's "resets 7pm PT" => 2025-09-09T02:00:00Z
const T_SOON = T_RIPE + 60_000; // still well inside a 6h lease taken at T_RIPE

const REAL_429 =
  "Agent terminated early due to an API error: You've hit your session limit · " +
  "resets 7pm (America/Los_Angeles) (error type rate_limit, HTTP 429, request id req_01X)";
const REAL_TASK_FAILURE =
  "Agent finished: the build fails on main and I could not reproduce the issue; the " +
  "linked issue describes a file that does not exist in this repo.";

interface Bed {
  dir: string;
  ledger: string;
  brief: string;
  summary429: string;
  summaryFail: string;
  run: (...args: string[]) => { code: number; out: string };
  read: () => Array<Record<string, unknown>>;
}

function bed(): Bed {
  const dir = mkdtempSync(join(tmpdir(), "agentloop-retry-cli-"));
  const ledger = join(dir, "agentloop", "retry-ledger.json");
  const brief = join(dir, "brief.txt");
  const summary429 = join(dir, "s429.txt");
  const summaryFail = join(dir, "sfail.txt");
  writeFileSync(brief, "do the thing");
  writeFileSync(summary429, REAL_429);
  writeFileSync(summaryFail, REAL_TASK_FAILURE);
  return {
    dir,
    ledger,
    brief,
    summary429,
    summaryFail,
    run(...args) {
      const p = Bun.spawnSync(["bun", CLI, ...args], {
        env: {
          ...process.env,
          AGENTLOOP_RETRY_LEDGER: ledger,
          // The default 10s lock wait is right in production and wrong here: the
          // contended case would spend 10s proving a held lock is refused, and
          // blow the suite's own 5s per-test budget. Measured — that is exactly
          // how this file first went red in the gate.
          AGENTLOOP_RETRY_LOCK_WAIT_MS: "300",
        },
      });
      return {
        code: p.exitCode,
        out: `${p.stdout.toString()}${p.stderr.toString()}`,
      };
    },
    read: () => JSON.parse(readFileSync(ledger, "utf8")),
  };
}

const seed = (b: Bed, target = "o/r#1", at = String(T_SEED)) =>
  b.run(
    "record",
    "--agent",
    "a1",
    "--target",
    target,
    "--brief-file",
    b.brief,
    "--summary-file",
    b.summary429,
    "--now",
    at,
  );

/** Runs `fn` against a fresh bed and always cleans up. */
function withBed(fn: (b: Bed) => void): void {
  const b = bed();
  try {
    fn(b);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
}

const scannedLine = (out: string) => out.split("\n").find((l) => l.startsWith("scanned="));

describe("agent-retry CLI — the `scanned=` invariant", () => {
  test("`due` prints scanned= on an EMPTY ledger, and says the recorder may not have fired", () => {
    withBed((b) => {
      const r = b.run("due", "--now", String(T_RIPE));
      expect(r.code).toBe(0);
      expect(scannedLine(r.out)).toBe(
        "scanned=0 pending=0 inFlight=0 reclaimed=0 due=0 needsHuman=0",
      );
      expect(r.out).toContain("the ledger is EMPTY");
    });
  });

  test("`due` prints scanned= when the ledger is FULL but nothing is ripe", () => {
    withBed((b) => {
      seed(b);
      const r = b.run("due", "--now", String(T_SEED)); // before the parsed reset instant
      expect(r.code).toBe(0);
      // The whole point: due=0 in both cases, scanned= tells them apart.
      expect(scannedLine(r.out)).toContain("scanned=1");
      expect(scannedLine(r.out)).toContain("due=0");
      expect(r.out).not.toContain("the ledger is EMPTY");
    });
  });

  test("`due` prints scanned= while a claim is in flight", () => {
    withBed((b) => {
      seed(b);
      b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      const r = b.run("due", "--now", String(T_SOON));
      expect(scannedLine(r.out)).toContain("scanned=1");
      expect(scannedLine(r.out)).toContain("inFlight=1");
      expect(r.out).toContain("⏳ IN FLIGHT o/r#1");
    });
  });
});

describe("agent-retry CLI — `--now` must be epoch ms", () => {
  test("REJECT — an ISO timestamp is refused, not silently NaN", () => {
    // Unvalidated, NaN hid every ripe record while still exiting 0 — and `record`
    // persisted `notBefore: null`, which then compares as immediately due.
    withBed((b) => {
      seed(b);
      const r = b.run("due", "--now", "2026-09-11T00:00:00Z");
      expect(r.code).toBe(2);
      expect(r.out).toContain("--now must be epoch milliseconds");
      // And nothing was hidden behind a reassuring green line.
      expect(scannedLine(r.out)).toBeUndefined();
    });
  });

  test("REJECT — `record` refuses it BEFORE writing anything", () => {
    withBed((b) => {
      const r = b.run(
        "record",
        "--agent",
        "a1",
        "--target",
        "o/r#2",
        "--brief-file",
        b.brief,
        "--summary-file",
        b.summary429,
        "--now",
        "tomorrow",
      );
      expect(r.code).toBe(2);
      expect(() => b.read()).toThrow(); // no ledger written at all
    });
  });

  test("ACCEPT — a real epoch value still works (the arm that proves the guard is not blanket)", () => {
    withBed((b) => {
      expect(seed(b).code).toBe(0);
      expect(b.run("due", "--now", String(T_RIPE)).out).toContain("--- DUE o/r#1");
    });
  });
});

describe("agent-retry CLI — the claim", () => {
  test("ACCEPT — bump claims, and the record leaves `due`", () => {
    withBed((b) => {
      seed(b);
      const r = b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      expect(r.code).toBe(0);
      expect(b.read()[0]?.status).toBe("in-flight");
      expect(b.read()[0]?.attempts).toBe(1);
      expect(b.run("due", "--now", String(T_SOON)).out).not.toContain("--- DUE");
    });
  });

  test("REJECT — a second bump on an in-flight record is refused, not counted", () => {
    withBed((b) => {
      seed(b);
      b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      const r = b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_SOON),
      );
      expect(r.code).toBe(1);
      expect(r.out).toContain("already in flight");
      expect(b.read()[0]?.attempts).toBe(1); // NOT 2
    });
  });

  test("REJECT — the attempt cap is a limit, not `due`'s opinion", () => {
    // Measured before the fix: `✓ claimed … (attempt 4/3)` exit 0. `due` reported
    // needsHuman while a direct `bump` walked straight past it.
    withBed((b) => {
      seed(b);
      const recs = b.read();
      const rec = recs[0] as Record<string, unknown>;
      rec.attempts = 3;
      rec.maxAttempts = 3;
      writeFileSync(b.ledger, JSON.stringify(recs));
      const r = b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      expect(r.code).toBe(1);
      expect(r.out).toContain("spent its attempt budget");
      expect(b.read()[0]?.attempts).toBe(3);
      expect(b.read()[0]?.status).toBe("pending");
      // And `due` agrees — the two faces do not disagree about the same record.
      expect(b.run("due", "--now", String(T_RIPE)).out).toContain("NEEDS HUMAN o/r#1");
    });
  });

  test("an unanchored claim is allowed but SAYS SO — it is lease-only to recover", () => {
    withBed((b) => {
      seed(b);
      const r = b.run("bump", "--target", "o/r#1", "--now", String(T_RIPE));
      expect(r.code).toBe(0);
      expect(r.out).toContain("UNANCHORED");
      expect(r.out).toContain("no --holder-pid");
    });
  });

  test("REJECT — a nonsense --holder-pid is refused", () => {
    withBed((b) => {
      seed(b);
      for (const bad of ["notanumber", "0", "-1"]) {
        const r = b.run("bump", "--target", "o/r#1", "--holder-pid", bad, "--now", String(T_RIPE));
        expect(r.code).toBe(2);
      }
      expect(b.read()[0]?.status).toBe("pending");
    });
  });

  test("a dead holder's claim is reclaimed on the next poll, and reported", () => {
    withBed((b) => {
      seed(b);
      b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      // Rewrite the claim to name a pid that cannot exist.
      const recs = b.read();
      (recs[0]?.claim as Record<string, unknown>).pid = 999_999;
      writeFileSync(b.ledger, JSON.stringify(recs));
      const r = b.run("due", "--now", String(T_SOON));
      expect(r.out).toContain("↺ reclaimed o/r#1 (holder-gone)");
      expect(scannedLine(r.out)).toContain("reclaimed=1");
      expect(r.out).toContain("--- DUE o/r#1");
      // The attempt is NOT refunded, so a crash loop still terminates.
      expect(b.read()[0]?.attempts).toBe(1);
    });
  });
});

describe("agent-retry CLI — `record` and a live claim", () => {
  test("REJECT — a death report does NOT un-claim a retry held by a live holder", () => {
    // Measured before the fix: the claim was released unconditionally, so a late
    // or duplicate death report about an already-retried generation un-claimed a
    // running retry and the target went out a second time.
    withBed((b) => {
      seed(b);
      b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      const r = seed(b, "o/r#1", String(T_SOON));
      expect(r.code).toBe(0);
      expect(r.out).toContain("claim KEPT");
      expect(b.read()[0]?.status).toBe("in-flight");
      expect(b.run("due", "--now", String(T_SOON)).out).not.toContain("--- DUE");
    });
  });

  test("ACCEPT — the claim's OWN holder may release it by naming itself", () => {
    // The accept twin. Without it, a `record` hardwired to never release would
    // satisfy the reject test above.
    withBed((b) => {
      seed(b);
      b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      const p = Bun.spawnSync(
        [
          "bun",
          CLI,
          "record",
          "--agent",
          "a1",
          "--target",
          "o/r#1",
          "--brief-file",
          b.brief,
          "--summary-file",
          b.summary429,
          "--now",
          String(T_SOON),
          "--holder-pid",
          String(process.pid),
        ],
        {
          env: { ...process.env, AGENTLOOP_RETRY_LEDGER: b.ledger },
        },
      );
      expect(`${p.stdout.toString()}`).toContain("claim released — you are its holder");
      expect(b.read()[0]?.status).toBe("pending");
    });
  });
});

describe("agent-retry CLI — refusing to guess", () => {
  test("a non-retryable death records NOTHING and says a human is needed", () => {
    withBed((b) => {
      const r = b.run(
        "record",
        "--agent",
        "a1",
        "--target",
        "o/r#3",
        "--brief-file",
        b.brief,
        "--summary-file",
        b.summaryFail,
        "--now",
        String(T_SEED),
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain("NOT retryable (task-failure)");
      // It gets a ROW. See the colour-collision block below for why.
      expect(b.read()[0]?.status).toBe("needs-human");
    });
  });

  test("REJECT — a needs-human row is never due and never claimable", () => {
    withBed((b) => {
      b.run(
        "record",
        "--agent",
        "a1",
        "--target",
        "o/r#3",
        "--brief-file",
        b.brief,
        "--summary-file",
        b.summaryFail,
        "--now",
        String(T_SEED),
      );
      const due = b.run("due", "--now", String(T_RIPE));
      expect(due.out).not.toContain("--- DUE");
      expect(scannedLine(due.out)).toContain("due=0");
      expect(b.run("bump", "--target", "o/r#3", "--now", String(T_RIPE)).code).toBe(1);
    });
  });

  test("POSITIVE CONTROL — a run of pure task failures is not a dead recorder", () => {
    // This module's own thesis turned on itself. Before the fix, `record` wrote
    // nothing on a non-retryable death, so `due` after a run where EVERY agent
    // failed at its task printed `scanned=0` plus "the ledger is EMPTY … the
    // recorder did not fire" — byte-identical to a recorder that never ran, and
    // asserting the wrong one of the two.
    withBed((b) => {
      for (const t of ["o/r#1", "o/r#2", "o/r#3"])
        b.run(
          "record",
          "--agent",
          "a1",
          "--target",
          t,
          "--brief-file",
          b.brief,
          "--summary-file",
          b.summaryFail,
          "--now",
          String(T_SEED),
        );
      const r = b.run("due", "--now", String(T_RIPE));
      expect(scannedLine(r.out)).toContain("scanned=3");
      expect(scannedLine(r.out)).toContain("needsHuman=3");
      expect(r.out).not.toContain("the ledger is EMPTY");
      expect(r.out).toContain("classified NOT retryable");
    });
  });

  test("DISCRIMINATES — three task failures and an untouched ledger differ on `due`", () => {
    const outs: string[] = [];
    withBed((b) => {
      for (const t of ["o/r#1", "o/r#2", "o/r#3"])
        b.run(
          "record",
          "--agent",
          "a1",
          "--target",
          t,
          "--brief-file",
          b.brief,
          "--summary-file",
          b.summaryFail,
          "--now",
          String(T_SEED),
        );
      outs.push(b.run("due", "--now", String(T_RIPE)).out);
    });
    withBed((b) => outs.push(b.run("due", "--now", String(T_RIPE)).out));
    const [failures, neverRan] = [outs[0] ?? "", outs[1] ?? ""];
    // Both have due=0 — that was never the discriminator.
    expect(scannedLine(failures)).toContain("due=0");
    expect(scannedLine(neverRan)).toContain("due=0");
    // These are the two facts that must not share a colour.
    expect(scannedLine(failures)).not.toBe(scannedLine(neverRan));
    expect(failures).not.toContain("the RECORDER did not fire");
    expect(neverRan).toContain("the RECORDER did not fire");
  });

  test("two kinds of needs-human are told apart, not merged into one count", () => {
    withBed((b) => {
      b.run(
        "record",
        "--agent",
        "a1",
        "--target",
        "fail",
        "--brief-file",
        b.brief,
        "--summary-file",
        b.summaryFail,
        "--now",
        String(T_SEED),
      );
      seed(b, "capped");
      const recs = b.read();
      const capped = recs.find((x) => x.target === "capped") as Record<string, unknown>;
      capped.attempts = 3;
      capped.maxAttempts = 3;
      writeFileSync(b.ledger, JSON.stringify(recs));
      const r = b.run("due", "--now", String(T_RIPE));
      expect(scannedLine(r.out)).toContain("needsHuman=2");
      expect(r.out).toContain("NEEDS HUMAN fail: classified NOT retryable");
      expect(r.out).toContain("NEEDS HUMAN capped: 3/3 attempts spent");
    });
  });

  test("a non-retryable report does NOT disturb an in-flight retry for the same target", () => {
    withBed((b) => {
      seed(b);
      b.run(
        "bump",
        "--target",
        "o/r#1",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      const r = b.run(
        "record",
        "--agent",
        "a1",
        "--target",
        "o/r#1",
        "--brief-file",
        b.brief,
        "--summary-file",
        b.summaryFail,
        "--now",
        String(T_SOON),
      );
      expect(r.out).toContain("leaving its claim alone");
      expect(b.read()[0]?.status).toBe("in-flight");
    });
  });

  test("a corrupt ledger must NOT read as an empty one", () => {
    withBed((b) => {
      seed(b); // creates the directory
      writeFileSync(b.ledger, "{not json");
      const r = b.run("due", "--now", String(T_RIPE));
      expect(r.code).toBe(2);
      expect(r.out).toContain("unreadable");
      expect(scannedLine(r.out)).toBeUndefined();
    });
  });

  test("valid JSON that is not an array is likewise refused", () => {
    withBed((b) => {
      seed(b);
      writeFileSync(b.ledger, '{"records":[]}');
      const r = b.run("due", "--now", String(T_RIPE));
      expect(r.code).toBe(2);
      expect(r.out).toContain("not a JSON array");
    });
  });
});

describe("agent-retry CLI — records written before the claim state", () => {
  test("a legacy record with no `claim` field loads, is offered, and is claimable", () => {
    withBed((b) => {
      seed(b); // make the directory, then overwrite with a legacy shape
      writeFileSync(
        b.ledger,
        JSON.stringify([
          {
            target: "legacy",
            agentId: "a",
            brief: "old brief",
            wipRef: null,
            notBefore: 100,
            attempts: 0,
            maxAttempts: 3,
            status: "pending",
            recordedAt: 1,
            reason: "written before in-flight existed",
          },
        ]),
      );
      const due = b.run("due", "--now", String(T_RIPE));
      expect(scannedLine(due.out)).toContain("scanned=1");
      expect(due.out).toContain("--- DUE legacy");
      const r = b.run(
        "bump",
        "--target",
        "legacy",
        "--holder-pid",
        String(process.pid),
        "--now",
        String(T_RIPE),
      );
      expect(r.code).toBe(0);
      expect(b.read()[0]?.status).toBe("in-flight");
    });
  });
});

describe("agent-retry CLI — a lock it cannot take", () => {
  test("exit 3, distinct from a bad request (2) and a missing record (1)", () => {
    withBed((b) => {
      seed(b);
      // A live holder (this test process) that is nowhere near the stale ceiling.
      writeFileSync(
        `${b.ledger}.lock`,
        `${JSON.stringify({ pid: process.pid, at: Date.now(), purpose: "another gate", cwd: "/x" })}\n`,
      );
      const r = b.run("due", "--now", String(T_RIPE));
      expect(r.code).toBe(3);
      expect(r.out).toContain("REFUSING to proceed");
      expect(r.out).toContain(`pid ${process.pid}`);
      // The refusal is the whole point: nothing was read or written unguarded.
      expect(scannedLine(r.out)).toBeUndefined();
    });
  });

  test("a bad AGENTLOOP_RETRY_LOCK_WAIT_MS falls back, it does not become NaN", () => {
    // `waited >= NaN` is false, so a NaN ceiling means the wait never ends — the
    // `--now` trap one layer down. The fallback must be loud, not silent.
    withBed((b) => {
      seed(b);
      const p = Bun.spawnSync(["bun", CLI, "due", "--now", String(T_RIPE)], {
        env: {
          ...process.env,
          AGENTLOOP_RETRY_LEDGER: b.ledger,
          AGENTLOOP_RETRY_LOCK_WAIT_MS: "soon",
        },
      });
      expect(p.exitCode).toBe(0);
      expect(p.stderr.toString()).toContain("using the default");
      expect(scannedLine(p.stdout.toString())).toContain("scanned=1");
    });
  });

  test("a lock left by a process that no longer exists does NOT wedge the ledger", () => {
    withBed((b) => {
      seed(b);
      writeFileSync(
        `${b.ledger}.lock`,
        `${JSON.stringify({ pid: 999_999, at: Date.now(), purpose: "killed -9", cwd: "/x" })}\n`,
      );
      const r = b.run("due", "--now", String(T_RIPE));
      expect(r.code).toBe(0);
      expect(scannedLine(r.out)).toContain("scanned=1");
    });
  });
});
