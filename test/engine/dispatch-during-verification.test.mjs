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
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";
import { ensureAttemptWorktree, fixture, packet, waitForValue, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

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

test("a sibling is dispatched while a resumed judge re-ask is still blocked on its own mechanical gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-dispatch-during-judge-reask-"));
  // Armed only for the resumed re-ask: absent, the mechanical proof passes at
  // once, which is what the initial run (below) needs from its two judge
  // attempts so `build` reaches `judge_unavailable` without ever blocking.
  const armMarker = join(directory, "gate-proof-armed");
  const gateFile = join(directory, "gate-proof-release");
  const pollScript = `const fs=require("fs");const armed=${JSON.stringify(armMarker)};const gate=${JSON.stringify(gateFile)};if(fs.existsSync(armed)){while(!fs.existsSync(gate)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}}`;
  // `second`'s own verification, armed only for the initial run: it must fail
  // there so resume has a fresh dispatch to reopen, and pass once resumed so
  // the run can actually finish.
  const secondShouldFail = join(directory, "second-should-fail");
  const secondVerifyScript = `process.exit(require("fs").existsSync(${JSON.stringify(secondShouldFail)}) ? 2 : 0)`;
  const path = writeContract(directory, fixture({
    id: "dispatch-during-judge-reask-run",
    pollIntervalMs: 10,
    maxParallel: 1,
    nodes: [
      {
        id: "build",
        type: "backend",
        taskPacket: packet(),
        definitionOfDone: [
          { id: "gate-proof", text: "a mechanical proof that blocks once armed", proof: { kind: "command", ref: `${process.execPath} -e ${JSON.stringify(pollScript)}` } },
          { id: "works", text: "the result is high quality", judgment: true },
        ],
        gate: { review: "blocking", failOn: ["major", "critical"] },
      },
      {
        id: "second",
        type: "backend",
        taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", secondVerifyScript] }] }),
        gate: false,
      },
    ],
  }));
  const runDir = join(directory, ".runs", "dispatch-during-judge-reask-run");
  writeFileSync(secondShouldFail, "armed\n");
  // `build`'s judge invocation itself fails twice (the bounded re-ask, then
  // the one automatic retry), settling `judge_unavailable` with the accepted
  // worker result preserved; its own mechanical proof is unarmed here, so
  // neither of those two attempts ever blocks on the gate file.
  const initial = await withFakeCodex(directory, "judge-fail", () => runContract(path));
  assert.equal(initial.ok, false);
  const build = nodeState(initial, "build");
  assert.equal(build.status, "blocked", build.error?.message);
  assert.equal(build.error?.code, "judge_unavailable");
  const acceptedResult = build.result;
  const second = nodeState(initial, "second");
  assert.equal(second.status, "failed", second.error?.message);

  // Resume classifies `build` as a rejudge (its worker result is preserved,
  // only the arbitration is missing) and `second` as an ordinary retry: both
  // reach `pending` at the top of the resumed loop. `maxParallel: 1` means
  // `second` can only dispatch this tick if `build`'s own re-ask -- blocked
  // on its mechanical proof below -- is not occupying the run's one slot.
  unlinkSync(secondShouldFail);
  writeFileSync(armMarker, "armed\n");
  const secondSnapshotPath = join(runDir, "nodes", "second.json");
  const resumed = withFakeCodex(directory, "pass", () => resumeRun(runDir));
  try {
    await waitForValue(() => {
      if (!existsSync(secondSnapshotPath)) return null;
      const state = JSON.parse(readFileSync(secondSnapshotPath, "utf8"));
      return state.status === "running" || state.status === "done" ? state : null;
    }, 20_000, 10);
    assert.equal(existsSync(gateFile), false, "second dispatched into the freed slot while build's re-ask was still blocked on its own mechanical gate");
  } finally {
    writeFileSync(gateFile, "release\n");
  }
  const result = await resumed;
  const after = nodeState(result, "build");
  assert.equal(after.status, "done", after.error?.message);
  assert.deepEqual(after.result, acceptedResult, "the accepted worker result survived the rejudge");
  assert.equal(nodeState(result, "second").status, "done", nodeState(result, "second").error?.message);
});

test("a background settlement that rejects fails the run instead of a clean exit swallowing it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-background-settlement-reject-"));
  const path = writeContract(directory, fixture({
    id: "background-settlement-reject-run",
    pollIntervalMs: 10,
    // An empty Definition of Done reaches `done` -- and, once rewound and
    // rejudged below, reaches its second `done` -- without ever spawning a
    // judge invocation (see "skips the judge for an empty Definition of Done
    // checklist" in judge.test.mjs): the rejudge below is carried entirely by
    // `settlementQueue`, the same queue this node's fix routes the re-ask
    // dispatch through, with nothing else in flight to confound which
    // settlement produced the failure.
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [], gate: { failOn: ["critical"] } }],
  }));
  const runDir = join(directory, ".runs", "background-settlement-reject-run");
  const finished = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(finished.ok, true);
  const accepted = nodeState(finished);
  assert.equal(accepted.status, "done", accepted.error?.message);

  // Rewind to the shape a `judge_unavailable` block leaves: resume classifies
  // this as a rejudge from the preserved worker result, with only the
  // arbitration missing -- the same dispatch this node's fix now routes
  // through `settlementQueue` instead of awaiting inline.
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  state.status = "blocked";
  state.phase = "judge";
  state.error = { code: "judge_unavailable", message: "no available runtime remains for judge" };
  state.worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify(state, null, 2));

  const previousInterrupt = process.env.FABERUN_INTEGRATION_INTERRUPT;
  process.env.FABERUN_INTEGRATION_INTERRUPT = "after-state";
  try {
    await assert.rejects(
      () => withFakeCodex(directory, "pass", () => resumeRun(runDir)),
      /integration interrupted after node state write/u,
    );
  } finally {
    if (previousInterrupt === undefined) delete process.env.FABERUN_INTEGRATION_INTERRUPT;
    else process.env.FABERUN_INTEGRATION_INTERRUPT = previousInterrupt;
  }
});
