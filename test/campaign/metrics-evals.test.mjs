import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { closeCampaign, initializeCampaign, registerRun } from "../../src/campaign/index.mjs";
import { appendJournal } from "../../src/campaign/journal.mjs";
import { projectMetrics } from "../../src/campaign/metrics.mjs";
import { readMetricsSources } from "../../src/campaign/metrics-command.mjs";
import { compareEvalReports, mergeEvalRunSources, noiseBandOf, projectEvalIndicators, renderEvalComparisonReport, readEvalRunSources } from "../../evals/metrics.mjs";
import { readEvalLedgerSources } from "../../evals/ledger.mjs";
import { runsRoot } from "../../src/run/paths.mjs";

const RUNNER = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
const EVAL_RUNNER = fileURLToPath(new URL("../../evals/run.mjs", import.meta.url));

/** @param {number} minute @param {number} [second] @returns {string} */
const at = (minute, second = 0) => new Date(Date.parse("2026-09-10T10:00:00.000Z") + (minute * 60 + second) * 1000).toISOString();

test("metrics from a ledger equal metrics from its run directories", () => {
  const repo = mkdtempSync(join(tmpdir(), "metrics-ledger-equivalence-"));
  const runsDir = runsRoot(repo);
  const campaign = initializeCampaign(runsDir, { campaignId: "ledger-equivalence", goal: "Recompute metrics from versioned evidence" });
  const runFixtures = {
    "run-a": {
      events: [
        { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
        { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
      ],
      usage: [{ nodeId: "build", role: "worker", runtimeId: "sonnet", inputTokens: 10, outputTokens: 2, costUsd: 1, costProvenance: "provider" }],
      notify: [{ dedupeKey: "build", attempt: 1, status: "delivered", at: at(1, 1) }],
      nodes: [{ id: "build", status: "done", attempt: 1, revisions: 0, review: null }],
    },
    "run-b": {
      events: [
        { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(2) },
        { node: "ship", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(3) },
      ],
      usage: [{ nodeId: "ship", role: "judge", runtimeId: "sonnet", inputTokens: 4, outputTokens: 1, costUsd: 0, costProvenance: "provider" }],
      notify: null,
      nodes: [{ id: "ship", status: "done", attempt: 1, revisions: 1, review: null }],
    },
  };
  for (const [runId, fixture] of Object.entries(runFixtures)) {
    registerRun(campaign.path, runId);
    const runDir = join(runsDir, runId);
    mkdirSync(join(runDir, "nodes"), { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), fixture.events.map((record) => `${JSON.stringify(record)}\n`).join(""));
    writeFileSync(join(runDir, "usage.jsonl"), fixture.usage.map((record) => `${JSON.stringify(record)}\n`).join(""));
    if (fixture.notify !== null) writeFileSync(join(runDir, "notify.jsonl"), fixture.notify.map((record) => JSON.stringify(record)).join("\n") + "\n");
    for (const node of fixture.nodes) writeFileSync(join(runDir, "nodes", `${node.id}.json`), JSON.stringify(node));
  }

  appendJournal(campaign.path, {
    type: "retrospective",
    eventId: "retro-ledger-equivalence",
    at: at(4),
    sessionId: "test",
    text: "Retrospective: recomputation evidence is complete.",
  });
  closeCampaign(campaign.path);
  const ledgerDir = join(repo, "docs", "campaigns", "ledger-equivalence", "ledger");
  assert.ok(existsSync(join(ledgerDir, "campaign.json")));
  const runSources = readMetricsSources(campaign.path, { runsDir });
  const ledgerSources = readMetricsSources(campaign.path, { ledgerDir });
  assert.deepEqual(projectMetrics(ledgerSources), projectMetrics(runSources));

  const liveEval = projectEvalIndicators(mergeEvalRunSources(runSources.runIds.map((runId) => readEvalRunSources(join(runsDir, runId)))));
  const ledgerEval = projectEvalIndicators(readEvalLedgerSources(ledgerDir));
  assert.deepEqual(ledgerEval, liveEval);

  const campaignJson = spawnSync(process.execPath, [RUNNER, "metrics", campaign.campaign.id, "--cwd", repo, "--ledger", ledgerDir, "--json"], { encoding: "utf8" });
  assert.equal(campaignJson.status, 0, campaignJson.stderr);
  assert.deepEqual(JSON.parse(campaignJson.stdout).indicators, projectMetrics(ledgerSources));
  const evalJson = spawnSync(process.execPath, [EVAL_RUNNER, "--project-ledger", ledgerDir, "--json"], { encoding: "utf8" });
  assert.equal(evalJson.status, 0, evalJson.stderr);
  assert.deepEqual(JSON.parse(evalJson.stdout).indicators, ledgerEval);

  rmSync(join(ledgerDir, "run-a.notify.jsonl"));
  const incomplete = readMetricsSources(campaign.path, { ledgerDir });
  const incompleteMetrics = projectMetrics(incomplete);
  const completeMetrics = projectMetrics(ledgerSources);
  assert.equal(incompleteMetrics.notifyReceiptRate.value, null);
  assert.deepEqual(incompleteMetrics.notifyReceiptRate.missingSources, ["run-a.notify.jsonl"]);
  for (const [name, indicator] of Object.entries(incompleteMetrics)) {
    if (name === "notifyReceiptRate") continue;
    assert.deepEqual(indicator, /** @type {Record<string, unknown>} */ (completeMetrics)[name], `${name} must remain measured when notify evidence is absent`);
  }
  const incompleteJson = spawnSync(process.execPath, [RUNNER, "metrics", campaign.campaign.id, "--cwd", repo, "--ledger", ledgerDir, "--json"], { encoding: "utf8" });
  assert.equal(incompleteJson.status, 0, incompleteJson.stderr);
  assert.deepEqual(JSON.parse(incompleteJson.stdout).indicators.notifyReceiptRate.missingSources, ["run-a.notify.jsonl"]);
  const incompleteText = spawnSync(process.execPath, [RUNNER, "metrics", campaign.campaign.id, "--cwd", repo, "--ledger", ledgerDir], { encoding: "utf8" });
  assert.equal(incompleteText.status, 0, incompleteText.stderr);
  assert.match(incompleteText.stdout, /missing run-a\.notify\.jsonl/u);

  rmSync(join(ledgerDir, "run-a.usage.jsonl"));
  const incompleteEval = projectEvalIndicators(readEvalLedgerSources(ledgerDir));
  assert.equal(incompleteEval.costPerClosedCheckpoint.value, null);
  assert.deepEqual(incompleteEval.costPerClosedCheckpoint.missingSources, ["run-a.usage.jsonl"]);
  const incompleteEvalJson = spawnSync(process.execPath, [EVAL_RUNNER, "--project-ledger", ledgerDir, "--json"], { encoding: "utf8" });
  assert.equal(incompleteEvalJson.status, 0, incompleteEvalJson.stderr);
  assert.deepEqual(JSON.parse(incompleteEvalJson.stdout).indicators.costPerClosedCheckpoint.missingSources, ["run-a.usage.jsonl"]);
  const incompleteEvalText = spawnSync(process.execPath, [EVAL_RUNNER, "--project-ledger", ledgerDir], { encoding: "utf8" });
  assert.equal(incompleteEvalText.status, 0, incompleteEvalText.stderr);
  assert.match(incompleteEvalText.stdout, /missing sources: run-a\.usage\.jsonl/u);
});

test("a closed ledger carries the closed requirements used by the north star", () => {
  const repo = mkdtempSync(join(tmpdir(), "metrics-closed-requirements-"));
  const runsDir = runsRoot(repo);
  const campaign = initializeCampaign(runsDir, { campaignId: "closed-requirements", goal: "Close with recomputable requirements", at: at(0) });
  registerRun(campaign.path, "run-a", at(1));
  const runDir = join(runsDir, "run-a");
  mkdirSync(join(runDir, "nodes"), { recursive: true });
  writeFileSync(join(runDir, "contract.json"), JSON.stringify({ id: "run-a", nodes: [{ id: "build", requirementIds: ["r1"] }] }));
  writeFileSync(join(runDir, "nodes", "build.json"), JSON.stringify({ id: "build", status: "done", requirementIds: ["r1"], verification: { passed: true }, gate: { verdict: "pass" } }));
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({ node: "build", to: "done", at: at(2) }) + "\n");
  appendJournal(campaign.path, { type: "retrospective", eventId: "retro-closed-requirements", at: at(3), sessionId: "test", text: "Retrospective recorded." });
  closeCampaign(campaign.path, { at: at(4) });
  const ledgerDir = join(repo, "docs", "campaigns", "closed-requirements", "ledger");
  const ledgerCampaign = JSON.parse(readFileSync(join(ledgerDir, "campaign.json"), "utf8"));
  assert.equal(ledgerCampaign.status, "closed");
  assert.deepEqual(ledgerCampaign.requirements, [{ requirementId: "r1", status: "covered", nodes: [{ runId: "run-a", node: "build", passed: true, verdict: "pass" }] }]);
  const live = projectMetrics(readMetricsSources(campaign.path, { runsDir }));
  const ledger = projectMetrics(readMetricsSources(campaign.path, { ledgerDir }));
  assert.equal(ledger.intentToVerifiedSeconds.value, live.intentToVerifiedSeconds.value);
});

test("evals null vs zero", () => {
  const empty = projectEvalIndicators({ events: [], usageRecords: [] });
  // Every indicator with nothing recorded to support it is null, never 0,
  // even the rate-shaped indicators whose "0/0" would otherwise read as a
  // real, measured zero.
  assert.equal(empty.costPerClosedCheckpoint.value, null);
  assert.equal(empty.costPerClosedCheckpoint.count, 0);
  assert.equal(empty.firstPassGateRate.value, null);
  assert.equal(empty.judgeInvocationRate.value, null);
  assert.equal(empty.revisionsPerDone.value, null);
  assert.equal(empty.blockedContextRate.value, null);
  assert.equal(empty.wallClockPerClosedCheckpoint.value, null);
  assert.equal(empty.providerFailoverRate.value, null);
  assert.equal(empty.protocolFailureRate.value, null);

  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
  ];
  const usageRecords = [{ nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 0, costProvenance: "provider" }];
  const measured = projectEvalIndicators({ events, usageRecords });
  // With one closed checkpoint and one zero-cost invocation, the ratio is a
  // real measured 0, not a missing measurement: it must stay distinct from
  // the null case above rather than collapsing onto the same value.
  assert.equal(measured.costPerClosedCheckpoint.value, 0);
  assert.equal(measured.costPerClosedCheckpoint.count, 1);
  assert.notEqual(measured.costPerClosedCheckpoint.value, empty.costPerClosedCheckpoint.value);

  const comparison = compareEvalReports(empty, measured);
  // Comparing a null indicator against a measured number never yields a
  // numeric delta.
  assert.equal(comparison.costPerClosedCheckpoint.delta, null);
  assert.equal(comparison.costPerClosedCheckpoint.comparable, false);
  // Two measured zeros compare as a real, zero delta.
  const bothMeasured = compareEvalReports(measured, measured);
  assert.equal(bothMeasured.costPerClosedCheckpoint.delta, 0);
  assert.equal(bothMeasured.costPerClosedCheckpoint.comparable, true);
});

