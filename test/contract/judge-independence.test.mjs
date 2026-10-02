import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateContract } from "../../src/contract/index.mjs";
import { declaredModelTier } from "../../src/harnesses/model-tiers.mjs";
import { SAME_PROVIDER_REVIEW_LABEL } from "../../src/contract/judge-independence.mjs";
import { buildGraph } from "../../src/campaign/campaign-brief-graph.mjs";
import { renderCampaignBriefMarkdown } from "../../src/report/campaign-brief.mjs";
import { renderReport, renderReportJson, renderStatus, renderStatusJson } from "../../src/report/render.mjs";
import { renderMetricsJson, renderMetricsReport } from "../../src/report/metrics-report.mjs";
import { initializeCampaign } from "../../src/campaign/index.mjs";
import { configureCampaignReserve, readCampaignReserve, reconcileCampaignReservation, reserveCampaignCost, RESERVE_DIR } from "../../src/campaign/reserve.mjs";
import { CAMPAIGN_FILE } from "../../src/campaign/layout.mjs";
import { runsRoot } from "../../src/run/paths.mjs";
import { CONTRACT_VERSION, harnessCapabilities } from "../../src/harnesses/index.mjs";
import { packet, writeFixture } from "./helpers.mjs";
import { doneResult, makeRun } from "../report/run-fixture.mjs";
import { startJudge } from "../../src/engine/dispatch.mjs";

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

// `startJudge` (src/engine/dispatch.mjs) computes the dynamic mark itself,
// separately from the static admission `markSameProviderReviewNodes` stamps
// at contract validation: the dynamic mark has to read the runtime that
// actually ran, fallback included, and a re-ask or a judge-failure retry
// calls `startJudge` again after it has already overwritten `state.runtime`
// with the judge's own runtime -- so this drives `startJudge` directly
// instead of writing `sameProviderReview` into a fixture snapshot by hand.
test("startJudge marks a genuine same-vendor pairing on first dispatch, and never mismarks a cross-vendor one on a judge re-ask or retry", async () => {
  /** @type {any} */
  const sameVendorContract = {
    judgeIndependence: "same-vendor",
    cwd: process.cwd(),
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
      judge: { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
    },
  };
  /** @type {any} */
  const node = { id: "build", gate: { enabled: true, review: "blocking" }, definitionOfDone: [] };
  /** @type {any} */
  const lock = {};

  // First dispatch of the attempt: `state.runtime` still holds the worker
  // that just ran, exactly as `startJudge`'s caller leaves it.
  /** @type {any} */
  const firstDispatchState = {
    attempt: 1,
    invocations: [{ id: "inv-worker", phase: "worker", runtimeId: "worker" }],
    runtime: { id: "worker", harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
  };
  const firstRound = await startJudge(sameVendorContract, node, firstDispatchState, "", new Map(), {}, lock, new Map(), "");
  assert.equal(firstRound.kind, "settle", "no judgment item: the judge is never actually dispatched");
  assert.equal(firstDispatchState.sameProviderReview, true, "worker and judge share a vendor: marked on first dispatch");

  // A judge re-ask (review.mjs) or a judge-failure retry (settle-judge.mjs)
  // calls `startJudge` again with `state.runtime` already overwritten to the
  // judge's own runtime by the first call. A worker/judge pair of different
  // vendors must stay unmarked even then.
  /** @type {any} */
  const crossVendorContract = {
    judgeIndependence: "same-vendor",
    cwd: process.cwd(),
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "codex", model: "gpt-6-codex", vendor: "openai" },
      judge: { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
    },
  };
  /** @type {any} */
  const reaskState = {
    attempt: 1,
    invocations: [
      { id: "inv-worker", phase: "worker", runtimeId: "worker" },
      { id: "inv-judge-1", phase: "judge", runtimeId: "judge" },
    ],
    runtime: { id: "judge", harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
  };
  const reaskRound = await startJudge(crossVendorContract, node, reaskState, "", new Map(), {}, lock, new Map(), "");
  assert.equal(reaskRound.kind, "settle");
  assert.equal(
    reaskState.sameProviderReview,
    false,
    "the worker (openai) and the judge (anthropic) never shared a vendor -- comparing state.runtime to itself on the re-ask would wrongly mark this node",
  );
});

// The dispatch side of the optional campaign reserve (ADR 0011): a new judge
// call is admitted through the campaign's balance before it starts, and its
// cost estimate is the only measured number available -- what the worker's
// call just charged. A balance that cannot hold that estimate refuses only
// this new dispatch, parks the node blocked, and takes no hold of its own.
test("startJudge refuses a judge dispatch the armed reserve cannot cover and parks the node without one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "judge-reserve-refusal-"));
  const { path: campaignPath } = initializeCampaign(runsRoot(directory), { campaignId: "reserve-judge-refusal", goal: "Gate the judge" });
  configureCampaignReserve(campaignPath, 100);
  const hold = reserveCampaignCost(campaignPath, { costUsd: 60 });
  assert.ok(hold.reservation, "the seeded hold was admitted with a reservation");
  reconcileCampaignReservation(campaignPath, hold.reservation.id, 60);

  /** @type {any} */
  const contract = {
    judgeIndependence: "same-vendor",
    cwd: process.cwd(),
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
      judge: { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
    },
  };
  /** @type {any} */
  const node = {
    id: "build",
    gate: { failOn: ["critical"] },
    taskPacket: packet(),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  };
  // The refusal parks the node with a persisted snapshot, so the state it
  // starts from is the full shape the engine writes, not the trimmed shape
  // the settle-path tests above can get away with.
  const state = judgeRefusalState();
  /** @type {any} */
  const lock = { assert() {} };
  const round = await startJudge(contract, node, state, mkdtempSync(join(tmpdir(), "judge-reserve-rundir-")), new Map(), {}, lock, new Map(), campaignPath);

  assert.equal(round.kind, "refused", "40 USD available cannot hold the worker's measured 50 USD again");
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "reserve_insufficient", state.error?.message);
  assert.equal(state.phase, "judge");
  const status = readCampaignReserve(campaignPath);
  assert.equal(status.availableUsd, 40, "the refusal charged nothing and released nothing");
  assert.equal(status.reservations.length, 1, "a refused admission takes no hold of its own");
  assert.equal(status.heldUsd, 0);
});

