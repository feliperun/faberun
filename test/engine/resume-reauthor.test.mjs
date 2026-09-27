import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateContract } from "../../src/contract/index.mjs";
import { reauthorApproved, reauthorRiskTier } from "../../src/contract/scope-findings.mjs";
import { reauthorRefusedNode, resumeRun } from "../../src/engine/resume.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";

/**
 * R10's engine half: a refused packet is widened by a bounded discovery pass,
 * the widened packet is validated against the whole contract before it is
 * applied, and only an accepted widening under the approval threshold (or one
 * the operator explicitly approved) re-dispatches the node.
 */

/**
 * A refused node snapshot. `reauthorRefusedNode` reads only the terminal
 * boundary, the missing context the discovery prompt carries, and the node's
 * frozen packet, so the rest of the snapshot is not needed here.
 *
 * @param {string} id
 * @param {string[]} [missingContext]
 * @returns {import("../../src/contract/index.mjs").NodeSnapshot}
 */
function blockedState(id, missingContext = ["src/extra.mjs"]) {
  return /** @type {any} */ ({
    id,
    status: "blocked",
    phase: "complete",
    error: { code: "context_missing", message: missingContext.join("; ") },
    result: { status: "blocked_context", summary: "missing context", verification: [], artifacts: [], missingContext },
  });
}

/**
 * @param {{id?: string, nodes?: Record<string, unknown>[], files?: Record<string, string>}} [options]
 * @returns {{directory: string, contractPath: string, contract: import("../../src/contract/index.mjs").ValidatedContract, runDir: string}}
 */
function scaffold(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "reauthor-"));
  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  writeContract(directory, fixture({
    id: options.id ?? "reauthor-run",
    ...(options.nodes ? { nodes: options.nodes } : {}),
  }));
  const contractPath = join(directory, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  return { directory, contractPath, contract, runDir: join(directory, "reauthor-record") };
}

test("a refused packet is widened, validated, and recorded", async () => {
  const { contractPath, contract, runDir } = scaffold({ files: { "src/extra.mjs": "export const extra = 1;\n" } });
  const node = contract.nodes[0];
  const outcome = await reauthorRefusedNode({
    contract,
    contractPath,
    runDir,
    node,
    state: blockedState(node.id),
    discover: async () => ({ readFiles: ["src/extra.mjs"], writeFiles: ["src/extra.mjs"] }),
  });

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.roundsUsed, 1);
  assert.ok(outcome.contract, "the accepted candidate is re-validated");
  assert.deepEqual(outcome.contract.nodes[0].taskPacket.readFiles, ["contract.json", "src/extra.mjs"]);
  assert.deepEqual(outcome.contract.nodes[0].taskPacket.writeFiles, ["README.md", "src/extra.mjs"]);

  const record = JSON.parse(readFileSync(join(runDir, "reauthor.jsonl"), "utf8").trim());
  assert.equal(record.outcome, "applied");
  assert.equal(record.node, "build");
  assert.deepEqual(record.reauthorProposal.addedReadFiles, ["src/extra.mjs"]);
  assert.deepEqual(record.reauthorProposal.addedWriteFiles, ["src/extra.mjs"]);
  assert.equal(record.reauthorRounds.budget, 1);
  assert.equal(record.reauthorRounds.used, 1);
  assert.equal(record.reauthorRounds.exhausted, false);
});

test("the discovery rounds budget is hard and an unclosing widening is never applied", async () => {
  const { contractPath, contract, runDir } = scaffold({ files: { "src/extra.mjs": "export const extra = 1;\n" } });
  const node = contract.nodes[0];
  let discoverCalls = 0;
  const outcome = await reauthorRefusedNode({
    contract,
    contractPath,
    runDir,
    node,
    state: blockedState(node.id),
    rounds: 3,
    discover: async () => {
      discoverCalls += 1;
      return { readFiles: [`missing-${discoverCalls}.mjs`] };
    },
  });

  assert.equal(discoverCalls, 3, "the budget is exactly three discovery calls");
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.contract, null);
  assert.equal(outcome.raw, null);
  assert.equal(outcome.roundsUsed, 3);

  const record = JSON.parse(readFileSync(join(runDir, "reauthor.jsonl"), "utf8").trim());
  assert.equal(record.outcome, "rounds_exhausted");
  assert.equal(record.reauthorRounds.budget, 3);
  assert.equal(record.reauthorRounds.used, 3);
  assert.equal(record.reauthorRounds.exhausted, true);
  assert.equal(record.reauthorRounds.history.length, 3);
  assert.ok(record.reauthorProposal.findings.length > 0, "the last refusal is the proposal's finding");
});

