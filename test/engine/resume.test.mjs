import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cancelRun } from "../../src/engine/cancel.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";

import { processStartToken } from "../../src/run/lock.mjs";

import { closeResult, ensureAttemptWorktree, fakeCodex, fixture, initializeGit, orphan, packet, readStatus, waitForValue, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState, childPid, persistFailure, withCitedGateCodex, withAdvisoryGateCodex } from "../runner-helpers.mjs";
import { invocationAlive } from "../../src/engine/process.mjs";

/**
 * A scope declared through a symlink is a POSIX-shaped fixture. Git decides at
 * init time whether the filesystem can hold symlinks and writes `core.symlinks`
 * accordingly; measured 2026-09-21 on Windows 11, a fresh `git init` there says
 * false even where node itself can create one, so the attempt worktree gets a
 * regular file holding the target path and there is no link for the scope to
 * resolve through. The product is unchanged by that — the write still lands
 * inside the workspace and is still reported — but the two spellings the
 * assertion is about exist only where git materializes the link.
 */
const REASON = "git checks a symlink out as a regular file where core.symlinks is off, which is every Windows worktree";
import { captureWorkspaceSnapshot } from "../../src/repo/workspace.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

test("resume adopts an orphaned worker result instead of repeating the work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-"));
  const path = writeContract(directory, fixture({ id: "resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  unlinkSync(join(runDir, "results", "build.json"));
  orphan(runDir, "build");

  // A provider that fails every worker call proves the result came from the orphaned log.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(resumed.ok, true);
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(/** @type {{summary: string}} */ (nodeState(resumed).result).summary, "worker complete");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume refuses a harness that was known but is now unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-harness-drift-"));
  const path = writeContract(directory, fixture({ id: "resume-harness-drift-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  await assert.rejects(
    () => withFakeCodex(directory, "version-fail", () => resumeRun(runDir)),
    /harness probe unavailable for luna; resume refused/u,
  );
});

test("resume permits worker edits only to packet write files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-write-boundary-"));
  const work = join(directory, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "baseline\n");
  initializeGit(work);
  const path = writeContract(directory, fixture({
    id: "resume-write-boundary-run",
    cwd: "work",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"], writeFiles: ["README.md"] }), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "write-allowed", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
});

test("resume accepts allowed changes reached through an autonomous symlink root", { skip: process.platform === "win32" ? REASON : false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-symlink-root-"));
  mkdirSync(join(directory, "src"));
  // git tracks no empty directory: a placeholder makes "src" survive into
  // the isolated attempt worktree the alias symlink must resolve against.
  writeFileSync(join(directory, "src", ".keep"), "");
  symlinkSync("src", join(directory, "alias"));
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "resume-symlink-root-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  const workspace = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).worktree.path;
  writeFileSync(join(workspace, "src", "allowed.txt"), "allowed\n");
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  assert.equal(nodeState(resumed).status, "done");
  assert.equal(nodeState(resumed).attempt, 1);
});

test("resume source identity uses the pre-execution symlink boundary", { skip: process.platform === "win32" ? REASON : false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-scope-boundary-"));
  mkdirSync(join(directory, "src"));
  // git tracks no empty directory: a placeholder makes "src" survive into
  // the isolated attempt worktree the alias symlink must resolve against.
  writeFileSync(join(directory, "src", ".keep"), "");
  mkdirSync(join(directory, "outside"));
  writeFileSync(join(directory, "outside", "baseline.txt"), "outside\n");
  symlinkSync("src", join(directory, "alias"));
  initializeGit(directory);
  const autonomousPacket = packet({ mode: "autonomous", readFiles: [], writeFiles: undefined, writeRoots: ["alias"], verification: [] });
  const path = writeContract(directory, fixture({
    id: "resume-scope-boundary-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: autonomousPacket, gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const persisted = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.deepEqual(persisted.scope.boundary.roots, ["alias", "src"]);
  unlinkSync(join(directory, "alias"));
  symlinkSync("outside", join(directory, "alias"));
  writeFileSync(join(directory, "alias", "unauthorized.txt"), "unauthorized target\n");
  orphan(runDir, "build");
  // The retarget above changes the shared repository the fingerprint warning
  // reads; the scope gate itself compares the isolated attempt worktree, so
  // the same retarget is reproduced there for the recovered attempt to see.
  const workspace = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8")).worktree.path;
  unlinkSync(join(workspace, "alias"));
  symlinkSync("outside", join(workspace, "alias"));
  writeFileSync(join(workspace, "alias", "unauthorized.txt"), "unauthorized target\n");
  // Workers and the orchestrator commit between attempts, so a changed tree
  // fingerprint is a surfaced warning, never a refusal.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.ok(
    (metadata.identityWarnings ?? []).some((/** @type {string} */ warning) => warning.includes("fingerprint")),
    "the fingerprint mismatch is recorded on the run",
  );
  assert.match(readFileSync(join(runDir, "STATUS.md"), "utf8"), /fingerprint changed since the run started/u);
  assert.equal(resumed.ok, false, "the orphaned attempt still fails instead of passing silently");
});

test("resume fails closed when the persisted scope boundary is missing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-missing-scope-boundary-"));
  const path = writeContract(directory, fixture({ id: "resume-missing-scope-boundary-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  state.scope = null;
  writeFileSync(nodePath, JSON.stringify(state, null, 2));
  await assert.rejects(
    () => withFakeCodex(directory, "pass", () => resumeRun(runDir)),
    /persisted worker scope boundary|scope boundary/u,
  );
});

test("resume refuses a head that is not a descendant of the recorded one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-unexpected-drift-"));
  const work = join(directory, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "baseline\n");
  initializeGit(work);
  const path = writeContract(directory, fixture({
    id: "resume-unexpected-drift-run",
    cwd: "work",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["README.md"], writeFiles: ["README.md"] }), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  orphan(runDir, "build");
  // An unrelated history: not a descendant of the head the run was recorded
  // at, so the tree the run would continue on is not the one the work was
  // authorized against.
  execFileSync("git", ["-C", work, "checkout", "-q", "--orphan", "stray"]);
  execFileSync("git", ["-C", work, "-c", "user.email=runner@example.test", "-c", "user.name=runner", "commit", "-q", "-m", "unrelated history"]);
  await assert.rejects(
    () => withFakeCodex(directory, "worker-fail", () => resumeRun(runDir)),
    /source drift detected in gitHead; resume refused/u,
  );
});

test("resume adopts a completed orphan judge without running it twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-gate-"));
  const path = writeContract(directory, fixture({
    id: "resume-gate-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), definitionOfDone: [{ id: "works", text: "It works", judgment: true }], gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withAdvisoryGateCodex(directory, async () => (await runContract(path)).runDir);
  orphan(runDir, "build");

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const state = nodeState(resumed);
  assert.equal(state.status, "done");
  assert.equal(/** @type {{summary: string}} */ (state.result).summary, "worker complete");
  assert.ok(state.gate, "adopted gate recorded");
  assert.equal(state.gate.summary, "minor advisory");
  assert.equal(existsSync(join(runDir, "logs", "build.1.judge.r2.jsonl")), false, "a completed judge must be adopted once");
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

test("verification output beyond the snapshot budget does not crash the controller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-verification-large-"));
  const path = writeContract(directory, fixture({
    id: "verification-large-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000))"] }] }),
      gate: false,
    }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "done");
  assert.ok(state.verification, "verification state persisted");
  assert.equal(state.verification.passed, true);
  assert.ok(state.verification.attempts, "verification attempts persisted");
  const boundedAttempt = state.verification.attempts[0];
  assert.ok(boundedAttempt.result, "bounded attempt result persisted");
  assert.ok(Buffer.byteLength(boundedAttempt.result.stdout, "utf8") <= 2 * 1024);
  assert.ok(Buffer.byteLength(boundedAttempt.result.stderr, "utf8") <= 2 * 1024);
});