// The fail-closed half of the same gate: a campaign record that is present
// but cannot be read is the opposite of unconfigured, because it may have
// changed since the launch validated it. The judge dispatch is refused
// before any provider starts, with an error distinct from
// `reserve_insufficient` -- the balance here admits on cost alone, so the
// record is the only thing that can refuse.
test("startJudge fails closed when the campaign record cannot be read, parking the node without a paid call or a hold", async () => {
  const directory = mkdtempSync(join(tmpdir(), "judge-record-corrupt-"));
  const { path: campaignPath } = initializeCampaign(runsRoot(directory), { campaignId: "reserve-judge-corrupt", goal: "Gate the judge" });
  configureCampaignReserve(campaignPath, 100);
  // Valid when the run launched; unparseable by the time the judge dispatch
  // is admitted -- exactly the mid-run change the gate must not wave through.
  writeFileSync(join(campaignPath, CAMPAIGN_FILE), "{not json");

  /** @type {any} */
  const contract = {
    judgeIndependence: "same-vendor",
    cwd: process.cwd(),
    runtimeDefaults: { worker: "worker", judge: "judge" },
    runtimes: {
      worker: { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
      judge: { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
    },
  };
  /** @type {any} */
  const node = {
    id: "build",
    gate: { failOn: ["critical"] },
    taskPacket: packet(),
    definitionOfDone: [{ id: "works", text: "It works", judgment: true }],
  };
  const state = judgeRefusalState();
  /** @type {any} */
  const lock = { assert() {} };
  const round = await startJudge(contract, node, state, mkdtempSync(join(tmpdir(), "judge-record-rundir-")), new Map(), {}, lock, new Map(), campaignPath);

  assert.equal(round.kind, "refused", "a present but unreadable record is not evidence that the reserve is unconfigured");
  assert.equal(state.status, "blocked");
  assert.equal(state.error?.code, "campaign_record_unreadable", state.error?.message);
  assert.equal(state.phase, "judge");
  assert.equal(state.invocations?.length, 1, "the refused judge dispatch never became a provider call");
  assert.equal(existsSync(join(campaignPath, RESERVE_DIR)), false, "the refused admission took no hold and created no reserve state");
});

/**
 * The full node-snapshot shape the engine persists, as the refusal tests'
 * starting point: `startJudge` parks this state with a write, so it has to
 * arrive complete rather than trimmed. `invocations` carries one closed,
 * already-priced worker call, which is also the estimate the next admission
 * would hold against.
 *
 * @returns {any}
 */
function judgeRefusalState() {
  const at = "2026-09-30T00:00:00.000Z";
  return {
    schemaVersion: 3,
    contractVersion: CONTRACT_VERSION,
    id: "build",
    type: "backend",
    sourceIdentity: { kind: "node", contractId: "reserve-judge-refusal-run", nodeId: "build" },
    packetHash: "a".repeat(64),
    status: "pending",
    phase: "worker",
    attempt: 1,
    revisions: 0,
    judgeFailures: 0,
    runtime: { id: "worker", harness: "claude", model: "claude-sonnet-5", vendor: "anthropic", capabilities: harnessCapabilities({ harness: "claude" }) },
    blockedBy: [],
    startedAt: at,
    updatedAt: at,
    result: null,
    gate: null,
    error: null,
    invocations: [{
      id: "inv-worker",
      pid: 4242,
      processGroupId: null,
      processStartToken: null,
      harness: "claude",
      phase: "worker",
      role: "worker",
      runId: "reserve-judge-refusal-run",
      campaignId: "reserve-judge-refusal",
      planPhase: "phase-1",
      runtimeFingerprint: "worker",
      model: "claude-sonnet-5",
      reasoning: null,
      sandbox: null,
      continuationId: null,
      continuationMode: "fresh",
      promptPath: null,
      stdoutPath: null,
      stderrPath: null,
      executable: null,
      startedAt: at,
      updatedAt: at,
      deadlineAt: at,
      closedAt: at,
      exitCode: 0,
      signal: null,
      status: "closed",
      costUsd: 50,
    }],
  };
}

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
