import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cancelRun } from "../../src/engine/cancel.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { reauthorApproved, reauthorRiskTier } from "../../src/contract/scope-findings.mjs";
import { reauthorRefusedNode, resumeRun } from "../../src/engine/resume.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { invocationAlive } from "../../src/engine/process.mjs";
import { captureWorkspaceSnapshot } from "../../src/repo/workspace.mjs";
import { processStartToken } from "../../src/run/lock.mjs";
import { runsRoot } from "../../src/run/paths.mjs";
import { closeResult, ensureAttemptWorktree, fakeCodex, fixture, packet, readStatus, waitForValue, withFakeCodex, writeContract } from "../helpers.mjs";
import { childPid, nodeState, withAdvisoryGateCodex, withCitedGateCodex } from "../runner-helpers.mjs";

/**
 * R10's engine half: a refused packet is widened by a bounded discovery pass,
 * the widened packet is validated against the whole contract before it is
 * applied, and only an accepted widening under the approval threshold (or one
 * the operator explicitly approved) re-dispatches the node.
 */

/**
 * A refused node snapshot. `reauthorRefusedNode` reads only the terminal
 * boundary, the missing context the discovery prompt carries, and the node's
 * frozen packet, so the rest of the snapshot is not needed here.
 *
 * @param {string} id
 * @param {string[]} [missingContext]
 * @returns {import("../../src/contract/index.mjs").NodeSnapshot}
 */
function blockedState(id, missingContext = ["src/extra.mjs"]) {
  return /** @type {any} */ ({
    id,
    status: "blocked",
    phase: "complete",
    error: { code: "context_missing", message: missingContext.join("; ") },
    result: { status: "blocked_context", summary: "missing context", verification: [], artifacts: [], missingContext },
  });
}

/**
 * @param {{id?: string, nodes?: Record<string, unknown>[], files?: Record<string, string>}} [options]
 * @returns {{directory: string, contractPath: string, contract: import("../../src/contract/index.mjs").ValidatedContract, runDir: string}}
 */
function scaffold(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "reauthor-"));
  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  writeContract(directory, fixture({
    id: options.id ?? "reauthor-run",
    ...(options.nodes ? { nodes: options.nodes } : {}),
  }));
  const contractPath = join(directory, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  return { directory, contractPath, contract, runDir: join(directory, "reauthor-record") };
}

test("a refused packet is widened, validated, and recorded", async () => {
  const { contractPath, contract, runDir } = scaffold({ files: { "src/extra.mjs": "export const extra = 1;\n" } });
  const node = contract.nodes[0];
  const outcome = await reauthorRefusedNode({
    contract,
    contractPath,
    runDir,
    node,
    state: blockedState(node.id),
    discover: async () => ({ readFiles: ["src/extra.mjs"], writeFiles: ["src/extra.mjs"] }),
  });

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.roundsUsed, 1);
  assert.ok(outcome.contract, "the accepted candidate is re-validated");
  assert.deepEqual(outcome.contract.nodes[0].taskPacket.readFiles, ["contract.json", "src/extra.mjs"]);
  assert.deepEqual(outcome.contract.nodes[0].taskPacket.writeFiles, ["README.md", "src/extra.mjs"]);

  const record = JSON.parse(readFileSync(join(runDir, "reauthor.jsonl"), "utf8").trim());
  assert.equal(record.outcome, "applied");
  assert.equal(record.node, "build");
  assert.deepEqual(record.reauthorProposal.addedReadFiles, ["src/extra.mjs"]);
  assert.deepEqual(record.reauthorProposal.addedWriteFiles, ["src/extra.mjs"]);
  assert.equal(record.reauthorRounds.budget, 1);
  assert.equal(record.reauthorRounds.used, 1);
  assert.equal(record.reauthorRounds.exhausted, false);
});

