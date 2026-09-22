/**
 * Phase 2.2 — the outcome reduction and the parked state.
 *
 * A parked run is not a finished one: `runProgress` distinguishes success from
 * stopping and waiting, the supervisor keeps watching a parked run, attention
 * re-nags on a schedule, and a node whose remedy is "try again" gets exactly
 * one automatic retry whose consumption survives a controller restart.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PARKED, SETTLED, SUCCESS, TERMINAL } from "../../src/engine/prompts.mjs";
import { reduceRunOutcome, runProgress, superviseRun } from "../../src/engine/supervise.mjs";
import { AUTO_RETRY_CODES, autoRetryConsumed, autoRetryNode, autoRetryParkedNodes, livenessState } from "../../src/engine/lifecycle.mjs";
import { blockDependents } from "../../src/engine/assignment.mjs";
import { transition } from "../../src/engine/state.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";
import { emitScheduledAttention, attentionScheduleSlot, alreadyNotified } from "../../src/engine/notify-queue.mjs";
import { cancelRun } from "../../src/engine/cancel.mjs";
import { checkWorkerScope } from "../../src/engine/scope.mjs";
import { runIsNonterminal } from "../../src/cli/launch.mjs";
import { syncAgentSignal } from "../../src/repo/signal.mjs";
import { describeRuns, selectGarbageCollectableRuns } from "../../src/run/disk-gc.mjs";
import { renderStatus } from "../../src/report/render.mjs";
import { validateContract, loadPersistedContract, CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/contract/index.mjs";
import { fixture, packet, writeContract, withFakeCodex } from "../helpers.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

/** @param {string} runDir @param {string} id @param {Record<string, unknown>} snapshot */
function writeSnapshot(runDir, id, snapshot) {
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "nodes", `${id}.json`), JSON.stringify({ id, ...snapshot }));
}

/** @returns {string} */
function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "runner-parked-"));
}

/**
 * @param {string} startIso
 * @returns {{now: () => number, advance: (milliseconds: number) => void}}
 */
function fakeClock(startIso) {
  let current = Date.parse(startIso);
  return { now: () => current, advance: (milliseconds) => { current += milliseconds; } };
}

/** @param {string|null} exhaustedUntil @returns {Record<string, unknown>} */
function exhaustedNode(exhaustedUntil) {
  return {
    status: "blocked",
    phase: "worker",
    error: { code: "runtime_tier_exhausted", message: "no runtime left" },
    routing: { tierExhaustion: { role: "worker", candidates: [{ runtimeId: "luna", exhaustedUntil }] } },
  };
}

/** A fully valid node snapshot, so `transition` can persist it in a unit test. @param {string} id @param {Partial<import("../../src/contract/index.mjs").NodeSnapshot>} [overrides] @returns {import("../../src/contract/index.mjs").NodeSnapshot} */
function validSnapshot(id, overrides = {}) {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id,
    type: "backend",
    sourceIdentity: { kind: "node", contractId: "parked-unit", nodeId: id },
    packetHash: "a".repeat(64),
    status: "failed",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    result: null,
    gate: null,
    error: { code: "provider_error", message: "boom" },
    ...overrides,
  };
}

/**
 * A run directory with a persisted, loadable contract, valid run metadata and
 * valid node snapshots — enough for the render, launch and cancel readers.
 *
 * @param {{contract?: Record<string, unknown>, statuses?: Record<string, Record<string, unknown>>}} [options]
 */
function makeValidRunDir(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "runner-parked-valid-"));
  const value = fixture({ id: "parked-valid-run", ...(options.contract ?? {}) });
  const contractPath = writeContract(directory, value);
  const runDir = runDirectory(directory, String(value.id));
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  copyFileSync(contractPath, join(runDir, "contract.json"));
  const contract = loadPersistedContract(join(runDir, "contract.json"), undefined);
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    pid: 1234,
    processStartToken: null,
    startedAt: new Date(0).toISOString(),
    sourceIdentity: { kind: "run", contractId: contract.id, campaignId: contract.campaignId },
  }));
  for (const node of contract.nodes) {
    const snapshot = {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      id: node.id,
      type: node.type,
      sourceIdentity: node.sourceIdentity,
      packetHash: node.packetHash,
      status: "pending",
      phase: "waiting",
      attempt: 0,
      revisions: 0,
      runtime: null,
      blockedBy: [],
      startedAt: null,
      updatedAt: new Date(0).toISOString(),
      result: null,
      gate: null,
      error: null,
      ...(options.statuses?.[node.id] ?? {}),
    };
    writeFileSync(join(runDir, "nodes", `${node.id}.json`), `${JSON.stringify(snapshot)}\n`);
  }
  return { runDir, directory, contract };
}

