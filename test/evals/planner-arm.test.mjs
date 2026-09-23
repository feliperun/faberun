import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareEvalReports } from "../../evals/metrics.mjs";
import { plannerArm, qualifyingSessionCampaigns, sessionArm } from "../../evals/planner/arm.mjs";

/**
 * A minimal `docs/campaigns/<id>` tree under a fresh temp `repoRoot`: a
 * structured `REQUIREMENTS.md` (one requirement whose proof names a file
 * that exists, one whose proof names a file that does not), a ledger with a
 * journal, a costed usage record, and (optionally) a `control/` contract and
 * an `existing.txt` the proven requirement's proof points at.
 *
 * @param {string} repoRoot
 * @param {string} campaignId
 * @param {{withLedger?: boolean, withControl?: boolean}} [options]
 */
function writeFixtureCampaign(repoRoot, campaignId, options = {}) {
  const { withLedger = true, withControl = true } = options;
  const campaignDir = join(repoRoot, "docs", "campaigns", campaignId);
  mkdirSync(join(campaignDir, "spec"), { recursive: true });
  writeFileSync(join(repoRoot, "existing.txt"), "fixture proof target\n");
  writeFileSync(
    join(campaignDir, "spec", "REQUIREMENTS.md"),
    [
      "## Requirements",
      "",
      "### R1. A proven requirement",
      "",
      "- **statement:** the fixture requirement whose proof exists.",
      "- **proof:** `path: existing.txt`",
      "",
      "### R2. An unproven requirement",
      "",
      "- **statement:** the fixture requirement whose proof does not exist.",
      "- **proof:** `path: does-not-exist.txt`",
      "",
    ].join("\n"),
  );
  if (!withLedger) return;
  mkdirSync(join(campaignDir, "ledger"), { recursive: true });
  writeFileSync(
    join(campaignDir, "ledger", "campaign.json"),
    JSON.stringify({
      id: campaignId,
      status: "closed",
      promotions: [
        { runId: `${campaignId}-1`, sha: "a", previousSha: "0" },
        { runId: `${campaignId}-1`, sha: "a", previousSha: "a" },
        { runId: `${campaignId}-2`, sha: "b", previousSha: "a" },
      ],
    }),
  );
  writeFileSync(
    join(campaignDir, "ledger", "journal.jsonl"),
    [
      JSON.stringify({ type: "outcome", text: `Run 1 (${campaignId}): done on the first attempt.` }),
      JSON.stringify({ type: "outcome", text: `Run 2 (${campaignId}): needed attempt 2 to close.` }),
      JSON.stringify({ type: "decision", text: "the packet was blocked on missing scope." }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(campaignDir, "ledger", `${campaignId}-1.usage.jsonl`),
    [
      JSON.stringify({ nodeId: "a", role: "worker", costUsd: 1, costProvenance: "provider" }),
      JSON.stringify({ nodeId: "a", role: "judge", costUsd: 1, costProvenance: "provider" }),
      JSON.stringify({ nodeId: "a", role: "worker", costUsd: 5, costProvenance: "unknown" }),
      "",
    ].join("\n"),
  );
  if (!withControl) return;
  mkdirSync(join(campaignDir, "control"), { recursive: true });
  writeFileSync(join(campaignDir, "control", "1.contract.json"), JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }] }));
  writeFileSync(join(campaignDir, "control", "2.contract.json"), JSON.stringify({ nodes: [{ id: "c" }] }));
}

test("the session arm lists at least the qualifying campaigns from a fixture record tree", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "planner-arm-session-"));
  writeFixtureCampaign(repoRoot, "fixture-complete");
  writeFixtureCampaign(repoRoot, "fixture-no-ledger", { withLedger: false });
  // A campaign with a ledger but no REQUIREMENTS.md never appears in specPaths
  // at all, so it is not part of this fixture's candidate list either.

  const specPaths = [
    "docs/campaigns/fixture-complete/spec/REQUIREMENTS.md",
    "docs/campaigns/fixture-no-ledger/spec/REQUIREMENTS.md",
  ];
  const ids = qualifyingSessionCampaigns({ repoRoot, specPaths });
  assert.deepEqual(ids, ["fixture-complete"], "only the campaign with both a REQUIREMENTS.md and a ledger qualifies");

  const report = sessionArm({ repoRoot, specPaths });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.side, "session");
  assert.deepEqual(report.campaigns.map((entry) => entry.campaignId), ["fixture-complete"]);

  const entry = report.campaigns[0];
  // costPerClosedCheckpoint: 2 USD of provider-provenance cost (the third
  // record's cost is "unknown" provenance and excluded) over 1 proven
  // requirement (R1's proof exists; R2's does not).
  assert.equal(entry.costPerClosedCheckpoint, 2);
  assert.equal(entry.planningCost, null, "the session side never recorded planning cost separately");
  assert.equal(entry.criticalFindingsPerPlan, null, "the session side ran no plan review step");
  // nodesPerClosedCheckpoint: 3 nodes across the two control contracts, over
  // 2 distinct promoted runIds (the second promotion of fixture-complete-1
  // moved nothing and is deduplicated by runId).
  assert.equal(entry.nodesPerClosedCheckpoint, 1.5);
  // firstPassGateRate: 1 of 2 outcome notes mentioning an attempt count says
  // "first attempt".
  assert.equal(entry.firstPassGateRate, 0.5);
  // blockedContextRate: 1 of 3 outcome/decision notes mentions "blocked".
  assert.ok(Math.abs(/** @type {number} */ (entry.blockedContextRate) - 1 / 3) < 1e-9);

  const indicators = report.indicators;
  assert.equal(indicators.costPerClosedCheckpoint.value, 2);
  assert.equal(indicators.costPerClosedCheckpoint.count, 1);
  assert.equal(indicators.planningCost.value, null);
  assert.equal(indicators.planningCost.count, 0);
});

