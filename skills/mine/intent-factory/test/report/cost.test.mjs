import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { renderReport, renderReportJson } from "../../src/report/render.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";

const NOW = "2026-01-01T00:00:00.000Z";

test("reports known provider cost at node and aggregate levels", () => {
  const { runDir } = makeRun([{
    id: "known",
    costUsd: 0.3,
    invocations: [invocation("known-1", 0.1), invocation("known-2", 0.2)],
  }]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.nodes[0].costUsd, 0.3);
    assert.equal(report.nodes[0].costStatus, "known");
    assert.deepEqual(report.totals.inputTokens, 10);
    assert.deepEqual(report.totals.outputTokens, 5);
    assert.deepEqual(report.totals.cacheReadInputTokens, 0);
    assert.equal(report.totals.costUsd, 0.3);
    assert.equal(report.totals.costStatus, "known");
    const text = renderReport(runDir);
    assert.match(text, /\$0\.300000 \(known\)/u);
    assert.match(text, /totals .*cost \$0\.300000 \(known\)/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("reports a standalone persisted cost as estimated", () => {
  const { runDir } = makeRun([{ id: "estimated", costUsd: 0.4 }]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.nodes[0].costUsd, 0.4);
    assert.equal(report.nodes[0].costStatus, "estimated");
    assert.equal(report.totals.inputTokens, 10);
    assert.equal(report.totals.outputTokens, 5);
    assert.equal(report.totals.cacheReadInputTokens, 0);
    assert.equal(report.totals.costUsd, 0.4);
    assert.equal(report.totals.costStatus, "estimated");
    assert.match(renderReport(runDir), /\$0\.400000 \(estimated\)/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("keeps conflicting and legacy no-cost entries ambiguous", () => {
  const { runDir } = makeRun([
    { id: "conflicting", costUsd: 0.9, invocations: [invocation("conflicting-1", 0.5)] },
    { id: "legacy" },
  ]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.deepEqual(report.nodes.map((/** @type {{id: string, costUsd: number|null, costStatus: string}} */ { id, costUsd, costStatus }) => ({ id, costUsd, costStatus })), [
      { id: "conflicting", costUsd: null, costStatus: "ambiguous" },
      { id: "legacy", costUsd: null, costStatus: "ambiguous" },
    ]);
    assert.equal(report.totals.costUsd, null);
    assert.equal(report.totals.costStatus, "ambiguous");
    const text = renderReport(runDir);
    assert.match(text, /- \(ambiguous\)/u);
    assert.doesNotMatch(text, /\$0\.000000/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("totals carry worker and judge role costs without double-counting the node total", () => {
  const { runDir } = makeRun([{
    id: "roles",
    costUsd: 0.3,
    invocations: [invocation("roles-worker", 0.1, "worker"), invocation("roles-judge", 0.2, "judge")],
  }]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.totals.workerCostUsd, 0.1, "the worker role is summed from its invocations alone");
    assert.equal(report.totals.judgeCostUsd, 0.2);
    assert.equal(report.totals.costUsd, 0.3, "the aggregate is not the role sum added to the node total");
    const text = renderReport(runDir);
    assert.match(text, /worker \$0\.100000 · judge \$0\.200000 · cost \$0\.300000 \(known\)/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an unavailable or partial role cost is null, never a fabricated $0", () => {
  const { runDir } = makeRun([{
    id: "partial",
    costUsd: 0.25,
    invocations: [invocation("partial-worker-known", 0.1, "worker"), invocation("partial-worker-unknown", undefined, "worker"), invocation("partial-judge", 0.15, "judge")],
  }]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.totals.workerCostUsd, null, "one unpriced worker invocation makes the whole role unavailable");
    assert.equal(report.totals.judgeCostUsd, 0.15, "a fully priced judge role is still reported");
    const text = renderReport(runDir);
    assert.match(text, /worker - · judge \$0\.150000/u);
    assert.doesNotMatch(text, /worker \$0\.000000/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a run with no invocations reports both role costs as unavailable, not $0", () => {
  const { runDir } = makeRun([{ id: "empty" }]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.totals.workerCostUsd, null);
    assert.equal(report.totals.judgeCostUsd, null);
    assert.match(renderReport(runDir), /worker - · judge -/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/**
 * @param {Array<{id: string, costUsd?: number, invocations?: Array<{id: string, costUsd?: number}>}>} nodes
 */
function makeRun(nodes) {
  const directory = mkdtempSync(join(tmpdir(), "intent-factory-report-cost-"));
  const contractPath = writeContract(directory, fixture({
    nodes: nodes.map(({ id }) => ({ id, type: "backend", taskPacket: packet(), gate: false })),
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(directory, ".runs", "report-cost");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), readFileSync(contractPath));
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    pid: process.pid,
    processStartToken: null,
    startedAt: NOW,
    sourceIdentity: { kind: "run" },
  }, null, 2)}\n`);
  for (const node of nodes) {
    const planNode = /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (contract.nodes.find((candidate) => candidate.id === node.id));
    writeFileSync(join(runDir, "nodes", `${node.id}.json`), `${JSON.stringify({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: INTENT_FACTORY_VERSION,
      type: planNode.type,
      sourceIdentity: planNode.sourceIdentity,
      packetHash: planNode.packetHash,
      status: "done",
      phase: "complete",
      attempt: 1,
      revisions: 0,
      runtime: null,
      blockedBy: [],
      startedAt: NOW,
      updatedAt: NOW,
      result: null,
      gate: null,
      error: null,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
      ...node,
    }, null, 2)}\n`);
  }
  return { runDir };
}

/** @param {string} id @param {number|undefined} costUsd @param {"worker"|"judge"} [role] */
function invocation(id, costUsd, role = "worker") {
  return {
    id,
    pid: process.pid,
    processGroupId: null,
    processStartToken: null,
    harness: "codex",
    phase: role,
    promptPath: null,
    stdoutPath: null,
    stderrPath: null,
    executable: "/usr/bin/true",
    startedAt: NOW,
    updatedAt: NOW,
    closedAt: NOW,
    deadlineAt: NOW,
    exitCode: 0,
    signal: null,
    status: "closed",
    costUsd,
    runId: "test-run",
    campaignId: "test-campaign",
    planPhase: "fixture-phase-0",
    role,
    runtimeFingerprint: "fixture",
    model: "gpt-5.6-luna",
    reasoning: null,
    sandbox: null,
    continuationId: null,
    continuationMode: "fresh",
  };
}