// ---------------------------------------------------------------------------
// done-when 1, 3, 4, 5: the reduction against the declared node set.
// ---------------------------------------------------------------------------

test("done-when 1: an all-settled run that is not all successful reports parked, naming each node", () => {
  const runDir = makeRunDir();
  writeSnapshot(runDir, "alpha", { status: "failed", error: { code: "provider_error", message: "boom" } });
  writeSnapshot(runDir, "beta", { status: "done" });
  const progress = runProgress(runDir);
  assert.equal(progress.state, "done", "every node has settled, so the old state is done");
  assert.equal(progress.runOutcome, "parked");
  assert.deepEqual(progress.outcomeNodes, [{ id: "alpha", status: "failed", errorCode: "provider_error" }]);
});

test("done-when 2: done and no-op report succeeded; a future tier reset reports waiting, then unfinished", () => {
  const succeededDir = makeRunDir();
  writeSnapshot(succeededDir, "alpha", { status: "done" });
  writeSnapshot(succeededDir, "beta", { status: "no-op" });
  assert.equal(runProgress(succeededDir).runOutcome, "succeeded");

  const waitingDir = makeRunDir();
  const clock = fakeClock("2026-09-14T00:00:00Z");
  writeSnapshot(waitingDir, "alpha", exhaustedNode("2026-09-14T00:05:00Z"));
  const waiting = runProgress(waitingDir, clock.now());
  assert.equal(waiting.runOutcome, "waiting");
  assert.equal(waiting.waitingUntil, "2026-09-14T00:05:00.000Z");

  clock.advance(6 * 60_000);
  const due = runProgress(waitingDir, clock.now());
  assert.equal(due.state, "unfinished", "the reset has arrived, so the retry is ordinary work");
  assert.notEqual(due.runOutcome, "parked", "a due tier reset is never filed as parked");
});

test("done-when 3: a three-node contract with one done snapshot does not report succeeded", () => {
  const { runDir } = (() => {
    const directory = mkdtempSync(join(tmpdir(), "runner-parked-sparse-"));
    const value = fixture({
      id: "parked-sparse-run",
      nodes: [
        { id: "alpha", type: "backend", taskPacket: packet(), gate: false },
        { id: "beta", type: "backend", taskPacket: packet(), gate: false },
        { id: "gamma", type: "backend", taskPacket: packet(), gate: false },
      ],
    });
    const contractPath = writeContract(directory, value);
    const sparseRunDir = runDirectory(directory, String(value.id));
    mkdirSync(join(sparseRunDir, "nodes"), { recursive: true });
    copyFileSync(contractPath, join(sparseRunDir, "contract.json"));
    return { runDir: sparseRunDir };
  })();
  writeSnapshot(runDir, "alpha", { status: "done" });
  const progress = runProgress(runDir);
  assert.equal(progress.total, 3, "the declared node set, not the snapshots on disk");
  assert.notEqual(progress.runOutcome, "succeeded");
  assert.equal(progress.runOutcome, "parked");
  const named = (progress.outcomeNodes ?? []).map((node) => `${node.id}:${node.status}`).sort();
  assert.deepEqual(named, ["beta:missing", "gamma:missing"]);
});

test("done-when 4: an unreadable snapshot is named and a durable cancel marker wins over node status", () => {
  const corruptDir = makeRunDir();
  writeSnapshot(corruptDir, "alpha", { status: "running" });
  writeFileSync(join(corruptDir, "nodes", "beta.json"), '{"id":"beta","status":"run');
  const corrupt = runProgress(corruptDir);
  assert.equal(corrupt.state, "unknown", "a torn snapshot is not evidence either way");
  assert.equal(corrupt.runOutcome, "parked");
  const named = (corrupt.outcomeNodes ?? []).find((node) => node.id === "beta");
  assert.equal(named?.status, "unreadable", "the corrupt node is named, never dropped");

  const canceledDir = makeRunDir();
  writeSnapshot(canceledDir, "alpha", { status: "done" });
  writeSnapshot(canceledDir, "beta", { status: "canceled" });
  assert.equal(runProgress(canceledDir).runOutcome, "parked", "without the marker a canceled node is not inferred to cancel the run");
  writeFileSync(join(canceledDir, "cancel.request.json"), JSON.stringify({ requestedAt: new Date(0).toISOString() }));
  assert.equal(runProgress(canceledDir).runOutcome, "canceled", "the durable marker, not the node status, is the run-level cancellation");
});

