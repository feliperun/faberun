import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { renderReport, renderReportJson, renderStatus, renderStatusJson } from "../../src/report/render.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

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
    assert.equal(report.roles.worker.costProvenance, "priced");
    assert.equal(report.roles.worker.costUsd, 0.1);
    assert.equal(report.roles.worker.pricedInvocations, 1);
    assert.equal(report.roles.worker.unpricedInvocations, 0);
    assert.equal(report.roles.judge.costProvenance, "priced");
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
    assert.equal(report.roles.worker.costProvenance, "partial", "a mixed role is partial, not priced");
    assert.equal(report.roles.worker.costUsd, null, "a partial role shows no total, not the priced half");
    assert.equal(report.roles.worker.pricedInvocations, 1);
    assert.equal(report.roles.worker.unpricedInvocations, 1);
    const status = JSON.parse(renderStatusJson(runDir));
    assert.equal(status.roles.worker.costProvenance, "partial", "the status payload carries the same provenance as the report");
    assert.equal(status.roles.worker.costUsd, null, "the status payload never fabricates the priced half");
    assert.equal(status.roles.worker.pricedInvocations, 1);
    assert.equal(status.roles.worker.unpricedInvocations, 1);
    const text = renderReport(runDir);
    assert.match(text, /worker unpriced \(/u, "a partial role still shows its tokens, not a dash");
    assert.match(text, /judge \$0\.150000/u);
    assert.doesNotMatch(text, /worker \$0\.000000/u);
    assert.doesNotMatch(text, /worker \$0\.100000/u, "the priced half of a partial role is never shown as the total");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an all-unpriced role renders unpriced with its tokens and the JSON says unpriced", () => {
  const tokens = { inputTokens: 1_900_000, outputTokens: 1_060_000, cacheReadInputTokens: 67_600_000 };
  const { runDir } = makeRun([{
    id: "unpriced",
    invocations: [invocation("unpriced-worker", undefined, "worker", tokens)],
  }]);
  try {
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.roles.worker.costProvenance, "unpriced");
    assert.equal(report.roles.worker.costUsd, null, "an unpriced role never fabricates a total");
    assert.equal(report.roles.worker.inputTokens, 1_900_000);
    assert.equal(report.roles.worker.outputTokens, 1_060_000);
    assert.equal(report.roles.worker.cacheReadInputTokens, 67_600_000);
    assert.equal(report.roles.worker.pricedInvocations, 0);
    assert.equal(report.roles.worker.unpricedInvocations, 1);
    assert.equal(report.roles.judge.costProvenance, "none");
    assert.equal(report.totals.workerCostUsd, null);
    const status = JSON.parse(renderStatusJson(runDir));
    assert.equal(status.roles.worker.costProvenance, "unpriced");
    assert.equal(status.roles.worker.inputTokens, 1_900_000);
    assert.match(renderReport(runDir), /worker unpriced \(in 1\.9M · out 1\.1M · cache 67\.6M\)/u);
    assert.match(renderStatus(runDir), /worker unpriced \(in 1\.9M · out 1\.1M · cache 67\.6M\)/u, "the human status Cost line shows the unpriced role, not a dash");
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
    assert.equal(report.roles.worker.costProvenance, "none");
    assert.equal(report.roles.worker.costUsd, null);
    assert.equal(report.roles.worker.unpricedInvocations, 0);
    assert.match(renderReport(runDir), /worker - · judge -/u);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/**
 * @param {Array<{id: string, costUsd?: number, invocations?: Array<{id: string, costUsd?: number}>}>} nodes
 */
function makeRun(nodes) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-cost-"));
  const contractPath = writeContract(directory, fixture({
    nodes: nodes.map(({ id }) => ({ id, type: "backend", taskPacket: packet(), gate: false })),
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = runDirectory(directory, "report-cost");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), readFileSync(contractPath));
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    pid: process.pid,
    processStartToken: null,
    startedAt: NOW,
    sourceIdentity: { kind: "run" },
  }, null, 2)}\n`);
  for (const node of nodes) {
    const planNode = /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (contract.nodes.find((candidate) => candidate.id === node.id));
    writeFileSync(join(runDir, "nodes", `${node.id}.json`), `${JSON.stringify({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
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

/**
 * @param {string} id
 * @param {number|undefined} costUsd
 * @param {"worker"|"judge"} [role]
 * @param {{inputTokens: number, outputTokens: number, cacheReadInputTokens: number}} [usage]
 */
function invocation(id, costUsd, role = "worker", usage) {
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
    ...(usage ? { usage } : {}),
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
