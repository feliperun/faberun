import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCompletedExecutionNodes } from "../../src/run/usage.mjs";
import { scheduleUnderCapacity } from "../../src/campaign/campaign-brief-graph.mjs";
import { estimateBriefExpense } from "../../src/report/campaign-brief-estimate.mjs";

// R5: the expense range is derived only from this target project's durable
// completed execution nodes, with planning/discovery runs and incomplete nodes
// excluded. These tests exercise the comparable-sample floor, the evidence each
// measure needs, the 90-day window, and the capacity-aware duration schedule.

const CUTOFF = "2026-09-22T00:00:00.000Z";
const IN_WINDOW = "2026-09-01T00:00:00.000Z";
const OUT_OF_WINDOW = "2026-05-01T00:00:00.000Z";

/** @returns {string} */
function makeRunsRoot() {
  return mkdtempSync(join(tmpdir(), "brief-estimate-"));
}

/** @param {string} root @param {string} runId @param {{contract: Record<string, any>, nodes: Record<string, any>[], usage?: Record<string, any>[]}} content @returns {string} */
function writeRun(root, runId, content) {
  const runDir = join(root, runId);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), `${JSON.stringify(content.contract, null, 2)}\n`, "utf8");
  for (const node of content.nodes) {
    writeFileSync(join(runDir, "nodes", `${node.id}.json`), `${JSON.stringify(node, null, 2)}\n`, "utf8");
  }
  if (content.usage && content.usage.length > 0) {
    writeFileSync(join(runDir, "usage.jsonl"), `${content.usage.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  }
  return runDir;
}

/** @param {Record<string, any>[]} nodes @returns {Record<string, any>} */
function executionContract(nodes) {
  return {
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5", maxConcurrent: 1 }, claude: { model: "sonnet" } },
    runtimeDefaults: { worker: "codex", judge: "claude" },
    nodes: nodes.map((node) => ({ taskPacket: { mode: "execution" }, ...node })),
  };
}

/** @typedef {{taskKind?: string, runtimeId?: string, model?: string, role?: string, costUsd?: (index: number) => number, minutes?: (index: number) => number, costProvenance?: string, verificationMs?: number|null, completedAt?: string, status?: string, prefix?: string, judge?: {runtimeId: string, model: string}|null}} SeedOptions */

/**
 * Create one run per index, each with a single completed node and matching
 * invocation records, for the estimate to compare against.
 *
 * @param {string} root
 * @param {number} count
 * @param {SeedOptions} [options]
 * @returns {string[]}
 */
function seedRuns(root, count, options = {}) {
  const taskKind = options.taskKind ?? "implement";
  const runtimeId = options.runtimeId ?? "codex";
  const model = options.model ?? "gpt-5";
  const role = options.role ?? "worker";
  const costUsd = options.costUsd ?? ((index) => index + 1);
  const minutes = options.minutes ?? ((index) => (index + 1) * 10);
  const costProvenance = options.costProvenance ?? "priced";
  const verificationMs = options.verificationMs === undefined ? 60_000 : options.verificationMs;
  const completedAt = options.completedAt ?? IN_WINDOW;
  const status = options.status ?? "done";
  const prefix = options.prefix ?? "run";
  const runIds = [];
  for (let index = 0; index < count; index += 1) {
    const runId = `${prefix}-${index + 1}`;
    runIds.push(runId);
    const totalMs = minutes(index) * 60_000;
    const startedAt = new Date(Date.parse(completedAt) - (totalMs - (verificationMs ?? 0))).toISOString();
    const invocations = [{ role, runtimeId, model, costUsd: costUsd(index), costProvenance, startedAt, closedAt: completedAt }];
    if (options.judge) {
      invocations.push({
        role: "judge",
        runtimeId: options.judge.runtimeId,
        model: options.judge.model,
        costUsd: 0.25,
        costProvenance: "priced",
        startedAt,
        closedAt: completedAt,
      });
    }
    writeRun(root, runId, {
      contract: executionContract([{ id: "work", type: taskKind, runtime: runtimeId, dependsOn: [] }]),
      nodes: [{
        id: "work",
        type: taskKind,
        status,
        startedAt,
        updatedAt: completedAt,
        runtime: { id: runtimeId, model },
        invocations,
        verification: verificationMs === null ? {} : { passed: true, attempts: [{ startedAt, completedAt, result: { durationMs: verificationMs } }] },
      }],
    });
  }
  return runIds;
}

test("collects only durable completed execution nodes in the cutoff window", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const valid = seedRuns(root, 5);

  // A planning/discovery run is excluded even though its node is complete.
  writeRun(root, "plan-1", {
    contract: { maxParallel: 1, runtimes: {}, runtimeDefaults: {}, nodes: [{ id: "draft", type: "draft", taskPacket: { mode: "discovery" } }] },
    nodes: [{ id: "draft", type: "draft", status: "done", startedAt: IN_WINDOW, updatedAt: IN_WINDOW, verification: { attempts: [] } }],
  });
  // A run whose node never completed is excluded.
  writeRun(root, "run-incomplete", {
    contract: executionContract([{ id: "work", type: "implement", runtime: "codex", dependsOn: [] }]),
    nodes: [{ id: "work", type: "implement", status: "running", startedAt: IN_WINDOW, updatedAt: IN_WINDOW, verification: { attempts: [] } }],
  });
  // A completed node older than the 90-day window is excluded.
  seedRuns(root, 1, { completedAt: OUT_OF_WINDOW, prefix: "run-old" });

  const pool = collectCompletedExecutionNodes({ runsRoot: root, cutoff: CUTOFF });
  assert.equal(pool.readable, true);
  assert.equal(pool.nodes.length, 5);
  assert.deepEqual([...pool.sourceRuns].sort(), [...valid].sort());
  assert.ok(!pool.sourceRuns.includes("plan-1"));
  assert.ok(!pool.sourceRuns.includes("run-incomplete"));
  assert.ok(!pool.sourceRuns.includes("run-old-1"));
});

test("reads priced cost from usage.jsonl and falls back to persisted invocations", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Snapshot says provider-only, ledger says priced: the ledger is the source.
  writeRun(root, "run-ledger", {
    contract: executionContract([{ id: "work", type: "implement", runtime: "codex", dependsOn: [] }]),
    nodes: [{
      id: "work", type: "implement", status: "done", startedAt: IN_WINDOW, updatedAt: IN_WINDOW,
      runtime: { id: "codex", model: "gpt-5" },
      invocations: [{ role: "worker", runtimeId: "codex", model: "gpt-5", costUsd: 1, costProvenance: "provider", startedAt: IN_WINDOW, closedAt: IN_WINDOW }],
      verification: { attempts: [{ startedAt: IN_WINDOW, completedAt: IN_WINDOW, result: { durationMs: 1000 } }] },
    }],
    usage: [{ invocationId: "i1", nodeId: "work", role: "worker", runtimeId: "codex", model: "gpt-5", costUsd: 2, costProvenance: "priced" }],
  });
  // No ledger: the persisted invocation is the only recorded source.
  writeRun(root, "run-snapshot", {
    contract: executionContract([{ id: "work", type: "implement", runtime: "codex", dependsOn: [] }]),
    nodes: [{
      id: "work", type: "implement", status: "done", startedAt: IN_WINDOW, updatedAt: IN_WINDOW,
      runtime: { id: "codex", model: "gpt-5" },
      invocations: [{ role: "worker", runtimeId: "codex", model: "gpt-5", costUsd: 3, costProvenance: "priced", startedAt: IN_WINDOW, closedAt: IN_WINDOW }],
      verification: { attempts: [{ startedAt: IN_WINDOW, completedAt: IN_WINDOW, result: { durationMs: 1000 } }] },
    }],
  });
  const pool = collectCompletedExecutionNodes({ runsRoot: root, cutoff: CUTOFF });
  const ledgerNode = pool.nodes.find((node) => node.runId === "run-ledger");
  const snapshotNode = pool.nodes.find((node) => node.runId === "run-snapshot");
  assert.equal(ledgerNode?.worker.costUsd, 2);
  assert.equal(snapshotNode?.worker.costUsd, 3);
});

test("returns cost and duration ranges and a capacity-aware concurrency", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runIds = seedRuns(root, 5, { costUsd: (index) => index + 1, minutes: (index) => (index + 1) * 10 });
  const contract = {
    maxParallel: 2,
    runtimes: { codex: { model: "gpt-5", maxConcurrent: 2 } },
    runtimeDefaults: { worker: "codex" },
    nodes: [
      { id: "n1", type: "implement", runtime: "codex", dependsOn: [] },
      { id: "n2", type: "implement", runtime: "codex", dependsOn: ["n1"] },
      { id: "n3", type: "implement", runtime: "codex", dependsOn: [] },
    ],
  };
  const estimate = estimateBriefExpense({ contract, cutoff: CUTOFF, runsRoot: root });

  assert.equal(estimate.cost.status, "range");
  assert.equal(estimate.cost.min, 3); // three nodes at the $1 low
  assert.equal(estimate.cost.max, 15); // three nodes at the $5 high
  assert.equal(estimate.cost.samples, 5);
  assert.equal(estimate.cost.provenance, "priced usage.jsonl invocations");
  assert.deepEqual(estimate.cost.sourceRuns, [...runIds].sort());

  assert.equal(estimate.duration.status, "range");
  assert.equal(estimate.duration.min, 20); // n1 and n3 at 10, then n2 at 10
  assert.equal(estimate.duration.max, 100); // n1 and n3 at 50, then n2 at 50
  assert.equal(estimate.duration.provenance, "recorded actual node and verification elapsed times");

  assert.equal(estimate.nodeCount, 3);
  assert.equal(estimate.workerCount, 3);
  assert.equal(estimate.effectiveConcurrency, 2);
  assert.deepEqual(estimate.runtimes, ["codex"]);
  assert.deepEqual(estimate.models, ["gpt-5"]);
  assert.equal(estimate.sampleCutoff, CUTOFF);
  assert.ok(estimate.method.some((line) => line.includes("maxParallel")));
  assert.ok(estimate.assumptions.some((line) => line.includes("advisory")));
});

test("a judged node needs five comparable completed nodes for both roles", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRuns(root, 5, { costUsd: (index) => index + 1, minutes: (index) => (index + 1) * 10, judge: { runtimeId: "claude", model: "sonnet" } });
  const contract = {
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5" }, claude: { model: "sonnet" } },
    runtimeDefaults: { worker: "codex", judge: "claude" },
    nodes: [{ id: "n1", type: "implement", runtime: "codex", dependsOn: [], gate: { enabled: true, review: "blocking", runtime: "claude" } }],
  };
  const estimate = estimateBriefExpense({ contract, cutoff: CUTOFF, runsRoot: root });
  assert.equal(estimate.cost.status, "range");
  assert.equal(estimate.cost.min, 1.25); // $1 worker + $0.25 judge
  assert.equal(estimate.cost.max, 5.25);
  assert.equal(estimate.cost.samples, 5);
  assert.equal(estimate.duration.status, "range");
  assert.equal(estimate.duration.min, 10);
  assert.equal(estimate.duration.max, 50);

  // The same contract against worker-only history has no judge evidence.
  const workerOnlyRoot = makeRunsRoot();
  t.after(() => rmSync(workerOnlyRoot, { recursive: true, force: true }));
  seedRuns(workerOnlyRoot, 5);
  const noJudge = estimateBriefExpense({ contract, cutoff: CUTOFF, runsRoot: workerOnlyRoot });
  assert.equal(noJudge.cost.status, "insufficient data");
  assert.match(noJudge.cost.reason ?? "", /judge/u);
});

test("four comparable completed nodes yield insufficient data for both measures", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRuns(root, 4);
  const contract = {
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5" } },
    runtimeDefaults: { worker: "codex" },
    nodes: [{ id: "n1", type: "implement", runtime: "codex", dependsOn: [] }],
  };
  const estimate = estimateBriefExpense({ contract, cutoff: CUTOFF, runsRoot: root });
  assert.equal(estimate.cost.status, "insufficient data");
  assert.equal(estimate.cost.min, null);
  assert.equal(estimate.cost.samples, 4);
  assert.match(estimate.cost.reason ?? "", /fewer than 5/u);
  assert.equal(estimate.duration.status, "insufficient data");
  assert.match(estimate.duration.reason ?? "", /fewer than 5/u);
});

test("the comparability key is the full task kind, runtime, model and role tuple", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRuns(root, 5, { model: "gpt-5", costUsd: (index) => index + 1 });
  seedRuns(root, 2, { model: "gpt-4", costUsd: () => 100, prefix: "run-gpt4" });
  const contract = {
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5" } },
    runtimeDefaults: { worker: "codex" },
    nodes: [{ id: "n1", type: "implement", runtime: "codex", dependsOn: [] }],
  };
  const estimate = estimateBriefExpense({ contract, cutoff: CUTOFF, runsRoot: root });
  assert.equal(estimate.cost.status, "range");
  assert.equal(estimate.cost.max, 5); // the two gpt-4 samples at $100 are not comparable
  assert.equal(estimate.cost.samples, 5);
});

test("unpriced usage leaves cost insufficient while duration stays a range", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRuns(root, 5, { costProvenance: "provider" });
  const contract = {
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5" } },
    runtimeDefaults: { worker: "codex" },
    nodes: [{ id: "n1", type: "implement", runtime: "codex", dependsOn: [] }],
  };
  const estimate = estimateBriefExpense({ contract, cutoff: CUTOFF, runsRoot: root });
  assert.equal(estimate.cost.status, "insufficient data");
  assert.match(estimate.cost.reason ?? "", /priced comparable/u);
  assert.equal(estimate.duration.status, "range");
});

test("a missing verification elapsed record leaves duration insufficient while cost stays a range", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRuns(root, 5, { verificationMs: null });
  const contract = {
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5" } },
    runtimeDefaults: { worker: "codex" },
    nodes: [{ id: "n1", type: "implement", runtime: "codex", dependsOn: [] }],
  };
  const estimate = estimateBriefExpense({ contract, cutoff: CUTOFF, runsRoot: root });
  assert.equal(estimate.duration.status, "insufficient data");
  assert.match(estimate.duration.reason ?? "", /recorded node and verification elapsed/u);
  assert.equal(estimate.cost.status, "range");
});

test("an unreadable pool is insufficient data with the reason", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contract = {
    maxParallel: 1,
    runtimes: { codex: { model: "gpt-5" } },
    runtimeDefaults: { worker: "codex" },
    nodes: [{ id: "n1", type: "implement", runtime: "codex", dependsOn: [] }],
  };
  const estimate = estimateBriefExpense({ contract, cutoff: CUTOFF, runsRoot: join(root, "does-not-exist") });
  assert.equal(estimate.cost.status, "insufficient data");
  assert.match(estimate.cost.reason ?? "", /unreadable/u);
  assert.equal(estimate.duration.status, "insufficient data");
  const pool = collectCompletedExecutionNodes({ runsRoot: join(root, "does-not-exist"), cutoff: CUTOFF });
  assert.equal(pool.readable, false);
  assert.match(pool.unreadable[0]?.reason ?? "", /unreadable/u);
});

test("a missing cutoff is insufficient data rather than a range", (t) => {
  const root = makeRunsRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedRuns(root, 5);
  const estimate = estimateBriefExpense({
    contract: { maxParallel: 1, runtimes: { codex: { model: "gpt-5" } }, runtimeDefaults: { worker: "codex" }, nodes: [{ id: "n1", type: "implement", runtime: "codex", dependsOn: [] }] },
    runsRoot: root,
  });
  assert.equal(estimate.cost.status, "insufficient data");
  assert.match(estimate.cost.reason ?? "", /cutoff/u);
});

test("scheduling respects maxParallel and each runtime's maxConcurrent", () => {
  const independent = [
    { id: "a", runtimeId: "codex", dependsOn: [] },
    { id: "b", runtimeId: "codex", dependsOn: [] },
    { id: "c", runtimeId: "codex", dependsOn: [] },
  ];
  assert.equal(scheduleUnderCapacity(independent, () => 1, 3, { codex: 2 }).peakConcurrency, 2);
  assert.equal(scheduleUnderCapacity(independent, () => 1, 1, { codex: 5 }).peakConcurrency, 1);
  assert.equal(scheduleUnderCapacity(independent, () => 1, 3, {}).peakConcurrency, 1);

  const mixedRuntimes = [
    { id: "a", runtimeId: "codex", dependsOn: [] },
    { id: "b", runtimeId: "claude", dependsOn: [] },
  ];
  assert.equal(scheduleUnderCapacity(mixedRuntimes, () => 1, 2, { codex: 1, claude: 1 }).peakConcurrency, 2);

  const chain = [
    { id: "a", runtimeId: "codex", dependsOn: [] },
    { id: "b", runtimeId: "codex", dependsOn: ["a"] },
  ];
  const scheduled = scheduleUnderCapacity(chain, (node) => (node.id === "a" ? 10 : 5), 5, { codex: 5 });
  assert.equal(scheduled.makespanMs, 15);
  assert.equal(scheduled.peakConcurrency, 1);
});
