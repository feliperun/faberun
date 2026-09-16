/**
 * `executeControllerVerification` keeps a running node's status moving while
 * a verification child runs: `state.verification.progress` names the command
 * now running, 1-based, out of the pass's total, with its argv. Each fixture
 * command here appends a copy of the node's own snapshot to a shared log the
 * moment it starts -- proving what was on disk *before* the child produced
 * any output, since `onAttemptStart` writes the snapshot synchronously before
 * the child is spawned (run-command.mjs). A passing node's packet commands
 * run a second time, unlogged, against the integration candidate workspace
 * (`verifyCandidateWorkspace`, out of this node's scope); the log is read
 * back filtered to entries that carry progress, so that second pass cannot
 * be mistaken for the one under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { verificationProgress } from "../../src/engine/verify.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { envelope, workerResult, writeRecording } from "../harnesses/replay-helpers.mjs";

const LOG_SCRIPT = "const fs=require('node:fs');"
  + "const state=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));"
  + "fs.appendFileSync(process.argv[2], JSON.stringify({status: state.status, progress: (state.verification && state.verification.progress) || null}) + String.fromCharCode(10));";

/** @param {string} nodeJsonPath @param {string} logPath @param {string} tag @returns {string[]} */
const captureArgv = (nodeJsonPath, logPath, tag) => [process.execPath, "-e", LOG_SCRIPT, "--", nodeJsonPath, logPath, tag];

test("a controller verification pass records k/n progress and the running argv, and clears it on completion", async () => {
  const id = "verification-progress-run";
  const directory = mkdtempSync(join(tmpdir(), `${id}-`));
  const recordingDir = mkdtempSync(join(tmpdir(), `${id}-rec-`));
  const captureDir = mkdtempSync(join(tmpdir(), `${id}-cap-`));
  const nodeJsonPath = join(directory, ".runs", id, "nodes", "build.json");
  const logPath = join(captureDir, "log.jsonl");
  writeFileSync(logPath, "");
  const argv1 = captureArgv(nodeJsonPath, logPath, "command-one");
  const argv2 = captureArgv(nodeJsonPath, logPath, "command-two");

  const workerRecording = writeRecording(recordingDir, [
    { envelope: envelope({ result: JSON.stringify(workerResult("built")) }) },
  ], "worker.jsonl");
  const contractPath = writeContract(directory, fixture({
    id,
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "replay-worker", judge: "replay-judge" },
    runtimes: {
      "replay-worker": { harness: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { harness: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: argv1 }, { argv: argv2 }] }), gate: false }],
  }));

  const outcome = await runContract(contractPath);
  assert.equal(outcome.ok, true, "the run completes once both verification commands pass");

  /** @type {{status: string, progress: {index: number, total: number, argv: string}|null}[]} */
  const records = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const withProgress = records.filter((record) => record.progress !== null);
  assert.equal(withProgress.length, 2, "only the controller's own verification pass records progress on the node snapshot");
  assert.equal(withProgress[0].status, "running", "the node is still running while its own first verification command executes");
  assert.deepEqual(withProgress[0].progress, verificationProgress(1, 2, argv1), "the first command's own start recorded it as 1 of 2");
  assert.deepEqual(withProgress[1].progress, verificationProgress(2, 2, argv2), "the second command's start recorded it as 2 of 2");

  const final = outcome.states.get("build");
  assert.equal(final?.verification?.completed, true);
  assert.equal(final?.verification?.passed, true);
  assert.equal(
    /** @type {{progress?: unknown}|null|undefined} */ (final?.verification)?.progress,
    undefined,
    "progress is cleared once the pass's final rewrite replaces state.verification",
  );
});

test("a failing verification command still leaves no stray progress on the terminal record", async () => {
  const id = "verification-progress-failure";
  const directory = mkdtempSync(join(tmpdir(), `${id}-`));
  const recordingDir = mkdtempSync(join(tmpdir(), `${id}-rec-`));
  const captureDir = mkdtempSync(join(tmpdir(), `${id}-cap-`));
  const nodeJsonPath = join(directory, ".runs", id, "nodes", "build.json");
  const logPath = join(captureDir, "log.jsonl");
  writeFileSync(logPath, "");
  const argv1 = captureArgv(nodeJsonPath, logPath, "command-one");
  const failingArgv = [process.execPath, "-e", "process.exit(1)"];

  const workerRecording = writeRecording(recordingDir, [
    { envelope: envelope({ result: JSON.stringify(workerResult("built")) }) },
  ], "worker.jsonl");
  const contractPath = writeContract(directory, fixture({
    id,
    pollIntervalMs: 10,
    runtimeDefaults: { worker: "replay-worker", judge: "replay-judge" },
    runtimes: {
      "replay-worker": { harness: "replay", model: "replay-worker-model", vendor: "replay-worker-vendor", config: { "replay.recording": workerRecording } },
      "replay-judge": { harness: "replay", model: "replay-judge-model", vendor: "replay-judge-vendor" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: argv1 }, { argv: failingArgv }] }), gate: false }],
  }));

  // A node that fails its own verification is never integrated, so this
  // packet's commands run exactly once: the log needs no filtering.
  const outcome = await runContract(contractPath);
  /** @type {{status: string, progress: {index: number, total: number, argv: string}|null}[]} */
  const records = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].progress, verificationProgress(1, 2, argv1));

  const final = outcome.states.get("build");
  assert.equal(final?.status, "failed");
  assert.equal(final?.verification?.completed, true);
  assert.equal(final?.verification?.passed, false);
  assert.equal(
    /** @type {{progress?: unknown}|null|undefined} */ (final?.verification)?.progress,
    undefined,
    "the pass's final rewrite of state.verification never carries the last running command's progress forward",
  );
});
