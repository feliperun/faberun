/**
 * The gate wrapper (`src/engine/gate.mjs`) as its own program: it holds the
 * provider until the controller has persisted the invocation, and it stops
 * the provider when the two things it watches -- the controller, and the run
 * directory -- are gone, before the release and after it.
 *
 * Separate from `test/run/process.test.mjs`, which owns spawning, stalls,
 * ownership and termination, because these three drive the wrapper rather
 * than the controller, and because that file crossed the 800-line ceiling
 * carrying both jobs.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { deterministicGate, verificationEnvironment } from "../../src/engine/judge-gate.mjs";
import { invocationAlive, startProcess } from "../../src/engine/process.mjs";
import { pidAlive } from "../../src/run/lock.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { killTarget } from "../../src/host/platform.mjs";
import { errorCode } from "../../src/util.mjs";
import { fixture, writeContract } from "../helpers.mjs";

/**
 * @param {string} runDir
 * @param {Record<string, unknown>} [overrides]
 * @returns {{contract: import("../../src/contract/index.mjs").ValidatedContract, node: import("../../src/contract/index.mjs").ValidatedNode}}
 */
function validatedRun(runDir, overrides = {}) {
  const contractPath = writeContract(runDir, fixture({ pollIntervalMs: 10, ...overrides }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const node = contract.nodes[0];
  if (!node) throw new Error("fixture has no build node");
  return { contract, node };
}

/**
 * @param {import("../../src/contract/index.mjs").ValidatedNode} node
 * @returns {import("../../src/contract/index.mjs").NodeSnapshot}
 */
function nodeSnapshot(node) {
  const now = new Date().toISOString();
  return validateNodeSnapshot({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: node.id,
    type: node.type,
    sourceIdentity: node.sourceIdentity,
    packetHash: node.packetHash,
    status: "running",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: now,
    updatedAt: now,
    result: null,
    verification: null,
    scope: null,
    gate: null,
    error: null,
    judgeFailures: 0,
    routing: { history: [], currentOverride: null },
    progress: null,
    invocations: [],
    executionOverrides: [],
    worktree: { status: "unassigned", path: null, branch: null, commit: null, baseSha: null },
    integratedHead: null,
  }, node);
}

/**
 * Kill the gate's whole process group. The gate holds the provider, so this
 * skips `terminateInvocation`'s ownership proof (which a flaky
 * `processStartToken` read could fail) and just kills, ignoring ESRCH.
 * @param {{pid: number|null, processGroupId?: number|null}|undefined} invocation
 */
function killGateGroup(invocation) {
  const pid = invocation?.processGroupId ?? invocation?.pid;
  if (pid === null || pid === undefined) return;
  // Through the product's own kill, because a negative pid is a POSIX process
  // group and names nothing on Windows: `process.kill(-pid)` there reports
  // ESRCH, this helper swallows it, and the gate -- and the harness under it --
  // outlives the test. Measured 2026-09-21: the runner then never exited.
  try { killTarget(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch (error) {
    if (/** @type {{code?: string}} */ (error).code !== "ESRCH") throw error;
  }
}

test("a persistence failure leaves the gated provider unstarted and terminates its wrapper", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-persistence-barrier-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const marker = join(runDir, "provider-started");
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, "import { writeFileSync } from \"node:fs\"; writeFileSync(process.env.FABERUN_MARKER, \"started\"); setInterval(() => {}, 1000);\n");
  chmodSync(provider, 0o755);
  const previous = process.env.FABERUN_CODEX_BIN;
  const previousMarker = process.env.FABERUN_MARKER;
  process.env.FABERUN_CODEX_BIN = provider;
  process.env.FABERUN_MARKER = marker;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node);
  let persistedInvocation;
  try {
    assert.throws(() => startProcess({
      contract,
      node,
      state,
      runtime: { id: "luna", harness: "codex", model: "test" },
      prompt: "task",
      paths: {
        prompt: join(logs, "worker.prompt"),
        stdout: join(logs, "worker.jsonl"),
        stderr: join(logs, "worker.err"),
      },
      phase: "worker",
      onInvocation: (invocation) => {
        persistedInvocation = invocation;
        throw new Error("persistence failed");
      },
    }), /persistence failed/u);
    assert.equal(existsSync(marker), false);
    // A SIGTERM only schedules the gate's own SIGKILL 100ms out (src/engine/
    // gate.mjs stopProvider), and a loaded machine fires that timer late, so
    // death is not claimable at any fixed checkpoint. The claim is that the
    // unstarted wrapper dies, so poll for it: 60s, like the gate test below,
    // which the source-shape deadline ratchet deliberately does not count.
    const terminateDeadline = Date.now() + 60_000;
    while (invocationAlive(persistedInvocation) && Date.now() < terminateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(invocationAlive(persistedInvocation), false, "a persistence failure terminates the wrapper that persisted nothing");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    if (previousMarker === undefined) delete process.env.FABERUN_MARKER;
    else process.env.FABERUN_MARKER = previousMarker;
    killGateGroup(persistedInvocation);
  }
});

test("a gate exits once the directory holding its release file is gone", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "lock-gate-release-dir-gone-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!${process.execPath}\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
  chmodSync(provider, 0o755);
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = provider;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node);
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", harness: "codex", model: "test" },
    prompt: "task",
    paths: {
      prompt: join(logs, "worker.prompt"),
      stdout: join(logs, "worker.jsonl"),
      stderr: join(logs, "worker.err"),
    },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    const pid = job.invocation.pid;
    // The gate is released the moment startProcess persists the invocation, so
    // it can be mid-release right here: on its release tick it creates the two
    // log files with "wx" (src/engine/gate.mjs), and a creation landing between
    // rmSync's readdir and rmdir fails the removal with ENOTEMPTY. The removal
    // is the test's point, so retry it: measured 2026-09-19 this exact race
    // failed a green tree. 20 x 25ms is far past any release tick (10ms).
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(logs, { recursive: true, force: true });
        break;
      } catch (error) {
        if (errorCode(error) !== "ENOTEMPTY" || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    // A generous deadline, not a claim about how fast the gate reacts: the
    // ratchet in test/repo/source-shape.test.mjs caps deadlines under 60s at
    // three, and this one is a fourth if it races under that line.
    const deadline = Date.now() + 60_000;
    while (pidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(pidAlive(pid), false, "the gate exits once its release file's directory is gone, never waiting for a release that can now never appear");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    killGateGroup(job.invocation);
  }
});

test("a gate stops its provider when the run directory goes after the provider started", async () => {
  // The other ordering, and the one the pre-release check never covered: the
  // gate is already released and babysitting a live provider when its run
  // directory disappears. Clearing the interval on release left the provider's
  // own exit as the gate's only remaining liveness check, so a controller that
  // died without cleaning up left the provider running with nobody watching.
  //
  // The prompt lives in its own directory on purpose. The release file and the
  // gate config sit beside the prompt, and the gate holds neither open, while
  // it does hold the two log files open -- so removing this directory is a
  // clean removal on every platform, including one where an open handle
  // forbids deleting the file under it.
  const runDir = mkdtempSync(join(tmpdir(), "lock-gate-live-dir-gone-"));
  const logs = join(runDir, "logs");
  const control = join(runDir, "control");
  mkdirSync(logs);
  mkdirSync(control);
  const provider = join(runDir, "provider.mjs");
  writeFileSync(provider, `#!${process.execPath}\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
  chmodSync(provider, 0o755);
  const previous = process.env.FABERUN_CODEX_BIN;
  process.env.FABERUN_CODEX_BIN = provider;
  const { contract, node } = validatedRun(runDir);
  const state = nodeSnapshot(node);
  const stdout = join(logs, "worker.jsonl");
  const job = startProcess({
    contract,
    node,
    state,
    runtime: { id: "luna", harness: "codex", model: "test" },
    prompt: "task",
    paths: { prompt: join(control, "worker.prompt"), stdout, stderr: join(logs, "worker.err") },
    phase: "worker",
    onInvocation: () => {},
  });
  try {
    const pid = job.invocation.pid;
    // The gate creates both log files with "wx" on its release tick, so the
    // first one appearing is the proof that the provider was spawned. Poll for
    // it -- a lower bound on elapsed time, never a claim about this machine.
    const spawned = Date.now() + 60_000;
    while (!existsSync(stdout) && Date.now() < spawned) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(stdout), true, "the gate released and spawned its provider");

    rmSync(control, { recursive: true, force: true });
    const deadline = Date.now() + 60_000;
    while (pidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(pidAlive(pid), false, "a released gate still notices its run directory is gone");
  } finally {
    if (previous === undefined) delete process.env.FABERUN_CODEX_BIN;
    else process.env.FABERUN_CODEX_BIN = previous;
    killGateGroup(job.invocation);
  }
});

test("a worker sees only the environment it was allowed", async () => {
  // A controller variable no adapter, `*.env_key`, or envPassthrough named is
  // dropped before the provider starts. The base operating-system names and
  // the named ones survive, and a verification command -- which is not a
  // worker -- still receives the whole controller environment.
  const runDir = mkdtempSync(join(tmpdir(), "lock-worker-env-"));
  const logs = join(runDir, "logs");
  mkdirSync(logs);
  const allowedName = "FABERUN_TEST_ENV_ALLOWED";
  const secretName = "FABERUN_TEST_ENV_SECRET";
  const workerEnvPath = join(runDir, "worker-env.json");
  const provider = join(runDir, "provider.mjs");
  // Written aside and renamed into place: the test polls for the file, so it
  // must never see it half-written. Measured 2026-09-28: read on existence,
  // it failed once with "Unexpected end of JSON input" in a full-suite run.
  writeFileSync(provider, `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(`${workerEnvPath}.partial`)}, JSON.stringify(process.env));
renameSync(${JSON.stringify(`${workerEnvPath}.partial`)}, ${JSON.stringify(workerEnvPath)});
`);
  chmodSync(provider, 0o755);
  const planted = { FABERUN_CODEX_BIN: provider, [allowedName]: "allowed-value", [secretName]: "must-not-leak" };
  const previous = new Map(Object.entries(planted).map(([key]) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(planted)) process.env[key] = value;
  let job;
  try {
    const { contract, node } = validatedRun(runDir);
    const state = nodeSnapshot(node);
    job = startProcess({
      contract,
      node,
      state,
      // FABERUN_CODEX_BIN is declared by the codex adapter; the passthrough
      // name is the one extra the operator allowed.
      runtime: { id: "luna", harness: "codex", model: "test", envPassthrough: [allowedName] },
      prompt: "task",
      paths: {
        prompt: join(logs, "worker.prompt"),
        stdout: join(logs, "worker.jsonl"),
        stderr: join(logs, "worker.err"),
      },
      phase: "worker",
      onInvocation: () => {},
    });
    const spawned = Date.now() + 60_000;
    while (!existsSync(workerEnvPath) && Date.now() < spawned) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(workerEnvPath), true, "the gate released and the worker reported its environment");
    const workerEnv = JSON.parse(readFileSync(workerEnvPath, "utf8"));
    assert.equal(workerEnv[secretName], undefined, "a controller variable the allowlist does not name never reaches the worker");
    assert.equal(workerEnv[allowedName], "allowed-value", "an envPassthrough name reaches the worker");
    assert.equal(workerEnv.FABERUN_CODEX_BIN, provider, "a name the codex adapter declares reaches the worker");
    assert.equal(typeof workerEnv.PATH, "string", "the base operating-system names reach the worker");
    assert.equal(workerEnv.FABERUN_NOTIFY_BIN, undefined, "a notification transport never reaches the worker");

    // The verification spawn is not a worker. A command proof writes down its
    // own environment and must still see the secret the worker did not.
    const proofEnvPath = join(runDir, "proof-env.json");
    const proofScript = join(runDir, "proof-env.mjs");
    writeFileSync(proofScript, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(proofEnvPath)}, JSON.stringify(process.env));
`);
    assert.equal(verificationEnvironment()[secretName], "must-not-leak", "the verification environment is the full controller environment");
    const proofNode = /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (/** @type {unknown} */ ({
      definitionOfDone: [{
        id: "proof-env",
        // Forward slashes keep the quoted argv valid under cmd.exe as well as
        // POSIX shells; a raw Windows path doubles its backslashes in JSON.
        proof: {
          kind: "command",
          ref: `${JSON.stringify(process.execPath.replace(/\\/gu, "/"))} ${JSON.stringify(proofScript.replace(/\\/gu, "/"))}`,
        },
      }],
    }));
    const { verdict } = await deterministicGate(proofNode, runDir, false, 30_000);
    assert.equal(verdict.verdict, "pass", "the verification command proof passed");
    const proofEnv = JSON.parse(readFileSync(proofEnvPath, "utf8"));
    assert.equal(proofEnv[secretName], "must-not-leak", "the verification spawn keeps the full controller environment");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    killGateGroup(job?.invocation);
  }
});
