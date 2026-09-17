/**
 * A node's controller verification (and, by the same mechanism, its judge
 * round) must not hold up dispatching a sibling into a slot its own exited
 * worker already freed. `maxParallel: 1` makes that freed slot the only one
 * available, so a sibling reaching `running` proves the loop stopped
 * serializing settlement across nodes rather than merely running two workers
 * concurrently from the start.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, waitForValue, withFakeCodex, writeContract } from "../helpers.mjs";

test("a sibling is dispatched into the freed slot while the first node's controller verification is still blocked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-dispatch-during-verification-"));
  const gateFile = join(directory, "verification-gate");
  // The first node's own verification command, not a fixture stand-in: it
  // blocks in its own child process until the gate file the test writes later
  // exists, polling rather than sleeping a fixed duration so it releases the
  // instant the test says to and never bounds how long that takes.
  const pollScript = `const fs=require("fs");const gate=${JSON.stringify(gateFile)};while(!fs.existsSync(gate)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}`;
  const path = writeContract(directory, fixture({
    id: "dispatch-during-verification-run",
    pollIntervalMs: 10,
    maxParallel: 1,
    nodes: [
      {
        id: "first",
        type: "backend",
        taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", pollScript], timeoutSec: 20 }] }),
        gate: false,
      },
      { id: "second", type: "backend", taskPacket: packet(), gate: false },
    ],
  }));
  const runDir = join(directory, ".runs", "dispatch-during-verification-run");
  const secondSnapshotPath = join(runDir, "nodes", "second.json");
  const outcome = withFakeCodex(directory, "pass", () => runContract(path));
  try {
    // Poll rather than await a fixed delay: the assertion below only holds if
    // `second` reaches `running` before the gate file exists, in whichever
    // order the two events actually land, however long that takes.
    await waitForValue(() => {
      if (!existsSync(secondSnapshotPath)) return null;
      const state = JSON.parse(readFileSync(secondSnapshotPath, "utf8"));
      return state.status === "running" || state.status === "done" ? state : null;
    }, 20_000, 10);
    assert.equal(existsSync(gateFile), false, "second dispatched into the freed slot while first's controller verification was still blocked on the gate file");
  } finally {
    // Whether the assertion above passed or failed, the first node's
    // verification process is still polling and must be released so the run
    // (and this test) can finish instead of hanging on its own timeout.
    writeFileSync(gateFile, "release\n");
  }
  const result = await outcome;
  assert.equal(result.states.get("first")?.status, "done", result.states.get("first")?.error?.message);
  assert.equal(result.states.get("second")?.status, "done", result.states.get("second")?.error?.message);
});