test("done-when 5: an empty declaration is never succeeded, and validation rejects an empty contract", () => {
  assert.notEqual(reduceRunOutcome([], new Map()).outcome, "succeeded");
  const directory = mkdtempSync(join(tmpdir(), "runner-parked-empty-"));
  assert.throws(
    () => validateContract(fixture({ nodes: [] }), join(directory, "contract.json")),
    /contract\.nodes must be a non-empty array/u,
    "contract validation owns rejecting the empty node set",
  );
});

// ---------------------------------------------------------------------------
// done-when 6, 7: supervise on a parked run, and the escalating re-nag.
// ---------------------------------------------------------------------------

test("done-when 6: supervise on a parked run reports attention, keeps ticking and does not return done", async () => {
  const runDir = makeRunDir();
  writeSnapshot(runDir, "alpha", { status: "failed", error: { code: "provider_error", message: "boom" } });
  const clock = fakeClock("2026-09-14T00:00:00Z");
  /** @type {string[]} */
  const outcomes = [];
  const outcome = await superviseRun(runDir, {
    intervalSec: 1,
    maxTicks: 3,
    now: clock.now,
    sleep: async () => {},
    launch: () => { throw new Error("a parked run is never relaunched"); },
    onTick: (tick) => { outcomes.push(tick.progress.runOutcome ?? "none"); },
  });
  assert.equal(outcome.state, "stopped", "the tick budget, not a finished run, ends the loop");
  assert.equal(outcome.reason, "tick budget exhausted");
  assert.equal(outcome.ticks, 3);
  assert.deepEqual(outcomes, ["parked", "parked", "parked"]);
  const metadata = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(metadata.attention.code, "provider_error", "the durable attention anchor names the parked code");
});

