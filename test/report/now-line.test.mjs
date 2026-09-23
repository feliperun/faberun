import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { renderStatus, renderStatusJson } from "../../src/report/render.mjs";
import { verificationProgress } from "../../src/engine/verify.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";
import { runDirectory } from "../../src/run/paths.mjs";

const NOW = "2026-01-01T00:00:00.000Z";

test("verificationProgress carries the 1-based index, total and a joined argv", () => {
  assert.deepEqual(verificationProgress(2, 5, ["npm", "test"]), { index: 2, total: 5, argv: "npm test" });
});

test("verificationProgress bounds a long argv to 120 bytes", () => {
  const argv = ["node", "-e", "x".repeat(400)];
  const progress = verificationProgress(1, 1, argv);
  assert.ok(Buffer.byteLength(progress.argv, "utf8") <= 120);
});

test("verificationProgress treats a missing argv as empty", () => {
  assert.deepEqual(verificationProgress(1, 1, undefined), { index: 1, total: 1, argv: "" });
});

test("a running node's verification progress surfaces on the now line and executionPhase", () => {
  const { runDir } = makeRun({
    status: "running",
    phase: "worker",
    verification: { passed: false, commands: [], completed: false, attempts: [], progress: { index: 2, total: 5, argv: "npm test" } },
  });
  try {
    assert.match(renderStatus(runDir), /now: build running \([^)]*\) · - · - · verification 2\/5 · npm test/u);
    const payload = JSON.parse(renderStatusJson(runDir));
    assert.equal(payload.nodes[0].executionPhase, "verification");
    assert.deepEqual(payload.nodes[0].verificationProgress, { index: 2, total: 5, argv: "npm test" });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a running node with no verification progress keeps its persisted phase and a null verificationProgress", () => {
  const { runDir } = makeRun({ status: "running", phase: "worker" });
  try {
    const text = renderStatus(runDir);
    assert.match(text, /now: build running/u);
    assert.doesNotMatch(text, /verification \d/u);
    const payload = JSON.parse(renderStatusJson(runDir));
    assert.equal(payload.nodes[0].executionPhase, "worker");
    assert.equal(payload.nodes[0].verificationProgress, null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("verification progress clears once the pass completes", () => {
  const { runDir } = makeRun({
    status: "running",
    phase: "worker",
    verification: { passed: true, commands: [], completed: true, attempts: [] },
  });
  try {
    const payload = JSON.parse(renderStatusJson(runDir));
    assert.equal(payload.nodes[0].verificationProgress, null);
    assert.equal(payload.nodes[0].executionPhase, "worker");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a node whose integration candidate is being re-verified names the candidate phase, on both renderings", () => {
  const { runDir } = makeRun({
    status: "running",
    phase: "worker",
    verification: { passed: true, commands: [], completed: true, attempts: [], candidate: true },
  });
  try {
    assert.match(renderStatus(runDir), /now: build running \([^)]*\) · - · - · candidate verification/u);
    const payload = JSON.parse(renderStatusJson(runDir));
    assert.equal(payload.nodes[0].executionPhase, "candidate");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("candidate verification and attempt verification progress do not both surface at once", () => {
  const { runDir } = makeRun({
    status: "running",
    phase: "worker",
    verification: { passed: true, commands: [], completed: true, attempts: [], candidate: false },
  });
  try {
    const payload = JSON.parse(renderStatusJson(runDir));
    assert.equal(payload.nodes[0].executionPhase, "worker");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a node whose gate accepted a fail verdict below its threshold reports the gate outcome as passed, not the verdict, on both renderings", () => {
  const { runDir } = makeRun({
    status: "done",
    phase: "complete",
    gate: { verdict: "fail", maxSeverity: "minor", summary: "advisory finding", findings: [{ severity: "minor", description: "d", evidence: "e" }] },
  });
  try {
    const text = renderStatus(runDir);
    assert.match(text, /passed/u);
    const payload = JSON.parse(renderStatusJson(runDir));
    assert.equal(payload.nodes[0].verdict, "fail", "the raw judge verdict stays available in the payload");
    assert.equal(payload.nodes[0].gateOutcome, "passed");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an exhausted node's gate outcome reads rejected", () => {
  const { runDir } = makeRun({
    status: "exhausted",
    phase: "complete",
    gate: { verdict: "fail", maxSeverity: "critical", summary: "needs work", findings: [{ severity: "critical", description: "d", evidence: "e" }] },
  });
  try {
    const payload = JSON.parse(renderStatusJson(runDir));
    assert.equal(payload.nodes[0].verdict, "fail");
    assert.equal(payload.nodes[0].gateOutcome, "rejected");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a node with no gate yet reports a null gate outcome", () => {
  const { runDir } = makeRun({ status: "running", phase: "worker" });
  try {
    const payload = JSON.parse(renderStatusJson(runDir));
    assert.equal(payload.nodes[0].gateOutcome, null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/**
 * @param {Record<string, unknown>} nodeOverrides
 */
function makeRun(nodeOverrides) {
  const directory = mkdtempSync(join(tmpdir(), "faberun-report-now-line-"));
  const contractPath = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = runDirectory(directory, "report-now-line");
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
  const planNode = /** @type {import("../../src/contract/index.mjs").ValidatedNode} */ (contract.nodes[0]);
  writeFileSync(join(runDir, "nodes", "build.json"), `${JSON.stringify({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: "build",
    type: planNode.type,
    sourceIdentity: planNode.sourceIdentity,
    packetHash: planNode.packetHash,
    status: "running",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: NOW,
    updatedAt: NOW,
    result: null,
    gate: null,
    error: null,
    ...nodeOverrides,
  }, null, 2)}\n`);
  return { runDir };
}
