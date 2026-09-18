import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeCampaign } from "../../src/campaign/index.mjs";
import { readJournal } from "../../src/campaign/journal.mjs";
import { loadRuntimesCatalogue } from "../../src/cli/plan.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { runProgress } from "../../src/engine/supervise.mjs";
import { runPlanningPipeline } from "../../src/plan/pipeline.mjs";
import { TASK_KIND_CATALOGUE_PATH } from "../../src/plan/template.mjs";
import { envelope, writeRecording } from "../harnesses/replay-helpers.mjs";
import { campaignTree, runDirectory, runsRoot } from "../../src/run/paths.mjs";

/**
 * Every discovery `done` result — planning or not — is checked by the
 * existing discovery protocol (`parseDiscoveryResult`, `lifecycle.mjs`)
 * against `artifacts[0]`, which must parse as a valid execution task packet
 * regardless of what the planning pipeline itself reads (`output`). This
 * placeholder satisfies that check without the pipeline ever looking at it.
 */
const PLACEHOLDER_EXECUTION_PACKET = JSON.stringify({
  mode: "execution",
  objective: "placeholder, unread by the planning pipeline",
  instructions: ["placeholder, unread by the planning pipeline"],
  readFiles: ["src/index.mjs"],
  writeFiles: ["src/index.mjs"],
  symbols: [],
  decisions: [],
  nonGoals: [],
  verification: [],
});

/** @param {string} cwd @param {string} relative @param {string} content */
function writeFixtureFile(cwd, relative, content) {
  const path = join(cwd, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** @param {string} cwd */
function initializeGit(cwd) {
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "add", ".", ":!.runs"]);
  execFileSync("git", ["-C", cwd, "-c", "user.email=plan-test@example.test", "-c", "user.name=plan-test", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
}

/**
 * A minimal, schema-valid draft/revise plan: two independent nodes, each with
 * its own mechanical Definition of Done proof and disjoint writeFiles, so
 * sizing's merge rules leave both in place (a single-node plan is refused).
 *
 * @param {{highRisk?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
function twoNodePlan({ highRisk = false } = {}) {
  return {
    nodes: [
      {
        id: "build",
        objective: "Implement the feature",
        taskKind: "implement",
        riskTier: highRisk ? "high" : "standard",
        dependsOn: [],
        readFiles: ["src/index.mjs"],
        writeFiles: ["src/index.mjs"],
        definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "path", ref: "src/index.mjs" } }],
        verification: [],
      },
      {
        id: "docs",
        objective: "Document the feature",
        taskKind: "docs",
        riskTier: "low",
        dependsOn: [],
        readFiles: ["docs/spec.md"],
        writeFiles: ["docs/spec.md"],
        definitionOfDone: [{ id: "documented", text: "Documented", proof: { kind: "path", ref: "docs/spec.md" } }],
        verification: [],
      },
    ],
  };
}

/**
 * A temp checkout with everything a planning contract's readFiles may name,
 * two replay runtimes (distinct vendors, one per role) and an active
 * campaign. `reviewMode` picks the review recording: "clean" never finds a
 * critical, "critical" always does.
 *
 * @param {string} campaignId
 * @param {{reviewMode?: "clean"|"critical", highRisk?: boolean}} [options]
 * @returns {{cwd: string, campaignId: string, runtimes: Record<string, Record<string, unknown>>, runtimeDefaults: {worker: string, judge: string}}}
 */
function setup(campaignId, { reviewMode = "clean", highRisk = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-"));
  writeFixtureFile(cwd, TASK_KIND_CATALOGUE_PATH, "export const TASK_KINDS = [];\n");
  writeFixtureFile(cwd, "src/index.mjs", "export default 1;\n");
  writeFixtureFile(cwd, "docs/spec.md", "# Feature 42\n\nA legacy spec with no front matter, accepted outright.\n");
  initializeGit(cwd);

  const runsDir = runsRoot(cwd);
  initializeCampaign(runsDir, { campaignId, goal: "Ship feature 42" });

  // Each replay line serves exactly one invocation, consumed strictly in
  // order and persisted in a `.cursor` sidecar next to the recording — so a
  // runtime reused across draft and revise, or across two pipeline calls in
  // one test, needs one line per invocation it will actually serve.
  const draftLine = { envelope: envelope({ result: JSON.stringify({
    status: "done", summary: "drafted", verification: [], artifacts: [PLACEHOLDER_EXECUTION_PACKET], missingContext: [],
    output: { plan: twoNodePlan({ highRisk }) },
  }) }) };
  const reviewFindings = reviewMode === "critical"
    ? [{ id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" }]
    : [];
  const reviewLine = { envelope: envelope({ result: JSON.stringify({
    status: "done", summary: "reviewed", verification: [], artifacts: [PLACEHOLDER_EXECUTION_PACKET], missingContext: [],
    output: { findings: reviewFindings },
  }) }) };
  const recordingDir = mkdtempSync(join(tmpdir(), "plan-pipeline-rec-"));
  const invocationBudget = 10;
  const draftRecording = writeRecording(recordingDir, Array(invocationBudget).fill(draftLine), "draft.jsonl");
  const reviewRecording = writeRecording(recordingDir, Array(invocationBudget).fill(reviewLine), "review.jsonl");

  const runtimes = {
    "planner-worker": { harness: "replay", model: "replay-worker-model", vendor: "vendor-worker", config: { "replay.recording": draftRecording } },
    "planner-judge": { harness: "replay", model: "replay-judge-model", vendor: "vendor-judge", config: { "replay.recording": reviewRecording } },
  };
  const runtimeDefaults = { worker: "planner-worker", judge: "planner-judge" };
  return { cwd, campaignId, runtimes, runtimeDefaults };
}

/** @param {string} contractPath @returns {Promise<void>} */
async function launch(contractPath) {
  await runContract(contractPath);
}

/** @param {string} runDir */
function wait(runDir) {
  return runProgress(runDir);
}

test("the pipeline runs draft and review from recordings and freezes", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("freeze-demo");
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    launch,
    wait,
  });
  assert.equal(result.status, "frozen");
  assert.ok(existsSync(result.contractPath), "contract.json is written");
  assert.ok(existsSync(result.planPath), "plan.json is written");
  const plan = JSON.parse(readFileSync(result.planPath, "utf8"));
  assert.equal(plan.status, "frozen");
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  assert.equal(contract.nodes.length, 2);

  // "plan never autostarts": freezing writes contract.json and stops; nothing
  // ever creates a run directory for the frozen contract itself.
  assert.equal(existsSync(runDirectory(cwd, contract.id)), false);
});

test("operator override wins: --runtime-defaults appears in the frozen contract's runtimeDefaults over the table", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("override-demo");
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    launch,
    wait,
  });
  assert.equal(result.status, "frozen");
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  assert.deepEqual(contract.runtimeDefaults, runtimeDefaults);
  for (const node of contract.nodes) assert.equal(node.runtime, runtimeDefaults.worker);
});