test("resume rejects a dead completion whose persisted close time is past the absolute deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-deadline-"));
  const path = writeContract(directory, fixture({
    id: "resume-deadline-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations.at(-1);
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const timeoutAt = new Date(Date.now() - 10_000).toISOString();
  const worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    worktree,
    executionOverrides: [{ kind: "timeout", timeoutSec: 10, at: timeoutAt, reason: "persisted deadline" }],
    invocations: [{ ...invocation, status: "closed", startedAt, closedAt: new Date().toISOString(), workspace: worktree?.path ?? invocation.workspace }],
  }, null, 2));

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 2, "an overdue completion is restarted rather than adopted");
});

test("resume adopts a dead completion closed before its deadline after downtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-downtime-"));
  const path = writeContract(directory, fixture({
    id: "resume-downtime-run",
    timeoutSec: 10,
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const invocation = state.invocations.at(-1);
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const closedAt = new Date(Date.now() - 19_000).toISOString();
  const worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "running",
    phase: "worker",
    worktree,
    executionOverrides: [{ kind: "timeout", timeoutSec: 10, at: new Date(Date.now() - 20_000).toISOString(), reason: "persisted deadline" }],
    invocations: [{ ...invocation, status: "closed", startedAt, closedAt }],
  }, null, 2));

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 1, "a completion closed before the deadline remains adoptable after downtime");
  assert.ok(final.usage, "usage persisted");
  assert.equal(final.usage.inputTokens, 10);
});

