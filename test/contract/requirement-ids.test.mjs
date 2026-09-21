import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, PROTOCOL_SCHEMA_VERSION, validateContract } from "../../src/contract/index.mjs";
import { validateEvent, validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { freezePlan, verifyFrozenPlan } from "../../src/plan/freeze.mjs";
import { fixture, packet, writeContract } from "../helpers.mjs";

const provenance = {
  targetGitHead: null,
  planner: { runtimeId: "test", model: "test" },
  reviewer: { runtimeId: "test", model: "test" },
  sizing: {},
  findings: [],
};

test("a frozen plan stamps each node with its phase's requirement ids", () => {
  const outDir = mkdtempSync(join(tmpdir(), "requirement-ids-freeze-"));
  freezePlan(fixture({
    nodes: [
      { id: "build", type: "backend", phase: "alpha", taskPacket: packet(), gate: false },
      { id: "docs", type: "docs", phase: "beta", taskPacket: packet({ mode: "discovery", readFiles: [], writeFiles: [], objective: "Survey the docs" }), gate: false },
    ],
  }), {
    outDir,
    provenance,
    phases: [
      { id: "alpha", requirementIds: ["req-1", "req-2"], deliverable: "the build works" },
      { id: "beta", requirementIds: [], deliverable: "the docs exist" },
    ],
  });
  const contract = JSON.parse(readFileSync(join(outDir, "contract.json"), "utf8"));
  assert.deepEqual(contract.nodes[0].requirementIds, ["req-1", "req-2"], "the node inherits its phase's ids");
  assert.equal(contract.nodes[1].requirementIds, undefined, "a phase declaring no ids leaves its nodes unstamped");
  assert.ok(verifyFrozenPlan(outDir).ok, "the stamped contract still matches the recorded digest");
});

test("freezing without phase declarations leaves the nodes unstamped", () => {
  const outDir = mkdtempSync(join(tmpdir(), "requirement-ids-nophases-"));
  freezePlan(fixture({
    nodes: [{ id: "build", type: "backend", phase: "alpha", taskPacket: packet(), gate: false }],
  }), { outDir, provenance });
  const contract = JSON.parse(readFileSync(join(outDir, "contract.json"), "utf8"));
  assert.equal(contract.nodes[0].requirementIds, undefined);
});

test("requirementIds is additive and optional, and CONTRACT_VERSION stays 0.3.0", () => {
  assert.equal(CONTRACT_VERSION, "0.3.0");
  const directory = mkdtempSync(join(tmpdir(), "requirement-ids-optional-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
  }));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const contract = validateContract(raw, path);
  assert.equal(contract.nodes[0].requirementIds, undefined, "a contract without the field loads unchanged");
});

test("contract validation bounds requirementIds", () => {
  const directory = mkdtempSync(join(tmpdir(), "requirement-ids-invalid-"));
  const path = writeContract(directory, fixture({
    nodes: [{ id: "build", type: "backend", requirementIds: ["req-1"], taskPacket: packet(), gate: false }],
  }));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(validateContract(raw, path).nodes[0].requirementIds, ["req-1"], "a well-formed list validates");
  raw.nodes[0].requirementIds = "req-1";
  assert.throws(() => validateContract(raw, path), /requirementIds must be an array/);
  raw.nodes[0].requirementIds = ["req-1", 7];
  assert.throws(() => validateContract(raw, path), /requirementIds\[1\]/);
});

test("the node snapshot and the transition event carry stamped ids", () => {
  const packetHash = "b".repeat(64);
  const updatedAt = new Date().toISOString();
  const snapshot = /** @type {Record<string, unknown>} */ ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    id: "build",
    type: "backend",
    status: "done",
    phase: "complete",
    attempt: 1,
    revisions: 0,
    packetHash,
    runtime: null,
    sourceIdentity: { kind: "node", contractId: "run", nodeId: "build" },
    blockedBy: [],
    startedAt: null,
    updatedAt,
    result: { status: "done", summary: "s", verification: [], artifacts: [], missingContext: [] },
    gate: null,
    error: null,
    requirementIds: ["req-1"],
  });
  assert.deepEqual(validateNodeSnapshot(snapshot).requirementIds, ["req-1"]);
  snapshot.requirementIds = ["req-1", 7];
  assert.throws(() => validateNodeSnapshot(snapshot), /requirementIds/);
  const event = /** @type {Record<string, unknown>} */ ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    at: updatedAt,
    node: "build",
    from: "running",
    to: "done",
    phase: "complete",
    sourceIdentity: { kind: "node", contractId: "run", nodeId: "build" },
    packetHash,
    requirementIds: ["req-1"],
  });
  assert.deepEqual(validateEvent(event).requirementIds, ["req-1"]);
  event.requirementIds = "req-1";
  assert.throws(() => validateEvent(event), /requirementIds/);
});