test("evals costPerClosedCheckpoint divides known-provenance cost by closed checkpoints, excluding open nodes", () => {
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(1) },
  ];
  const usageRecords = [
    { nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 4, costProvenance: "provider" },
    { nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 10, costProvenance: "unknown" },
  ];
  const report = projectEvalIndicators({ events, usageRecords });
  assert.deepEqual(report.costPerClosedCheckpoint, { value: 4, direction: "down", count: 1 });
});

test("evals costPerClosedCheckpoint ignores a checkpoint whose provider reported no cost", () => {
  // Two checkpoints close; only one runs on a provider that reports cost.
  // Dividing by both would publish 2 and call the free-looking node a saving,
  // which is how any move toward dsh, zcode, or codex-on-ChatGPT used to make
  // the indicator fall without a dollar changing hands. The measured answer
  // is 4 over the one checkpoint that was measured, and `count` says so.
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "deepseek", at: at(1) },
    { node: "ship", from: "running", to: "done", phase: "complete", runtime: "deepseek", at: at(2) },
  ];
  const usageRecords = [
    { nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 4, costProvenance: "provider" },
    { nodeId: "ship", role: "worker", runtimeId: "deepseek", costUsd: 0, costProvenance: "unknown" },
  ];
  const report = projectEvalIndicators({ events, usageRecords });
  assert.deepEqual(report.costPerClosedCheckpoint, { value: 4, direction: "down", count: 1 });
});