test("resume preserves a durable pending judge phase instead of resetting to worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-resume-pending-judge-"));
  const path = writeContract(directory, fixture({
    id: "resume-pending-judge-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
  }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  const nodePath = join(runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  const worktree = ensureAttemptWorktree(runDir, state);
  writeFileSync(nodePath, JSON.stringify({
    ...state,
    status: "pending",
    phase: "judge",
    worktree,
    result: { status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] },
    gate: null,
  }, null, 2));

  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(runDir));
  const final = nodeState(resumed);
  assert.equal(final.status, "done");
  assert.equal(final.attempt, 1, "the pending judge does not repeat the worker attempt");
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

test("an operator override reaches any non-terminal node", async () => {
  // Every parked status, not only the `context_missing` boundary: the answer is
  // recorded for each, rendered into the re-dispatched attempt's prompt, and
  // the next attempt is cut from the previous attempt's seal. The authored
  // packet and its packet hash never move.
  const parkedStates = [
    { status: "stalled", code: "stall_timeout" },
    { status: "failed", code: "provider_error" },
    { status: "exhausted", code: "verification_failed" },
    { status: "blocked", code: "integration_conflict" },
  ];
  for (const parked of parkedStates) {
    const directory = mkdtempSync(join(tmpdir(), `runner-override-${parked.status}-`));
    const path = writeContract(directory, fixture({ id: `override-${parked.status}-run`, pollIntervalMs: 10 }));
    const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);

    // What the run was authored with, before any answer can touch it.
    const contractPath = join(runDir, "contract.json");
    const authored = JSON.parse(readFileSync(contractPath, "utf8"));
    const authoredPacket = JSON.stringify(authored.nodes[0].taskPacket);
    const authoredPacketHash = authored.nodes[0].packetHash;

    // Park the node in the named non-terminal state, but recreate the previous
    // attempt's worktree and leave uncommitted work in it: only the seal can
    // carry that work into the next attempt.
    const nodePath = join(runDir, "nodes", "build.json");
    const parkedNode = JSON.parse(readFileSync(nodePath, "utf8"));
    parkedNode.worktree = ensureAttemptWorktree(runDir, parkedNode);
    writeFileSync(nodePath, JSON.stringify(parkedNode, null, 2));
    writeFileSync(join(parkedNode.worktree.path, "carried.txt"), "sealed by the previous attempt\n");
    persistFailure(runDir, "build", parked);

    const answerText = `operator answer for ${parked.status}`;
    const answerPath = join(directory, "answer.txt");
    writeFileSync(answerPath, answerText);

    const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir, { answer: { node: "build", path: answerPath } }));
    const state = nodeState(resumed);
    assert.equal(state.status, "done", `${parked.status}: ${state.error?.message}`);
    assert.equal(state.attempt, 2, `${parked.status}: the answered node is re-dispatched exactly once`);

    const override = /** @type {Record<string, unknown>[]} */ (state.executionOverrides ?? []).find((item) => item.kind === "operator-answer");
    assert.ok(override, `${parked.status}: the answer is recorded as an operator-answer override`);
    assert.equal(override.text, answerText, `${parked.status}: the recorded text is the operator's answer`);

    const workerPrompt = readFileSync(join(runDir, "logs", "build.2.worker.prompt"), "utf8");
    assert.ok(workerPrompt.includes(answerText), `${parked.status}: the answer reaches the re-dispatched worker prompt`);

    const after = JSON.parse(readFileSync(contractPath, "utf8"));
    assert.equal(JSON.stringify(after.nodes[0].taskPacket), authoredPacket, `${parked.status}: the authored packet is intact`);
    assert.equal(after.nodes[0].packetHash, authoredPacketHash, `${parked.status}: the packet hash is intact`);

    // The engine records `previousAttempt` only when the previous worktree
    // sealed a non-empty diff, and the only uncommitted change made to the
    // parked attempt was `carried.txt`, so this is the seal continuation.
    assert.equal(state.worktree?.previousAttempt, 1, `${parked.status}: the next attempt is cut from the previous seal`);

    // A terminal node has no attempt left to receive the answer, so the engine
    // refuses it instead of recording an override nothing can act on. The
    // harness stays pinned here too: this refusal is the engine's terminal
    // gate, and source identity is checked before it, so an unpinned probe
    // would surface a harness-versions drift instead of the gate.
    await withFakeCodex(directory, "pass", () => assert.rejects(
      () => resumeRun(runDir, { answer: { node: "build", path: answerPath } }),
      /not blocked on missing context/u,
      `${parked.status}: a done node refuses the override`,
    ));
  }
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