test("done-when 7: attention re-emits at 10m, 1h, 4h and every 4h, survives a restart and is deduped per slot", async () => {
  assert.equal(attentionScheduleSlot(-1), -1);
  assert.equal(attentionScheduleSlot(10 * 60_000), 0);
  assert.equal(attentionScheduleSlot(60 * 60_000), 1);
  assert.equal(attentionScheduleSlot(4 * 60 * 60_000), 2);
  assert.equal(attentionScheduleSlot(8 * 60 * 60_000), 3);
  assert.equal(attentionScheduleSlot(12 * 60 * 60_000), 4);

  const runDir = makeRunDir();
  const anchor = "2026-09-14T00:00:00Z";
  const base = Date.parse(anchor);
  assert.equal(await emitScheduledAttention(runDir, { anchor, code: "provider_error", now: base + 9 * 60_000 }), null, "before ten minutes nothing is due");
  assert.equal(await emitScheduledAttention(runDir, { anchor, code: "provider_error", now: base + 10 * 60_000 }), 0);
  assert.equal(await emitScheduledAttention(runDir, { anchor, code: "provider_error", now: base + 10 * 60_000 }), null, "the same slot is never announced twice, even across a restart");
  assert.equal(await emitScheduledAttention(runDir, { anchor, code: "provider_error", now: base + 60 * 60_000 }), 1);
  assert.equal(await emitScheduledAttention(runDir, { anchor, code: "provider_error", now: base + 4 * 60 * 60_000 }), 2);
  const receipts = readFileSync(join(runDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(receipts.filter((receipt) => receipt.type === "attention").length, 3);
  assert.ok(alreadyNotified(runDir, `run.attention:${basename(runDir)}:2026-09-14T00:00:00Z:0`), "the slot receipt is durable");
});

test("done-when 7: a parked run anchors attention and re-nags across a supervisor restart", async () => {
  const runDir = makeRunDir();
  writeSnapshot(runDir, "alpha", { status: "blocked", error: { code: "provider_error", message: "boom" } });
  const clock = fakeClock("2026-09-14T00:00:00Z");
  await superviseRun(runDir, {
    intervalSec: 1,
    maxTicks: 1,
    now: clock.now,
    sleep: async () => {},
    launch: () => {},
  });
  const anchored = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(typeof anchored.attention.at, "string");

  // The anchor is durable, so a second supervisor -- a restart -- reads the
  // same interval and re-nags when the ten-minute slot comes due.
  clock.advance(10 * 60_000);
  await superviseRun(runDir, {
    intervalSec: 1,
    maxTicks: 1,
    now: clock.now,
    sleep: async () => {},
    launch: () => {},
  });
  assert.equal(alreadyNotified(runDir, `run.attention:${basename(runDir)}:${anchored.attention.at}:0`), true, "the restart re-nags from the durable anchor");
});

test("done-when 7: resumeRun clears the anchor only when it changed node state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-parked-resume-attention-"));
  const path = writeContract(directory, fixture({ id: "parked-resume-attention-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "worker-fail", async () => (await runContract(path)).runDir);
  const snapshotPath = join(runDir, "nodes", "build.json");
  const parkedSnapshot = readFileSync(snapshotPath, "utf8");
  assert.equal(JSON.parse(parkedSnapshot).status, "failed", "the run parks before the resume is attempted");
  const anchor = { code: "provider_error", message: "boom", at: new Date(0).toISOString() };
  const persisted = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...persisted, attention: anchor }));

  // A resume that cannot change state -- here a context_missing node it may
  // not re-dispatch -- leaves the anchor in place, so the next park interval
  // still re-nags. This is the precedence guard: resume passes no attention,
  // and the persisted record must survive the run.json rewrite.
  writeFileSync(snapshotPath, JSON.stringify({
    ...JSON.parse(parkedSnapshot),
    status: "blocked",
    phase: "worker",
    error: { code: "context_missing", message: "missing context" },
  }));
  await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).attention, anchor, "a resume that changed nothing does not silence the re-nag");

  // The same run, resumed once it can change state, clears the anchor and
  // finishes; the supervisor would now report done instead of parked.
  writeFileSync(snapshotPath, parkedSnapshot);
  await withFakeCodex(directory, "pass", () => resumeRun(runDir));
  const cleared = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(cleared.attention, null, "a resume that changed node state clears the durable anchor");
  assert.equal(JSON.parse(readFileSync(snapshotPath, "utf8")).status, "done");
});

// ---------------------------------------------------------------------------
// done-when 8, 9, 10, 11: the one automatic retry.
// ---------------------------------------------------------------------------

test("done-when 8: judge_unavailable and provider_error retry once; timeout codes park with an empty seal", () => {
  for (const code of ["provider_error", "judge_unavailable"]) {
    const runDir = makeRunDir();
    const phase = code === "judge_unavailable" ? "judge" : "worker";
    const status = code === "judge_unavailable" ? "blocked" : "failed";
    const state = validSnapshot("build", { status, phase, error: { code, message: "try again" } });
    assert.equal(autoRetryNode(runDir, state, undefined, null), true, `${code} earns its one retry`);
    assert.equal(state.status, "pending");
    assert.equal(state.error, null);
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "auto_retry" && event.errorCode === code), "the retry carries its own event code");
  }
  for (const code of ["stall_timeout", "wall_clock_timeout"]) {
    const runDir = makeRunDir();
    const state = validSnapshot("build", { status: "stalled", error: { code, message: "timed out" } });
    assert.equal(autoRetryNode(runDir, state, undefined, null), false, `${code} parks with an empty seal`);
    assert.equal(autoRetryConsumed(runDir, "build"), false);
  }
  assert.equal(AUTO_RETRY_CODES.has("provider_error"), true);
});

test("a stream that ended before its terminal envelope earns the same retry an error envelope earns", () => {
  // The asymmetry this closes: a provider that answered with an error got a
  // second attempt, and a provider whose transport died mid-turn -- the less
  // informative failure -- parked on the first.
  const runDir = makeRunDir();
  const state = validSnapshot("build", { status: "failed", error: { code: "incomplete_stream", message: "Claude emitted no result event" } });
  assert.equal(autoRetryNode(runDir, state, undefined, null), true, "incomplete_stream earns its one retry");
  assert.equal(state.status, "pending");
  assert.equal(state.error, null);
  assert.equal(autoRetryNode(runDir, validSnapshot("build", { status: "failed", error: { code: "incomplete_stream", message: "again" } }), undefined, null), false, "and only one");
});

