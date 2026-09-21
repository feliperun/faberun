import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeCampaign, initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";

/**
 * A linked run as a close reads it: a contract whose nodes declare requirement
 * ids, and the node snapshots the attempts left behind. `carried` is what the
 * snapshot itself carries (the engine stamps it on done); a node whose
 * snapshot does not carry an id never covers that id, however its text reads.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @param {{id: string, requirementIds: string[], status?: string, carried?: string[], verification?: unknown, gate?: unknown, result?: unknown}[]} nodes
 */
function writeRun(runsDir, runId, nodes) {
  const runDir = join(runsDir, runId);
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), JSON.stringify({
    id: runId,
    nodes: nodes.map(({ id, requirementIds }) => ({ id, requirementIds })),
  }));
  for (const { id, status, carried, verification, gate, result } of nodes) {
    writeFileSync(join(runDir, "nodes", `${id}.json`), JSON.stringify({
      id,
      status: status ?? "pending",
      requirementIds: carried ?? [],
      verification: verification ?? null,
      gate: gate ?? null,
      result: result ?? null,
    }));
  }
}

test("closure maps requirements to nodes and keeps uncovered requirements open", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "requirement-closure-"));
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "closure-campaign", goal: "cover the requirements" });
  // Registered out of order on purpose: the closure must stay deterministic
  // in run order, node order and requirement order regardless.
  registerRun(campaignPath, "run-b");
  registerRun(campaignPath, "run-a");
  writeRun(runsDir, "run-a", [
    { id: "build", requirementIds: ["req-1"], status: "done", carried: ["req-1"], verification: { passed: true }, gate: { verdict: "pass" } },
    { id: "docs", requirementIds: ["req-2"], status: "done", carried: ["req-2"], verification: { passed: true }, gate: { verdict: "pass" } },
    { id: "spike", requirementIds: ["req-3"], status: "failed", result: { summary: "finished req-3 by hand" } },
  ]);
  writeRun(runsDir, "run-b", [
    { id: "docs-again", requirementIds: ["req-2"], status: "done", carried: ["req-2"], verification: { passed: false }, gate: { verdict: "fail" } },
    { id: "legacy", requirementIds: ["req-1"], status: "done", carried: [] },
  ]);
  appendJournal(campaignPath, { type: "retrospective", at: new Date().toISOString(), eventId: randomUUID(), sessionId: "session", text: "done" });

  const { campaign } = closeCampaign(campaignPath);
  // Correlation is by carried identifier only: spike's result text names
  // req-3, and legacy is a done node, yet neither snapshot carries an id for
  // what it did not earn -- req-3 stays open and req-1 keeps exactly one
  // covering node, with its verification evidence beside it.
  assert.deepEqual(campaign.requirements, [
    { requirementId: "req-1", status: "covered", nodes: [{ runId: "run-a", node: "build", passed: true, verdict: "pass" }] },
    { requirementId: "req-2", status: "covered", nodes: [{ runId: "run-a", node: "docs", passed: true, verdict: "pass" }, { runId: "run-b", node: "docs-again", passed: false, verdict: "fail" }] },
    { requirementId: "req-3", status: "open", nodes: [] },
  ]);
  // The record on disk is the closed one and reads back through the validator.
  const record = readCampaign(campaignPath);
  assert.equal(record.status, "closed");
  assert.deepEqual(record.requirements, campaign.requirements);
});

test("closing a campaign with no linked runs records an empty closure", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "requirement-closure-empty-"));
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "empty-closure", goal: "nothing to cover" });
  appendJournal(campaignPath, { type: "retrospective", at: new Date().toISOString(), eventId: randomUUID(), sessionId: "session", text: "done" });
  const { campaign } = closeCampaign(campaignPath);
  assert.deepEqual(campaign.requirements, []);
  assert.deepEqual(readCampaign(campaignPath).requirements, []);
});
