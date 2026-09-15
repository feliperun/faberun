import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controllerAlive, runProgress, superviseRun, terminateControllerGroup, writeHeartbeat } from "../../src/engine/supervise.mjs";
import { recoverOrphan } from "../../src/engine/recover.mjs";
import { lockPath, processStartToken } from "../../src/run/lock.mjs";

/** @param {string} runDir @param {Record<string, string>} statuses */
function writeNodes(runDir, statuses) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  for (const [id, status] of Object.entries(statuses)) {
    writeFileSync(join(runDir, "nodes", `${id}.json`), JSON.stringify({ id, status }));
  }
}

/** @param {string} runDir @param {string} id @param {Record<string, unknown>} snapshot */
function writeSnapshot(runDir, id, snapshot) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "nodes", `${id}.json`), JSON.stringify({ id, ...snapshot }));
}

/**
 * A node blocked the way Phase 1a records tier exhaustion: the reason lives on
 * the routing evidence, and Phase 1c reads only the reset instant from it.
 *
 * @param {string|null} exhaustedUntil
 * @returns {Record<string, unknown>}
 */
function exhaustedNode(exhaustedUntil) {
  return {
    status: "blocked",
    phase: "worker",
    error: { code: "runtime_tier_exhausted", message: "no runtime left" },
    routing: { tierExhaustion: { role: "worker", candidates: [{ runtimeId: "luna", exhaustedUntil }] } },
  };
}

/**
 * A clock the loop advances only through its `sleep` seam, so no test ever
 * waits on real time.
 *
 * @param {string} startIso
 * @returns {{now: () => number, advance: (milliseconds: number) => void}}
 */
function fakeClock(startIso) {
  let current = Date.parse(startIso);
  return {
    now: () => current,
    advance: (milliseconds) => { current += milliseconds; },
  };
}

/** @returns {string} */
function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "runner-supervise-"));
}

/** Make this process the run's demonstrably-live controller holder. @param {string} runDir */
function liveLock(runDir) {
  writeFileSync(lockPath(runDir), JSON.stringify({
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    startedAt: new Date().toISOString(),
    hostname: "test",
  }));
}

/** @param {string} runDir @param {Record<string, unknown>} heartbeat */
function writeRunHeartbeat(runDir, heartbeat) {
  writeHeartbeat(runDir, /** @type {any} */ (heartbeat));
}

/**
 * Run one adoption probe through the real recovery pass: a live detached
 * process with a transcript that already holds a done worker result. Inside its
 * deadline the pass adopts it; past its deadline it re-dispatches.
 *
 * @param {{expired: boolean}} options
 * @returns {Promise<{kind?: string}>}
 */
async function recoverProbe({ expired }) {
  const runDir = mkdtempSync(join(tmpdir(), "runner-recover-"));
  const stdoutPath = join(runDir, "stdout.log");
  const stderrPath = join(runDir, "stderr.log");
  writeFileSync(stderrPath, "");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("probe process did not start");
  const startedAt = expired ? new Date(Date.now() - 7_200_000).toISOString() : new Date().toISOString();
  const resultText = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
  writeFileSync(stdoutPath, [
    JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } }),
  ].join("\n") + "\n");
  const invocation = {
    id: `inv-${expired ? "expired" : "live"}`,
    pid,
    processGroupId: pid,
    processStartToken: processStartToken(pid),
    harness: "codex",
    runtimeId: "luna",
    phase: "worker",
    promptPath: null,
    stdoutPath,
    stderrPath,
    startedAt,
    deadlineAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(),
    updatedAt: startedAt,
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "active",
    executable: "codex",
  };
  const state = { status: "running", id: "alpha", invocations: [invocation] };
  const node = { id: "alpha", timeoutSec: 3_600 };
  const contract = { timeoutSec: 2_400, pollIntervalMs: 10, runtimes: { luna: { harness: "codex", model: "gpt-5.6-luna" } } };
  try {
    return /** @type {any} */ (await recoverOrphan(
      runDir,
      /** @type {any} */ (contract),
      /** @type {any} */ (node),
      /** @type {any} */ (state),
      /** @type {any} */ (null),
    ));
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The probe process was already terminated by the recovery pass.
    }
  }
}

