/**
 * Cancel against processes that actually exist.
 *
 * Every other cancel test builds its running state with `orphan()`: a status
 * field rewritten on an already finished node, with no process behind it. This
 * file is the other half — the fixtures are child processes the test owns and
 * reaps, recorded on the node snapshots the way a dispatched worker would be,
 * so the signal, the death wait, the SIGKILL escalation, the still-alive
 * refusal, the verification-attempt cancellation and the preserved-ref
 * ordering are held to operating-system facts instead of state files. The
 * escalation is deterministic by construction (a fixture that records and
 * ignores SIGTERM, so a corpse can only mean SIGKILL), the order of cancel's
 * git operations is read off a recording shim put first on PATH, and no
 * assertion bounds a measured duration from above.
 *
 * Half of that construction is POSIX: a signal a process can record, ignore,
 * or miss. Windows ends a console process with `taskkill /T /F` and nothing
 * else, so the four tests that do not rest on an ignored signal run there and
 * the three that do are skipped by name — see `NO_IGNORABLE_SIGNAL`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { cancelRun } from "../../src/engine/cancel.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { invocationOwned, processGroupAlive } from "../../src/engine/process-identity.mjs";
import { readLock, processStartToken } from "../../src/run/lock.mjs";
import { gitHead, preservedRefName, runRefName } from "../../src/repo/worktree.mjs";

import { binariesInPath, fixture, orphan, waitForValue, withFakeCodex, writeContract } from "../helpers.mjs";
import { childPid } from "../runner-helpers.mjs";

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */

const lockModuleHref = new URL("../../src/run/lock.mjs", import.meta.url).href;

/**
 * Three of these tests are built on a fixture that is dealt SIGTERM, records
 * it, and survives — the construction that makes an escalation to SIGKILL, or
 * a signal that misses, provable rather than assumed. Windows offers a console
 * process no such ending: `taskkill /T /F` is the only one there (ADR 0009),
 * so nothing runs on the way out, no signal is ever ignored, and a kill by pid
 * never misses. The escalation those three pin does not exist to be tested;
 * the four that do not depend on it run.
 */
const NO_IGNORABLE_SIGNAL = "a console process on Windows cannot record or survive the signal that kills it";

/**
 * How a fixture that cancel took down reports its own death. POSIX names the
 * signal that did it; Windows has none to name — `taskkill /T /F` ends the
 * process and the handle reports an exit code with a null `signalCode`. Both
 * mean "cancel killed it", on top of the kernel's own answer `awaitGone` has
 * already taken. The handle settles a moment after the kernel frees the pid,
 * so it is waited for rather than read in the tick `awaitGone` returned in.
 *
 * @param {ChildProcess} child
 * @param {string} message
 * @returns {Promise<void>}
 */
async function assertKilledByCancel(child, message) {
  if (process.platform !== "win32") {
    assert.equal(child.signalCode, "SIGTERM", message);
    return;
  }
  await waitForValue(() => (child.exitCode !== null || child.signalCode !== null ? true : null), 10_000);
  assert.equal(child.signalCode, null, `${message}: Windows names no signal`);
}

// A failed test must never leave a runner behind — this repository has
// collected orphan test processes before. Every fixture is tracked, reaped in
// a `finally` that asserts the corpse, and this handler is the last will for a
// hard process exit, where no `finally` runs.
/** @type {Set<ChildProcess>} */
const tracked = new Set();
process.on("exit", () => {
  for (const child of tracked) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      // ESRCH is the only acceptable way to miss: the fixture is already gone.
      if (/** @type {{code?: string}} */ (error).code !== "ESRCH") throw error;
    }
  }
});

/**
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === "ESRCH") return false;
    throw error;
  }
}

/**
 * A fixture process the test owns: a small node program written to a
 * throwaway directory. Detached by default, so it leads its own process group
 * the way a dispatched gate process does and a group-directed signal reaches
 * it alone; the controller fixtures pass `detached: false` because cancel
 * signals a controller by pid.
 *
 * @param {string} script
 * @param {{detached?: boolean}} [options]
 * @returns {ChildProcess}
 */
