/**
 * `contract.sharedVerification` is the contract-level command set appended to
 * every node's verification. These cases prove the merge order (packet, then
 * shared, then finalVerification), that a shared command that fails on one
 * node's workspace fails only that node, that the heartbeat budget counts the
 * set on both the attempt and the candidate, and that `preflight
 * --time-verification` measures it once.
 *
 * The run is driven through the replay harness, so no provider is reached and
 * every case is deterministic.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeBudgetBasisMs, verificationBudgetMs, runContract } from "../../src/engine/scheduler.mjs";
import { declaredVerificationCommands, timeVerificationCommands } from "../../src/host/preflight.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { envelope, workerResult, writeRecording } from "../harnesses/replay-helpers.mjs";

/** @param {string} marker @returns {string[]} */
const passing = (marker) => [process.execPath, "-e", "process.exit(0)", marker];

/**
 * @param {{id: string, nodes: Record<string, unknown>[], worker: unknown[], sharedVerification?: unknown[], finalVerification?: unknown[]}} options
 */
async function drive({ id, nodes, worker, sharedVerification, finalVerification }) {
  const directory = mkdtempSync(join(tmpdir(), `${id}-`));
  const recordingDir = mkdtempSync(join(tmpdir(), `${id}-rec-`));
  const workerRecording = writeRecording(recordingDir, worker, "worker.jsonl");
  const judgeRecording = writeRecording(recordingDir, [
    envelope({ result: JSON.stringify({ verdict: "pass", maxSeverity: "none", summary: "ok", findings: [] }) }),
  ], "judge.jsonl");
  const contractPath = writeContract(directory, fixture({
    id,
    pollIntervalMs: 10,
    ...(sharedVerification ? { sharedVerification } : {}),
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

test("shared verification runs on every node and precedes final verification on the phase-terminal node", async () => {
  const packetArgv = passing("packet");
  const sharedArgv = passing("shared");
  const finalArgv = passing("final");
  const { outcome } = await drive({
    id: "shared-chain",
    sharedVerification: [{ argv: sharedArgv }],
    finalVerification: [{ argv: finalArgv }],
    worker: [
      { envelope: envelope({ result: JSON.stringify(workerResult("first")) }) },
      { envelope: envelope({ result: JSON.stringify(workerResult("terminal")) }) },
    ],
    nodes: [
      { id: "first", type: "backend", taskPacket: packet({ verification: [{ argv: packetArgv }] }), gate: false },
      { id: "terminal", type: "backend", taskPacket: packet({ objective: "Terminal", verification: [{ argv: packetArgv }] }), dependsOn: ["first"], gate: false },
    ],
  });

  assert.equal(outcome.ok, true);
  const first = outcome.states.get("first");
  const terminal = outcome.states.get("terminal");
  assert.deepEqual(
    first?.verification?.commands?.map((command) => command.argv),
    [packetArgv, sharedArgv],
    "a node with a dependant runs its packet commands then the shared set",
  );
  assert.deepEqual(
    terminal?.verification?.commands?.map((command) => command.argv),
    [packetArgv, sharedArgv, finalArgv],
    "the phase-terminal node runs the shared set before its final verification",
  );
});

test("a shared command that fails one workspace fails only the node whose attempt ran it", async () => {
  const packetArgv = passing("packet");
  // The ratchet is workspace-sensitive: it is red only where the offending
  // node's worker left offend.txt, so the clean node cannot inherit the failure.
  const sharedArgv = [process.execPath, "-e", "process.exit(require('node:fs').existsSync('offend.txt') ? 1 : 0)"];
  const { outcome } = await drive({
    id: "shared-offender",
    sharedVerification: [{ argv: sharedArgv }],
    worker: [
      { envelope: envelope({ result: JSON.stringify(workerResult("offender")) }), files: [{ path: "offend.txt", content: "breaks the ratchet\n" }] },
      { envelope: envelope({ result: JSON.stringify(workerResult("clean")) }) },
    ],
    nodes: [
      // Two scripted worker envelopes, one per node: no revision, or the
      // offender's retry would dispatch a third worker the script has no
      // answer for. What is measured is the first attempt's shared result.
      { id: "offender", type: "backend", taskPacket: packet({ writeFiles: ["offend.txt"], verification: [{ argv: packetArgv }] }), gate: { enabled: false, maxRevisions: 0 } },
      { id: "clean", type: "backend", taskPacket: packet({ objective: "Clean", verification: [{ argv: packetArgv }] }), gate: { enabled: false, maxRevisions: 0 } },
    ],
  });

  const offender = outcome.states.get("offender");
  const clean = outcome.states.get("clean");
  assert.equal(offender?.status, "failed", "the offending node fails on its own attempt");
  assert.equal(offender?.verification?.passed, false);
  assert.deepEqual(offender?.verification?.commands?.[1].argv, sharedArgv);
  assert.equal(offender?.verification?.commands?.[1].passed, false);
  assert.equal(clean?.status, "done", "the clean node still passes");
  assert.equal(clean?.verification?.passed, true);
  assert.deepEqual(clean?.verification?.commands?.map((command) => command.argv), [packetArgv, sharedArgv]);
});

test("the heartbeat budget counts the shared set on the attempt and the candidate, including repeat", () => {
  const node = { timeoutSec: 60, taskPacket: { verification: [] }, definitionOfDone: [], gate: { enabled: false } };
  const delta = nodeBudgetBasisMs(/** @type {any} */ ({ timeoutSec: 60, sharedVerification: [{ argv: ["ratchet"], timeoutSec: 10, repeat: 3 }] }), /** @type {any} */ (node))
    - nodeBudgetBasisMs(/** @type {any} */ ({ timeoutSec: 60 }), /** @type {any} */ (node));
  assert.equal(delta, 60_000, "10s x repeat 3 runs on the attempt and again on the integration candidate");
  assert.equal(verificationBudgetMs([{ argv: ["ratchet"], timeoutSec: 10, repeat: 3 }]), 30_000);
});

test("preflight times the shared verification once, under sharedVerification", () => {
  const directory = mkdtempSync(join(tmpdir(), "shared-preflight-"));
  const path = writeContract(directory, fixture({
    id: "shared-preflight",
    sharedVerification: [{ argv: ["shared-ratchet"], timeoutSec: 120 }],
    nodes: [
      { id: "one", type: "backend", taskPacket: packet({ verification: [{ argv: ["node-one"] }] }), gate: false },
      { id: "two", type: "backend", taskPacket: packet({ objective: "Two", verification: [{ argv: ["node-two"] }] }), gate: false },
    ],
  }));
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);

  const declared = declaredVerificationCommands(contract);
  const shared = declared.filter((command) => command.argv[0] === "shared-ratchet");
  assert.equal(shared.length, 1, "the contract-wide set is one distinct declaration");
  assert.deepEqual(shared[0].nodes, ["sharedVerification"]);

  /** @type {string[]} */
  const invoked = [];
  let clock = 0;
  const checks = timeVerificationCommands(contract, {
    now: () => clock,
    run: /** @type {any} */ (/** @param {string} file */ (file) => {
      invoked.push(file);
      clock += 1_000;
      return { status: 0, signal: null };
    }),
  });
  assert.equal(invoked.filter((file) => file === "shared-ratchet").length, 1, "measured once, not once per node");
  assert.ok(checks.some((check) => check.name.includes("shared-ratchet")), "the shared command is reported");
});
