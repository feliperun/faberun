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
 *
 * The proof-gate tests drive `executeControllerVerification` directly, two
 * passes at a time: the gate's overlap never engages through `runContract`,
 * whose settlement chain invokes passes one at a time. Every gate assertion
 * reads the shared log's ORDER -- a pass that should have waited leaves its
 * `start` entry after the pass it waited for left `end` -- so no assertion
 * bounds a duration from above, and a slow machine only makes the waits
 * longer, never the verdict different.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContract } from "../../src/engine/scheduler.mjs";
import { executeControllerVerification, verificationProgress } from "../../src/engine/verify.mjs";
import { captureNodeScopeBoundaries, emptyScope } from "../../src/engine/scope.mjs";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { createAttemptWorktree, createRunRef, gitHead } from "../../src/repo/worktree.mjs";
import { acquire as acquireLock } from "../../src/run/lock.mjs";
import { fixture, packet, waitForValue, writeContract } from "../helpers.mjs";
import { envelope, workerResult, writeRecording } from "../harnesses/replay-helpers.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

/** @typedef {import("../../src/contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../../src/contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../../src/contract/index.mjs").VerificationState} VerificationState */
/** @typedef {import("../../src/contract/index.mjs").WorktreeState} WorktreeState */
/** @typedef {import("../../src/contract/index.mjs").WorkspaceScopeBoundary} WorkspaceScopeBoundary */

const LOG_SCRIPT = "const fs=require('node:fs');"
  + "const state=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));"
  + "fs.appendFileSync(process.argv[2], JSON.stringify({status: state.status, progress: (state.verification && state.verification.progress) || null}) + String.fromCharCode(10));";

/** @param {string} nodeJsonPath @param {string} logPath @param {string} tag @returns {string[]} */
const captureArgv = (nodeJsonPath, logPath, tag) => [process.execPath, "-e", LOG_SCRIPT, "--", nodeJsonPath, logPath, tag];

/**
 * A run with a validated contract, a run ref and one live snapshot per node,
 * for driving `executeControllerVerification` directly. Each node's one
 * verification command appends `start-<node>` to a shared log, polls for its
 * gate file, then appends `end-<node>`; the tests read the log's order.
 *
 * @param {string} id
 * @param {string[]} nodeIds
 * @param {number} maxParallel
 * @param {"independent"|"shared"|"base"} worktrees
 *   `independent`: one attempt worktree per node. `shared`: every snapshot
 *   points at the first node's worktree, so both passes run in one tree.
 *   `base`: no worktree at all, so each pass runs in the contract's base
 *   checkout.
 */
