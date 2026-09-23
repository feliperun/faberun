import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeCampaign, initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { readCampaign } from "../../src/campaign/record.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { runsRoot } from "../../src/run/paths.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// The last moment an accepted-but-flagged node can still be read. Measured
// 2026-09-21: a node's gate verdict was `fail` with a real finding under the
// threshold, the gate accepted it correctly, and the campaign then closed
// with a retrospective claiming every gate had passed first time.
test("close refuses while an accepted node's judge findings are unanswered, and proceeds once a note names the node", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "requirement-advisory-"));
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "advisory-campaign", goal: "close honestly" });
  registerRun(campaignPath, "run-a");
  writeRun(runsDir, "run-a", [
    {
      id: "synthesis",
      requirementIds: ["req-1"],
      status: "done",
      carried: ["req-1"],
      verification: { passed: true },
      gate: { verdict: "fail", maxSeverity: "minor", summary: "reads well. However, the cost table does not reconcile.", findings: [{ severity: "minor", description: "cost table does not reconcile", evidence: "row 7" }] },
    },
  ]);
  appendJournal(campaignPath, { type: "retrospective", at: new Date().toISOString(), eventId: randomUUID(), sessionId: "session", text: "every gate passed on the first attempt" });

  assert.throws(() => closeCampaign(campaignPath), /judge findings no note has answered: run-a\/synthesis \(1 finding, minor\)/u);

  appendJournal(campaignPath, { type: "outcome", at: new Date().toISOString(), eventId: randomUUID(), sessionId: "session", runId: "run-a", text: "synthesis carried a minor finding about the cost table; accepted, tracked separately" });
  assert.equal(closeCampaign(campaignPath).campaign.status, "closed");
});

test("a rejected node's findings do not block a close: there they are the rejection, not an aside", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "requirement-rejected-"));
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "rejected-campaign", goal: "close honestly" });
  registerRun(campaignPath, "run-a");
  writeRun(runsDir, "run-a", [
    {
      id: "build",
      requirementIds: ["req-1"],
      status: "exhausted",
      gate: { verdict: "fail", maxSeverity: "critical", summary: "rejected", findings: [{ severity: "critical", description: "broken", evidence: "test" }] },
    },
  ]);
  appendJournal(campaignPath, { type: "retrospective", at: new Date().toISOString(), eventId: randomUUID(), sessionId: "session", text: "done" });
  assert.equal(closeCampaign(campaignPath).campaign.status, "closed");
});

test("close says what the closure measured, so an open requirement is not read as an undelivered one", () => {
  // The record was written silently and only ever met by opening JSON, where
  // `open` reads as "not delivered". It means "no node of this campaign
  // proved it", which is a different claim: measured 2026-09-22 on
  // availability-is-verified-not-assumed, R4 read open with an empty nodes
  // array while the work was merged in a6a5d43, because the node carrying it
  // blocked and the operator finished it by hand.
  const directory = mkdtempSync(join(tmpdir(), "requirement-closure-cli-"));
  const runsDir = runsRoot(directory);
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "spoken-closure", goal: "say what was measured" });
  registerRun(campaignPath, "run-a");
  writeRun(runsDir, "run-a", [
    { id: "build", requirementIds: ["req-1"], status: "done", carried: ["req-1"], verification: { passed: true }, gate: { verdict: "pass" } },
    { id: "blocked", requirementIds: ["req-2"], status: "blocked" },
  ]);
  appendJournal(campaignPath, { type: "retrospective", at: new Date().toISOString(), eventId: randomUUID(), sessionId: "session", text: "done" });

  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const closed = spawnSync(process.execPath, [runner, "campaign", "close", "spoken-closure", "--cwd", directory], { encoding: "utf8" });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, /requirements · 1\/2 carried by a node that reached done/u);
  assert.match(closed.stdout, /no done node carried req-2/u);
  assert.match(closed.stdout, /never the branch/u, "the line names what closure cannot see");
});

test("a close with every requirement covered says so and adds no caveat", () => {
  const directory = mkdtempSync(join(tmpdir(), "requirement-closure-cli-clean-"));
  const runsDir = runsRoot(directory);
  const { path: campaignPath } = initializeCampaign(runsDir, { campaignId: "clean-closure", goal: "cover everything" });
  registerRun(campaignPath, "run-a");
  writeRun(runsDir, "run-a", [
    { id: "build", requirementIds: ["req-1"], status: "done", carried: ["req-1"], verification: { passed: true }, gate: { verdict: "pass" } },
  ]);
  appendJournal(campaignPath, { type: "retrospective", at: new Date().toISOString(), eventId: randomUUID(), sessionId: "session", text: "done" });

  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const closed = spawnSync(process.execPath, [runner, "campaign", "close", "clean-closure", "--cwd", directory], { encoding: "utf8" });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, /requirements · 1\/1 carried by a node that reached done/u);
  assert.doesNotMatch(closed.stdout, /never the branch/u, "no caveat when there is nothing it could not see");
});
