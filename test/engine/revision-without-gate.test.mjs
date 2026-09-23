import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContract } from "../../src/engine/scheduler.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

/**
 * A verification that fails the first time it runs and passes afterwards:
 * the marker file is the memory between attempts (each attempt runs in its
 * own worktree, so the marker lives outside them).
 *
 * @param {string} marker
 * @returns {string[]}
 */
function failOnceArgv(marker) {
  return [process.execPath, "-e", "const fs = require('node:fs'); if (fs.existsSync(process.argv[1])) process.exit(0); fs.writeFileSync(process.argv[1], ''); process.exit(2);", marker];
}

// Measured 2026-09-20 on the orchestration-arms campaign: with `gate: false`
// a red deterministic verification ended the node with no second attempt,
// because the revision path lived behind `gate.enabled`; one timing test that
// flaked under three concurrent workers cost a node and its dependant. The
// gate governs review; the revision budget is the node's, gate or not.
test("a red verification without a gate gets one fresh attempt, and the node settles done when it passes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-revision-no-gate-"));
  const marker = join(directory, "verification-ran-once");
  const path = writeContract(directory, fixture({
    id: "revision-without-gate-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: failOnceArgv(marker) }] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.ok(existsSync(marker), "the first verification ran and failed");
  assert.equal(state.status, "done");
  assert.equal(state.revisions, 1, "the red verification consumed the one revision");
  assert.equal(state.attempt, 2, "the retry was a fresh attempt");
  assert.equal(state.error, null);
});

test("a verification that stays red without a gate fails after the revision budget, not before it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-revision-no-gate-red-"));
  const path = writeContract(directory, fixture({
    id: "revision-without-gate-red-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(2)"] }] }), gate: false }],
  }));
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed", "no gate means no review to exhaust: the node fails");
  assert.equal(state.error?.code, "verification_failed");
  assert.equal(state.revisions, 1);
  assert.equal(state.attempt, 2, "two attempts ran before the node gave up");
});

test("a disabled gate may declare its revision budget, and zero means the first red verification is final", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-revision-no-gate-zero-"));
  const contract = fixture({
    id: "revision-without-gate-zero-run",
    pollIntervalMs: 10,
    nodes: [{ id: "build", type: "backend", taskPacket: packet({ verification: [{ argv: [process.execPath, "-e", "process.exit(2)"] }] }), gate: { enabled: false, maxRevisions: 0 } }],
  });
  const path = writeContract(directory, contract);
  const validated = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  assert.deepEqual(validated.nodes[0].gate, { enabled: false, maxRevisions: 0 });
  const badShape = JSON.parse(readFileSync(path, "utf8"));
  badShape.nodes[0].gate = { enabled: false, review: "none" };
  assert.throws(() => validateContract(badShape, path), /disabled shape/u);
  const result = await withFakeCodex(directory, "pass", () => runContract(path));
  const state = nodeState(result);
  assert.equal(state.status, "failed");
  assert.equal(state.revisions, 0);
  assert.equal(state.attempt, 1, "no retry was granted");
});
