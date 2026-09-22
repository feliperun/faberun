import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";
import { planResumeRetry } from "../../src/engine/retry.mjs";
import { buildRouting, planRoute, upsertTierExhaustionCandidate } from "../../src/engine/backoff.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { fakeCodex, fixture, packet, withFakeCodex, writeContract, ensureAttemptWorktree } from "../helpers.mjs";
import { nodeState, withBrokenGateCodex } from "../runner-helpers.mjs";
import { snapshot as contractSnapshot } from "../contract/helpers.mjs";

// Phase 1a of the follow-up spec: durable tier-exhaustion evidence that
// survives its own hops, split from an append-only generation counter so
// clearing one never resets the other.

const READY = { available: true, exhaustedUntil: null, reason: "ready" };
const FAILOVER = /** @type {const} */ ({ kind: "failover", reason: "provider" });
const ROUTE_ERROR = { code: "provider_exhausted", message: "provider exhausted" };
const NOW = Date.parse("2026-09-04T06:00:00.000Z");

/**
 * A codex-shaped provider that logs, on every dispatched turn, which runtime
 * it is and which tier-exhaustion candidates the persisted node already
 * carries. The log path is embedded rather than passed through the
 * environment so the observation is exactly the node snapshot the controller
 * wrote before spawning this turn.
 *
 * @param {string} log absolute path to the evidence log
 * @param {{fail: boolean}} options
 * @returns {string}
 */
