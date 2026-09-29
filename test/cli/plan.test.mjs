import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readJournal } from "../../src/campaign/journal.mjs";
import { loadRuntimesCatalogue, loadVerificationSuites, resolvePlanRuntimes } from "../../src/cli/plan.mjs";
import { DISCOVERY_RUNTIME_DEFINITIONS } from "../../src/engine/runtime-discovery.mjs";
import { runPlanningPipeline } from "../../src/plan/pipeline.mjs";
import { planProgressPath } from "../../src/plan/progress.mjs";
import { campaignTree, runDirectory } from "../../src/run/paths.mjs";
import { writeJsonAtomic } from "../../src/run/store.mjs";
import { commitFixture, launch, readPipelineStages, scopeGapPlan, setup, twoNodePlan, wait, writeFixtureFile } from "./plan-helpers.mjs";

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

  // The repo-facts stage is the one that holds the terminal for minutes, so it
  // announces the commands it is about to time and reports each as it lands
  // (AP3). The fixture declares no scripts, so the one candidate is the test
  // directory the setup writes.
  const plansDir = join(campaignTree(cwd, campaignId), "plans", "build");
  assert.deepEqual(readPipelineStages(plansDir).slice(0, 3).map((line) => line.stage), ["repo-facts:start", "repo-facts:measured", "repo-facts"]);
  assert.deepEqual(readPipelineStages(plansDir)[0].commands, ["node --test test/cli"]);
  // A pipeline that returned leaves no liveness record (AP4): a record on disk
  // means a process that never reached its own end, and a stale one here would
  // make the next launch report a death that did not happen.
  assert.equal(existsSync(join(plansDir, "progress.json")), false);
});

