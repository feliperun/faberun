/**
 * F5 admission holds a node's slot from its spawn until its settle completes,
 * so a node whose worker exited but whose controller verification (and, by
 * the same mechanism, its judge round or a resumed re-ask) is still running
 * keeps the slot its dispatch reserved. `maxParallel: 1` makes that hold the
 * whole run: a sibling reaching `running` only after the settle closes proves
 * the window is honoured, and both nodes finishing proves the hold is a wait,
 * not a wedge.
 *
 * The overlap tests drive `maxParallel: 2`: a settlement now parks for the
 * length of its controller verification (`engine/settlement-overlap.mjs`), so
 * two nodes' proofs in independent worktrees run at the same time -- proven
 * by rendezvous markers each pass waits on, never by a clock -- while a third
 * node's proof cannot start until a settled node has actually released its
 * slot.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";
import { ensureAttemptWorktree, fixture, packet, waitForValue, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

test("a sibling waits for the settle window while the first node's controller verification is blocked, and dispatches once it settles", async () => {
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
  const runDir = runDirectory(directory, "dispatch-during-verification-run");
  const firstSnapshotPath = join(runDir, "nodes", "first.json");
  const secondSnapshotPath = join(runDir, "nodes", "second.json");
  const outcome = withFakeCodex(directory, "pass", () => runContract(path));
  try {
    // The settle window opens the moment `first`'s controller verification
    // starts its blocked command, and the node holds the run's only slot for
    // as long as it stays open.
    await waitForValue(() => {
      if (!existsSync(firstSnapshotPath)) return null;
      const state = JSON.parse(readFileSync(firstSnapshotPath, "utf8"));
      return state.verification?.progress ? state : null;
    }, 20_000, 10);
    const second = existsSync(secondSnapshotPath) ? JSON.parse(readFileSync(secondSnapshotPath, "utf8")) : null;
    assert.ok(!second || second.status === "pending", `second left the queue while first's controller verification was still blocked on the gate file: ${second && second.status}`);
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

test("two nodes' controller verifications overlap through a real run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-overlapping-proofs-"));
  const signals = mkdtempSync(join(tmpdir(), "runner-overlapping-proofs-signals-"));
  /** @param {string} name @returns {string} */
  const marker = (name) => join(signals, name);
  // Rendezvous proof: each pass records that it started, then waits for the
  // other pass's start marker before it may finish. The first pass therefore
  // cannot complete until the second has begun, and the second can only have
  // begun while the first was still in flight -- that concurrence is the
  // overlap itself, read off durable markers instead of a clock. A settlement
  // chain that serialized the passes again would deadlock them into their own
  // 20s timeouts, fail both nodes, and fail every assertion below; no
  // assertion here bounds a duration from above.
  /** @param {string} id @param {string} other @returns {string} */
  const rendezvous = (id, other) => `const fs=require("fs");fs.writeFileSync(${JSON.stringify(marker(`${id}-started`))},"started\\n");const theirs=${JSON.stringify(marker(`${other}-started`))};while(!fs.existsSync(theirs)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}fs.writeFileSync(${JSON.stringify(marker(`${id}-done`))},"done\\n");`;
  const path = writeContract(directory, fixture({
    id: "overlapping-proofs-run",
    pollIntervalMs: 10,
    maxParallel: 2,
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", rendezvous("alpha", "beta")], timeoutSec: 20 }] }), gate: false },
      { id: "beta", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", rendezvous("beta", "alpha")], timeoutSec: 20 }] }), gate: false },
    ],
  }));
  // Both nodes settle all the way through integration, so their passes also
  // run a second time against the candidate worktree; the markers are already
  // there by then, so that pass exits immediately.
  const outcome = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(outcome.ok, true);
  assert.equal(nodeState(outcome, "alpha").status, "done", nodeState(outcome, "alpha").error?.message);
  assert.equal(nodeState(outcome, "beta").status, "done", nodeState(outcome, "beta").error?.message);
  // The revisions are what turns the rendezvous into the proof: a chain that
  // serialized the passes would time out the first one, spend that node's one
  // revision, and still finish green an attempt later -- done statuses and
  // markers alone would not catch it. Zero revisions means each node's only
  // proof passed, and a pass could only complete once the other's had started.
  assert.equal(nodeState(outcome, "alpha").revisions, 0, "alpha spent a revision its proof would not have needed had the passes overlapped");
  assert.equal(nodeState(outcome, "beta").revisions, 0, "beta spent a revision its proof would not have needed had the passes overlapped");
  assert.ok(existsSync(marker("alpha-started")), "alpha's controller verification pass ran");
  assert.ok(existsSync(marker("beta-started")), "beta's controller verification pass ran");
  assert.ok(existsSync(marker("alpha-done")), "alpha's pass completed, which it can only do once beta's had started");
  assert.ok(existsSync(marker("beta-done")), "beta's pass completed, which it can only do once alpha's had started");
});

