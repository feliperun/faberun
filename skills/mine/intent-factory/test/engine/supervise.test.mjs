import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controllerAlive, runProgress, superviseRun } from "../../src/engine/supervise.mjs";
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

test("a run directory with no snapshots yet is unknown, not unfinished", () => {
  const runDir = makeRunDir();
  const progress = runProgress(runDir);
  assert.equal(progress.state, "unknown", "an empty run directory has not proved it needs resuming");
  assert.equal(progress.total, 0);
});

test("progress counts terminal nodes and reports done only when every node is terminal", () => {
  const runDir = makeRunDir();
  writeNodes(runDir, { alpha: "done", beta: "running" });
  assert.deepEqual(runProgress(runDir), { state: "unfinished", total: 2, terminal: 1 });
  writeNodes(runDir, { alpha: "done", beta: "blocked" });
  assert.deepEqual(runProgress(runDir), { state: "done", total: 2, terminal: 2 }, "blocked is terminal: there is nothing left to drive");
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