test("evals firstPassGateRate groups by taskKind (the node id) and keys off the first recorded verdict", () => {
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "running", phase: "judge", runtime: "opus", verdict: "fail", at: at(1) },
    { node: "build", from: "running", to: "running", phase: "judge", runtime: "opus", verdict: "pass", at: at(2) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "opus", at: at(3) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "ship", from: "running", to: "running", phase: "judge", runtime: "opus", verdict: "pass", at: at(1) },
    { node: "ship", from: "running", to: "done", phase: "complete", runtime: "opus", at: at(2) },
  ];
  const report = projectEvalIndicators({ events, usageRecords: [] });
  assert.deepEqual(report.firstPassGateRate, { value: { build: 0, ship: 1 }, direction: "up", count: 2, numerator: { build: 0, ship: 1 }, denominator: { build: 1, ship: 1 }, excludedRunIds: [] });
});

test("evals blockedContextRate counts a blocked-context terminal transition among every terminal node, done or not", () => {
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "build", from: "running", to: "blocked", phase: "complete", runtime: "sonnet", at: at(1) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
    { node: "ship", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
  ];
  const report = projectEvalIndicators({ events, usageRecords: [] });
  assert.deepEqual(report.blockedContextRate, { value: 0.5, direction: "down", count: 2, numerator: 1, denominator: 2, excludedRunIds: [] });
});

