import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHeartbeat,
  markRecovering,
  readHeartbeat,
  writeHeartbeat,
  heartbeatBreach,
} from "../../src/engine/supervise.mjs";
import { nodeBudgetBasisMs, verificationBudgetMs } from "../../src/engine/scheduler.mjs";
import { controllerStatus } from "../../src/report/render.mjs";
import { lockPath, processStartToken } from "../../src/run/lock.mjs";

/** @returns {string} */
function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "runner-heartbeat-"));
}

/**
 * A clock moved only by the test, so every threshold is driven by a fake
 * instant and no test ever waits on real time.
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

/** @param {string} runDir @param {Record<string, unknown>} [heartbeat] */
function writeRunHeartbeat(runDir, heartbeat = {}) {
  const at = "2026-09-14T00:00:00.000Z";
  writeHeartbeat(runDir, {
    at,
    lastProgressAt: at,
    iteration: 0,
    activeNodes: [],
    ...heartbeat,
  });
}

test("done-when 1: at advances across a verification longer than 2 x interval while lastProgressAt stays put", () => {
  const runDir = makeRunDir();
  const clock = fakeClock("2026-09-14T00:00:00Z");
  /** @type {() => void} */
  let beat = () => {};
  const heartbeat = createHeartbeat({
    runDir,
    intervalMs: 10_000,
    now: clock.now,
    setIntervalFn: (fn) => { beat = fn; return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  try {
    const initial = readHeartbeat(runDir);
    assert.equal(typeof initial?.at, "string");
    assert.equal(typeof initial?.lastProgressAt, "string");
    assert.equal(initial?.iteration, 0);
    assert.deepEqual(initial?.activeNodes, [], "activeNodes is an array, even before any node is active");

    // The loop is inside a verification for longer than 2 x interval: only the
    // unref'd timer runs, never a loop body.
    clock.advance(10_000);
    beat();
    clock.advance(10_000);
    beat();
    const busy = readHeartbeat(runDir);
    assert.ok(Date.parse(busy?.at ?? "") > Date.parse(initial?.at ?? ""), "at must advance while the loop is busy, proving it is not loop-written");
    assert.equal(busy?.lastProgressAt, initial?.lastProgressAt, "lastProgressAt is written by the loop and cannot move during a verification");
    assert.equal(busy?.iteration, 0);

    // The loop resumes and records a transition.
    heartbeat.progress();
    const resumed = readHeartbeat(runDir);
    assert.ok(Date.parse(resumed?.lastProgressAt ?? "") > Date.parse(initial?.lastProgressAt ?? ""));
    assert.equal(resumed?.iteration, 1);
  } finally {
    heartbeat.stop();
  }
});

/** @returns {Record<string, unknown>} */
function budgetContract() {
  return {
    timeoutSec: 60,
    finalVerification: [{ argv: ["final"], timeoutSec: 100, repeat: 2 }],
    nodes: [
      { id: "alpha", dependsOn: [] },
      { id: "terminal", dependsOn: ["alpha"] },
    ],
  };
}

/** @param {string} id @param {number} repeat @returns {Record<string, unknown>} */
function budgetNode(id, repeat) {
  return {
    id,
    timeoutSec: 60,
    taskPacket: { verification: [{ argv: ["verify"], timeoutSec: 10, repeat }] },
    definitionOfDone: [],
    gate: { enabled: false },
  };
}

/** @param {Record<string, unknown>} contract @param {Record<string, unknown>} node */
function budget(contract, node) {
  return nodeBudgetBasisMs(/** @type {any} */ (contract), /** @type {any} */ (node));
}

test("done-when 6: the derived budget counts a verification command with repeat > 1 and finalVerification on a phase-terminal node", () => {
  const contract = budgetContract();
  const once = budget(contract, budgetNode("alpha", 1));
  const thrice = budget(contract, budgetNode("alpha", 3));
  // The packet set is budgeted twice (controller verification and the
  // integration candidate), so two extra 10s runs add 40s.
  assert.equal(thrice - once, 40_000, "repeat > 1 must be counted, including the candidate re-run");
  assert.equal(verificationBudgetMs([{ argv: ["v"], timeoutSec: 10, repeat: 3 }]), 30_000);

  // `alpha` has a dependant, so it is not phase-terminal and carries no
  // finalVerification; `terminal` carries the 2 x 100s set plus its candidate.
  const terminal = budget(contract, budgetNode("terminal", 1));
  assert.equal(terminal - once, 400_000, "finalVerification is budgeted on the phase-terminal node, including its candidate re-run");
});

test("done-when 7: the recovery poll refreshes at but never advances lastProgressAt", () => {
  const runDir = makeRunDir();
  writeRunHeartbeat(runDir, {
    at: "2026-09-14T00:00:00.000Z",
    lastProgressAt: "2026-09-14T00:00:00.000Z",
    iteration: 4,
    activeNodes: [{ nodeId: "alpha", lastProgressAt: "2026-09-14T00:00:00.000Z", budgetBasis: 1_000 }],
  });
  markRecovering(runDir, "2026-09-14T01:00:00.000Z", "2026-09-14T00:10:00.000Z");
  markRecovering(runDir, "2026-09-14T01:00:00.000Z", "2026-09-14T00:10:05.000Z");
  const heartbeat = readHeartbeat(runDir);
  assert.equal(heartbeat?.lastProgressAt, "2026-09-14T00:00:00.000Z", "an alive-but-advancing orphan must not look like perpetual progress");
  assert.equal(heartbeat?.iteration, 4);
  assert.equal(heartbeat?.phase, "recovering");
  assert.equal(heartbeat?.until, "2026-09-14T01:00:00.000Z");
  assert.equal(heartbeat?.at, "2026-09-14T00:10:05.000Z", "at is refreshed each poll so a frozen resume is still caught");
});

test("done-when 7: while recovering the supervisor judges against until + grace, not lastProgressAt", () => {
  const now = Date.parse("2026-09-14T00:10:00Z");
  const heartbeat = {
    at: "2026-09-14T00:10:00.000Z",
    lastProgressAt: "2026-09-14T00:00:00.000Z",
    iteration: 1,
    activeNodes: [{ nodeId: "alpha", lastProgressAt: "2026-09-14T00:00:00.000Z", budgetBasis: 1_000 }],
    phase: "recovering",
    until: "2026-09-14T00:20:00.000Z",
  };
  assert.equal(heartbeatBreach(heartbeat, now), null, "inside until + grace an old lastProgressAt is the bounded recovery, not a breach");
  const beyond = Date.parse("2026-09-14T01:00:00Z");
  assert.equal(heartbeatBreach({ ...heartbeat, at: "2026-09-14T01:00:00.000Z" }, beyond)?.kind, "recovering", "past until + grace the recovery is dead even with a fresh at");
});

test("done-when 10: status reports a real lastTick from heartbeat.json, where 47 of 47 recorded files report null", () => {
  const runDir = makeRunDir();
  // A live detached probe holds the lock, so controllerStatus reports an active
  // controller without naming this test runner's own process group.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("lock probe did not start");
  try {
    writeFileSync(lockPath(runDir), JSON.stringify({
      pid,
      processStartToken: processStartToken(pid),
      startedAt: "2026-09-14T00:00:00.000Z",
      hostname: "test",
    }));
    assert.equal(controllerStatus(runDir, []).status.lastTick, null, "before a heartbeat there is no tick to report");
    writeRunHeartbeat(runDir, { at: "2026-09-14T00:00:05.000Z", lastProgressAt: "2026-09-14T00:00:05.000Z", iteration: 1 });
    const status = controllerStatus(runDir, []);
    assert.equal(status.status.state, "active");
    assert.equal(status.status.lastTick, "2026-09-14T00:00:05.000Z", "a live lock's lastTick is the heartbeat's at");
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The probe is already gone; the assertion above already read the status.
    }
  }
});
