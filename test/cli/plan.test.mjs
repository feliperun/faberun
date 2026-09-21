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

// runsRoot registers every resolved path under $FABERUN_HOME; these fixtures
// resolve through it without the shared helpers, so the home is always a
// throwaway directory, never the operator's own ~/.faberun.
process.env.FABERUN_HOME = mkdtempSync(join(tmpdir(), "faberun-test-home-"));

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
 * A plan whose write set drags along a file it does not declare: the test
 * named after the entry point runs src/cli.mjs, which imports
 * src/plan/thing.mjs, so scope closure refuses the packet — the exact shape
 * that killed the live pipeline between the routing and freeze stage lines
 * on 2026-09-20. `closed` declares the dragged-along test, the fix a revise
 * round is expected to make once the in-round contract check reports it.
 *
 * @param {{closed?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
function scopeGapPlan({ closed = false } = {}) {
  return {
    nodes: [
      {
        id: "thing",
        objective: "Implement the thing",
        taskKind: "implement",
        riskTier: "standard",
        dependsOn: [],
        readFiles: ["src/cli.mjs"],
        writeFiles: closed ? ["src/plan/thing.mjs", "test/cli/cli.test.mjs"] : ["src/plan/thing.mjs"],
        definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "path", ref: "src/plan/thing.mjs" } }],
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

/** @param {string} plansDir @returns {Array<Record<string, unknown>>} the pipeline.jsonl stage lines */
function readPipelineStages(plansDir) {
  return readFileSync(join(plansDir, "pipeline.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
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
 * critical, "critical" always does. `plans` lists the plan each worker
 * invocation emits, in order (the draft, then one revise output per later
 * invocation); the default repeats the same valid two-node plan.
 *
 * @param {string} campaignId
 * @param {{reviewMode?: "clean"|"critical", highRisk?: boolean, plans?: unknown[]}} [options]
 * @returns {{cwd: string, campaignId: string, runtimes: Record<string, Record<string, unknown>>, runtimeDefaults: {worker: string, judge: string}}}
 */
function setup(campaignId, { reviewMode = "clean", highRisk = false, plans } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-"));
  writeFixtureFile(cwd, TASK_KIND_CATALOGUE_PATH, "export const TASK_KINDS = [];\n");
  writeFixtureFile(cwd, "src/index.mjs", "export default 1;\n");
  writeFixtureFile(cwd, "docs/spec.md", "# Feature 42\n\nA legacy spec with no front matter, accepted outright.\n");
  // The scope-closure pair a planned write set is checked against: the entry
  // point imports the module a scope-gap plan writes, and the test named
  // after the entry runs it — the dragged-along obligation detector 1 names,
  // in the shape that cost the live run on 2026-09-20.
  writeFixtureFile(cwd, "src/cli.mjs", "import { thing } from \"./plan/thing.mjs\";\nexport default thing;\n");
  writeFixtureFile(cwd, "test/cli/cli.test.mjs", "new URL(\"../../src/cli.mjs\", import.meta.url);\n");
  initializeGit(cwd);

  const runsDir = runsRoot(cwd);
  initializeCampaign(runsDir, { campaignId, goal: "Ship feature 42" });

  // Each replay line serves exactly one invocation, consumed strictly in
  // order and persisted in a `.cursor` sidecar next to the recording — so a
  // runtime reused across draft and revise, or across two pipeline calls in
  // one test, needs one line per invocation it will actually serve.
  const invocationBudget = 10;
  const workerPlans = plans ?? Array(invocationBudget).fill(twoNodePlan({ highRisk }));
  const reviewFindings = reviewMode === "critical"
    ? [{ id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" }]
    : [];
  const reviewLine = { envelope: envelope({ result: JSON.stringify({
    status: "done", summary: "reviewed", verification: [], artifacts: [], missingContext: [],
    output: { findings: reviewFindings },
  }) }) };
  const recordingDir = mkdtempSync(join(tmpdir(), "plan-pipeline-rec-"));
  const draftRecording = writeRecording(recordingDir, workerPlans.map((plan) => ({ envelope: envelope({ result: JSON.stringify({
    status: "done", summary: "drafted", verification: [], artifacts: [], missingContext: [],
    output: { plan },
  }) }) })), "draft.jsonl");
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

test("a plan that cannot freeze is caught while a revise round remains, and the revise closes the scope", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("preflight-demo", {
    plans: [scopeGapPlan(), scopeGapPlan({ closed: true })],
  });
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

  // Round 1 recorded the freeze failure on its review line and spent a revise
  // on it; round 2's plan closed the scope and froze.
  const stages = readPipelineStages(result.plansDir);
  const round1 = stages.find((entry) => entry.stage === "review" && entry.round === 1);
  assert.ok(round1, "round 1 recorded a review stage line");
  assert.match(String(round1.freezeFailed), /task packet scope does not close/);
  assert.match(String(round1.freezeFailed), /test\/cli\/cli\.test\.mjs/);
  // The sentence the validator cannot know rides after its verbatim message:
  // removing the write clears that same text more cheaply than declaring the
  // dragged-along file, which is the move that cost two workers their packets
  // on 2026-09-20.
  assert.match(String(round1.freezeFailed), /never by dropping a write the node needs/);
  assert.ok(stages.some((entry) => entry.stage === "revise"), "the freeze finding drove a revise round");

  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  const thing = contract.nodes.find((/** @type {any} */ node) => node.id === "thing");
  assert.ok(thing.taskPacket.writeFiles.includes("test/cli/cli.test.mjs"), "the revise declared the dragged-along test");
});

test("a revise that clears a finding by shrinking the write set is contested, the drop named", async () => {
  // The cheap move, replayed: the draft writes two files, the revise answers
  // the reviewer's critical finding by declaring one — a smaller write set
  // clears scope closure without judging any importer, but it leaves the node
  // without a file the work needs (measured 2026-09-20: two context_missing
  // refusals from exactly this). The revision is contested, never frozen.
  const draft = /** @type {any} */ (twoNodePlan());
  draft.nodes[0].writeFiles = ["src/index.mjs", "src/other.mjs"];
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("shrink-demo", {
    reviewMode: "critical",
    plans: [draft, twoNodePlan()],
  });
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
  assert.equal(result.status, "contested");
  assert.equal(result.round, 2);
  const dropped = result.findings.find((finding) => finding.id === "dropped-write-build-1");
  assert.ok(dropped, "the dropped write is recorded as a critical finding");
  assert.equal(dropped.severity, "critical");
  assert.equal(dropped.nodeId, "build");
  assert.match(dropped.text, /src\/other\.mjs/);
  assert.match(dropped.text, /never to drop a write the node needs/);

  const reviseLine = readPipelineStages(result.plansDir).find((entry) => entry.stage === "revise" && entry.round === 1);
  assert.equal(reviseLine?.droppedWrites, 1);
  const contestedPlan = JSON.parse(readFileSync(join(result.plansDir, "plan.json"), "utf8"));
  assert.ok(contestedPlan.findings.some((/** @type {any} */ finding) => finding.id === "dropped-write-build-1"), "the contested record carries the drop");
});

test("a deterministic stage that fails after the rounds ends contested with its stage line", async () => {
  const soloPlan = {
    nodes: [{
      id: "solo",
      objective: "Implement the feature alone",
      taskKind: "implement",
      riskTier: "standard",
      dependsOn: [],
      readFiles: ["src/index.mjs"],
      writeFiles: ["src/index.mjs"],
      definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "path", ref: "src/index.mjs" } }],
      verification: [],
    }],
  };
  // With no review round configured there is no in-round pre-flight to catch
  // the single-node plan sizing refuses; the wrap must still record the
  // failure and contest instead of dying between stage lines.
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("tail-wrap-demo", { plans: [soloPlan] });
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewRounds: 0,
    launch,
    wait,
  });
  assert.equal(result.status, "contested");
  assert.equal(result.round, 0);
  const sizing = result.findings.find((finding) => finding.id === "plan-shape-sizing");
  assert.ok(sizing, "the failed stage is recorded as a critical finding");
  assert.match(sizing.text, /sizing_single_node_plan/);

  const stages = readPipelineStages(result.plansDir);
  const sizingLine = stages.find((entry) => entry.stage === "sizing");
  assert.ok(sizingLine, "the failing stage wrote its line");
  assert.match(String(sizingLine.failed), /sizing_single_node_plan/);
  assert.equal(existsSync(join(result.plansDir, "contract.json")), false);
  const journal = readJournal(campaignTree(cwd, campaignId));
  assert.ok(journal.some((entry) => entry.type === "open-question" && entry.questionId === "plan-build-contested"));
});