test("the discovery rounds budget is hard and an unclosing widening is never applied", async () => {
  const { contractPath, contract, runDir } = scaffold({ files: { "src/extra.mjs": "export const extra = 1;\n" } });
  const node = contract.nodes[0];
  let discoverCalls = 0;
  const outcome = await reauthorRefusedNode({
    contract,
    contractPath,
    runDir,
    node,
    state: blockedState(node.id),
    rounds: 3,
    discover: async () => {
      discoverCalls += 1;
      return { readFiles: [`missing-${discoverCalls}.mjs`] };
    },
  });

  assert.equal(discoverCalls, 3, "the budget is exactly three discovery calls");
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.contract, null);
  assert.equal(outcome.raw, null);
  assert.equal(outcome.roundsUsed, 3);

  const record = JSON.parse(readFileSync(join(runDir, "reauthor.jsonl"), "utf8").trim());
  assert.equal(record.outcome, "rounds_exhausted");
  assert.equal(record.reauthorRounds.budget, 3);
  assert.equal(record.reauthorRounds.used, 3);
  assert.equal(record.reauthorRounds.exhausted, true);
  assert.equal(record.reauthorRounds.history.length, 3);
  assert.ok(record.reauthorProposal.findings.length > 0, "the last refusal is the proposal's finding");
});

test("a widening that takes over another node's write is refused, never applied", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reauthor-conflict-"));
  mkdirSync(join(directory, "src"), { recursive: true });
  mkdirSync(join(directory, "test"), { recursive: true });
  writeFileSync(join(directory, "src", "b.mjs"), "export const b = 1;\n");
  writeFileSync(join(directory, "test", "a.test.mjs"), "export const t = 1;\n");
  writeContract(directory, fixture({
    id: "reauthor-conflict-run",
    nodes: [
      { id: "a", type: "backend", taskPacket: packet({ readFiles: ["test/a.test.mjs"], writeFiles: ["test/a.test.mjs"] }), gate: false },
      { id: "b", type: "backend", taskPacket: packet({ readFiles: ["src/b.mjs"], writeFiles: ["src/b.mjs"] }), gate: false },
    ],
  }));
  const contractPath = join(directory, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(directory, "reauthor-record");
  const node = contract.nodes.find((candidate) => candidate.id === "b");
  assert.ok(node);

  const outcome = await reauthorRefusedNode({
    contract,
    contractPath,
    runDir,
    node,
    state: blockedState("b"),
    discover: async () => ({ writeFiles: ["test/a.test.mjs"] }),
  });

  assert.equal(outcome.accepted, false, "a write node a already owns is not an admissible widening");
  assert.equal(outcome.applied, false);
  const record = JSON.parse(readFileSync(join(runDir, "reauthor.jsonl"), "utf8").trim());
  assert.ok(record.reauthorProposal.findings.some((/** @type {string} */ finding) => /already declared in writeFiles by node a/u.test(finding)));
  assert.equal(record.reauthorRounds.exhausted, true);
});

test("a high-risk node needs an approval the default threshold withholds", () => {
  const low = /** @type {any} */ ({ gate: { enabled: false } });
  const standard = /** @type {any} */ ({ gate: { enabled: true, review: "advisory" } });
  const high = /** @type {any} */ ({ gate: { enabled: true, review: "blocking" } });

  assert.equal(reauthorRiskTier(low), "low");
  assert.equal(reauthorRiskTier(standard), "standard");
  assert.equal(reauthorRiskTier(high), "high");

  assert.equal(reauthorApproved(low), true);
  assert.equal(reauthorApproved(standard), true);
  assert.equal(reauthorApproved(high), false);
  assert.equal(reauthorApproved(high, { approveBelow: "high" }), true);
  assert.equal(reauthorApproved(high, { approve: true }), true);
  assert.equal(reauthorApproved(standard, { approveBelow: "none" }), false);
  assert.throws(() => reauthorApproved(low, { approveBelow: "nope" }), /approveBelow/u);
});

test("a refused packet is widened and the node resumes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reauthor-resume-"));
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src", "extra.mjs"), "export const extra = 1;\n");
  const path = writeContract(directory, fixture({ id: "reauthor-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "blocked-context", async () => (await runContract(path)).runDir);
  const blocked = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error.code, "context_missing");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir, {
    reauthor: {
      node: "build",
      discover: async () => ({ readFiles: ["src/extra.mjs"], writeFiles: ["src/extra.mjs"] }),
    },
  }));

  const state = nodeState(resumed);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.attempt, 2, "the widened node is re-dispatched exactly once");
  const persisted = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  assert.deepEqual(persisted.nodes[0].taskPacket.writeFiles, ["README.md", "src/extra.mjs"]);
  assert.ok(existsSync(join(runDir, "reauthor.jsonl")), "the widening is recorded on the run");
});