test("approval policy", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("approval-demo", { highRisk: true });

  const underStandard = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "standard-phase",
    cwd,
    runtimes,
    runtimeDefaults,
    approveBelow: "standard",
    launch,
    wait,
  });
  assert.equal(underStandard.status, "frozen");
  assert.equal(underStandard.approved, false);
  const planUnderStandard = JSON.parse(readFileSync(underStandard.planPath, "utf8"));
  assert.equal(planUnderStandard.approved, false);
  const journalAfterStandard = readJournal(campaignTree(cwd, campaignId));
  assert.ok(journalAfterStandard.some((entry) => entry.type === "open-question" && entry.questionId === "plan-standard-phase-approval"));

  const underHigh = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "high-phase",
    cwd,
    runtimes,
    runtimeDefaults,
    approveBelow: "high",
    launch,
    wait,
  });
  assert.equal(underHigh.status, "frozen");
  assert.equal(underHigh.approved, true);
  const planUnderHigh = JSON.parse(readFileSync(underHigh.planPath, "utf8"));
  assert.equal(planUnderHigh.approved, true);
});

test("--runtimes loads a catalogue file, which drives the pipeline end to end", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("catalogue-demo");
  const runtimesPath = join(cwd, "runtimes.json");
  writeFileSync(runtimesPath, JSON.stringify(runtimes, null, 2));

  const loaded = loadRuntimesCatalogue(runtimesPath);
  assert.deepEqual(Object.keys(loaded).sort(), Object.keys(runtimes).sort());

  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes: loaded,
    runtimeDefaults,
    launch,
    wait,
  });
  assert.equal(result.status, "frozen");
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  assert.deepEqual(Object.keys(contract.runtimes).sort(), Object.keys(runtimes).sort());
  assert.deepEqual(contract.runtimeDefaults, runtimeDefaults);
});

test("--runtimes rejects a catalogue file that is not valid JSON", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-bad-runtimes-"));
  const runtimesPath = join(cwd, "runtimes.json");
  writeFileSync(runtimesPath, "not json");
  assert.throws(() => loadRuntimesCatalogue(runtimesPath), /not valid JSON/);
});

test("--runtimes rejects a catalogue entry that fails runtime validation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-bad-runtime-entry-"));
  const runtimesPath = join(cwd, "runtimes.json");
  writeFileSync(runtimesPath, JSON.stringify({ "planner-worker": { harness: "not-a-real-harness" } }));
  assert.throws(() => loadRuntimesCatalogue(runtimesPath));
});

test("contested plan writes no contract", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("contested-demo", { reviewMode: "critical" });
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewRounds: 2,
    launch,
    wait,
  });
  assert.equal(result.status, "contested");
  assert.equal(result.round, 2);
  assert.ok(result.findings.some((finding) => finding.severity === "critical"));
  assert.equal(existsSync(join(result.plansDir, "contract.json")), false);
  const journal = readJournal(campaignTree(cwd, campaignId));
  assert.ok(journal.some((entry) => entry.type === "open-question" && entry.questionId === "plan-build-contested"));
});