function proofHarness(id, nodeIds, maxParallel, worktrees) {
  const directory = mkdtempSync(join(tmpdir(), `${id}-`));
  const captureDir = mkdtempSync(join(tmpdir(), `${id}-cap-`));
  const logPath = join(captureDir, "log");
  writeFileSync(logPath, "");
  const gatePath = (/** @type {string} */ nodeId) => join(captureDir, `gate-${nodeId}`);
  const gateCommand = (/** @type {string} */ nodeId) => ({
    argv: [process.execPath, "-e",
      `const fs=require("fs");const log=${JSON.stringify(logPath)};const gate=${JSON.stringify(gatePath(nodeId))};`
      + `fs.appendFileSync(log, "start-${nodeId}" + String.fromCharCode(10));`
      + `while(!fs.existsSync(gate)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}`
      + `fs.appendFileSync(log, "end-${nodeId}" + String.fromCharCode(10));`],
    timeoutSec: 30,
  });
  const contractPath = writeContract(directory, fixture({
    id,
    maxParallel,
    nodes: nodeIds.map((nodeId) => ({ id: nodeId, type: "backend", taskPacket: packet({ verification: [gateCommand(nodeId)] }), gate: false })),
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = runDirectory(directory, id);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const scopeBoundaries = captureNodeScopeBoundaries(contract);
  const repo = directory;
  createRunRef(repo, id, /** @type {string} */ (gitHead(repo)));
  /** @param {string} nodeId @returns {NodeSnapshot} */
  const stateFor = (nodeId) => {
    /** @type {WorktreeState} */
    let worktree;
    if (worktrees === "base") {
      worktree = { status: "unassigned", path: null, branch: null, commit: null, baseSha: null };
    } else {
      const owner = worktrees === "shared" ? /** @type {string} */ (nodeIds[0]) : nodeId;
      const created = createAttemptWorktree({ repo, runDir, runId: id, nodeId: owner, attempt: 1 });
      worktree = { status: "ready", path: created.path, branch: created.branch, commit: created.commit, baseSha: created.baseSha };
    }
    // Every id this harness is constructed with is a contract node id, so the
    // find always lands; the cast keeps the snapshot's non-null fields honest.
    const node = /** @type {ValidatedNode} */ (contract.nodes.find((candidate) => candidate.id === nodeId));
    return {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      id: nodeId,
      type: "backend",
      sourceIdentity: node.sourceIdentity,
      packetHash: node.packetHash,
      status: "running",
      phase: "worker",
      attempt: 1,
      revisions: 0,
      runtime: null,
      blockedBy: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      verification: null,
      scope: emptyScope(/** @type {WorkspaceScopeBoundary} */ (scopeBoundaries.get(nodeId))),
      gate: null,
      error: null,
      judgeFailures: 0,
      routing: { history: [], currentOverride: null },
      progress: null,
      invocations: [],
      executionOverrides: [],
      worktree,
      integratedHead: null,
    };
  };
  return {
    contract,
    runDir,
    lock: acquireLock(runDir),
    stateFor,
    release: (/** @type {string} */ nodeId) => writeFileSync(gatePath(nodeId), "release\n"),
    logLines: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean),
  };
}

/**
 * One direct controller verification pass, and a `finally` body that releases
 * every gate and settles both passes even when an assertion above it threw —
 * a blocked child would otherwise hold its pass until the 30s timeout.
 *
 * @param {ReturnType<typeof proofHarness>} run
 * @param {[string, ValidatedNode][]} passes
 * @returns {Promise<VerificationState>[]} the pass promises
 */
function proofPasses(run, passes) {
  return passes.map(([nodeId, node]) => executeControllerVerification(run.contract, run.runDir, node, run.stateFor(nodeId), run.lock));
}

test("a controller verification pass records k/n progress and the running argv, and clears it on completion", async () => {
  const id = "verification-progress-run";
  const directory = mkdtempSync(join(tmpdir(), `${id}-`));
  const recordingDir = mkdtempSync(join(tmpdir(), `${id}-rec-`));
  const captureDir = mkdtempSync(join(tmpdir(), `${id}-cap-`));
  const nodeJsonPath = join(runDirectory(directory, id), "nodes", "build.json");
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
  const nodeJsonPath = join(runDirectory(directory, id), "nodes", "build.json");
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
    // One recorded worker envelope and a log read without filtering: no
    // revision, or the retry a gateless node now gets would run the commands
    // a second time.
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: argv1 }, { argv: failingArgv }] }), gate: { enabled: false, maxRevisions: 0 } }],
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

test("a node in the integration candidate's own verification pass carries the candidate phase on its snapshot, and it clears once settled", async () => {
  const id = "verification-progress-candidate";
  const directory = mkdtempSync(join(tmpdir(), `${id}-`));
  const recordingDir = mkdtempSync(join(tmpdir(), `${id}-rec-`));
  const captureDir = mkdtempSync(join(tmpdir(), `${id}-cap-`));
  const nodeJsonPath = join(runDirectory(directory, id), "nodes", "build.json");
  const logPath = join(captureDir, "log.jsonl");
  writeFileSync(logPath, "");
  const script = "const fs=require('node:fs');"
    + "const state=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));"
    + "fs.appendFileSync(process.argv[2], JSON.stringify({candidate: Boolean(state.verification && state.verification.candidate)}) + String.fromCharCode(10));";
  const argv = [process.execPath, "-e", script, "--", nodeJsonPath, logPath];

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
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv }] }), gate: false }],
  }));

  const outcome = await runContract(contractPath);
  assert.equal(outcome.ok, true, "the run completes once both the attempt and the candidate verification pass");

  /** @type {{candidate: boolean}[]} */
  const records = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(records.length, 2, "the packet's one verification command runs once for the attempt and once for the integration candidate");
  assert.equal(records[0].candidate, false, "the attempt-stage pass is not the candidate pass");
  assert.equal(records[1].candidate, true, "the candidate-stage pass marks the node snapshot while it runs");

  const final = outcome.states.get("build");
  assert.equal(final?.status, "done");
  assert.equal(
    /** @type {{candidate?: unknown}|null|undefined} */ (final?.verification)?.candidate,
    false,
    "the candidate marker is cleared once the candidate pass settles",
  );
});

