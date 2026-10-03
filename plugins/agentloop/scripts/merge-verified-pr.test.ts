#!/usr/bin/env bun
/**
 * Runs merge-verified-pr.test.sh under `bun test`, so the gate that picks this
 * package's tests runs the merge script's suite too (it was a bare .sh nobody
 * invoked). Run with a factory run's env on purpose (arc#7662): the suite must
 * be hermetic about ARC_CODE_AGENT_RUN_ID / ARC_FACTORY_ALLOW_SELF_MERGE, or a
 * gate inside a Factory run would see the accept cases refused.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

test("merge-verified-pr.test.sh passes, also when run inside a factory run's env", () => {
  const p = Bun.spawnSync(["bash", join(import.meta.dir, "merge-verified-pr.test.sh")], {
    env: {
      ...process.env,
      ARC_CODE_AGENT_RUN_ID: "agent-suite0000",
      ARC_FACTORY_ALLOW_SELF_MERGE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${p.stdout.toString()}\n${p.stderr.toString()}`;
  expect({ exit: p.exitCode, tail: out.trim().split("\n").slice(-5) }).toEqual({
    exit: 0,
    tail: expect.arrayContaining(["ok"]),
  });
});
