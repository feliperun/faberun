import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateContract } from "../../src/contract/index.mjs";
import { declaredModelTier } from "../../src/harnesses/catalogue.mjs";
import { SAME_PROVIDER_REVIEW_LABEL } from "../../src/contract/judge-independence.mjs";
import { buildGraph } from "../../src/campaign/campaign-brief-graph.mjs";
import { renderCampaignBriefMarkdown } from "../../src/report/campaign-brief.mjs";
import { renderReport, renderReportJson, renderStatus, renderStatusJson } from "../../src/report/render.mjs";
import { renderMetricsJson, renderMetricsReport } from "../../src/report/metrics-report.mjs";
import { packet, writeFixture } from "./helpers.mjs";
import { doneResult, makeRun } from "../report/run-fixture.mjs";

// R20: an operator with a single provider opts in to same-vendor judge
// review with `judgeIndependence: "same-vendor"`; without it, a gate-enabled
// node whose worker and judge share a vendor stays refused exactly as today.

function sonnetJudgeFixture(overrides = {}) {
  return writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "claude", model: "claude-sonnet-5", executable: "/nonexistent/claude", permissionMode: "bypassPermissions" },
      judge: { harness: "claude", model: "claude-opus-5-5", executable: "/nonexistent/claude" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
    ...overrides,
  });
}

test("same-vendor review is opt-in, needs a judge of equal or higher tier and is marked everywhere", () => {
  // Declared tiers back the whole test: Sonnet works, Opus judges above it.
  assert.equal(declaredModelTier("claude", "claude-sonnet-5"), 2);
  assert.equal(declaredModelTier("claude", "claude-opus-5-5"), 3);

  // Without the opt-in, a same-vendor pair is refused exactly as today.
  const { path: offPath } = sonnetJudgeFixture();
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(offPath, "utf8")), offPath),
    /worker runtime worker and judge runtime judge share vendor anthropic/u,
  );

  // Opted in, with a judge tier at or above the worker's: admitted and marked.
  const { path: onPath } = sonnetJudgeFixture({ judgeIndependence: "same-vendor" });
  const contract = validateContract(JSON.parse(readFileSync(onPath, "utf8")), onPath);
  assert.equal(contract.judgeIndependence, "same-vendor");
  assert.equal(contract.nodes[0].gate.enabled, true);
  assert.equal(contract.nodes[0].sameProviderReview, true, "the node is marked same-provider review");

  // A gated node this mode never touches is not marked.
  const { path: ungatedPath } = writeFixture({
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: false }],
    judgeIndependence: "same-vendor",
  });
  const ungated = validateContract(JSON.parse(readFileSync(ungatedPath, "utf8")), ungatedPath);
  assert.equal(ungated.nodes[0].sameProviderReview, false);

  // Opted in, but the judge's tier is below the worker's: refused, naming both.
  const { path: lowTierPath } = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "claude", model: "claude-opus-5-5", executable: "/nonexistent/claude", permissionMode: "bypassPermissions" },
      judge: { harness: "claude", model: "claude-sonnet-5", executable: "/nonexistent/claude" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
    judgeIndependence: "same-vendor",
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(lowTierPath, "utf8")), lowTierPath),
    /judge tier 2 \(claude-sonnet-5\) is below worker tier 3 \(claude-opus-5-5\)/u,
  );

  // Opted in, but the judge model declares no tier at all: cannot judge in the mode.
  const { path: noTierPath } = writeFixture({
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "claude", model: "claude-sonnet-5", executable: "/nonexistent/claude", permissionMode: "bypassPermissions" },
      judge: { harness: "claude", model: "claude-sonnet-4-6", executable: "/nonexistent/claude" },
    },
    nodes: [{ id: "build", type: "backend", taskPacket: packet(), gate: { failOn: ["critical"] } }],
    judgeIndependence: "same-vendor",
  });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(noTierPath, "utf8")), noTierPath),
    /judge model claude-sonnet-4-6 declares no tier and cannot judge in same-vendor mode/u,
  );

  // Only "same-vendor" is accepted.
  const { path: badValuePath } = sonnetJudgeFixture({ judgeIndependence: "cross-vendor" });
  assert.throws(
    () => validateContract(JSON.parse(readFileSync(badValuePath, "utf8")), badValuePath),
    /contract\.judgeIndependence must be "same-vendor"/u,
  );

  // The mark is not only a contract field: every human-facing surface names it.

  // Campaign Brief work graph (src/campaign/campaign-brief-graph.mjs, rendered
  // by src/report/campaign-brief.mjs).
  const briefContract = {
    judgeIndependence: "same-vendor",
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
      judge: { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
    },
  };
  const graph = buildGraph(briefContract, [{ id: "build", dependsOn: [], gate: { enabled: true }, requirementIds: ["R20"] }]);
  assert.equal(graph.nodes[0].sameProviderReview, true, "the work graph marks the node");
  const briefModel = minimalBriefModel(graph);
  const briefMarkdown = renderCampaignBriefMarkdown(briefModel);
  assert.match(briefMarkdown, /Same-provider review: `build`/u);

  // The run report (markdown and JSON) and the status text and JSON: the
  // node also carries a scope finding, so the mark cannot be dropped for a
  // node with advisory findings.
  const { runDir } = makeRun([{
    id: "build",
    phase: "p",
    status: "done",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    result: doneResult("built"),
    scopeFindings: { unexpectedPaths: ["extra.txt"] },
    sameProviderReview: true,
  }]);

  const reportMarkdown = renderReport(runDir);
  assert.match(reportMarkdown, new RegExp(`scope: 1 unexpected path.*${SAME_PROVIDER_REVIEW_LABEL}`, "u"), "the markdown report keeps the mark beside a scope finding");
  const reportJson = JSON.parse(renderReportJson(runDir));
  assert.equal(reportJson.nodes[0].sameProviderReview, true, "the JSON report marks the node");

  const statusText = renderStatus(runDir);
  assert.match(statusText, new RegExp(SAME_PROVIDER_REVIEW_LABEL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), "the human-readable status text carries the mark");
  const statusJson = JSON.parse(renderStatusJson(runDir));
  assert.equal(statusJson.nodes[0].sameProviderReview, true, "the status JSON marks the node");

  // Campaign metrics: the node is named, not just counted.
  const metricsSources = {
    campaignId: "same-vendor-metrics",
    runIds: ["run-a"],
    events: [],
    usageRecords: [],
    notifications: [],
    nodes: [{ runId: "run-a", id: "build", status: "done", attempt: 1, revisions: 0, review: null, sameProviderReview: true }],
    journal: [],
    campaign: {},
    excludedRunIds: [],
    missingSources: [],
  };
  const emptyMetrics = /** @type {import("../../src/campaign/metrics.mjs").CampaignMetrics} */ ({});
  const metricsText = renderMetricsReport(metricsSources, emptyMetrics);
  assert.match(metricsText, /1 same-provider review nodes \(run-a\/build\)/u);
  const metricsJson = JSON.parse(renderMetricsJson(metricsSources, emptyMetrics));
  assert.equal(metricsJson.sameProviderReviewNodeCount, 1);
  assert.deepEqual(metricsJson.sameProviderReviewNodeIds, ["run-a/build"]);
});