test("a widening that takes over another node's write is refused, never applied", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reauthor-conflict-"));
  mkdirSync(join(directory, "src"), { recursive: true });
  mkdirSync(join(directory, "test"), { recursive: true });
  writeFileSync(join(directory, "src", "b.mjs"), "export const b = 1;\n");
  writeFileSync(join(directory, "test", "a.test.mjs"), "export const t = 1;\n");
  writeContract(directory, fixture({
    id: "reauthor-conflict-run",
    nodes: [
      { id: "a", type: "backend", taskPacket: packet({ readFiles: ["test/a.test.mjs"], writeFiles: ["test/a.test.mjs"] }), gate: false },
      { id: "b", type: "backend", taskPacket: packet({ readFiles: ["src/b.mjs"], writeFiles: ["src/b.mjs"] }), gate: false },
    ],
  }));
  const contractPath = join(directory, "contract.json");
  const contract = validateContract(JSON.parse(readFileSync(contractPath, "utf8")), contractPath);
  const runDir = join(directory, "reauthor-record");
  const node = contract.nodes.find((candidate) => candidate.id === "b");
  assert.ok(node);

  const outcome = await reauthorRefusedNode({
    contract,
    contractPath,
    runDir,
    node,
    state: blockedState("b"),
    discover: async () => ({ writeFiles: ["test/a.test.mjs"] }),
  });

  assert.equal(outcome.accepted, false, "a write node a already owns is not an admissible widening");
  assert.equal(outcome.applied, false);
  const record = JSON.parse(readFileSync(join(runDir, "reauthor.jsonl"), "utf8").trim());
  assert.ok(record.reauthorProposal.findings.some((/** @type {string} */ finding) => /already declared in writeFiles by node a/u.test(finding)));
  assert.equal(record.reauthorRounds.exhausted, true);
});

test("a high-risk node needs an approval the default threshold withholds", () => {
  const low = /** @type {any} */ ({ gate: { enabled: false } });
  const standard = /** @type {any} */ ({ gate: { enabled: true, review: "advisory" } });
  const high = /** @type {any} */ ({ gate: { enabled: true, review: "blocking" } });

  assert.equal(reauthorRiskTier(low), "low");
  assert.equal(reauthorRiskTier(standard), "standard");
  assert.equal(reauthorRiskTier(high), "high");

  assert.equal(reauthorApproved(low), true);
  assert.equal(reauthorApproved(standard), true);
  assert.equal(reauthorApproved(high), false);
  assert.equal(reauthorApproved(high, { approveBelow: "high" }), true);
  assert.equal(reauthorApproved(high, { approve: true }), true);
  assert.equal(reauthorApproved(standard, { approveBelow: "none" }), false);
  assert.throws(() => reauthorApproved(low, { approveBelow: "nope" }), /approveBelow/u);
});

test("a refused packet is widened and the node resumes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reauthor-resume-"));
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src", "extra.mjs"), "export const extra = 1;\n");
  const path = writeContract(directory, fixture({ id: "reauthor-resume-run", pollIntervalMs: 10 }));
  const runDir = await withFakeCodex(directory, "blocked-context", async () => (await runContract(path)).runDir);
  const blocked = JSON.parse(readFileSync(join(runDir, "nodes", "build.json"), "utf8"));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error.code, "context_missing");

  const resumed = await withFakeCodex(directory, "pass", () => resumeRun(runDir, {
    reauthor: {
      node: "build",
      discover: async () => ({ readFiles: ["src/extra.mjs"], writeFiles: ["src/extra.mjs"] }),
    },
  }));

  const state = nodeState(resumed);
  assert.equal(state.status, "done", state.error?.message);
  assert.equal(state.attempt, 2, "the widened node is re-dispatched exactly once");
  const persisted = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
  assert.deepEqual(persisted.nodes[0].taskPacket.writeFiles, ["README.md", "src/extra.mjs"]);
  assert.ok(existsSync(join(runDir, "reauthor.jsonl")), "the widening is recorded on the run");
});
