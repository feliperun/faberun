import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initializeCampaign } from "../../src/campaign/index.mjs";
import { readJournal } from "../../src/campaign/journal.mjs";
import { loadRuntimesCatalogue, loadVerificationSuites } from "../../src/cli/plan.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { runProgress } from "../../src/engine/supervise.mjs";
import { runPlanningPipeline } from "../../src/plan/pipeline.mjs";
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
 * invocation); the default repeats the same valid two-node plan. `reviews`
 * does the same for the reviewer, one findings array per round, for a test
 * about what one round remembers of another.
 *
 * @param {string} campaignId
 * @param {{reviewMode?: "clean"|"critical", highRisk?: boolean, plans?: unknown[], reviews?: unknown[][]}} [options]
 * @returns {{cwd: string, campaignId: string, runtimes: Record<string, Record<string, unknown>>, runtimeDefaults: {worker: string, judge: string}, reviewers: string[]}}
 */
function setup(campaignId, { reviewMode = "clean", highRisk = false, plans, reviews } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-"));
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
  const reviewRounds = reviews ?? Array(invocationBudget).fill(reviewFindings);
  const recordingDir = mkdtempSync(join(tmpdir(), "plan-pipeline-rec-"));
  const draftRecording = writeRecording(recordingDir, workerPlans.map((plan) => ({ envelope: envelope({ result: JSON.stringify({
    status: "done", summary: "drafted", verification: [], artifacts: [], missingContext: [],
    output: { plan },
  }) }) })), "draft.jsonl");
  const reviewRecording = writeRecording(recordingDir, reviewRounds.map((findings) => ({ envelope: envelope({ result: JSON.stringify({
    status: "done", summary: "reviewed", verification: [], artifacts: [], missingContext: [],
    output: { findings },
  }) }) })), "review.jsonl");

  const runtimes = {
    "planner-worker": { harness: "replay", model: "replay-worker-model", vendor: "vendor-worker", config: { "replay.recording": draftRecording } },
    "planner-judge": { harness: "replay", model: "replay-judge-model", vendor: "vendor-judge", config: { "replay.recording": reviewRecording } },
  };
  const runtimeDefaults = { worker: "planner-worker", judge: "planner-judge" };
  // R19: the planner's own reviewer list is separate from runtimeDefaults.judge;
  // this fixture points it at the same replay runtime so every existing test
  // below keeps exercising the review stage exactly as before.
  const reviewers = ["planner-judge"];
  return { cwd, campaignId, runtimes, runtimeDefaults, reviewers };
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
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("freeze-demo");
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
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

test("re-planning a phase skips the stage run ids an earlier plan left", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("replan-demo");
  // What an earlier `faberun plan` of this phase leaves behind: its draft run.
  mkdirSync(runDirectory(cwd, `${campaignId}-plan-build-draft-1`), { recursive: true });
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"), campaignId, phase: "build", cwd, runtimes, runtimeDefaults, reviewers, launch, wait,
  });
  assert.equal(result.status, "frozen");
  const stages = readFileSync(join(result.plansDir, "pipeline.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(stages.find((entry) => entry.stage === "draft")?.runId, `${campaignId}-plan-build-draft-2`);
});