function spawnFixture(script, options = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "cancel-live-fixture-")), "fixture.mjs");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  const child = spawn(process.execPath, [path], { stdio: "ignore", detached: options.detached ?? true });
  tracked.add(child);
  // Unreferenced so a fixture can never hold the runner open. The `finally`
  // that reaps it does not run when a helper throws before its `try` — and a
  // referenced handle then keeps the event loop alive forever, which is how
  // one failing assertion turned into a six-hour CI job (measured
  // 2026-09-22). The exit handler above still reaps every tracked fixture.
  child.unref();
  return child;
}

/**
 * A fixture that records every SIGTERM it is dealt and survives it. The
 * recorded line proves the first signal was delivered, and the process being
 * dead afterwards can then only mean the SIGKILL escalation ran — no sleep
 * and no duration bound decides it.
 *
 * @param {string} log
 * @returns {string}
 */
function trapperScript(log) {
  // The empty file is written *after* the handler is installed, so its
  // existence proves the handler is in place -- that is what `awaitTrapReady`
  // waits for, and the order is the whole point: a file written first would
  // prove only that the script started. Without that order the test
  // can cancel while the fixture is still starting, SIGTERM takes its default
  // action, nothing is ever appended, and the read fails with ENOENT --
  // measured 2026-09-22 on three of four CI runners, green on the fourth and
  // green on the author's machine, which is exactly how a startup race looks.
  return `import { appendFileSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => { appendFileSync(${JSON.stringify(log)}, "SIGTERM\\n"); });
writeFileSync(${JSON.stringify(log)}, "");
setInterval(() => {}, 60_000);
`;
}

/**
 * Wait until a trapper fixture has installed its SIGTERM handler. The file it
 * writes at startup is the readiness signal; polling for it is a lower bound
 * on elapsed time and never an assertion about how fast this machine is.
 *
 * @param {string} log
 * @returns {Promise<void>}
 */
async function awaitTrapReady(log) {
  await waitForValue(() => (existsSync(log) ? true : null), 10_000);
}

/**
 * A controller the way cancel expects to find one: another live process
 * holding the run lock through the real `acquire`. The test waits for
 * `readLock` to name the fixture before cancelling, so the record cancel
 * reads is the real one, never a hand-written shape.
 *
 * @param {string} runDirPath
 * @param {string|null} [signalLog] when set, received SIGTERMs are recorded and ignored
 * @returns {string}
 */
function controllerScript(runDirPath, signalLog = null) {
  return `import { acquire } from ${JSON.stringify(lockModuleHref)};
${signalLog ? `import { appendFileSync } from "node:fs";
process.on("SIGTERM", () => { appendFileSync(${JSON.stringify(signalLog)}, "SIGTERM\\n"); });` : ""}
await acquire(${JSON.stringify(runDirPath)});
setInterval(() => {}, 60_000);
`;
}

/**
 * A completed one-node fixture run, then orphaned into the running shape
 * every other cancel test starts from — but with a live process to be
 * recorded on it by the caller.
 *
 * @param {string} id
 * @returns {Promise<{directory: string, runDir: string}>}
 */