test("a run directory with no snapshots yet is unknown, not unfinished", () => {
  const runDir = makeRunDir();
  const progress = runProgress(runDir);
  assert.equal(progress.state, "unknown", "an empty run directory has not proved it needs resuming");
  assert.equal(progress.total, 0);
});

test("progress counts settled nodes and reports done only when every node is settled", () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "done", beta: "running" });
  assert.deepEqual(runProgress(runDir), {
    state: "unfinished",
    total: 2,
    terminal: 1,
    runOutcome: "parked",
    outcomeNodes: [{ id: "beta", status: "running", errorCode: null }],
  });
  writeNodes(runDir, { alpha: "done", beta: "blocked" });
  assert.deepEqual(
    runProgress(runDir),
    {
      state: "done",
      total: 2,
      terminal: 2,
      runOutcome: "parked",
      outcomeNodes: [{ id: "beta", status: "blocked", errorCode: null }],
    },
    "a parked node is settled but not successful: the run reports parked, not done",
  );
});

test("a torn snapshot is unknown rather than a reason to relaunch", () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running" });
  writeFileSync(join(runDir, "nodes", "beta.json"), '{"id":"beta","status":"run');
  assert.equal(runProgress(runDir).state, "unknown");
});

test("a live controller lock stops the supervisor from launching a second one", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running" });
  // This process is the holder, and it is demonstrably alive.
  writeFileSync(lockPath(runDir), JSON.stringify({
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    startedAt: new Date().toISOString(),
    hostname: "test",
  }));
  assert.equal(controllerAlive(runDir), true);

  /** @type {string[]} */
  const launches = [];
  const outcome = await superviseRun(runDir, {
    intervalSec: 0.001,
    maxTicks: 3,
    launch: (target) => { launches.push(target); },
  });
  assert.equal(outcome.state, "stopped");
  assert.deepEqual(launches, [], "a live controller is left alone");
});

test("an unfinished run with a dead controller is relaunched, and the loop ends when it finishes", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running" });
  // A lock naming a pid `pidAlive` rejects before it ever signals anything,
  // so the holder is proven dead without borrowing a real pid from the host.
  writeFileSync(lockPath(runDir), JSON.stringify({
    pid: 0,
    processStartToken: "gone",
    startedAt: new Date().toISOString(),
    hostname: "test",
  }));
  assert.equal(controllerAlive(runDir), false);

  /** @type {string[]} */
  const launches = [];
  const outcome = await superviseRun(runDir, {
    intervalSec: 0.001,
    launch: (target) => {
      launches.push(target);
      // The relaunched controller finishes the run, which is what ends the loop.
      writeNodes(runDir, { alpha: "done" });
    },
  });
  assert.equal(outcome.state, "done");
  assert.equal(outcome.launches, 1);
  assert.deepEqual(launches, [runDir]);
});

test("a run that refuses to resume stops the supervisor instead of spinning forever", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "failed", beta: "running" });
  const outcome = await superviseRun(runDir, {
    intervalSec: 0.001,
    launch: () => { throw new Error("controller_active"); },
  });
  assert.equal(outcome.state, "stopped");
  assert.equal(outcome.launches, 0);
  assert.match(String(outcome.reason), /resume failed 3 times: controller_active/u);
});

test("the supervisor never takes the run's lock", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running" });
  let sawLock = false;
  await superviseRun(runDir, {
    intervalSec: 0.001,
    maxTicks: 2,
    launch: () => {
      // Inside the launch seam is the only moment a supervisor could be
      // tempted to hold the lock itself; it must still be free for the
      // controller it is about to start.
      sawLock = sawLock || existsSync(lockPath(runDir));
    },
  });
  assert.equal(sawLock, false, "supervising a run must leave its controller lock free");
});