test("the frozen contract declares the parallelism sizing proved, and a plan sizing proved nothing about stays serial", async () => {
  // Both nodes of the default plan are dependency-free with disjoint write
  // sets, so sizing marks both parallelisable — a conclusion the contract had
  // no field for until it landed in maxParallel. The value is bounded, not
  // the node count: see provenParallelism in src/plan/sizing.mjs.
  const independent = setup("parallel-demo");
  const parallel = await runPlanningPipeline({
    specPath: join(independent.cwd, "docs/spec.md"),
    campaignId: independent.campaignId,
    phase: "build",
    cwd: independent.cwd,
    runtimes: independent.runtimes,
    runtimeDefaults: independent.runtimeDefaults,
    reviewers: independent.reviewers,
    launch,
    wait,
  });
  assert.equal(parallel.status, "frozen");
  const parallelContract = JSON.parse(readFileSync(parallel.contractPath, "utf8"));
  assert.equal(parallelContract.maxParallel, 2);
  const frozenPlan = JSON.parse(readFileSync(parallel.planPath, "utf8"));
  assert.equal(frozenPlan.provenance.sizing.filter((/** @type {any} */ entry) => entry.rule === "parallelisable").length, 2);

  // The same two nodes, chained: nothing is marked, so the contract declares
  // the serial default rather than a concurrency nobody proved.
  const chainedPlan = /** @type {any} */ (twoNodePlan());
  chainedPlan.nodes[1].dependsOn = ["build"];
  const chained = setup("serial-demo", { plans: [chainedPlan] });
  const serial = await runPlanningPipeline({
    specPath: join(chained.cwd, "docs/spec.md"),
    campaignId: chained.campaignId,
    phase: "build",
    cwd: chained.cwd,
    runtimes: chained.runtimes,
    runtimeDefaults: chained.runtimeDefaults,
    reviewers: chained.reviewers,
    launch,
    wait,
  });
  assert.equal(serial.status, "frozen");
  const serialContract = JSON.parse(readFileSync(serial.contractPath, "utf8"));
  assert.equal(serialContract.maxParallel, 1);
  assert.deepEqual(JSON.parse(readFileSync(serial.planPath, "utf8")).provenance.sizing.filter((/** @type {any} */ entry) => entry.rule === "parallelisable"), []);
});

test("operator override wins: --runtime-defaults appears in the frozen contract's runtimeDefaults over the table", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("override-demo");
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
    launch,
    wait,
  });
  assert.equal(result.status, "frozen");
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  assert.deepEqual(contract.runtimeDefaults, runtimeDefaults);
  for (const node of contract.nodes) assert.equal(node.runtime, runtimeDefaults.worker);
});

test("approval policy", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("approval-demo", { highRisk: true });

  const underStandard = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "standard-phase",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
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
    reviewers,
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
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("catalogue-demo");
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
    reviewers,
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

test("--verification loads a suites file, which the frozen contract carries end to end", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("verification-demo");
  const verificationPath = join(cwd, "verification.json");
  writeFileSync(verificationPath, JSON.stringify({
    sharedVerification: [{ argv: ["node", "--eval", "process.exit(0)"], timeoutSec: 10 }],
    finalVerification: [{ argv: ["git", "diff", "--quiet"] }],
  }, null, 2));

  // The loader returns the normalized command shape validateContract applies,
  // so the suites land in the contract exactly as a hand-authored one carries
  // them.
  const loaded = loadVerificationSuites(verificationPath);
  assert.deepEqual(loaded, {
    sharedVerification: [{ argv: ["node", "--eval", "process.exit(0)"], timeoutSec: 10, repeat: 1, env: [] }],
    finalVerification: [{ argv: ["git", "diff", "--quiet"], timeoutSec: 120, repeat: 1, env: [] }],
  });

  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
    verification: loaded,
    launch,
    wait,
  });
  assert.equal(result.status, "frozen");
  assert.deepEqual(result.warnings, []);
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  assert.deepEqual(contract.sharedVerification, loaded.sharedVerification);
  assert.deepEqual(contract.finalVerification, loaded.finalVerification);
});

test("freezing without either verification suite warns, and the contract carries no ratchet", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("unratcheted-demo");
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
    launch,
    wait,
  });
  assert.equal(result.status, "frozen");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /neither sharedVerification nor finalVerification/);
  assert.match(result.warnings[0], /--verification/);
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  assert.equal(contract.sharedVerification, undefined);
  assert.equal(contract.finalVerification, undefined);
});

test("--verification rejects a suites file that is not valid JSON", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-bad-verification-"));
  const verificationPath = join(cwd, "verification.json");
  writeFileSync(verificationPath, "not json");
  assert.throws(() => loadVerificationSuites(verificationPath), /not valid JSON/);
});

test("--verification rejects a suite entry that fails command validation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-bad-verification-entry-"));
  const verificationPath = join(cwd, "verification.json");
  writeFileSync(verificationPath, JSON.stringify({ sharedVerification: [{ argv: [] }] }));
  assert.throws(() => loadVerificationSuites(verificationPath), /sharedVerification/);
});

