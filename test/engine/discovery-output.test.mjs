import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeRun } from "../../src/engine/resume.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";
import { envelope, writeRecording } from "../harnesses/replay-helpers.mjs";

/**
 * A one-node replay contract: the worker runtime replays `workerRecording`
 * deterministically, and the judge runtime is never invoked (every node here
 * runs with `gate: false`).
 *
 * @param {string} directory
 * @param {string} id
 * @param {Record<string, unknown>[]} nodes
 * @param {string} workerRecording
 * @returns {string}
 */
function replayContractPath(directory, id, nodes, workerRecording) {
  return writeContract(directory, fixture({
    id,
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "replay-worker", judge: "replay-judge" },
    runtimes: {
      "replay-worker": { harness: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { harness: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor", config: { "replay.recording": workerRecording } },
    },
    nodes,
  }));
}

test("a discovery node's output field is persisted, reloads on a validated snapshot, and survives resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "discovery-output-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "discovery-output-rec-"));
  const discoveredPacket = packet({ objective: "Implement the finding" });
  const output = { entrypoint: "src/index.mjs", risk: "low" };
  const workerRecording = writeRecording(recordingDir, [{
    envelope: envelope({
      result: JSON.stringify({
        status: "done",
        summary: "discovery complete",
        verification: [],
        artifacts: [JSON.stringify(discoveredPacket)],
        missingContext: [],
        output,
      }),
    }),
  }], "worker.jsonl");

  const path = replayContractPath(directory, "discovery-output-run", [{
    id: "discover",
    type: "backend",
    taskPacket: packet({ mode: "discovery", readFiles: [], writeFiles: [], objective: "Find the entrypoint" }),
    gate: false,
  }], workerRecording);

  const result = await runContract(path);
  const state = nodeState(result, "discover");
  assert.equal(state.status, "done", state.error?.message);

  // (a) the run-owned canonical result file keeps output.
  const persisted = JSON.parse(readFileSync(join(result.runDir, "results", "discover.json"), "utf8"));
  assert.deepEqual(persisted.output, output);

  // (b) the node snapshot on disk keeps output and validates on reload.
  const snapshotOnDisk = JSON.parse(readFileSync(join(result.runDir, "nodes", "discover.json"), "utf8"));
  assert.deepEqual(/** @type {{output?: unknown}} */ (snapshotOnDisk.result).output, output);
  assert.doesNotThrow(() => validateNodeSnapshot(snapshotOnDisk));

  // (c) a resume of the finished run does not throw.
  await assert.doesNotReject(() => resumeRun(result.runDir));
});

test("an execution node whose worker returns output ends failed, naming the field", async () => {
  const directory = mkdtempSync(join(tmpdir(), "discovery-output-execution-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "discovery-output-execution-rec-"));
  const workerRecording = writeRecording(recordingDir, [{
    envelope: envelope({
      result: JSON.stringify({
        status: "done",
        summary: "worker complete",
        verification: [],
        artifacts: [],
        missingContext: [],
        output: { should: "not be allowed on an execution result" },
      }),
    }),
  }], "worker.jsonl");

  const path = replayContractPath(directory, "discovery-output-execution-run", [{
    id: "build",
    type: "backend",
    taskPacket: packet(),
    gate: false,
  }], workerRecording);

  const result = await runContract(path);
  const state = nodeState(result, "build");
  assert.equal(state.status, "failed");
  assert.match(state.error?.message ?? "", /output/u);
});