test("Phase 1c: a future tier reset reports waiting and holds the launch", async () => {
  const runDir = makeRunDir();
  const clock = fakeClock("2026-09-14T00:00:00Z");
  writeSnapshot(runDir, "alpha", exhaustedNode("2026-09-14T00:05:00Z"));
  const progress = runProgress(runDir, clock.now());
  assert.equal(progress.state, "waiting", "a known future reset is not done and not work for now");
  assert.equal(progress.waitingUntil, "2026-09-14T00:05:00.000Z");

  let launches = 0;
  const outcome = await superviseRun(runDir, {
    intervalSec: 30,
    maxTicks: 3,
    now: clock.now,
    sleep: async () => {},
    launch: () => { launches += 1; },
  });
  assert.equal(launches, 0, "the future reset must hold the launch");
  assert.equal(outcome.state, "stopped");
});

test("Phase 1c: the launch fires exactly once when the reset instant arrives", async () => {
  const runDir = makeRunDir();
  const clock = fakeClock("2026-09-14T00:00:00Z");
  writeSnapshot(runDir, "alpha", exhaustedNode("2026-09-14T00:01:00Z"));
  let launches = 0;
  const outcome = await superviseRun(runDir, {
    intervalSec: 30,
    maxTicks: 4,
    now: clock.now,
    sleep: async (ms) => { clock.advance(ms); },
    launch: () => {
      launches += 1;
      // The relaunched controller is what turns the node terminal.
      writeNodes(runDir, { alpha: "done" });
    },
  });
  assert.equal(launches, 1, "the instant is the trigger, and it fires once");
  assert.equal(outcome.state, "done");
});

test("Phase 1c: an unfinished node launches on schedule while another waits", async () => {
  const runDir = makeRunDir();
  const clock = fakeClock("2026-09-14T00:00:00Z");
  writeSnapshot(runDir, "alpha", exhaustedNode("2026-09-14T00:05:00Z"));
  writeSnapshot(runDir, "beta", { status: "running", phase: "worker" });
  assert.equal(runProgress(runDir, clock.now()).state, "unfinished", "unfinished outranks waiting");

  let launches = 0;
  await superviseRun(runDir, {
    intervalSec: 30,
    maxTicks: 1,
    now: clock.now,
    sleep: async () => {},
    launch: () => { launches += 1; },
  });
  assert.equal(launches, 1, "the waiting node never holds back the ordinary schedule");
});

test("Phase 1c: a live controller is left alone while a reset is pending", async () => {
  const runDir = makeRunDir();
  const clock = fakeClock("2026-09-14T00:00:00Z");
  writeSnapshot(runDir, "alpha", exhaustedNode("2026-09-14T00:01:00Z"));
  // This process is the holder, and it is demonstrably alive.
  writeFileSync(lockPath(runDir), JSON.stringify({
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    startedAt: new Date().toISOString(),
    hostname: "test",
  }));
  assert.equal(controllerAlive(runDir), true);

  let launches = 0;
  const outcome = await superviseRun(runDir, {
    intervalSec: 30,
    maxTicks: 3,
    now: clock.now,
    sleep: async (ms) => { clock.advance(ms); },
    launch: () => { launches += 1; },
  });
  assert.equal(launches, 0, "a live controller is left alone, waiting or not");
  assert.equal(outcome.state, "stopped");
});

test("Phase 1c: missing tier-exhaustion evidence stays terminal and the run is done", () => {
  const runDir = makeRunDir();
  writeSnapshot(runDir, "alpha", exhaustedNode(null));
  writeSnapshot(runDir, "beta", { status: "done" });
  const progress = runProgress(runDir, Date.parse("2026-09-14T00:00:00Z"));
  assert.equal(progress.state, "done", "nothing to wait for, so the baseline classification stands");
  assert.equal(progress.terminal, 2);
});

test("Phase 1c: a computable reset already past is unfinished, not waiting", () => {
  const runDir = makeRunDir();
  writeSnapshot(runDir, "alpha", exhaustedNode("2026-09-13T23:55:00Z"));
  const progress = runProgress(runDir, Date.parse("2026-09-14T00:00:00Z"));
  assert.equal(progress.state, "unfinished", "the ordinary launch is what dispatches Phase 1b's retry");
});