test("--verification rejects a key that is not a contract suite", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-pipeline-bad-verification-key-"));
  const verificationPath = join(cwd, "verification.json");
  writeFileSync(verificationPath, JSON.stringify({ sharedVerifcation: [{ argv: ["true"] }] }));
  assert.throws(() => loadVerificationSuites(verificationPath), /must carry only sharedVerification and finalVerification/);
});

test("contested plan writes no contract", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("contested-demo", { reviewMode: "critical" });
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
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
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("preflight-demo", {
    plans: [scopeGapPlan(), scopeGapPlan({ closed: true })],
  });
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
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
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("shrink-demo", {
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
    reviewers,
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

test("a finding the next round's reviewer does not repeat is still open, and reaches the reviser", async () => {
  // Round 1 objects twice, on two different nodes; the round-1 revise answers
  // the docs objection (touching that node) but not the rollback one, so
  // round 2 measures fewer criticals than round 1 and keeps its round.
  // Rounds 2 and 3 then say nothing at all and every later revise re-emits
  // the same plan, so nothing further is done about the rollback objection —
  // a reviewer's silence is not an answer, and round 3 measures the same
  // count as round 2, which is R14's non-convergence stop.
  const rollback = { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" };
  const docsGap = { id: "F2", severity: "critical", nodeId: "docs", text: "the docs page needs a versioning note" };
  const revisedDocs = /** @type {any} */ (twoNodePlan());
  revisedDocs.nodes[1].objective = "Document the feature with a versioning note";
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("carry-demo", {
    reviews: [[rollback, docsGap], [], []],
    plans: [twoNodePlan(), revisedDocs, revisedDocs],
  });
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
    reviewRounds: 3,
    launch,
    wait,
  });
  assert.equal(result.status, "contested");
  assert.equal(result.round, 3);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["F1", "revision-not-converging-r3"]);

  // Round 2's reviser was handed the round-1 objection still open against
  // "build", not the empty file its own reviewer produced, and not the
  // "docs" objection the round-1 revise already answered.
  const secondRoundFindings = JSON.parse(readFileSync(join(cwd, ".faberun-plan", campaignId, "build", "findings-round-2.json"), "utf8"));
  assert.deepEqual(secondRoundFindings.map((/** @type {any} */ finding) => finding.id), ["F1"]);
  const stages = readPipelineStages(result.plansDir);
  assert.equal(stages.find((entry) => entry.stage === "revise" && entry.round === 1)?.carriedFindings, 1);
  assert.equal(stages.find((entry) => entry.stage === "review" && entry.round === 2)?.criticalCount, 1);
});

test("a finding the revise answered is not carried, and a plan that answers every objection freezes", async () => {
  // The other half of the rule: the round-1 objection names a node the revise
  // changed, so it is cleared by the plan moving under it rather than by the
  // next reviewer's silence — which is what keeps a carried finding from
  // making convergence impossible.
  const answered = /** @type {any} */ (twoNodePlan());
  answered.nodes[0].objective = "Implement the feature behind a rollback path";
  const rollback = [{ id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" }];
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("answered-demo", {
    plans: [twoNodePlan(), answered],
    reviews: [rollback, []],
  });
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
    reviewRounds: 2,
    launch,
    wait,
  });
  assert.equal(result.status, "frozen");
  assert.deepEqual(result.findings, []);
  const stages = readPipelineStages(result.plansDir);
  assert.equal(stages.find((entry) => entry.stage === "revise" && entry.round === 1)?.carriedFindings, 0);
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  const build = contract.nodes.find((/** @type {any} */ node) => node.id === "build");
  assert.equal(build.taskPacket.objective, "Implement the feature behind a rollback path");
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
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("tail-wrap-demo", { plans: [soloPlan] });
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
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

// R4: the refusal lands before the first stage, which is the whole point. The
// planner is spent at `draft` and the reviewer not until `review`, so a
// reviewer that never answers used to surface after the draft was bought.
test("a mute runtime refuses planning before the first stage launches", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults } = setup("asks-first-demo");
  /** @type {string[]} */
  const launched = [];
  await assert.rejects(
    runPlanningPipeline({
      specPath: join(cwd, "docs/spec.md"),
      campaignId,
      phase: "build",
      cwd,
      runtimes,
      runtimeDefaults,
      launch: async (contractPath) => { launched.push(contractPath); },
      wait,
      ask: async () => [/** @type {never} */ (/** @type {unknown} */ ({
        id: runtimeDefaults.judge, harness: "replay", ok: false,
        detail: "replay 1.0.0 · live failed · preflight_timeout: no answer",
      }))],
    }),
    (error) => {
      assert.equal(/** @type {{code?: string}} */ (error).code, "env_preflight_failed");
      assert.match(String(error), /did not answer: preflight_timeout/u);
      return true;
    },
  );
  assert.deepEqual(launched, [], "no stage was launched, so nothing was spent");
});

test("planning whose runtimes all answer runs its stages unchanged", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("asks-first-green");
  let asked = 0;
  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"),
    campaignId,
    phase: "build",
    cwd,
    runtimes,
    runtimeDefaults,
    reviewers,
    launch,
    wait,
    ask: async () => { asked += 1; return []; },
  });
  assert.equal(result.status, "frozen");
  assert.equal(asked, 1, "asked once, before the first stage, never once per stage");
});

