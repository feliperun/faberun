/**
 * `contract.finalVerification` runs once per phase, on whichever phase-terminal
 * node (a node no other node depends on) is the last of them to settle, not on
 * every phase-terminal node. These cases prove that: a phase with two
 * independent terminal nodes runs the suite exactly once, on whichever of them
 * closes last; a single-node contract keeps the old behaviour; and a node
 * retried after its only sibling has already closed keeps carrying the suite
 * on every retry, since the decision is recomputed fresh each time rather than
 * frozen from an earlier attempt.
 *
 * Every run is driven through the replay harness with `maxParallel: 1`, so
 * node order is deterministic and no provider is reached.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { envelope, workerResult, writeRecording } from "../harnesses/replay-helpers.mjs";

/** @param {string} marker @returns {string[]} */
const passing = (marker) => [process.execPath, "-e", "process.exit(0)", marker];

/** @param {{verification?: {commands?: {argv?: string[]}[]}|null}|undefined} state @param {string[]} argv @returns {boolean} */
function carriesCommand(state, argv) {
  return (state?.verification?.commands ?? []).some((command) => Array.isArray(command.argv) && command.argv.join(" ") === argv.join(" "));
}

/**
 * @param {{id: string, nodes: Record<string, unknown>[], worker: unknown[], judge?: unknown[], finalVerification?: unknown[], maxParallel?: number}} options
 */
async function drive({ id, nodes, worker, judge, finalVerification, maxParallel = 1 }) {
  const directory = mkdtempSync(join(tmpdir(), `${id}-`));
  const recordingDir = mkdtempSync(join(tmpdir(), `${id}-rec-`));
  const workerRecording = writeRecording(recordingDir, worker, "worker.jsonl");
  const judgeRecording = writeRecording(recordingDir, judge ?? [
    { envelope: envelope({ result: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "ok", findings: [] }) }) },
  ], "judge.jsonl");
  const contractPath = writeContract(directory, fixture({
    id,
    pollIntervalMs: 10,
    maxParallel,
    ...(finalVerification ? { finalVerification } : {}),
    runtimeDefaults: { worker: "replay-worker", judge: "replay-judge" },
    runtimes: {
      "replay-worker": { harness: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { harness: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor", config: { "replay.recording": judgeRecording } },
    },
    nodes,
  }));
  const outcome = await runContract(contractPath);
  return { directory, contractPath, outcome };
}

test("a three-node contract with two independent terminal nodes runs finalVerification once, on the one that closes last", async () => {
  const finalArgv = passing("final");
  // `maxParallel: 1` makes closing order deterministic: root closes first,
  // then whichever of its two dependants is declared first (alpha), then the
  // other (beta) -- alpha's own verification runs while beta is still
  // pending, so alpha is not last; beta's runs once alpha has already
  // settled, so beta is.
  const { outcome } = await drive({
    id: "two-terminal-nodes",
    finalVerification: [{ argv: finalArgv }],
    worker: [
      { envelope: envelope({ result: JSON.stringify(workerResult("root")) }) },
      { envelope: envelope({ result: JSON.stringify(workerResult("alpha")) }) },
      { envelope: envelope({ result: JSON.stringify(workerResult("beta")) }) },
    ],
    nodes: [
      { id: "root", type: "backend", taskPacket: packet(), gate: false },
      { id: "alpha", type: "backend", taskPacket: packet({ objective: "Alpha" }), dependsOn: ["root"], gate: false },
      { id: "beta", type: "backend", taskPacket: packet({ objective: "Beta" }), dependsOn: ["root"], gate: false },
    ],
  });

  assert.equal(outcome.ok, true);
  const root = outcome.states.get("root");
  const alpha = outcome.states.get("alpha");
  const beta = outcome.states.get("beta");
  assert.equal(root?.status, "done");
  assert.equal(alpha?.status, "done");
  assert.equal(beta?.status, "done");
  assert.equal(carriesCommand(root, finalArgv), false, "a node with dependants never carries finalVerification");
  assert.equal(carriesCommand(alpha, finalArgv), false, "alpha closed while beta was still open, so alpha is not the last to close");
  assert.equal(carriesCommand(beta, finalArgv), true, "beta closed once alpha had already settled, so beta carries the suite");
});

test("a single-node contract still runs finalVerification on its one node", async () => {
  const finalArgv = passing("final-single");
  const { outcome } = await drive({
    id: "single-terminal-node",
    finalVerification: [{ argv: finalArgv }],
    worker: [{ envelope: envelope({ result: JSON.stringify(workerResult("solo")) }) }],
    nodes: [{ id: "solo", type: "backend", taskPacket: packet(), gate: false }],
  });

  assert.equal(outcome.ok, true);
  const solo = outcome.states.get("solo");
  assert.equal(solo?.status, "done");
  assert.deepEqual(solo?.verification?.commands?.at(-1)?.argv, finalArgv);
});

test("a node retried after its only sibling has already closed carries finalVerification again on the retry", async () => {
  const finalArgv = passing("final-retry");
  const { outcome } = await drive({
    id: "retry-after-last-sibling-closed",
    finalVerification: [{ argv: finalArgv }],
    worker: [
      { envelope: envelope({ result: JSON.stringify(workerResult("alpha")) }) },
      { envelope: envelope({ result: JSON.stringify(workerResult("beta try 1")) }) },
      { envelope: envelope({ result: JSON.stringify(workerResult("beta try 2")) }) },
    ],
    judge: [
      { envelope: envelope({ result: JSON.stringify({ verdict: "fail", maxSeverity: "critical", summary: "not acceptable", findings: [{ severity: "critical", description: "the result is not high quality [quality]", evidence: "inspected the diff" }] }) }) },
      { envelope: envelope({ result: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "ok", findings: [] }) }) },
    ],
    nodes: [
      { id: "alpha", type: "backend", taskPacket: packet(), gate: false },
      {
        id: "beta",
        type: "backend",
        taskPacket: packet({ objective: "Beta" }),
        definitionOfDone: [{ id: "quality", text: "the result is high quality", judgment: true }],
        gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
      },
    ],
  });

  assert.equal(outcome.ok, true);
  const alpha = outcome.states.get("alpha");
  const beta = outcome.states.get("beta");
  assert.equal(alpha?.status, "done");
  assert.equal(beta?.status, "done");
  assert.equal(beta?.revisions, 1, "the judge rejected the first attempt once, which is why there is a retry to observe");
  assert.equal(carriesCommand(alpha, finalArgv), false, "alpha is the sibling that closed first and never carries the suite");
  assert.equal(carriesCommand(beta, finalArgv), true, "beta is still the only open phase-terminal node on its retried attempt, so it carries the suite again");
});