test("done-when 9 and 11: consumption survives a restart and touches neither revision nor hop counter", () => {
  const runDir = makeRunDir();
  const state = validSnapshot("build", { status: "failed", error: { code: "provider_error", message: "boom" }, revisions: 0, routing: { history: [], currentOverride: null } });
  assert.equal(autoRetryNode(runDir, state, undefined, null), true);
  assert.equal(state.revisions, 0, "the automatic retry is not a gate revision");
  assert.equal(state.routing?.history?.length, 0, "the automatic retry spends no failover hop");
  const stored = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(stored.autoRetries.build.code, "provider_error");
  const restarted = validSnapshot("build", { status: "failed", error: { code: "provider_error", message: "boom again" } });
  assert.equal(autoRetryNode(runDir, restarted, undefined, null), false, "a restart does not grant a fresh one");
  assert.equal(restarted.status, "failed");
});

test("done-when 10: a quota reset takes no auto_retry, and the retry precedes the ordinary parking path", async () => {
  const resetDir = makeRunDir();
  const resetState = validSnapshot("build", {
    status: "blocked",
    phase: "worker",
    error: { code: "provider_error", message: "usage limit", exhaustedUntil: "2026-09-14T01:00:00Z" },
  });
  assert.equal(autoRetryNode(resetDir, resetState, undefined, null), false, "an announced reset is waited for, not retried immediately");
  assert.equal(autoRetryConsumed(resetDir, "build"), false);

  const directory = mkdtempSync(join(tmpdir(), "runner-parked-retry-e2e-"));
  const path = writeContract(directory, fixture({ id: "parked-retry-e2e-run", pollIntervalMs: 10 }));
  const result = await withFakeCodex(directory, "worker-fail", () => runContract(path));
  const node = result.states.get("build");
  assert.ok(node, "the run has its build node");
  assert.equal(node.status, "failed");
  assert.deepEqual((node.invocations ?? []).map((invocation) => invocation.runtimeId), ["luna", "luna"], "both attempts stay on the same runtime");
  const stored = JSON.parse(readFileSync(join(result.runDir, "run.json"), "utf8"));
  assert.equal(stored.autoRetries.build.code, "provider_error");
});

test("done-when 12: a dependant waits while the parent still has its retry and blocks only once it parks", () => {
  const { runDir, contract } = makeValidRunDir({
    contract: {
      nodes: [
        { id: "first", type: "backend", taskPacket: packet(), gate: false },
        { id: "second", type: "backend", taskPacket: packet(), dependsOn: ["first"], gate: false },
      ],
    },
    statuses: {
      first: { status: "failed", phase: "worker", error: { code: "provider_error", message: "boom" }, attempt: 1 },
      second: { status: "pending", phase: "waiting" },
    },
  });
  const states = new Map(contract.nodes.map((node) => {
    const snapshot = JSON.parse(readFileSync(join(runDir, "nodes", `${node.id}.json`), "utf8"));
    return [node.id, snapshot];
  }));
  autoRetryParkedNodes(contract, runDir, states, /** @type {any} */ (null));
  assert.equal(autoRetryConsumed(runDir, "first"), true, "the parent's one retry is what re-opens it");
  assert.equal(states.get("first")?.status, "pending", "the parent is re-opened before dependants are considered");
  blockDependents(contract, runDir, states, /** @type {any} */ (null));
  assert.equal(states.get("second")?.status, "pending", "the dependant stays pending while the retry is unspent");
  assert.equal(states.get("second")?.phase, "waiting");

  // The retry is spent and the parent parks for good: now the dependant blocks.
  const failedFirst = validSnapshot("first", { status: "failed", phase: "worker", error: { code: "provider_error", message: "boom" } });
  states.set("first", failedFirst);
  blockDependents(contract, runDir, states, /** @type {any} */ (null));
  assert.equal(states.get("second")?.status, "blocked");
  assert.equal(states.get("second")?.error?.code, "dependency_failed");
  assert.deepEqual(states.get("second")?.blockedBy, ["first"]);
});

// ---------------------------------------------------------------------------
// done-when 13, 13b, 14: the readers, the render clock and the parked guards.
// ---------------------------------------------------------------------------

