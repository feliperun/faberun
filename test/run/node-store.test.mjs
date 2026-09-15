import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTENT_FACTORY_VERSION, PROTOCOL_SCHEMA_VERSION } from "../../src/harnesses/index.mjs";
import {
  listNodeSnapshots,
  nodeSnapshotPath,
  readNodeSnapshot,
  writeNodeSnapshot,
} from "../../src/run/node-store.mjs";

/** @param {string} id @returns {import("../../src/contract/index.mjs").NodeSnapshot} */
function minimalNodeSnapshot(id) {
  return /** @type {any} */ ({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    contractVersion: INTENT_FACTORY_VERSION,
    id,
    type: "generic",
    sourceIdentity: { kind: "node", contractId: "run-1", nodeId: id },
    packetHash: "a".repeat(64),
    status: "pending",
    phase: "waiting",
    attempt: 0,
    revisions: 0,
    runtime: null,
    blockedBy: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    result: null,
    verification: null,
    gate: null,
    error: null,
    routing: null,
    progress: null,
    invocations: [],
    executionOverrides: [],
    worktree: null,
    integratedHead: null,
  });
}

test("node store owns the snapshot path", () => {
  const runDir = mkdtempSync(join(tmpdir(), "node-store-"));
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  const state = minimalNodeSnapshot("alpha");

  writeNodeSnapshot(runDir, state);

  const path = nodeSnapshotPath(runDir, "alpha");
  assert.equal(path, join(runDir, "nodes", "alpha.json"));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), state);
  assert.deepEqual(readNodeSnapshot(runDir, "alpha"), state);
  assert.deepEqual(listNodeSnapshots(runDir), ["alpha.json"]);
  assert.deepEqual(listNodeSnapshots(join(runDir, "no-such-run")), []);
});