test("Phase 1c: the earliest future reset is carried across waiting nodes", () => {
  const runDir = makeRunDir();
  writeSnapshot(runDir, "alpha", exhaustedNode("2026-09-14T00:10:00Z"));
  writeSnapshot(runDir, "beta", exhaustedNode("2026-09-14T00:05:00Z"));
  const progress = runProgress(runDir, Date.parse("2026-09-14T00:00:00Z"));
  assert.equal(progress.state, "waiting");
  assert.equal(progress.waitingUntil, "2026-09-14T00:05:00.000Z");
});

test("done-when 2: a stale at on a live lock terminates the group and relaunches; a fresh at does nothing", async () => {
  const freshDir = makeRunDir();
  writeNodes(freshDir, { alpha: "running" });
  liveLock(freshDir);
  const freshClock = fakeClock("2026-09-14T00:00:00Z");
  writeRunHeartbeat(freshDir, {
    at: "2026-09-14T00:00:00.000Z",
    lastProgressAt: "2026-09-14T00:00:00.000Z",
    iteration: 1,
    activeNodes: [{ nodeId: "alpha", lastProgressAt: "2026-09-14T00:00:00.000Z", budgetBasis: 600_000 }],
  });
  /** @type {string[]} */
  const freshEvents = [];
  await superviseRun(freshDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 1,
    now: freshClock.now,
    sleep: async () => {},
    terminate: async () => { freshEvents.push("terminate"); },
    launch: () => { freshEvents.push("launch"); },
  });
  assert.deepEqual(freshEvents, [], "a fresh at with a live lock does nothing");

  const staleDir = makeRunDir();
  writeNodes(staleDir, { alpha: "running" });
  liveLock(staleDir);
  const staleClock = fakeClock("2026-09-14T00:00:00Z");
  // 60s stale, against a 2 x 15s threshold.
  writeRunHeartbeat(staleDir, { at: "2026-09-13T23:59:00.000Z", lastProgressAt: "2026-09-13T23:59:00.000Z", iteration: 1, activeNodes: [] });
  /** @type {string[]} */
  const staleEvents = [];
  await superviseRun(staleDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 1,
    now: staleClock.now,
    sleep: async () => {},
    terminate: async () => { staleEvents.push("terminate"); },
    launch: () => { staleEvents.push("launch"); },
  });
  assert.deepEqual(staleEvents, ["terminate", "launch"], "a stale at is a dead controller even with a live lock");
});

test("done-when 3: a fresh at with a node beyond its own derived budget is treated as dead", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running" });
  liveLock(runDir);
  const clock = fakeClock("2026-09-14T01:00:00Z");
  writeRunHeartbeat(runDir, {
    at: "2026-09-14T01:00:00.000Z",
    lastProgressAt: "2026-09-14T01:00:00.000Z",
    iteration: 3,
    activeNodes: [{ nodeId: "alpha", lastProgressAt: "2026-09-14T00:00:00.000Z", budgetBasis: 60_000 }],
  });
  assert.equal(controllerAlive(runDir, { now: clock.now() }), false, "the node's own element breaches while the global timestamp is fresh");
  let launched = 0;
  await superviseRun(runDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 1,
    now: clock.now,
    sleep: async () => {},
    terminate: async () => {},
    launch: () => { launched += 1; },
  });
  assert.equal(launched, 1, "a frozen node behind a fresh at is caught");
});

test("done-when 4: a legitimate verification longer than 2 x interval inside its budget is not relaunched", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running" });
  liveLock(runDir);
  const clock = fakeClock("2026-09-14T00:10:00Z");
  writeRunHeartbeat(runDir, {
    at: "2026-09-14T00:10:00.000Z",
    lastProgressAt: "2026-09-14T00:00:00.000Z",
    iteration: 2,
    activeNodes: [{ nodeId: "alpha", lastProgressAt: "2026-09-14T00:00:00.000Z", budgetBasis: 600_000 }],
  });
  let launched = 0;
  const outcome = await superviseRun(runDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 2,
    now: clock.now,
    sleep: async () => {},
    terminate: async () => {},
    launch: () => { launched += 1; },
  });
  assert.equal(launched, 0, "10 minutes of verification is inside a 10 minute budget and must not be killed");
  assert.equal(outcome.state, "stopped");
});