test("done-when 13: the split is exactly terminal versus parked, and each shared reader agrees", () => {
  assert.deepEqual([...TERMINAL].sort(), ["canceled", "done", "no-op"]);
  assert.deepEqual([...PARKED].sort(), ["blocked", "exhausted", "failed", "stalled"]);
  for (const status of PARKED) assert.equal(SETTLED.has(status), true);
  for (const status of SUCCESS) assert.equal(SETTLED.has(status), true);
  assert.equal(SUCCESS.has("stalled"), false);

  // assignment.blockDependents treats a parked parent as blocking, never a
  // successful one.
  const { runDir, contract } = makeValidRunDir({
    contract: { nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet(), dependsOn: ["first"], gate: false },
    ] },
    statuses: {
      first: { status: "exhausted", phase: "worker" },
      second: { status: "pending", phase: "waiting" },
    },
  });
  const states = new Map(contract.nodes.map((node) => [node.id, JSON.parse(readFileSync(join(runDir, "nodes", `${node.id}.json`), "utf8"))]));
  blockDependents(contract, runDir, states, /** @type {any} */ (null));
  assert.equal(states.get("second")?.error?.code, "dependency_failed");

  // lifecycle.livenessState reports a settled parked run as failed, not done.
  assert.equal(livenessState(/** @type {any} */ (new Map([["a", { status: "failed" }]]))), "failed");
  assert.equal(livenessState(/** @type {any} */ (new Map([["a", { status: "blocked" }]]))), "blocked");
  assert.equal(livenessState(/** @type {any} */ (new Map([["a", { status: "done" }]]))), "done");

  // launch.runIsNonterminal sees only unresolved nodes as live work.
  const live = makeValidRunDir({ statuses: { build: { status: "blocked", phase: "worker" } } });
  assert.equal(runIsNonterminal(live.runDir), false, "a parked node is not a reason to hold a detached bootstrap");
  const running = makeValidRunDir({ statuses: { build: { status: "running", phase: "worker" } } });
  assert.equal(runIsNonterminal(running.runDir), true);
});

test("done-when 13: blockDependents blocks only a parked parent, never a successful or canceled one", () => {
  // The old predicate was `TERMINAL.has(parent) && parent !== "done"`, and the
  // old TERMINAL still held `no-op` and `canceled`; the split's narrower PARKED
  // predicate intentionally no longer blocks on either. A successful parent
  // must never poison its dependants, and the canceled parent is safe because
  // the controller cancels every non-settled node on the same path.
  const { runDir, contract } = makeValidRunDir({
    contract: { nodes: [
      { id: "first", type: "backend", taskPacket: packet(), gate: false },
      { id: "second", type: "backend", taskPacket: packet(), dependsOn: ["first"], gate: false },
    ] },
    statuses: {
      first: { status: "no-op", phase: "complete" },
      second: { status: "pending", phase: "waiting" },
    },
  });
  const states = new Map(contract.nodes.map((node) => [node.id, JSON.parse(readFileSync(join(runDir, "nodes", `${node.id}.json`), "utf8"))]));
  const first = states.get("first");

  blockDependents(contract, runDir, states, /** @type {any} */ (null));
  assert.equal(states.get("second")?.status, "pending", "a no-op parent is success and never blocks its dependants");

  if (first) first.status = "canceled";
  blockDependents(contract, runDir, states, /** @type {any} */ (null));
  assert.equal(states.get("second")?.status, "pending", "a canceled parent is not a parked failure");
  assert.equal(states.get("second")?.phase, "waiting");

  if (first) first.status = "failed";
  blockDependents(contract, runDir, states, /** @type {any} */ (null));
  assert.equal(states.get("second")?.status, "blocked", "a parked parent does block");
  assert.equal(states.get("second")?.error?.code, "dependency_failed");
});

test("done-when 13: state.transition still logs a parked status as settled", () => {
  // `transition` replaced its TERMINAL membership test with SETTLED, which is
  // the same union, so a parked node keeps its `[node] <id> <status>` line.
  const runDir = makeRunDir();
  const state = validSnapshot("build", { status: "pending", phase: "worker", error: null });
  const write = mock.method(process.stdout, "write", () => true);
  try {
    transition(runDir, state, "failed", { phase: "worker", error: { code: "provider_error", message: "boom" } }, null);
  } finally {
    write.mock.restore();
  }
  const logged = write.mock.calls.map((call) => String(call.arguments[0] ?? ""));
  assert.ok(logged.some((line) => line.includes("[node] build failed")), "a parked transition is reported as settled");
  assert.match(readFileSync(join(runDir, "nodes", "build.json"), "utf8"), /"status":"failed"/u);
});