/**
 * The slower resume-engine regression cases, split out of
 * `test/engine/resume.test.mjs`: that file's whole-file verification command
 * caps it at 120s, and these recovery, gate, and process-lifecycle cases
 * alone overrun the budget. They live here beside the reauthor tests -- this
 * file's command has a 240s budget -- and still run on every verification.
 */

test("gate revisions are not consumed by attempts burned in restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-revisions-"));
  const path = writeContract(directory, fixture({
    id: "revisions-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
    }],
  }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).attempt, 3);

  // The judge must cite the judgment item id it rejects: an uncited rejection
  // is a protocol failure (bounded re-ask, then attention), never a revision.
  const final = await withCitedGateCodex(directory, () => resumeRun(runDir));
  assert.equal(nodeState(final).status, "exhausted");
  assert.equal(nodeState(final).attempt, 5, "two burned starts, the automatic retry, and the gate retry start");
  assert.equal(nodeState(final).revisions, 1, "one real gate rejection consumed");
});

test("resume refuses a --reauthor target that conflicts with --node", async () => {
  // Two different targets would widen one node while narrowing the retry to
  // another, leaving the widened node's dependants blocked; refused before the
  // run is even resolved.
  await assert.rejects(
    () => resumeRun("/nonexistent-run-dir", { node: "a", reauthor: { node: "b", discover: async () => ({}) } }),
    /--reauthor b conflicts with --node a/u,
  );
});

test("invalid orphan judge output is rejudged without charging worker usage twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-invalid-judge-"));
  const path = writeContract(directory, fixture({
    id: "resume-invalid-judge-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  /** @type {{id: string, attempt: number, invocations: Array<{id: string, phase: string, stdoutPath: string}>, worktree?: import("../../src/contract/index.mjs").WorktreeState|null}} */
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const judgeInvocation = state.invocations.at(-1);
  assert.ok(judgeInvocation, "persisted judge invocation exists");
  writeFileSync(judgeInvocation.stdoutPath, "not a structured judge result\n");
  const worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify({ ...state, status: "running", phase: "judge", worktree }, null, 2));

  const resumed = await withAdvisoryGateCodex(directory, () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 30, "worker usage is not added again while rejudging");
  assert.ok(final.executionOverrides, "execution overrides persisted");
  assert.equal(final.executionOverrides.filter((item) => item.invocationId === judgeInvocation.id).length, 1);
  const resumedAgain = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const finalAgain = nodeState(resumedAgain);
  assert.ok(finalAgain.usage, "usage persisted on second resume");
  assert.equal(finalAgain.usage.inputTokens, 30, "a second resume does not charge the orphan judge again");
});

test("resume restarts a node with no usable worker output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-restart-"));
  const path = writeContract(directory, fixture({ id: "resume-restart-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(nodeState(resumed).attempt, 3);
});

test("resume does not re-enable a disabled gate from the stored contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-no-gate-"));
  const path = writeContract(directory, fixture({ id: "resume-no-gate-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  assert.equal(JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8")).nodes[0].gate.enabled, false);

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  const logs = readdirSync(join(runDir, "logs"));
  assert.ok(!logs.some((name) => name.includes("judge")), "a disabled gate must not run a judge after resume");
});