test("a third node's proof cannot start while two settlements hold the run's slots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-proof-bound-"));
  const signals = mkdtempSync(join(tmpdir(), "runner-proof-bound-signals-"));
  /** @param {string} name @returns {string} */
  const marker = (name) => join(signals, name);
  /** @param {string} id @param {string} other @returns {string} */
  const rendezvous = (id, other) => `const fs=require("fs");fs.writeFileSync(${JSON.stringify(marker(`${id}-started`))},"started\\n");const theirs=${JSON.stringify(marker(`${other}-started`))};while(!fs.existsSync(theirs)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}fs.writeFileSync(${JSON.stringify(marker(`${id}-done`))},"done\\n");`;
  // gamma's proof checks, at start, that a fully settled node's own proof has
  // already completed: its worker cannot even be dispatched until a slot
  // frees, and the settle window holds alpha's and beta's slots through their
  // whole settlements, so the marker is there by construction. Finding it
  // missing means the overlap ran past `maxParallel`.
  const gammaProof = `const fs=require("fs");const settled=fs.existsSync(${JSON.stringify(marker("alpha-done"))})||fs.existsSync(${JSON.stringify(marker("beta-done"))});if(!settled){fs.writeFileSync(${JSON.stringify(marker("violation"))},"a third proof started with both slots still held\\n");}fs.writeFileSync(${JSON.stringify(marker("gamma-started"))},"started\\n");`;
  const path = writeContract(directory, fixture({
    id: "proof-bound-run",
    pollIntervalMs: 10,
    maxParallel: 2,
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", rendezvous("alpha", "beta")], timeoutSec: 20 }] }), gate: false },
      { id: "beta", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", rendezvous("beta", "alpha")], timeoutSec: 20 }] }), gate: false },
      { id: "gamma", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", gammaProof] }] }), gate: false },
    ],
  }));
  const outcome = await withFakeCodex(directory, "pass", () => runContract(path));
  assert.equal(outcome.ok, true);
  for (const id of ["alpha", "beta", "gamma"]) {
    assert.equal(nodeState(outcome, id).status, "done", nodeState(outcome, id).error?.message);
    // Same detector as the overlap test: a serialized pass would time out and
    // burn its one revision while still finishing green.
    assert.equal(nodeState(outcome, id).revisions, 0, `${id} spent a revision; its proof should never have waited out a sibling`);
  }
  assert.ok(existsSync(marker("gamma-started")), "gamma's proof ran");
  assert.ok(!existsSync(marker("violation")), "gamma's proof ran while alpha's and beta's settlements still held both slots");
});

test("a sibling is dispatched while a resumed judge re-ask is still blocked on its own mechanical gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-dispatch-during-judge-reask-"));
  // Armed only for the resumed re-ask: absent, the mechanical proof passes at
  // once, which is what the initial run (below) needs from its two judge
  // attempts so `build` reaches `judge_unavailable` without ever blocking.
  const armMarker = join(directory, "gate-proof-armed");
  const gateFile = join(directory, "gate-proof-release");
  const proofStarted = join(directory, "gate-proof-started");
  const pollScript = `const fs=require("fs");const armed=${JSON.stringify(armMarker)};const gate=${JSON.stringify(gateFile)};if(fs.existsSync(armed)){fs.writeFileSync(${JSON.stringify(proofStarted)},"polling\\n");while(!fs.existsSync(gate)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}}`;
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
          { id: "gate-proof", text: "a mechanical proof that blocks once armed", proof: { kind: "command", ref: `"${process.execPath}" -e ${JSON.stringify(pollScript)}` } },
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
  const runDir = runDirectory(directory, "dispatch-during-judge-reask-run");
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
  // reach `pending` at the top of the resumed loop. `maxParallel: 1` and the
  // re-ask's own dispatch mean `second` stays queued until `build`'s settle
  // window closes -- the re-ask is blocked on its mechanical proof below, and
  // its slot is held for exactly that long.
  unlinkSync(secondShouldFail);
  writeFileSync(armMarker, "armed\n");
  const secondSnapshotPath = join(runDir, "nodes", "second.json");
  const resumed = withFakeCodex(directory, "pass", () => resumeRun(runDir));
  try {
    // The armed proof is the one durable signal that the re-ask's settle
    // window is open: `startJudge` runs the mechanical gate before it
    // transitions the node, so while the proof is blocked the snapshot still
    // reads `pending` and the reservation the dispatch pass took lives only
    // in memory (`settling`). The marker is written by the proof child itself
    // the moment it starts polling -- strictly after the dispatch decision
    // that reserved the slot -- so the wait below is a state `build`
    // provably sits in, not a guess about how far the queue has run.
    await waitForValue(() => (existsSync(proofStarted) ? {} : null), 20_000, 10);
    const second = existsSync(secondSnapshotPath) ? JSON.parse(readFileSync(secondSnapshotPath, "utf8")) : null;
    assert.ok(!second || second.status === "pending", `second left the queue while build's re-ask was still blocked on its own mechanical gate: ${second && second.status}`);
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
  const runDir = runDirectory(directory, "background-settlement-reject-run");
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