test("done-when 13: campaign-watch and web keep the pre-split union, accounted outside this node", () => {
  // These three readers live outside this node's write scope. Each still
  // enumerates the pre-split union -- the old TERMINAL set plus the British
  // "cancelled" alias -- so the split is a no-op for them and today's
  // behaviour is preserved exactly. Narrowing them would change campaign-watch
  // liveness and web terminal/attention styling, a separate decision; this
  // pins the union so the reconciliation cannot drift in without a test.
  const skillDir = fileURLToPath(new URL("../..", import.meta.url));
  const expected = ["blocked", "canceled", "cancelled", "done", "exhausted", "failed", "no-op", "stalled"];
  /** @param {string} relative @param {string} name @returns {string[]} */
  const readStatusSet = (relative, name) => {
    const source = readFileSync(join(skillDir, relative), "utf8");
    const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`, "u").exec(source);
    assert.ok(match, `${relative} no longer declares ${name}`);
    return [...(match[1] ?? "").matchAll(/"([^"]+)"/gu)].map((entry) => String(entry[1])).sort();
  };
  assert.deepEqual(readStatusSet("src/campaign/watch.mjs", "TERMINAL_NODE_STATUSES"), expected);
  assert.deepEqual(readStatusSet("src/web/api.mjs", "RUN_TERMINAL_STATUSES"), expected);
  assert.deepEqual(readStatusSet("src/web/server.mjs", "TERMINAL_STATUSES"), expected);
});

test("done-when 13: a parked node keeps the managed signal active and blocks garbage collection", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runner-parked-signal-"));
  const runDir = join(runsDir, "parked-run");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ startedAt: new Date(0).toISOString() }));
  writeFileSync(join(runDir, "nodes", "alpha.json"), JSON.stringify({ id: "alpha", status: "blocked" }));
  writeFileSync(join(runsDir, "..", "AGENTS.md"), "# repo\n");

  assert.equal(syncAgentSignal(runsDir), true, "a parked run still appears in the managed block");
  assert.match(readFileSync(join(runsDir, "..", "AGENTS.md"), "utf8"), /parked-run/u);

  const descriptors = describeRuns(runsDir);
  assert.equal(descriptors.find((run) => run.path === runDir)?.allNodesTerminal, false);
  assert.deepEqual(selectGarbageCollectableRuns(descriptors, {}), [], "a parked run is never collected as completed");
});

test("done-when 13b: a parked node's elapsed clock stops in the rendered table", () => {
  const { runDir } = makeValidRunDir({
    statuses: {
      build: {
        status: "blocked",
        phase: "worker",
        startedAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T01:00:00.000Z",
        error: { code: "provider_error", message: "boom" },
      },
    },
  });
  const rendered = renderStatus(runDir);
  assert.match(rendered, /1h00m/u, "the clock stopped at updatedAt instead of running to now");
  assert.match(rendered, /build/u);
});

test("done-when 14: scope processing leaves a parked node alone and cancel does not overwrite it", async () => {
  const runDir = makeRunDir();
  const state = validSnapshot("build", { status: "blocked", phase: "worker", error: { code: "provider_error", message: "boom" } });
  const scopeOk = checkWorkerScope(
    /** @type {any} */ ({}),
    runDir,
    /** @type {any} */ ({ scopeChecked: false, state, node: { taskPacket: { writeFiles: [], writeRoots: [] } }, invocation: { snapshotPath: null } }),
    /** @type {any} */ (null),
  );
  assert.equal(scopeOk, false);
  assert.equal(state.status, "blocked", "a settled parked node is not overwritten by a scope failure");

  const valid = makeValidRunDir({ statuses: { build: { status: "blocked", phase: "worker", error: { code: "provider_error", message: "boom" } } } });
  await cancelRun(valid.runDir);
  const afterCancel = JSON.parse(readFileSync(join(valid.runDir, "nodes", "build.json"), "utf8"));
  assert.equal(afterCancel.status, "blocked", "cancel leaves the parked status as the evidence it is");
  assert.ok(readFileSync(join(valid.runDir, "cancel.request.json"), "utf8"), "the durable run-level cancellation marker is written");
});