test("done-when 5: a frozen sibling is caught while the global timestamp stays fresh, and recovery adopts the live sibling before its deadline", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running", beta: "running" });
  liveLock(runDir);
  const clock = fakeClock("2026-09-14T01:00:00Z");
  writeRunHeartbeat(runDir, {
    at: "2026-09-14T01:00:00.000Z",
    // The healthy sibling keeps the run-level timestamp fresh.
    lastProgressAt: "2026-09-14T01:00:00.000Z",
    iteration: 9,
    activeNodes: [
      { nodeId: "alpha", lastProgressAt: "2026-09-14T01:00:00.000Z", budgetBasis: 600_000 },
      { nodeId: "beta", lastProgressAt: "2026-09-14T00:00:00.000Z", budgetBasis: 600_000 },
    ],
  });
  /** @type {string[]} */
  const events = [];
  await superviseRun(runDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 1,
    now: clock.now,
    sleep: async () => {},
    terminate: async () => { events.push("terminate"); },
    launch: () => { events.push("launch"); },
  });
  assert.deepEqual(events, ["terminate", "launch"], "beta breaches by its own element even though alpha keeps lastProgressAt fresh");

  const adopted = await recoverProbe({ expired: false });
  assert.equal(adopted.kind, "adopted", "a still-live invocation inside its deadline is adopted by the next resume, not re-dispatched");
  const restarted = await recoverProbe({ expired: true });
  assert.equal(restarted.kind, "restart", "the same invocation is re-dispatched only once its deadline has passed");
});

test("done-when 7: a recovering controller inside until + grace is not killed and one beyond it is", async () => {
  const insideDir = makeRunDir();
  writeNodes(insideDir, { alpha: "running" });
  liveLock(insideDir);
  const insideClock = fakeClock("2026-09-14T00:10:00Z");
  writeRunHeartbeat(insideDir, {
    at: "2026-09-14T00:10:00.000Z",
    lastProgressAt: "2026-09-14T00:00:00.000Z",
    iteration: 1,
    activeNodes: [],
    phase: "recovering",
    until: "2026-09-14T00:20:00.000Z",
  });
  let insideLaunches = 0;
  await superviseRun(insideDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 1,
    now: insideClock.now,
    sleep: async () => {},
    terminate: async () => {},
    launch: () => { insideLaunches += 1; },
  });
  assert.equal(insideLaunches, 0, "an old lastProgressAt during a bounded recovery is not a breach");

  const beyondDir = makeRunDir();
  writeNodes(beyondDir, { alpha: "running" });
  liveLock(beyondDir);
  const beyondClock = fakeClock("2026-09-14T01:00:00Z");
  writeRunHeartbeat(beyondDir, {
    at: "2026-09-14T01:00:00.000Z",
    lastProgressAt: "2026-09-14T00:00:00.000Z",
    iteration: 1,
    activeNodes: [],
    phase: "recovering",
    until: "2026-09-14T00:20:00.000Z",
  });
  let beyondLaunches = 0;
  await superviseRun(beyondDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 1,
    now: beyondClock.now,
    sleep: async () => {},
    terminate: async () => {},
    launch: () => { beyondLaunches += 1; },
  });
  assert.equal(beyondLaunches, 1, "past until + grace the recovery is dead");
});

