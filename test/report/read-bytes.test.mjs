import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { renderReportJson, renderStatus, renderStatusJson } from "../../src/report/render.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";

const NOW = "2026-01-01T00:00:00.000Z";

test("status and report JSON carry a node's declared read weight and its run total", () => {
  const { runDir } = makeRun([
    { id: "measured", declaredReadBytes: 4096 },
    { id: "unmeasured" },
  ]);
  try {
    const status = JSON.parse(renderStatusJson(runDir));
    assert.equal(status.nodes[0].declaredReadBytes, 4096);
    assert.equal(status.nodes[1].declaredReadBytes, null, "a node that has not dispatched a worker yet carries no declared weight");
    assert.match(renderStatus(runDir), /read 4k/u, "the Cost line shows the run's declared read weight");

    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.nodes[0].declaredReadBytes, 4096);
    assert.equal(report.nodes[1].declaredReadBytes, null);
    assert.equal(report.totals.declaredReadBytes, 4096, "the run total sums only the nodes that carry a declared weight");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a run with no declared read weight shows a dash, never a fabricated zero", () => {
  const { runDir } = makeRun([{ id: "empty" }]);
  try {
    assert.match(renderStatus(runDir), /read -/u);
    const report = JSON.parse(renderReportJson(runDir));
    assert.equal(report.totals.declaredReadBytes, 0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/**
 * @param {Array<{id: string, declaredReadBytes?: number}>} nodes
 */
function makeRun(nodes) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-read-bytes-"));
  const contractPath = writeContract(directory, fixture({
    nodes: nodes.map(({ id }) => ({ id, type: "backend", taskPacket: packet(), gate: false })),
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(directory, ".runs", "report-read-bytes");
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
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      ...node,
    }, null, 2)}\n`);
  }
  return { runDir };
}
