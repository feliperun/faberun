import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("a discovery node closed to its read files delivers through output and owes no artifact", async () => {
  // The repo-reading discovery packet (empty readFiles) is the only one that
  // owes the execution-packet artifact; a packet closed to listed read files
  // -- every planning node -- delivers its structured result through `output`.
  const directory = mkdtempSync(join(tmpdir(), "discovery-output-closed-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "discovery-output-closed-rec-"));
  writeFileSync(join(directory, "spec.md"), "# Feature 42\n\nThe spec under planning.\n");
  const plan = {
    nodes: [{
      id: "build", objective: "Implement the feature", taskKind: "implement", riskTier: "standard",
      dependsOn: [], readFiles: ["spec.md"], writeFiles: ["src/index.mjs"], definitionOfDone: [], verification: [],
    }],
  };
  const workerRecording = writeRecording(recordingDir, [{
    envelope: envelope({
      result: JSON.stringify({
        status: "done",
        summary: "planned",
        verification: [],
        artifacts: [],
        missingContext: [],
        output: { plan },
      }),
    }),
  }], "worker.jsonl");

  const path = replayContractPath(directory, "discovery-output-closed-run", [{
    id: "plan",
    type: "backend",
    taskPacket: packet({ mode: "discovery", readFiles: ["spec.md"], writeFiles: [], objective: "Draft the plan" }),
    gate: false,
  }], workerRecording);

  const result = await runContract(path);
  const state = nodeState(result, "plan");
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(/** @type {{output?: unknown}} */ (state.result).output, { plan });
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

test("a planning-sized output copied into artifacts is re-asked with the broken ceiling named, and settles done once artifacts is empty", async () => {
  // Observed 2026-09-25: a 38 KiB plan copied into artifacts[0] was re-asked
  // with a repair about markdown fences, which it could not act on.
  const directory = mkdtempSync(join(tmpdir(), "discovery-output-ceiling-"));
  const recordingDir = mkdtempSync(join(tmpdir(), "discovery-output-ceiling-rec-"));
  writeFileSync(join(directory, "spec.md"), "# Feature 42\n\nThe spec under planning.\n");
  const plan = {
    nodes: Array.from({ length: 24 }, (_, index) => ({
      id: `node-${index}`, objective: `Implement part ${index} ${"of the feature ".repeat(40)}`, taskKind: "implement", riskTier: "standard",
      dependsOn: [], readFiles: ["spec.md"], writeFiles: [`src/part-${index}.mjs`], definitionOfDone: [], verification: [],
    })),
  };
  const planText = JSON.stringify(plan);
  assert.ok(Buffer.byteLength(planText) > 16 * 1024, "the plan is past the artifact ceiling");
  const result = (/** @type {string[]} */ artifacts) => JSON.stringify({ status: "done", summary: "planned", verification: [], artifacts, missingContext: [], output: { plan } });
  const workerRecording = writeRecording(recordingDir, [
    { envelope: envelope({ result: result([planText]) }) },
    { envelope: envelope({ result: result([]) }) },
  ], "worker.jsonl");

  const path = replayContractPath(directory, "discovery-output-ceiling-run", [{
    id: "plan",
    type: "backend",
    taskPacket: packet({ mode: "discovery", readFiles: ["spec.md"], writeFiles: [], objective: "Draft the plan" }),
    gate: false,
  }], workerRecording);

  const run = await runContract(path);
  const state = nodeState(run, "plan");
  assert.equal(state.status, "done", state.error?.message);
  assert.deepEqual(/** @type {{output?: unknown}} */ (state.result).output, { plan });
  const repairPrompt = readFileSync(join(run.runDir, "logs", "plan.2.worker.prompt"), "utf8");
  assert.match(repairPrompt, /worker result\.artifacts\[0\] exceeds 16384 bytes/);
  assert.match(repairPrompt, /never copies `output` into `artifacts`/);
  assert.ok(!repairPrompt.includes("no markdown fences"), "the repair names the ceiling, not the formatting");
});