test("the planner arm reads reports and reports none found distinctly from a measured report", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "planner-arm-planner-"));
  const empty = plannerArm({ repoRoot });
  assert.equal(empty.campaigns.length, 0);
  assert.equal(empty.indicators.costPerClosedCheckpoint.value, null);
  assert.equal(empty.indicators.costPerClosedCheckpoint.count, 0);

  mkdirSync(join(repoRoot, "evals", "planner", "reports"), { recursive: true });
  writeFileSync(
    join(repoRoot, "evals", "planner", "reports", "fixture-complete.json"),
    JSON.stringify({
      schemaVersion: 1,
      campaignId: "fixture-complete",
      plan: { nodeCount: 4, roundsUsed: 1, criticalFindings: 0, blockedAttempts: 0 },
      usage: [
        { role: "worker", costUsd: 3, costProvenance: "provider" },
        { role: "judge", costUsd: 1, costProvenance: "provider" },
        { role: "worker", costUsd: 9, costProvenance: "unknown" },
      ],
    }),
  );
  const withReport = plannerArm({ repoRoot });
  assert.equal(withReport.campaigns.length, 1);
  const entry = withReport.campaigns[0];
  assert.equal(entry.campaignId, "fixture-complete");
  assert.equal(entry.planningCost, 4);
  assert.equal(entry.costPerClosedCheckpoint, 1);
  assert.equal(entry.firstPassGateRate, 1);
  assert.equal(entry.blockedContextRate, 0);
  assert.equal(entry.nodesPerClosedCheckpoint, 4);
  assert.equal(entry.criticalFindingsPerPlan, 0);
});

test("null vs zero: an indicator with no supporting record is null and --compare reports no data, never 0", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "planner-arm-compare-"));
  const session = sessionArm({ repoRoot, specPaths: [] });
  const planner = plannerArm({ repoRoot });
  // Neither side has any qualifying record: every indicator is null with a
  // zero count, distinct from a measured zero.
  for (const name of Object.keys(session.indicators)) {
    assert.equal(session.indicators[name].value, null, `${name} on the session side`);
    assert.equal(session.indicators[name].count, 0, `${name} count on the session side`);
    assert.equal(planner.indicators[name].value, null, `${name} on the planner side`);
    assert.equal(planner.indicators[name].count, 0, `${name} count on the planner side`);
  }

  const comparison = compareEvalReports(session.indicators, planner.indicators);
  for (const name of Object.keys(comparison)) {
    assert.equal(comparison[name].comparable, false, `${name} must not be comparable with no supporting record on either side`);
    assert.equal(comparison[name].delta, null, `${name} delta must stay null, never a silent 0`);
  }

  // A measured zero on one side is still distinct from the null case: build
  // a planner report whose plan review found zero critical findings.
  mkdirSync(join(repoRoot, "evals", "planner", "reports"), { recursive: true });
  writeFileSync(
    join(repoRoot, "evals", "planner", "reports", "measured.json"),
    JSON.stringify({ schemaVersion: 1, campaignId: "measured", plan: { nodeCount: 1, criticalFindings: 0 }, usage: [] }),
  );
  const plannerMeasured = plannerArm({ repoRoot });
  assert.equal(plannerMeasured.indicators.criticalFindingsPerPlan.value, 0);
  assert.equal(plannerMeasured.indicators.criticalFindingsPerPlan.count, 1);
  assert.notEqual(plannerMeasured.indicators.criticalFindingsPerPlan.value, planner.indicators.criticalFindingsPerPlan.value);

  const secondComparison = compareEvalReports(session.indicators, plannerMeasured.indicators);
  assert.equal(secondComparison.criticalFindingsPerPlan.comparable, false, "the session side still has no supporting record for this indicator");
  assert.equal(secondComparison.criticalFindingsPerPlan.after.value, 0);
  assert.equal(secondComparison.criticalFindingsPerPlan.after.count, 1);
});