function tierProvider(log, { fail }) {
  const path = join(mkdtempSync(join(tmpdir(), "runner-tier-provider-")), "tier-provider.mjs");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) {
  console.log("tier-provider 1.0.0");
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    // The dispatch gate's live preflight says hello with one trivial prompt
    // before any dispatch: a real provider answers it even when this one is
    // out of quota, and the hello is not a dispatched turn, so it is answered
    // here and never reaches the evidence log the assertions read.
    if (input.includes("FABERUN_PREFLIGHT_OK")) {
      console.log(JSON.stringify({ type: "thread.started", thread_id: "preflight-hello" }));
      const hello = JSON.stringify({ status: "done", summary: "preflight hello answered", verification: [], artifacts: [], missingContext: [] });
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: hello } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    const runDir = process.env.FABERUN_RUN_DIR;
    const nodeId = process.env.FABERUN_NODE_ID;
    let runtime = null;
    let candidates = [];
    let cycle = 0;
    try {
      const state = JSON.parse(readFileSync(join(runDir, "nodes", nodeId + ".json"), "utf8"));
      runtime = state.runtime?.id ?? null;
      candidates = (state.routing?.tierExhaustion?.candidates ?? []).map((candidate) => candidate.runtimeId);
      cycle = state.routing?.tierExhaustionCycle ?? 0;
    } catch {}
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ runtime, candidates, cycle }) + "\\n");
    console.log(JSON.stringify({ type: "thread.started", thread_id: "tier-thread" }));
    if (${fail ? "true" : "false"}) {
      console.log(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Please try again at 12:58 PM" } }));
      process.exitCode = 1;
      return;
    }
    const result = JSON.stringify({ status: "done", summary: "worker complete", verification: [], artifacts: [], missingContext: [] });
    const resultPath = /canonical result file: (\\S+\\.json)/.exec(input)?.[1];
    if (resultPath) writeFileSync(resultPath, result);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  });
}
`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * @param {string} prefix
 * @returns {{directory: string, path: string}}
 */
function tierContract(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = writeContract(directory, fixture({
    id: `${prefix}run`,
    pollIntervalMs: 10,
    timeoutSec: 60,
    // Omitted defaults are what make the worker a composed same-tier route.
    runtimeDefaults: {},
    runtimes: {
      a: { harness: "codex", model: "a", vendor: "vendor-a", executable: "/nonexistent/codex", tier: 1, costRank: 1 },
      b: { harness: "codex", model: "b", vendor: "vendor-b", executable: "/nonexistent/codex", tier: 1, costRank: 2 },
      c: { harness: "codex", model: "c", vendor: "vendor-c", executable: "/nonexistent/codex", tier: 1, costRank: 3 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  return { directory, path };
}

/** @param {string} prefix @returns {import("../../src/contract/index.mjs").ValidatedContract} */
function validatedTierContract(prefix) {
  const { path } = tierContract(prefix);
  return validateContract(JSON.parse(readFileSync(path, "utf8")), path);
}

/**
 * @param {string} runtimeId
 * @param {number} cycle
 * @returns {{phase: "worker", runtimeId: string, revision: number, cycle: number}}
 */
function attempted(runtimeId, cycle) {
  return { phase: "worker", runtimeId, revision: 0, cycle };
}

/** @param {string} log @returns {{runtime: string|null, candidates: string[], cycle: number}[]} */
function evidenceLog(log) {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * A node blocked on tier exhaustion, as `resume` reads it: the phase that
 * exhausted, the generation's evidence, and (when a worker turn was accepted)
 * the result the block preserved.
 *
 * @param {"worker"|"judge"} role
 * @param {{runtimeId: string, exhaustedUntil: string|null}[]} candidates
 * @param {{result?: unknown, cycle?: number}} [options]
 * @returns {any}
 */
function tierBlockedState(role, candidates, options = {}) {
  return {
    id: "build",
    status: "blocked",
    phase: role,
    result: options.result ?? null,
    error: { code: "runtime_tier_exhausted", message: "no available runtime remains in tier 1" },
    routing: {
      history: [],
      currentOverride: null,
      assignments: { worker: "a", judge: "b", composedWorker: true, composedJudge: false },
      availability: { a: READY, b: READY, c: READY },
      tierExhaustionCycle: options.cycle ?? 0,
      tierExhaustion: { role, candidates },
    },
  };
}

test("a three-candidate tier exhaustion records all three candidates in order, asserted during the sequence", async () => {
  const logDirectory = mkdtempSync(join(tmpdir(), "runner-tier-evidence-log-"));
  const log = join(logDirectory, "evidence.jsonl");
  const directory = mkdtempSync(join(tmpdir(), "runner-tier-evidence-"));
  const path = writeContract(directory, fixture({
    id: "tier-evidence-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: {},
    runtimes: {
      a: { harness: "codex", model: "a", vendor: "vendor-a", executable: tierProvider(log, { fail: true }), tier: 1, costRank: 1 },
      b: { harness: "codex", model: "b", vendor: "vendor-b", executable: tierProvider(log, { fail: true }), tier: 1, costRank: 2 },
      c: { harness: "codex", model: "c", vendor: "vendor-c", executable: tierProvider(log, { fail: true }), tier: 1, costRank: 3 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "blocked", state.error?.message);
  assert.equal(state.error?.code, "runtime_tier_exhausted");
  assert.equal(state.routing?.tierExhaustion?.role, "worker");
  assert.deepEqual(
    (state.routing?.tierExhaustion?.candidates ?? []).map((candidate) => candidate.runtimeId),
    ["a", "b", "c"],
    "the final block records the third candidate after the first two hops",
  );
  assert.deepEqual(
    (state.routing?.tierExhaustion?.candidates ?? []).map((candidate) => candidate.exhaustedUntil),
    [null, null, null],
    "a provider that announced no reset is recorded as null, never a guessed instant",
  );
  const entries = evidenceLog(log);
  assert.deepEqual(entries.map((entry) => entry.runtime), ["a", "b", "c"]);
  assert.deepEqual(
    entries.map((entry) => entry.candidates),
    [[], ["a"], ["a", "b"]],
    "each dispatched candidate saw the evidence every earlier hop had already persisted",
  );
});

test("buildRouting preserves assignments, availability, and the generation counter across a hop", () => {
  const assignments = { worker: "a", judge: "b", composedWorker: true };
  const availability = { a: READY, b: READY };
  const plan = {
    blocked: null,
    nextRuntime: "b",
    ruleIndex: undefined,
    revision: 0,
    hop: 1,
    backoffSec: 0,
    backoffUntil: "2026-09-04T06:00:00.000Z",
    composed: true,
    tierExhaustion: { role: "worker", candidates: [{ runtimeId: "a", exhaustedUntil: null }, { runtimeId: "b", exhaustedUntil: null }] },
  };
  const state = {
    routing: {
      history: [],
      currentOverride: null,
      assignments,
      availability,
      tierExhaustion: { role: "worker", candidates: [{ runtimeId: "a", exhaustedUntil: null }] },
      tierExhaustionCycle: 2,
    },
  };
  const { routing } = buildRouting(/** @type {any} */ (state), {
    role: "worker",
    error: { code: "provider_exhausted", message: "exhausted" },
    current: "a",
    plan: /** @type {any} */ (plan),
    schedule: FAILOVER,
    status: "failed",
    now: NOW,
  });
  // Without the spread `buildRouting` would return only history/currentOverride
  // and every one of these would be silently dropped on the hop.
  assert.deepEqual(routing.assignments, assignments);
  assert.deepEqual(routing.availability, availability);
  assert.equal(routing.tierExhaustionCycle, 2);
  assert.deepEqual(routing.tierExhaustion, plan.tierExhaustion);
});

test("the tier-exhaustion generation, not the revision, scopes planRoute's attempted set", () => {
  const contract = validatedTierContract("runner-tier-cycle-");
  const node = contract.nodes[0];
  const state = /** @type {any} */ ({
    revisions: 0,
    routing: {
      history: [],
      currentOverride: null,
      assignments: { worker: "a", judge: "b", composedWorker: true, composedJudge: false },
      availability: { a: READY, b: READY, c: READY },
      tierExhaustionCycle: 1,
      tierExhaustion: { role: "worker", candidates: [] },
    },
    // Every candidate was already attempted in generation 0.
    invocations: [attempted("a", 0), attempted("b", 0), attempted("c", 0)],
  });
  const first = planRoute(contract, node, state, "worker", ROUTE_ERROR, "a", FAILOVER);
  assert.equal(first.blocked, null, "generation 1 ignores generation 0's invocations");
  assert.equal(first.nextRuntime, "b");
  state.invocations.push(attempted("a", 1));
  const second = planRoute(contract, node, state, "worker", ROUTE_ERROR, "b", FAILOVER);
  assert.equal(second.blocked, null);
  assert.equal(second.nextRuntime, "c");
  state.invocations.push(attempted("b", 1));
  const third = planRoute(contract, node, state, "worker", ROUTE_ERROR, "c", FAILOVER);
  assert.equal(third.blocked?.code, "runtime_tier_exhausted", "generation 1 walks all three candidates again");
  // The same invocations read as generation 0 exclude every candidate and
  // block at once: the cycle dimension is what changes the route, not revision.
  const generationZero = { ...state, routing: { ...state.routing, tierExhaustionCycle: 0 } };
  assert.equal(planRoute(contract, node, generationZero, "worker", ROUTE_ERROR, "a", FAILOVER).blocked?.code, "runtime_tier_exhausted");
});

test("a tier-exhaustion block leaves revisions untouched while a judge rejection still consumes one", async () => {
  const logDirectory = mkdtempSync(join(tmpdir(), "runner-tier-revisions-log-"));
  const log = join(logDirectory, "evidence.jsonl");
  const tierDirectory = mkdtempSync(join(tmpdir(), "runner-tier-revisions-tier-"));
  const tierPath = writeContract(tierDirectory, fixture({
    id: "tier-revisions-tier-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: {},
    runtimes: {
      only: { harness: "codex", model: "only", vendor: "vendor-only", executable: tierProvider(log, { fail: true }), tier: 1, costRank: 1 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const tierResult = await runContract(tierPath);
  const exhausted = nodeState(tierResult);
  assert.equal(exhausted.status, "blocked", exhausted.error?.message);
  assert.equal(exhausted.error?.code, "runtime_tier_exhausted");
  assert.equal(exhausted.revisions, 0, "tier-exhaustion routing is not a gate revision");

  const judgeDirectory = mkdtempSync(join(tmpdir(), "runner-tier-revisions-judge-"));
  const judgePath = writeContract(judgeDirectory, fixture({
    id: "tier-revisions-judge-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "blocking", failOn: ["major", "critical"], maxRevisions: 1 },
    }],
  }));
  const judgeResult = await withBrokenGateCodex(judgeDirectory, () => runContract(judgePath));
  const judged = nodeState(judgeResult);
  assert.equal(judged.revisions, 1, "a judge rejection still advances the revision round counter");
  assert.equal(judged.routing?.tierExhaustionCycle ?? 0, 0, "a judge rejection never touches the tier generation counter");
});

test("a node blocked for a reason this feature does not drive carries no tierExhaustion field", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-tier-other-block-"));
  const path = writeContract(directory, fixture({
    id: "tier-other-block-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await withFakeCodex(directory, "blocked-context", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "context_missing");
  assert.equal(state.routing?.tierExhaustion, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(state.routing ?? {}, "tierExhaustion"));
});

test("the schema round-trips tier evidence, the generation counter, and an invocation cycle", () => {
  const baseInvocation = {
    id: "inv-1", pid: 1, processGroupId: null, processStartToken: null,
    harness: "codex", runtimeId: "a", phase: "worker",
    promptPath: "/tmp/prompt", stdoutPath: "/tmp/out", stderrPath: "/tmp/err",
    startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deadlineAt: "2026-01-01T01:00:00.000Z",
    closedAt: null, exitCode: null, signal: null, status: "closed", executable: "/tmp/exec",
    runId: "run", campaignId: "campaign", planPhase: "phase", role: "worker",
    runtimeFingerprint: "f".repeat(64), model: "m", reasoning: null, sandbox: null,
    continuationId: null, continuationMode: "fresh", revision: 0,
  };
  const tierExhaustion = {
    role: "worker",
    candidates: [
      { runtimeId: "a", exhaustedUntil: null },
      { runtimeId: "b", exhaustedUntil: "2026-09-04T12:00:00.000Z" },
    ],
  };
  const validated = validateNodeSnapshot(contractSnapshot({
    routing: { history: [], currentOverride: null, tierExhaustion, tierExhaustionCycle: 3 },
    invocations: [{ ...baseInvocation, cycle: 2 }],
  }));
  assert.deepEqual(validated.routing?.tierExhaustion, tierExhaustion);
  assert.equal(validated.routing?.tierExhaustionCycle, 3);
  assert.equal(/** @type {any} */ (validated.invocations?.[0]).cycle, 2, "an invocation's cycle round-trips");

  const cases = [
    [contractSnapshot({ routing: { history: [], currentOverride: null, tierExhaustion: { ...tierExhaustion, cycle: 1 } } }), /tierExhaustion has unexpected field cycle/u],
    [contractSnapshot({ routing: { history: [], currentOverride: null, tierExhaustion: { role: "sre", candidates: [] } } }), /tierExhaustion\.role is invalid/u],
    [contractSnapshot({ routing: { history: [], currentOverride: null, tierExhaustion: { role: "worker", candidates: [{ runtimeId: "a", exhaustedUntil: null, extra: true }] } } }), /tierExhaustion\.candidates\[0\] has unexpected field extra/u],
    [contractSnapshot({ routing: { history: [], currentOverride: null, tierExhaustionCycle: -1 } }), /tierExhaustionCycle must be a non-negative integer/u],
    [contractSnapshot({ invocations: [{ ...baseInvocation, cycle: -1 }] }), /invocations\[0\]\.cycle must be a non-negative integer/u],
    [contractSnapshot({ invocations: [{ ...baseInvocation, typo: true }] }), /invocations\[0\] has unexpected field typo/u],
  ];
  for (const [value, expected] of cases) {
    assert.throws(() => validateNodeSnapshot(/** @type {any} */ (value)), expected);
  }
});

test("an ordinary success after a tier hop removes the evidence and leaves the counter untouched", async () => {
  const logDirectory = mkdtempSync(join(tmpdir(), "runner-tier-cleanup-log-"));
  const log = join(logDirectory, "evidence.jsonl");
  const directory = mkdtempSync(join(tmpdir(), "runner-tier-cleanup-"));
  const path = writeContract(directory, fixture({
    id: "tier-cleanup-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: {},
    runtimes: {
      a: { harness: "codex", model: "a", vendor: "vendor-a", executable: tierProvider(log, { fail: true }), tier: 1, costRank: 1 },
      b: { harness: "codex", model: "b", vendor: "vendor-b", executable: tierProvider(log, { fail: false }), tier: 1, costRank: 2 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  // The hop to b provably carried a's evidence; the success then removed it.
  assert.deepEqual(evidenceLog(log).map((entry) => entry.candidates), [[], ["a"]]);
  assert.equal(state.routing?.tierExhaustion, undefined, "an ordinary success ends the evidence generation");
  assert.ok(!Object.prototype.hasOwnProperty.call(state.routing ?? {}, "tierExhaustion"));
  assert.equal(state.routing?.tierExhaustionCycle ?? 0, 0, "cleanup never removes the generation counter");
});

test("cleanup keeps the generation counter so a later exhaustion routes by the current generation", () => {
  const contract = validatedTierContract("runner-tier-regression-");
  const node = contract.nodes[0];
  const state = /** @type {any} */ ({
    revisions: 0,
    routing: {
      history: [],
      currentOverride: null,
      assignments: { worker: "a", judge: "b", composedWorker: true, composedJudge: false },
      availability: { a: READY, b: READY, c: READY },
      tierExhaustionCycle: 0,
      tierExhaustion: {
        role: "worker",
        candidates: [
          { runtimeId: "a", exhaustedUntil: null },
          { runtimeId: "b", exhaustedUntil: null },
          { runtimeId: "c", exhaustedUntil: null },
        ],
      },
    },
    invocations: [attempted("a", 0), attempted("b", 0), attempted("c", 0)],
  });
  // Phase 1b starts generation 1 with fresh, empty evidence.
  state.routing.tierExhaustionCycle = 1;
  state.routing.tierExhaustion = { role: "worker", candidates: [] };
  // C hops to A because generation 1 ignores the cycle-0 invocations.
  const hop = planRoute(contract, node, state, "worker", ROUTE_ERROR, "c", FAILOVER);
  assert.equal(hop.blocked, null);
  assert.equal(hop.nextRuntime, "a");
  state.invocations.push(attempted("a", 1));
  // A blocks on an unrelated reason: the evidence is cleared, the counter is not.
  const { routing } = buildRouting(state, {
    role: "worker",
    error: { code: "context_missing", message: "missing context" },
    current: "a",
    plan: { ...hop, blocked: null, tierExhaustion: null },
    schedule: FAILOVER,
    status: "failed",
    now: NOW,
  });
  state.routing = routing;
  assert.equal(state.routing.tierExhaustion, undefined, "the unrelated transition removed the evidence");
  assert.equal(state.routing.tierExhaustionCycle, 1, "the generation counter never falls back to its implicit 0");
  // A exhausts again for the tier reason. With the counter still 1, only the
  // cycle-1 invocation (A) is excluded, so the route reaches B. Had cleanup
  // removed the counter too, the cycle-0 invocations would re-block here.
  const again = planRoute(contract, node, state, "worker", ROUTE_ERROR, "a", FAILOVER);
  assert.equal(again.blocked, null, "a stale cycle-0 exclusion set must not re-block this generation");
  assert.equal(again.nextRuntime, "b");
  assert.deepEqual(
    again.tierExhaustion,
    { role: "worker", candidates: [{ runtimeId: "a", exhaustedUntil: null }] },
    "the absent evidence is rebuilt by the same upsert rule, never tombstoned",
  );
});

test("a declared fallback that has no runtime default still records tier evidence only on the composed path", async () => {
  // A runtime with an explicit fallback is not tier-routed: the declared edge
  // is provider_failover, and no tier-exhaustion evidence is created for it.
  const directory = mkdtempSync(join(tmpdir(), "runner-tier-declared-"));
  const path = writeContract(directory, fixture({
    id: "tier-declared-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: { worker: "primary", judge: "primary" },
    runtimes: {
      primary: { harness: "codex", model: "primary", vendor: "vendor-primary", executable: fakeCodex(directory, "quota-429"), fallback: "backup" },
      backup: { harness: "codex", model: "backup", vendor: "vendor-backup", executable: fakeCodex(directory, "pass") },
    },
    nodes: [{ id: "build", type: "backend", runtime: "primary", taskPacket: packet(), gate: false }],
  }));
  const result = await runContract(path);
  const state = nodeState(result);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.routing?.tierExhaustion, undefined, "a declared fallback is not a tier exhaustion");
});

// Phase 1b: hold before the earliest recorded reset, then retry the right
// phase and target, advancing the generation once at the single dispatch point.

test("done-when 1: worker-tier exhaustion past its earliest reset retries as retry", () => {
  const contract = { nodes: [{ id: "build" }] };
  const past = new Date(Date.now() - 60_000).toISOString();
  const state = tierBlockedState("worker", [
    { runtimeId: "a", exhaustedUntil: past },
    { runtimeId: "b", exhaustedUntil: new Date(Date.now() - 30_000).toISOString() },
    { runtimeId: "c", exhaustedUntil: past },
  ]);
  const plan = planResumeRetry(contract, new Map([["build", state]]), {});
  assert.equal(plan.actions.get("build"), "retry");
  assert.equal(plan.attention.length, 0);
});

test("done-when 2: worker-tier exhaustion before its earliest reset holds in attention", () => {
  const contract = { nodes: [{ id: "build" }] };
  const earliest = Date.now() + 300_000;
  const state = tierBlockedState("worker", [
    { runtimeId: "a", exhaustedUntil: new Date(earliest + 60_000).toISOString() },
    { runtimeId: "b", exhaustedUntil: new Date(earliest).toISOString() },
  ]);
  const plan = planResumeRetry(contract, new Map([["build", state]]), {});
  assert.equal(plan.actions.get("build"), "hold");
  assert.equal(plan.attention.length, 1);
  assert.equal(plan.attention[0].id, "build");
  assert.ok(plan.attention[0].reason.includes(new Date(earliest).toISOString()), plan.attention[0].reason);
});

test("done-when 3 (classification): judge-tier exhaustion past its reset selects rejudge", () => {
  const contract = { nodes: [{ id: "build" }] };
  const result = { status: "done", summary: "accepted worker turn", verification: [], artifacts: [], missingContext: [] };
  const state = tierBlockedState("judge", [{ runtimeId: "b", exhaustedUntil: new Date(Date.now() - 60_000).toISOString() }], { result });
  const plan = planResumeRetry(contract, new Map([["build", state]]), {});
  assert.equal(plan.actions.get("build"), "rejudge");
});

test("done-when 3: resume rejudges a judge-tier exhaustion and keeps the accepted worker result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-tier-rejudge-resume-"));
  const path = writeContract(directory, fixture({
    id: "tier-rejudge-resume-run",
    pollIntervalMs: 10,
    nodes: [{
      id: "build",
      type: "backend",
      taskPacket: packet(),
      definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
      gate: { review: "advisory", failOn: ["critical"] },
    }],
  }));
  const finished = await withFakeCodex(directory, "pass", () => runContract(path));
  const accepted = nodeState(finished);
  assert.equal(accepted.status, "done", accepted.error?.message);
  const workerResult = accepted.result;
  const workerTurns = (accepted.invocations ?? []).filter((invocation) => invocation.phase === "worker").length;

  // Rewind the finished node to the shape a judge-tier exhaustion leaves: the
  // accepted worker result is on disk, the judge exhausted its tier, and the
  // recorded reset is already past.
  const nodePath = join(finished.runDir, "nodes", "build.json");
  const state = JSON.parse(readFileSync(nodePath, "utf8"));
  state.status = "blocked";
  state.phase = "judge";
  state.error = { code: "runtime_tier_exhausted", message: "no available runtime remains in tier 1 for judge" };
  // The finished run removed its worktree; an accepted attempt needs one back
  // for the rejudge to run against.
  state.worktree = ensureAttemptWorktree(finished.runDir, state);
  state.routing = {
    ...state.routing,
    tierExhaustionCycle: 0,
    tierExhaustion: { role: "judge", candidates: [{ runtimeId: "sol", exhaustedUntil: new Date(Date.now() - 60_000).toISOString() }] },
  };
  writeFileSync(nodePath, JSON.stringify(state, null, 2));

  // A worker re-dispatch would fail in this mode; only the rejudge reaches done.
  const resumed = await withFakeCodex(directory, "worker-fail", () => resumeRun(finished.runDir));
  const after = nodeState(resumed);
  assert.equal(after.status, "done", after.error?.message);
  assert.deepEqual(after.result, workerResult, "the accepted worker result survives the rejudge");
  assert.equal(
    (after.invocations ?? []).filter((invocation) => invocation.phase === "worker").length,
    workerTurns,
    "the worker is never re-run",
  );
  assert.equal(after.attempt, accepted.attempt, "a rejudge is adoption, not a new attempt");
  assert.equal(after.routing?.tierExhaustionCycle, 1, "the rejudge dispatch advanced the generation exactly once");
  assert.equal(after.routing?.tierExhaustion, undefined, "the successful judge then cleared the evidence, never the counter");
});

test("done-when 5: a dependency_failed dependant reopens for a rejudged dependency", () => {
  const contract = { nodes: [{ id: "build" }, { id: "second", dependsOn: ["build"] }] };
  const state = tierBlockedState("judge", [{ runtimeId: "b", exhaustedUntil: new Date(Date.now() - 60_000).toISOString() }], {
    result: { status: "done", summary: "work", verification: [], artifacts: [], missingContext: [] },
  });
  const dependent = {
    status: "blocked",
    phase: "complete",
    error: { code: "dependency_failed", message: "build failed" },
    blockedBy: ["build"],
  };
  const plan = planResumeRetry(contract, new Map([["build", state], ["second", dependent]]), {});
  assert.equal(plan.actions.get("build"), "rejudge");
  assert.equal(plan.actions.get("second"), "retry", "a rejudged dependency reopens its dependant exactly as a retry does");
});

test("done-when 6: a generation with no parseable reset instant holds indefinitely", () => {
  const contract = { nodes: [{ id: "build" }] };
  const allNull = tierBlockedState("worker", [
    { runtimeId: "a", exhaustedUntil: null },
    { runtimeId: "b", exhaustedUntil: null },
    { runtimeId: "c", exhaustedUntil: null },
  ]);
  const nullPlan = planResumeRetry(contract, new Map([["build", allNull]]), {});
  assert.equal(nullPlan.actions.get("build"), "hold");
  assert.match(nullPlan.attention[0].reason, /no recorded reset time/u);

  const unparseable = tierBlockedState("worker", [{ runtimeId: "a", exhaustedUntil: "not-an-instant" }]);
  const unparseablePlan = planResumeRetry(contract, new Map([["build", unparseable]]), {});
  assert.equal(unparseablePlan.actions.get("build"), "hold", "an unparseable instant never compares as NaN");
  assert.match(unparseablePlan.attention[0].reason, /no recorded reset time/u);
});

test("done-when 7: --node naming another node holds this exhausted node after its deadline", () => {
  const contract = { nodes: [{ id: "build" }, { id: "other" }] };
  const state = tierBlockedState("worker", [{ runtimeId: "a", exhaustedUntil: new Date(Date.now() - 60_000).toISOString() }]);
  const plan = planResumeRetry(contract, new Map([["build", state]]), { node: "other" });
  assert.equal(plan.actions.get("build"), "hold");
  assert.equal(plan.attention[0].id, "build");
  assert.match(plan.attention[0].reason, /outside the `--node` retry/u);
});

test("done-when 8: the cycle-restart dispatch empties the evidence before the next candidate runs", async () => {
  const logDirectory = mkdtempSync(join(tmpdir(), "runner-tier-restart-log-"));
  const log = join(logDirectory, "evidence.jsonl");
  const directory = mkdtempSync(join(tmpdir(), "runner-tier-restart-"));
  const path = writeContract(directory, fixture({
    id: "tier-restart-run",
    pollIntervalMs: 10,
    timeoutSec: 60,
    runtimeDefaults: {},
    runtimes: {
      a: { harness: "codex", model: "a", vendor: "vendor-a", executable: tierProvider(log, { fail: true }), tier: 1, costRank: 1 },
      b: { harness: "codex", model: "b", vendor: "vendor-b", executable: tierProvider(log, { fail: true }), tier: 1, costRank: 2 },
      c: { harness: "codex", model: "c", vendor: "vendor-c", executable: tierProvider(log, { fail: true }), tier: 1, costRank: 3 },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const first = await runContract(path);
  const blocked = nodeState(first);
  assert.equal(blocked.status, "blocked", blocked.error?.message);
  assert.equal(blocked.error?.code, "runtime_tier_exhausted");
  assert.equal(blocked.routing?.tierExhaustionCycle ?? 0, 0, "the first generation is the implicit zero");

  // The fake provider announces no reset, so give every candidate a recorded
  // instant already past: resume must dispatch rather than hold forever.
  const past = new Date(Date.now() - 60_000).toISOString();
  const nodePath = join(first.runDir, "nodes", "build.json");
  const persisted = JSON.parse(readFileSync(nodePath, "utf8"));
  for (const candidate of persisted.routing.tierExhaustion.candidates) candidate.exhaustedUntil = past;
  writeFileSync(nodePath, JSON.stringify(persisted, null, 2));

  const resumed = await resumeRun(first.runDir);
  const after = nodeState(resumed);
  assert.equal(after.status, "blocked", after.error?.message);
  assert.equal(after.routing?.tierExhaustionCycle, 1, "the dispatch advanced the generation exactly once");
  assert.deepEqual(
    [...new Set((after.routing?.tierExhaustion?.candidates ?? []).map((candidate) => candidate.runtimeId))].sort(),
    ["a", "b", "c"],
    "the new generation re-walked every candidate",
  );

  const firstNew = evidenceLog(log).find((entry) => entry.cycle === 1);
  assert.ok(firstNew, "the restarted generation dispatched a candidate");
  assert.deepEqual(firstNew.candidates, [], "the very first dispatch of the new generation carried no evidence forward");
});

test("done-when 8b: a smaller later generation computes its earliest only from its own candidates", () => {
  const contract = { nodes: [{ id: "build" }] };
  const now = Date.now();
  const obsolete = new Date(now - 86_400_000).toISOString();
  const first = new Date(now + 60_000).toISOString();
  const second = new Date(now + 120_000).toISOString();
  // Generation 1 was larger: three candidates, C's deadline already obsolete.
  const state = tierBlockedState("worker", [
    { runtimeId: "a", exhaustedUntil: first },
    { runtimeId: "b", exhaustedUntil: second },
    { runtimeId: "c", exhaustedUntil: obsolete },
  ], { cycle: 1 });
  // The cycle-restart write replaces the evidence wholesale, so generation 2
  // starts empty; its two upserts cannot resurrect C's obsolete past deadline.
  state.routing.tierExhaustionCycle = 2;
  state.routing.tierExhaustion = { role: "worker", candidates: [] };
  state.routing.tierExhaustion = upsertTierExhaustionCandidate(state.routing.tierExhaustion, "worker", "a", first);
  state.routing.tierExhaustion = upsertTierExhaustionCandidate(state.routing.tierExhaustion, "worker", "b", second);
  const plan = planResumeRetry(contract, new Map([["build", state]]), {});
  assert.deepEqual(
    state.routing.tierExhaustion.candidates.map((/** @type {{runtimeId: string}} */ candidate) => candidate.runtimeId),
    ["a", "b"],
    "generation 2 visited fewer candidates than the generation before it",
  );
  assert.equal(plan.actions.get("build"), "hold", "the obsolete past deadline from the larger generation cannot force a retry");
  assert.ok(plan.attention[0].reason.includes(first), "the earliest is computed from generation 2's own two candidates");
});