test("done-when 8: two relaunches without progress park with controller_unresponsive and the counter survives a restart", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running" });
  liveLock(runDir);
  const clock = fakeClock("2026-09-14T00:00:00Z");
  writeRunHeartbeat(runDir, {
    at: "2026-09-14T00:00:00.000Z",
    lastProgressAt: "2026-09-14T00:00:00.000Z",
    iteration: 1,
    activeNodes: [{ nodeId: "alpha", lastProgressAt: "2026-09-13T00:00:00.000Z", budgetBasis: 60_000 }],
  });
  let launches = 0;
  const outcome = await superviseRun(runDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 6,
    now: clock.now,
    sleep: async (ms) => { clock.advance(ms); },
    terminate: async () => {},
    launch: () => { launches += 1; },
  });
  assert.equal(outcome.state, "stopped");
  assert.equal(outcome.reason, "controller_unresponsive");
  assert.equal(launches, 2, "two relaunches are allowed; the third breach parks instead of killing");
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(metadata.relaunchCount, 2);
  assert.equal(metadata.attention.code, "controller_unresponsive");

  // A restarted supervisor reads the persisted counter and parks without a
  // third dispatch, which is the whole reason the counter is on disk.
  const restartedClock = fakeClock("2026-09-14T00:00:00Z");
  const restarted = await superviseRun(runDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 3,
    now: restartedClock.now,
    sleep: async () => {},
    terminate: async () => {},
    launch: () => { throw new Error("a parked run must not be relaunched"); },
  });
  assert.equal(restarted.reason, "controller_unresponsive");
});

test("done-when 9: termination is SIGTERM then SIGKILL after the named grace, and the lock is taken only after the group is gone", async () => {
  const runDir = makeRunDir();
  liveLock(runDir);
  const clock = fakeClock("2026-09-14T00:00:00Z");
  /** @type {string[]} */
  const signals = [];
  let alive = true;
  const terminated = await terminateControllerGroup(runDir, {
    graceMs: 1_000,
    killGraceMs: 1_000,
    now: clock.now,
    sleep: async (ms) => { clock.advance(ms); },
    alive: () => alive,
    kill: (pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    },
  });
  assert.equal(terminated, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "the escalation is bounded and ordered");
  assert.ok(clock.now() - Date.parse("2026-09-14T00:00:00Z") >= 1_000, "SIGKILL waits the named grace after SIGTERM");

  const breachDir = makeRunDir();
  writeNodes(breachDir, { alpha: "running" });
  liveLock(breachDir);
  const breachClock = fakeClock("2026-09-14T00:00:00Z");
  writeRunHeartbeat(breachDir, { at: "2026-09-13T23:00:00.000Z", lastProgressAt: "2026-09-13T23:00:00.000Z", iteration: 1, activeNodes: [] });
  /** @type {string[]} */
  const order = [];
  await superviseRun(breachDir, {
    intervalSec: 1,
    heartbeatIntervalMs: 15_000,
    maxTicks: 1,
    now: breachClock.now,
    sleep: async () => {},
    terminate: async () => { order.push("group gone"); },
    launch: () => { order.push("launch"); },
  });
  assert.deepEqual(order, ["group gone", "launch"], "the relaunch happens only after the group is gone");
});

test("done-when 11: every threshold is driven by a fake clock; no test waits on real time", async () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "running" });
  liveLock(runDir);
  const clock = fakeClock("2026-09-14T00:00:00Z");
  writeRunHeartbeat(runDir, {
    at: "2026-09-14T00:00:00.000Z",
    lastProgressAt: "2026-09-14T00:00:00.000Z",
    iteration: 1,
    activeNodes: [{ nodeId: "alpha", lastProgressAt: "2026-09-14T00:00:00.000Z", budgetBasis: 600_000 }],
  });
  let launches = 0;
  const outcome = await superviseRun(runDir, {
    intervalSec: 30,
    heartbeatIntervalMs: 15_000,
    maxTicks: 4,
    now: clock.now,
    // The injected sleep is the only thing that moves the clock: no real wait.
    sleep: async () => { clock.advance(1_000); },
    terminate: async () => {},
    launch: () => { launches += 1; },
  });
  assert.equal(outcome.ticks, 4, "the tick budget is reached without any real time passing");
  assert.equal(outcome.state, "stopped");
  assert.equal(launches, 0, "a fresh at and an in-budget node never trigger a relaunch across four ticks");
  assert.ok(clock.now() > Date.parse("2026-09-14T00:00:00Z"), "the loop advanced only through the injected clock");
});