test("a plan refuses a dirty tree before it spends anything on the repository", async () => {
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("dirty-tree-demo");
  writeFixtureFile(cwd, "uncommitted-note.txt", "work in progress\n");
  // Measured 2026-09-27 (AP10): the launch is the pipeline's last act, so this
  // refusal arrived after sixteen minutes of repo facts and read to the
  // operator as "detached bootstrap failed before readiness for pid 82057",
  // with no run directory and no reason.
  await assert.rejects(
    () => runPlanningPipeline({ specPath: join(cwd, "docs/spec.md"), campaignId, phase: "build", cwd, runtimes, runtimeDefaults, reviewers, launch, wait }),
    /refusing to launch against HEAD: the working tree has 1 uncommitted path/u,
  );
  assert.equal(existsSync(join(campaignTree(cwd, campaignId), "plans", "build")), false, "no planning artifact is written");
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
  commitFixture(cwd, "runtimes.json");

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

test("a plan reads the campaign's own plan-inputs/runtimes.json and names the file it read (AP19)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-inputs-runtimes-"));
  const catalogue = { "campaign-worker": { harness: "replay", model: "replay-worker-model", vendor: "vendor-worker", config: { "replay.recording": "/nonexistent/campaign.jsonl" } } };
  writeFixtureFile(cwd, "docs/campaigns/inputs-demo/plan-inputs/runtimes.json", JSON.stringify(catalogue));

  const carried = resolvePlanRuntimes({ cwd, campaignId: "inputs-demo", runtimes: undefined });
  assert.deepEqual(Object.keys(carried.runtimes), ["campaign-worker"]);
  assert.equal(carried.source, join(cwd, "docs/campaigns/inputs-demo/plan-inputs/runtimes.json"));

  // An operator who passes a path is overriding, not asking.
  const override = join(cwd, "elsewhere.json");
  writeFileSync(override, JSON.stringify({ "flag-worker": { harness: "replay", model: "m", vendor: "v", config: { "replay.recording": "/nonexistent/flag.jsonl" } } }));
  const overriding = resolvePlanRuntimes({ cwd, campaignId: "inputs-demo", runtimes: override });
  assert.deepEqual(Object.keys(overriding.runtimes), ["flag-worker"]);
  assert.equal(overriding.source, null, "a catalogue the operator named is already said on the command line");

  const absent = resolvePlanRuntimes({ cwd, campaignId: "no-inputs", runtimes: undefined });
  assert.equal(absent.source, null);
  assert.deepEqual(Object.keys(absent.runtimes), Object.keys(DISCOVERY_RUNTIME_DEFINITIONS));
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
  commitFixture(cwd, "verification.json");

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

// RM-107, measured 2026-09-27 on `safe-to-hand-to-a-friend` phase 1: the phase
// integrated a red tree — a file over the 800-line ceiling, a name exported by
// seven modules — and no node had run the repository's own structural suite,
// because contract-level verification was operator-only. The plan proposes it
// from the measured candidates now, and the operator's flag still overrides.
test("a plan that authors the contract's suites freezes ratcheted, with no warning", async () => {
  const plan = twoNodePlan();
  // `node --test test/cli` is the one candidate this fixture's repository
  // measures (the setup writes test/cli/cli.test.mjs), so both suites name a
  // measured command — the shape the draft is told to emit.
  const suite = [{ argv: ["node", "--test", "test/cli"], timeoutSec: 300 }];
  plan.sharedVerification = suite;
  plan.finalVerification = suite;
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("authored-suites-demo", { plans: Array(4).fill(plan) });

  const result = await runPlanningPipeline({
    specPath: join(cwd, "docs/spec.md"), campaignId, phase: "build", cwd,
    runtimes, runtimeDefaults, reviewers,
    launch, wait,
  });
  assert.equal(result.status, "frozen");
  assert.deepEqual(result.warnings, [], "the contract a plan ratcheted itself draws no warning");
  const normalized = [{ argv: ["node", "--test", "test/cli"], timeoutSec: 300, repeat: 1, env: [] }];
  const contract = JSON.parse(readFileSync(result.contractPath, "utf8"));
  assert.deepEqual(contract.sharedVerification, normalized);
  assert.deepEqual(contract.finalVerification, normalized);
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
  // refusals from exactly this). The drop goes to the next revise, which
  // re-emits the same shrunk plan: the drop and the review's objection both
  // stand on a node it left unchanged, so round 3 is R14's stop. The
  // revision is contested, never frozen.
  const draft = /** @type {any} */ (twoNodePlan());
  draft.nodes[0].writeFiles = ["src/index.mjs", "src/other.mjs"];
  const { cwd, campaignId, runtimes, runtimeDefaults, reviewers } = setup("shrink-demo", {
    reviewMode: "critical",
    plans: [draft, twoNodePlan(), twoNodePlan()],
    files: { "src/other.mjs": "export const other = 1;\n" },
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
  assert.ok(result.findings.some((finding) => finding.id === "revision-not-converging-r3"));
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

  // A planning process killed during a stage takes its own reason with it; the
  // liveness record it left is the only trace, and the next launch of that
  // phase is the one place the operator can still be told (AP4).
  writeJsonAtomic(planProgressPath(cwd, campaignId, "dead"), {
    pid: 2_147_483_646, processStartToken: null, at: "2026-09-26T12:00:00.000Z", campaignId, phase: "dead", stage: "repo-facts:start",
  });
  const later = spawnSync(process.execPath, [
    runner, "plan", "docs/no-such-spec.md", "--campaign", campaignId, "--phase", "dead", "--detach",
  ], { cwd, encoding: "utf8" });
  assert.match(later.stderr, /a previous planning process \(pid 2147483646\) stopped during repo-facts:start at 2026-09-26T12:00:00\.000Z/u);

  // The failure record lives inside the campaign tree, so a typo in --campaign
  // would otherwise leave a campaign directory with no record in it.
  const unknown = spawnSync(process.execPath, [
    runner, "plan", "docs/spec.md", "--campaign", "no-such-campaign", "--phase", "build", "--detach",
  ], { cwd, encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /campaign not found/u);
  assert.equal(existsSync(campaignTree(cwd, "no-such-campaign")), false, "a refused launch leaves no campaign directory behind");
});