test("a single-node plan is refused by default and frozen under --targeted-fix", async () => {
  // The finding this closes: sizing has always had `targetedFix`, and nothing
  // could set it. A phase whose honest answer is one node -- a targeted fix --
  // could not be planned at all, from any surface.
  const onePlan = { nodes: [/** @type {Record<string, unknown>[]} */ (twoNodePlan().nodes)[0]] };
  const refused = setup("single-node-refused", { plans: [onePlan, onePlan, onePlan] });
  const contested = await runPlanningPipeline({
    specPath: join(refused.cwd, "docs/spec.md"),
    campaignId: refused.campaignId,
    phase: "build",
    cwd: refused.cwd,
    runtimes: refused.runtimes,
    runtimeDefaults: refused.runtimeDefaults,
    reviewers: refused.reviewers,
    launch,
    wait,
  });
  assert.equal(contested.status, "contested", "one node is a plan that was never decomposed, until the operator says otherwise");
  assert.ok(
    JSON.stringify(contested.findings ?? []).includes("sizing_single_node_plan"),
    "the contested result names the rule that refused it",
  );

  const allowed = setup("single-node-targeted", { plans: [onePlan, onePlan, onePlan] });
  const result = await runPlanningPipeline({
    specPath: join(allowed.cwd, "docs/spec.md"),
    campaignId: allowed.campaignId,
    phase: "build",
    cwd: allowed.cwd,
    runtimes: allowed.runtimes,
    runtimeDefaults: allowed.runtimeDefaults,
    reviewers: allowed.reviewers,
    targetedFix: true,
    launch,
    wait,
  });
  assert.equal(result.status, "frozen");
  assert.equal(JSON.parse(readFileSync(result.contractPath, "utf8")).nodes.length, 1);
});

test("a detached plan that dies records why, and an unknown campaign is refused before anything is spawned", () => {
  // `--detach` writes `bootstrap-failure.json` beside the phase's durable plan
  // artifacts and the launcher reads it back; nothing exercised that path.
  const { cwd, campaignId } = setup("detached-plan-dies");
  const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));
  const dead = spawnSync(process.execPath, [
    runner, "plan", "docs/no-such-spec.md", "--campaign", campaignId, "--phase", "build", "--detach",
  ], { cwd, encoding: "utf8" });
  assert.notEqual(dead.status, 0, "the launcher fails when the child it spawned did not start");
  assert.match(dead.stderr, /bootstrap failed/u);
  const failurePath = join(campaignTree(cwd, campaignId), "plans", "build", "bootstrap-failure.json");
  assert.ok(existsSync(failurePath), "the reason has a durable home");
  assert.match(String(JSON.parse(readFileSync(failurePath, "utf8")).error), /no-such-spec\.md/u);

  // The failure record lives inside the campaign tree, so a typo in --campaign
  // would otherwise leave a campaign directory with no record in it.
  const unknown = spawnSync(process.execPath, [
    runner, "plan", "docs/spec.md", "--campaign", "no-such-campaign", "--phase", "build", "--detach",
  ], { cwd, encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /campaign not found/u);
  assert.equal(existsSync(campaignTree(cwd, "no-such-campaign")), false, "a refused launch leaves no campaign directory behind");
});