test("simultaneous resumes allow one controller and reject the other", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-concurrent-resume-"));
  const path = writeContract(directory, fixture({ id: "concurrent-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const started = join(runsRoot(directory), "provider-started");
  const release = join(runsRoot(directory), "provider-release");
  const slow = fakeCodex(directory, "wait-for-release");
  const first = spawn(process.execPath, [runner, "resume", runDir], {
    env: { ...process.env, FABERUN_CODEX_BIN: slow },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // A freshly spawned `resume` controller spends several seconds in startup
    // (identity probing, snapshots) before its first provider spawn, so the
    // lock-held observation needs a wider window than the 5s default.
    await waitForValue(() => {
      try {
        return existsSync(started)
          && first.exitCode === null
          && JSON.parse(readFileSync(join(runDir, "controller.lock"), "utf8")).pid === first.pid
          ? "held"
          : null;
      } catch {
        return null;
      }
    }, 20_000);
    const second = spawn(process.execPath, [runner, "resume", runDir], {
      env: { ...process.env, FABERUN_CODEX_BIN: fakeCodex(directory, "pass") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const secondResult = await closeResult(second);
    assert.notEqual(secondResult.code, 0, secondResult.stderr);
    assert.match(secondResult.stderr, /lock/u);
    writeFileSync(release, "release");
    const firstResult = await closeResult(first);
    assert.equal(firstResult.code, 0, `${firstResult.stderr}\n${firstResult.stdout}`);
    assert.equal(readStatus(join(runDir, "nodes", "build.json")), "done");
  } finally {
    writeFileSync(release, "release");
    try { first.kill("SIGKILL"); } catch {}
  }
});

test("cancelRun confirms controller death and terminates every recorded provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-cancel-confirmation-"));
  const path = writeContract(directory, fixture({ id: "cancel-confirmation-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const controller = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const verificationProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  /** @param {import("node:child_process").ChildProcess} child */
  const childExit = (child) => new Promise((resolve) => child.once("exit", resolve));
  const controllerExit = childExit(controller);
  const providerExit = childExit(provider);
  const verificationExit = childExit(verificationProcess);
  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  const invocation = {
    id: "cancel-provider",
    pid: childPid(provider),
    processGroupId: process.platform === "win32" ? null : childPid(provider),
    processStartToken: processStartToken(childPid(provider)),
    harness: "codex",
    runtimeId: "luna",
    runtimeFingerprint: "test-runtime",
    runId: basename(runDir),
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: "xhigh",
    sandbox: "workspace-write",
    continuationId: null,
    continuationMode: "fresh",
    phase: "worker",
    promptPath: null,
    stdoutPath: join(runDir, "logs", "missing.jsonl"),
    stderrPath: null,
    startedAt,
    updatedAt: startedAt,
    deadlineAt: new Date(now + 60_000).toISOString(),
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
  };
  state.status = "running";
  state.phase = "worker";
  state.verification = {
    passed: false,
    completed: false,
    commands: [],
    attempts: [{
      invocationId: "cancel-verification",
      commandIndex: 0,
      attempt: 1,
      pid: childPid(verificationProcess),
      processGroupId: process.platform === "win32" ? null : childPid(verificationProcess),
      processStartToken: processStartToken(childPid(verificationProcess)),
      startedAt,
      deadlineAt: new Date(now + 60_000).toISOString(),
      status: "active",
      completedAt: null,
      result: null,
    }],
  };
  writeFileSync(nodePath, JSON.stringify({ ...state, invocations: [invocation] }, null, 2));
  writeFileSync(join(runDir, "controller.lock"), JSON.stringify({
    schemaVersion: 1,
    pid: childPid(controller),
    processStartToken: processStartToken(childPid(controller)),
    startedAt: new Date(now - 100).toISOString(),
    hostname: "test-host",
  }, null, 2));
  try {
    await cancelRun(runDir);
    await Promise.all([controllerExit, providerExit, verificationExit]);
    assert.equal(JSON.parse(readFileSync(nodePath, "utf8")).status, "canceled");
    assert.equal(invocationAlive({ pid: childPid(controller), processStartToken: processStartToken(childPid(controller)) }), false);
    assert.equal(invocationAlive(invocation), false);
    assert.equal(invocationAlive({ pid: childPid(verificationProcess), processStartToken: processStartToken(childPid(verificationProcess)) }), false);
    assert.equal(JSON.parse(readFileSync(nodePath, "utf8")).verification.attempts[0].status, "canceled");
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(controller) : -childPid(controller), "SIGKILL"); } catch {}
    try { process.kill(process.platform === "win32" ? childPid(provider) : -childPid(provider), "SIGKILL"); } catch {}
    try { process.kill(process.platform === "win32" ? childPid(verificationProcess) : -childPid(verificationProcess), "SIGKILL"); } catch {}
  }
});

test("resume adopts a still-live orphan invocation after its stream completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-live-orphan-"));
  const path = writeContract(directory, fixture({ id: "live-orphan-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const stdoutPath = join(runDir, "logs", "active-orphan.jsonl");
  const stream = [
    { type: "thread.started", thread_id: "orphan-thread" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "done", summary: "adopted worker", verification: [], artifacts: [], missingContext: [] }) } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const child = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(stdoutPath)}, ${JSON.stringify(stream)}), 50); setTimeout(() => {}, 10000)`], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  // The synthetic invocation below fabricates a fresh attempt by hand; a real
  // attempt start clears the previous attempt's canonical result file, so the
  // fabricated one must not inherit it.
  rmSync(join(runDir, "results", "build.json"), { force: true });
  state.worktree = ensureAttemptWorktree(runDir, state);
  const snapshotPath = join(runDir, "logs", "active-orphan.snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(captureWorkspaceSnapshot(state.worktree.path)));
  const now = new Date().toISOString();
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.invocations = [{
    id: "live-orphan",
    pid: childPid(child),
    processGroupId: process.platform === "win32" ? null : childPid(child),
    processStartToken: processStartToken(childPid(child)),
    harness: "codex",
    runtimeId: "luna",
    runtimeFingerprint: "test-runtime",
    runId: basename(runDir),
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: "xhigh",
    sandbox: "workspace-write",
    continuationId: null,
    continuationMode: "fresh",
    phase: "worker",
    promptPath: null,
    stdoutPath,
    stderrPath: null,
    startedAt: now,
    updatedAt: now,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
    snapshotPath,
  }];
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  try {
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    const final = nodeState(resumed);
    assert.equal(final.status, "done");
    assert.equal(/** @type {{summary: string}} */ (final.result).summary, "adopted worker");
    assert.ok(final.invocations, "adopted invocation persisted");
    assert.equal(final.invocations.length, 1);
    assert.equal(final.invocations[0].id, "live-orphan");
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(child) : -childPid(child), "SIGKILL"); } catch {}
  }
});

test("resume terminates an interrupted verification attempt and re-runs the phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-resume-"));
  const path = writeContract(directory, fixture({ id: "verification-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const verificationProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  const now = Date.now();
  state.worktree = ensureAttemptWorktree(runDir, state);
  state.status = "running";
  state.phase = "worker";
  state.result = null;
  state.verification = {
    passed: false,
    completed: false,
    commands: [],
    attempts: [{
      invocationId: "crashed-verification",
      commandIndex: 0,
      attempt: 1,
      pid: childPid(verificationProcess),
      processGroupId: process.platform === "win32" ? null : childPid(verificationProcess),
      processStartToken: processStartToken(childPid(verificationProcess)),
      startedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 60_000).toISOString(),
      status: "active",
      completedAt: null,
      result: null,
    }],
  };
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  try {
    const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
    const final = nodeState(resumed);
    assert.equal(final.status, "done");
    assert.ok(final.verification, "verification state persisted");
    assert.equal(final.verification.passed, true);
    assert.ok(final.verification.attempts, "verification attempts persisted");
    assert.equal(final.verification.attempts[0].status, "crashed");
    // The fabricated crashed attempt is preserved and the phase re-runs once
    // (default repeat 1).
    assert.equal(final.verification.attempts.length, 2);
    assert.equal(final.revisions, 0);
    assert.equal(invocationAlive({ pid: childPid(verificationProcess), processStartToken: processStartToken(childPid(verificationProcess)) }), false);
  } finally {
    try { process.kill(process.platform === "win32" ? childPid(verificationProcess) : -childPid(verificationProcess), "SIGKILL"); } catch {}
  }
});

test("resume gives a never-started pending node zero usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-never-started-"));
  const path = writeContract(directory, fixture({ id: "resume-never-started-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "pending",
    phase: "waiting",
    attempt: 0,
    invocations: [],
    usage: undefined,
    costUsd: undefined,
    result: null,
    verification: null,
    gate: null,
    error: null,
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.deepEqual(nodeState(resumed).usage, { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 });
});