async function scaffoldRun(id) {
  const directory = mkdtempSync(join(tmpdir(), `cancel-live-${id}-`));
  const path = writeContract(directory, fixture({ id, pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "pass", async () => (await runContract(path)).runDir);
  return { directory, runDir };
}

/**
 * The identity a dispatched worker records. `processStartToken` reads the
 * process table, which can lag the spawn on a loaded host, so the token is
 * taken only once ownership of the pid is provable — the pid cannot be
 * recycled while the fixture is alive.
 *
 * @param {ChildProcess} child
 * @returns {Promise<string|null>} the token where the platform has one
 */
async function awaitOwnedToken(child) {
  const pid = childPid(child);
  // Windows records no start token: `wmic` is gone from Windows 11 26200 and
  // the PowerShell that replaced it costs about 400 ms a probe, so ownership
  // there is the live pid the controller recorded (`process-identity.mjs`).
  // Wait for whichever proof this platform actually has, and record the
  // identity a dispatched invocation would carry — the point is that cancel
  // reads the same shape it writes.
  const owned = await waitForValue(() => {
    const token = process.platform === "win32" ? null : processStartToken(pid);
    if (process.platform !== "win32" && (typeof token !== "string" || token.length === 0)) return null;
    return invocationOwned({ pid, processGroupId: pid, processStartToken: token }) ? { token } : null;
  });
  return /** @type {string|null} */ (/** @type {{token: string|null}} */ (owned).token);
}

/**
 * Record the fixture on the node snapshot the way a dispatched worker's
 * invocation is recorded: an active record carrying the pid, its own process
 * group and the start token that proves ownership. Modelled on the last
 * recorded invocation of the same node so the snapshot's shape is unchanged.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @param {ChildProcess} child
 * @param {{processGroupId?: number}} [overrides]
 * @returns {Promise<import("../../src/engine/process-identity.mjs").InvocationProbe>}
 */
async function recordInvocation(runDir, nodeId, child, overrides = {}) {
  const pid = childPid(child);
  const token = await awaitOwnedToken(child);
  const path = join(runDir, "nodes", `${nodeId}.json`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  const previous = (state.invocations ?? []).at(-1);
  const startedAt = new Date().toISOString();
  const invocation = {
    ...(previous ?? {}),
    id: "live-fixture-invocation",
    pid,
    // A dispatched invocation on Windows records no process group — there is
    // none to record — so neither does this one.
    processGroupId: process.platform === "win32" ? null : overrides.processGroupId ?? pid,
    processStartToken: token,
    harness: "codex",
    runtimeId: null,
    phase: "worker",
    promptPath: null,
    stdoutPath: join(runDir, "logs", "live-fixture.jsonl"),
    stderrPath: join(runDir, "logs", "live-fixture.err"),
    startedAt,
    // A dispatch always starts with a wall-clock deadline (process.mjs), and
    // the snapshot validator holds every invocation to a real timestamp --
    // null is a shape no dispatched invocation ever carries.
    deadlineAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(),
    updatedAt: startedAt,
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: process.execPath,
  };
  state.invocations = [...(state.invocations ?? []), invocation];
  writeFileSync(path, JSON.stringify(state, null, 2));
  return /** @type {import("../../src/engine/process-identity.mjs").InvocationProbe} */ (invocation);
}

/**
 * Record the fixture as an active verification attempt, so cancel's
 * verification-cancellation path has a real process to take down.
 *
 * @param {string} runDir
 * @param {string} nodeId
 * @param {ChildProcess} child
 * @returns {Promise<Record<string, unknown>>}
 */
async function recordVerificationAttempt(runDir, nodeId, child) {
  const pid = childPid(child);
  const token = await awaitOwnedToken(child);
  const path = join(runDir, "nodes", `${nodeId}.json`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  const verification = state.verification ?? { passed: false, commands: [], completed: false, attempts: [] };
  const previous = (verification.attempts ?? []).at(-1);
  const attempt = {
    ...(previous ?? {}),
    invocationId: "live-fixture-attempt",
    status: "active",
    pid,
    processGroupId: process.platform === "win32" ? null : pid,
    processStartToken: token,
    completedAt: null,
  };
  state.verification = {
    ...verification,
    completed: false,
    passed: false,
    attempts: [...(verification.attempts ?? []), attempt],
  };
  writeFileSync(path, JSON.stringify(state, null, 2));
  return attempt;
}

/**
 * A process-group id that names a group which no longer exists: the ephemeral
 * fixture leads its own group, exits, and the group dies with it. Cancel's
 * group-directed signal then hits ESRCH while the leader pid itself stays
 * provably alive and owned — the honest construction for a recorded
 * invocation that survives every signal cancel can send, because a live owned
 * process cannot survive SIGKILL itself.
 *
 * @returns {Promise<number>}
 */
async function aDeadGroupId() {
  const ephemeral = spawnFixture("process.exit(0);\n");
  const pid = childPid(ephemeral);
  await waitForValue(() => (ephemeral.exitCode !== null ? pid : null), 5_000);
  assert.equal(processGroupAlive(pid), false, "the ephemeral fixture's group is gone");
  return pid;
}

/**
 * Wait until the kernel itself reports the pid gone, then assert the group
 * when the fixture led one. Bounded polling, never an assumed outcome:
 * "cancel returned" is not the fact under test.
 *
 * @param {ChildProcess} child
 * @param {{group?: boolean}} [options]
 * @returns {Promise<void>}
 */
async function awaitGone(child, options = {}) {
  const pid = childPid(child);
  await waitForValue(() => (!pidAlive(pid) ? true : null), 10_000);
  if (options.group) assert.equal(processGroupAlive(pid), false, "the fixture's whole process group is gone");
}

/**
 * Kill a fixture if it still runs, wait for the kernel to confirm the death,
 * and refuse to return while anything survives. This is the anti-orphan
 * guarantee: no path out of a test here leaves a runner behind.
 *
 * @param {ChildProcess} child
 * @param {{group?: boolean}} [options]
 * @returns {Promise<void>}
 */
async function reap(child, options = {}) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      // ESRCH: already gone, which is the only acceptable way to miss.
      if (/** @type {{code?: string}} */ (error).code !== "ESRCH") throw error;
    }
  }
  await waitForValue(() => (child.exitCode !== null || child.signalCode !== null ? true : null), 5_000);
  assert.equal(pidAlive(childPid(child)), false, "the fixture is gone before the test returns");
  if (options.group) assert.equal(processGroupAlive(childPid(child)), false, "the fixture's process group is gone before the test returns");
}

/**
 * A `git` that fronts the real one and writes each invocation's argv to a log
 * before acting, so the order of cancel's git operations is observable from
 * outside. When `refuseDeleteRef` is set, the one deletion naming that ref is
 * refused with exit 1 — a release that genuinely fails after the preserved
 * refs already exist.
 *
 * @param {string} log
 * @param {string|null} refuseDeleteRef
 * @returns {string} directory to put first on PATH
 */
function gitRecorder(log, refuseDeleteRef) {
  const real = binariesInPath(["git"]).git;
  const directory = mkdtempSync(join(tmpdir(), "cancel-live-git-shim-"));
  const path = join(directory, "git");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const refused = ${JSON.stringify(refuseDeleteRef)};
if (refused && argv.includes("update-ref") && argv.includes("-d") && argv.includes(refused)) {
  process.stderr.write("test shim refuses: " + refused + "\\n");
  process.exit(1);
}
process.exit(spawnSync(${JSON.stringify(real)}, argv, { stdio: "inherit" }).status ?? 1);
`);
  chmodSync(path, 0o755);
  return directory;
}

/**
 * @param {string} log
 * @returns {string[][]}
 */
function gitCalls(log) {
  return readFileSync(log, "utf8").split("\n").filter((line) => line.trim())
    .map((line) => /** @type {string[]} */ (JSON.parse(line)));
}

/**
 * @template T
 * @param {string} directory
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T>}
 */
async function withGitFirst(directory, body) {
  const previous = process.env.PATH;
  process.env.PATH = `${directory}:${previous}`;
  try {
    return await body();
  } finally {
    process.env.PATH = previous;
  }
}

test("cancel signals a live invocation and confirms the process is gone", async () => {
  const { runDir } = await scaffoldRun("cancel-live-signal");
  orphan(runDir, "build");
  const child = spawnFixture("setInterval(() => {}, 60_000);\n");
  const invocation = await recordInvocation(runDir, "build", child);
  assert.equal(invocationOwned(invocation), true, "the recorded invocation names the live fixture");

  try {
    const result = await cancelRun(runDir);

    await awaitGone(child, { group: true });
    await assertKilledByCancel(child, "the first signal sufficed for a fixture without a handler");
    assert.deepEqual(result.preservedRefs, [preservedRefName("cancel-live-signal", "build")]);
    const state = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
    assert.equal(state.status, "canceled");
    const recorded = state.invocations.at(-1);
    assert.equal(recorded.status, "terminated", "the recorded invocation is terminated, not left active");
    assert.ok(recorded.closedAt, "the terminated invocation carries its close time");
  } finally {
    await reap(child, { group: true });
  }
});

test("an invocation that ignores SIGTERM is escalated to SIGKILL, deterministically", { skip: process.platform === "win32" ? NO_IGNORABLE_SIGNAL : false }, async () => {
  const { runDir } = await scaffoldRun("cancel-live-escalate");
  orphan(runDir, "build");
  const received = join(mkdtempSync(join(tmpdir(), "cancel-live-trap-")), "signals.log");
  const child = spawnFixture(trapperScript(received));
  await awaitTrapReady(received);
  await recordInvocation(runDir, "build", child);

  try {
    await cancelRun(runDir);

    await awaitGone(child, { group: true });
    assert.equal(readFileSync(received, "utf8").trim(), "SIGTERM", "the first signal was delivered and ignored, not skipped");
    assert.equal(child.signalCode, "SIGKILL", "a fixture that provably ignored SIGTERM is dead only by escalation");
    const state = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
    assert.equal(state.status, "canceled");
    assert.equal(state.invocations.at(-1).status, "terminated");
  } finally {
    await reap(child, { group: true });
  }
});

test("cancel refuses while a recorded invocation survives and releases nothing", { skip: process.platform === "win32" ? NO_IGNORABLE_SIGNAL : false }, async () => {
  const { directory, runDir } = await scaffoldRun("cancel-live-refusal");
  orphan(runDir, "build");
  const child = spawnFixture("setInterval(() => {}, 60_000);\n");
  const deadGroup = await aDeadGroupId();
  const invocation = await recordInvocation(runDir, "build", child, { processGroupId: deadGroup });
  assert.equal(invocationOwned(invocation), true, "the leader is alive and owned — the precondition of the refusal");
  const stateBefore = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  const branch = stateBefore.worktree.branch;
  assert.ok(gitHead(directory, branch), "the attempt branch exists before cancel");

  try {
    await assert.rejects(() => cancelRun(runDir), /could not confirm termination/u);

    assert.equal(pidAlive(childPid(child)), true, "the fixture survived every signal cancel sends");
    assert.equal(child.signalCode, null, "the fixture was never signalled to death");
    const state = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
    assert.equal(state.status, "running", "the run is not declared canceled over a live invocation");
    assert.equal(gitHead(directory, preservedRefName("cancel-live-refusal", "build")), null, "a refused cancel preserves nothing");
    assert.ok(gitHead(directory, branch), "a refused cancel releases no attempt branch");
    assert.ok(gitHead(directory, runRefName("cancel-live-refusal")), "a refused cancel releases no run ref");
  } finally {
    await reap(child, { group: true });
  }
});

test("cancel terminates an active verification attempt and marks verification canceled", async () => {
  const { runDir } = await scaffoldRun("cancel-live-attempt");
  orphan(runDir, "build");
  const child = spawnFixture("setInterval(() => {}, 60_000);\n");
  await recordVerificationAttempt(runDir, "build", child);

  try {
    await cancelRun(runDir);

    await awaitGone(child, { group: true });
    await assertKilledByCancel(child, "cancel took the verification attempt down");
    const state = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
    assert.equal(state.verification.completed, true);
    assert.equal(state.verification.passed, false);
    assert.equal(state.verification.error, "verification canceled");
    const attempt = state.verification.attempts.at(-1);
    assert.equal(attempt.status, "canceled");
    assert.equal(attempt.result.error, "verification canceled");
  } finally {
    await reap(child, { group: true });
  }
});

test("preserved refs exist before the first attempt branch release, so an interrupted cancel leaves more reachable", { skip: process.platform === "win32" ? NO_IGNORABLE_SIGNAL : false }, async () => {
  const { directory, runDir } = await scaffoldRun("cancel-live-order");
  orphan(runDir, "build");
  const received = join(mkdtempSync(join(tmpdir(), "cancel-live-trap-")), "signals.log");
  const child = spawnFixture(trapperScript(received));
  await awaitTrapReady(received);
  await recordInvocation(runDir, "build", child);
  const state = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  const branch = state.worktree.branch;
  const integratedHead = state.integratedHead;
  assert.ok(integratedHead, "the fixture node integrated before cancel");
  assert.ok(gitHead(directory, branch), "the recreated attempt branch exists before cancel");
  const log = join(mkdtempSync(join(tmpdir(), "cancel-live-gitlog-")), "git.log");

  try {
    // The shim refuses exactly one operation: the branch deletion, i.e. the
    // first attempt-branch release. The preserved ref is created before any
    // release is attempted, so this mid-release failure must leave the
    // integrated commit at least as reachable as cancel found it.
    const result = await withGitFirst(gitRecorder(log, `refs/heads/${branch}`), () => cancelRun(runDir));

    await awaitGone(child, { group: true });
    assert.equal(readFileSync(received, "utf8").trim(), "SIGTERM", "the slow death ran: SIGTERM was ignored");
    assert.equal(child.signalCode, "SIGKILL", "the escalation completed before cancel went on to the git work");

    const calls = gitCalls(log);
    const preservedAt = calls.findIndex((argv) => argv.includes("update-ref") && argv.includes(preservedRefName("cancel-live-order", "build")));
    const worktreeRemoveAt = calls.findIndex((argv) => argv.includes("worktree") && argv.includes("remove"));
    const branchDeleteAt = calls.findIndex((argv) => argv.includes("-d") && argv.includes(`refs/heads/${branch}`));
    const runRefDeleteAt = calls.findIndex((argv) => argv.includes("-d") && argv.includes(runRefName("cancel-live-order")));
    assert.ok(preservedAt >= 0, "the preserved ref was created through git");
    assert.ok(worktreeRemoveAt >= 0, "the attempt worktree release was attempted");
    assert.ok(branchDeleteAt >= 0, "the attempt branch release was attempted");
    assert.ok(runRefDeleteAt >= 0, "the run ref release was attempted");
    assert.ok(preservedAt < worktreeRemoveAt && preservedAt < branchDeleteAt && preservedAt < runRefDeleteAt,
      "the preserved ref is created before any release is even attempted");

    assert.equal(gitHead(directory, preservedRefName("cancel-live-order", "build")), integratedHead, "the integrated commit survives behind its preserved ref");
    assert.ok(gitHead(directory, branch), "the branch deletion genuinely failed — this is the interrupted cancel");
    assert.deepEqual(result.preservedRefs, [preservedRefName("cancel-live-order", "build")]);
    const after = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
    assert.equal(after.status, "canceled");
  } finally {
    await reap(child, { group: true });
  }
});

test("cancel signals a controller holding the run lock and confirms its death before taking over", async () => {
  const { runDir } = await scaffoldRun("cancel-live-controller");
  orphan(runDir, "build");
  const child = spawnFixture(controllerScript(runDir), { detached: false });
  await waitForValue(() => {
    const lock = readLock(runDir);
    return lock && !lock.invalid && lock.pid === childPid(child) ? true : null;
  }, 10_000);

  try {
    await cancelRun(runDir);

    await awaitGone(child);
    await assertKilledByCancel(child, "the controller died by the first signal");
    const state = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
    assert.equal(state.status, "canceled", "cancel took the dead controller's stale lock and finished the run");
  } finally {
    await reap(child);
  }
});

test("a controller that ignores SIGTERM is escalated to SIGKILL", { skip: process.platform === "win32" ? NO_IGNORABLE_SIGNAL : false }, async () => {
  const { runDir } = await scaffoldRun("cancel-live-controller-escalate");
  orphan(runDir, "build");
  const received = join(mkdtempSync(join(tmpdir(), "cancel-live-trap-")), "signals.log");
  const child = spawnFixture(controllerScript(runDir, received), { detached: false });
  await waitForValue(() => {
    const lock = readLock(runDir);
    return lock && !lock.invalid && lock.pid === childPid(child) ? true : null;
  }, 10_000);

  try {
    await cancelRun(runDir);

    await awaitGone(child);
    assert.equal(readFileSync(received, "utf8").trim(), "SIGTERM", "the first signal was delivered to the controller and ignored");
    assert.equal(child.signalCode, "SIGKILL", "only the escalation explains the controller's death");
  } finally {
    await reap(child);
  }
});