/**
 * The smallest `BriefModel` that renders without a gap: only the work graph
 * varies per test, everything else is the fixed shape `renderCampaignBriefMarkdown`
 * needs to not crash on an absent section.
 *
 * @param {import("../../src/campaign/campaign-brief-graph.mjs").BriefGraph} graph
 * @returns {import("../../src/campaign/campaign-brief.mjs").BriefModel}
 */
function minimalBriefModel(graph) {
  return {
    identity: {
      campaign: "judge-independence",
      specBaseline: null,
      specDigest: "a".repeat(64),
      specPath: "/repo/docs/SPEC.md",
      targetGitHead: null,
      planPath: "/repo/plan.json",
      planDigest: "b".repeat(64),
      contractDigest: "c".repeat(64),
      journalCursor: 0,
      usageSampleCutoff: null,
    },
    opening: { intent: null, expectedOutcome: null, successCriteria: [], humanFacts: [], calculatedFacts: [], gaps: [] },
    coverage: { rows: [], unknownIds: [], unknownDeclared: [], unknownStamped: [], gaps: [], specPath: "/repo/docs/SPEC.md", planPath: "/repo/plan.json", covered: 0, uncovered: 0, outside: 0, traceabilityMissing: 0, total: 0 },
    graph,
    decisions: { human: [], delegated: [], journal: [], risks: [], evals: [], gaps: [] },
    estimate: {
      cost: { status: "insufficient data", min: null, max: null, samples: null, reason: "no recorded runs", sourceRuns: [], method: null, provenance: null },
      duration: { status: "insufficient data", min: null, max: null, samples: null, reason: "no recorded runs", sourceRuns: [], method: null, provenance: null },
      runtimes: [],
      models: [],
      effectiveConcurrency: 1,
      nodeCount: 1,
      workerCount: 1,
      sampleCutoff: null,
      method: [],
      assumptions: [],
      gaps: [],
    },
    decisionState: "gaps to resolve",
  };
}
