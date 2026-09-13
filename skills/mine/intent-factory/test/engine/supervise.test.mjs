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