test("evals providerFailoverRate counts a node whose worker phase ran on more than one runtime", () => {
  const events = [
    { node: "build", from: "pending", to: "running", phase: "worker", runtime: "primary", at: at(0) },
    { node: "build", from: "running", to: "running", phase: "worker", runtime: "backup", at: at(1) },
    { node: "build", from: "running", to: "done", phase: "complete", runtime: "backup", at: at(2) },
    { node: "ship", from: "pending", to: "running", phase: "worker", runtime: "primary", at: at(0) },
    { node: "ship", from: "running", to: "done", phase: "complete", runtime: "primary", at: at(1) },
  ];
  const report = projectEvalIndicators({ events, usageRecords: [] });
  assert.deepEqual(report.providerFailoverRate, { value: 0.5, direction: "down", count: 2, numerator: 1, denominator: 2, excludedRunIds: [] });
});

test("evals compareEvalReports reports a real numeric delta when both sides are measured", () => {
  const before = projectEvalIndicators({
    events: [
      { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
      { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
    ],
    usageRecords: [{ nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 10, costProvenance: "provider" }],
  });
  const after = projectEvalIndicators({
    events: [
      { node: "build", from: "pending", to: "running", phase: "worker", runtime: "sonnet", at: at(0) },
      { node: "build", from: "running", to: "done", phase: "complete", runtime: "sonnet", at: at(1) },
    ],
    usageRecords: [{ nodeId: "build", role: "worker", runtimeId: "sonnet", costUsd: 6, costProvenance: "provider" }],
  });
  const comparison = compareEvalReports(before, after);
  assert.deepEqual(comparison.costPerClosedCheckpoint, {
    before: { value: 10, count: 1 },
    after: { value: 6, count: 1 },
    direction: "down",
    delta: -4,
    comparable: true,
  });
});

test("evals noise band: half the range across repeated reports, null below two readings; a delta inside it is not measured", () => {
  const reports = [
    { indicators: { costPerClosedCheckpoint: { value: 10, direction: "down", count: 1 }, firstPassGateRate: { value: 1, direction: "up", count: 1 } } },
    { indicators: { costPerClosedCheckpoint: { value: 14, direction: "down", count: 1 } } },
    { costPerClosedCheckpoint: { value: 12, direction: "down", count: 1 } },
  ];
  const band = noiseBandOf(reports);
  assert.deepEqual(band.costPerClosedCheckpoint, { band: 2, median: 12, n: 3 }, "half the range, the median, the readings; a bare map counts like a wrapper");
  assert.deepEqual(band.firstPassGateRate, { band: null, median: 1, n: 1 }, "one reading is not a spread");
  const before = { costPerClosedCheckpoint: { value: 12, direction: "down", count: 1 } };
  const inside = compareEvalReports(before, { costPerClosedCheckpoint: { value: 10.5, direction: "down", count: 1 } }, band);
  assert.equal(inside.costPerClosedCheckpoint.delta, -1.5);
  assert.equal(inside.costPerClosedCheckpoint.band, 2);
  assert.equal(inside.costPerClosedCheckpoint.significant, false);
  assert.match(renderEvalComparisonReport(inside), /delta: {2}not measured: \|-1\.5\| is within the noise band ±2/u);
  const outside = compareEvalReports(before, { costPerClosedCheckpoint: { value: 6, direction: "down", count: 1 } }, band);
  assert.equal(outside.costPerClosedCheckpoint.significant, true);
  assert.match(renderEvalComparisonReport(outside), /delta: {2}-6 \(outside the noise band ±2\)/u);
  const unbanded = compareEvalReports(before, { costPerClosedCheckpoint: { value: 6, direction: "down", count: 1 } }, { firstPassGateRate: 0.1 });
  assert.equal(unbanded.costPerClosedCheckpoint.band, null, "an indicator the band report never measured compares without a band");
  assert.equal(unbanded.costPerClosedCheckpoint.significant, null);
  assert.equal("band" in compareEvalReports(before, before).costPerClosedCheckpoint, false, "without a band report the comparison keeps its shape");
});