test("proof passes in independent attempt worktrees run concurrently within maxParallel", async () => {
  const run = proofHarness("proof-gate-parallel", ["alpha", "beta"], 2, "independent");
  const [first, second] = proofPasses(run, [
    ["alpha", /** @type {ValidatedNode} */ (run.contract.nodes[0])],
    ["beta", /** @type {ValidatedNode} */ (run.contract.nodes[1])],
  ]);
  try {
    // Both commands block on their own gate file, so both starts in the log
    // is the proof the budget allowed the overlap: a gate that serialized
    // independent worktrees would never produce the second start, because
    // nothing is released until both are seen here.
    await waitForValue(() => {
      const lines = run.logLines();
      return lines.includes("start-alpha") && lines.includes("start-beta") ? lines : null;
    }, 20_000, 10);
    run.release("alpha");
    run.release("beta");
    const firstState = await first;
    const secondState = await second;
    assert.equal(firstState.passed, true, JSON.stringify(firstState));
    assert.equal(secondState.passed, true, JSON.stringify(secondState));
    const lines = run.logLines();
    assert.ok(lines.indexOf("start-beta") < lines.indexOf("end-alpha"), "beta started while alpha was still inside its own pass");
  } finally {
    run.release("alpha");
    run.release("beta");
    await Promise.all([first.catch(() => {}), second.catch(() => {})]);
    run.lock.release();
  }
});

test("two proof passes in the same attempt worktree serialize even with budget to spare", async () => {
  const run = proofHarness("proof-gate-shared-worktree", ["alpha", "beta"], 2, "shared");
  const [first, second] = proofPasses(run, [
    ["alpha", /** @type {ValidatedNode} */ (run.contract.nodes[0])],
    ["beta", /** @type {ValidatedNode} */ (run.contract.nodes[1])],
  ]);
  try {
    await waitForValue(() => (run.logLines().includes("start-alpha") ? true : null), 20_000, 10);
    run.release("alpha");
    const firstState = await first;
    assert.equal(firstState.passed, true, JSON.stringify(firstState));
    await waitForValue(() => (run.logLines().includes("start-beta") ? true : null), 20_000, 10);
    run.release("beta");
    const secondState = await second;
    assert.equal(secondState.passed, true, JSON.stringify(secondState));
    const lines = run.logLines();
    assert.ok(lines.indexOf("end-alpha") < lines.indexOf("start-beta"), "beta's pass waited for alpha's to leave the shared worktree");
  } finally {
    run.release("alpha");
    run.release("beta");
    await Promise.all([first.catch(() => {}), second.catch(() => {})]);
    run.lock.release();
  }
});

test("two proof passes in the base checkout serialize even with budget to spare", async () => {
  const run = proofHarness("proof-gate-base-checkout", ["alpha", "beta"], 2, "base");
  const [first, second] = proofPasses(run, [
    ["alpha", /** @type {ValidatedNode} */ (run.contract.nodes[0])],
    ["beta", /** @type {ValidatedNode} */ (run.contract.nodes[1])],
  ]);
  try {
    await waitForValue(() => (run.logLines().includes("start-alpha") ? true : null), 20_000, 10);
    run.release("alpha");
    const firstState = await first;
    assert.equal(firstState.passed, true, JSON.stringify(firstState));
    await waitForValue(() => (run.logLines().includes("start-beta") ? true : null), 20_000, 10);
    run.release("beta");
    const secondState = await second;
    assert.equal(secondState.passed, true, JSON.stringify(secondState));
    const lines = run.logLines();
    assert.ok(lines.indexOf("end-alpha") < lines.indexOf("start-beta"), "the second base proof waited for the first to leave the base checkout");
  } finally {
    run.release("alpha");
    run.release("beta");
    await Promise.all([first.catch(() => {}), second.catch(() => {})]);
    run.lock.release();
  }
});

test("independent worktrees still serialize when the contract ceiling is 1", async () => {
  const run = proofHarness("proof-gate-ceiling-one", ["alpha", "beta"], 1, "independent");
  const [first, second] = proofPasses(run, [
    ["alpha", /** @type {ValidatedNode} */ (run.contract.nodes[0])],
    ["beta", /** @type {ValidatedNode} */ (run.contract.nodes[1])],
  ]);
  try {
    await waitForValue(() => (run.logLines().includes("start-alpha") ? true : null), 20_000, 10);
    run.release("alpha");
    const firstState = await first;
    assert.equal(firstState.passed, true, JSON.stringify(firstState));
    await waitForValue(() => (run.logLines().includes("start-beta") ? true : null), 20_000, 10);
    run.release("beta");
    const secondState = await second;
    assert.equal(secondState.passed, true, JSON.stringify(secondState));
    const lines = run.logLines();
    assert.ok(lines.indexOf("end-alpha") < lines.indexOf("start-beta"), "the ceiling of one held the second independent proof behind the first");
  } finally {
    run.release("alpha");
    run.release("beta");
    await Promise.all([first.catch(() => {}), second.catch(() => {})]);
    run.lock.release();
  }
});
