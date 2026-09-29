import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { carryPhaseDeclarations, effectiveVerificationSuites, frozenContractRawOf, writeFrozenPlan } from "../../src/plan/pipeline.mjs";
import { freezePlan } from "../../src/plan/freeze.mjs";
import { checkPlanBeforeReview } from "../../src/plan/preflight.mjs";
import { runReviewRounds } from "../../src/plan/rounds.mjs";
import { stableJson } from "../../src/util.mjs";
import { fixture, packet } from "../helpers.mjs";

/**
 * The two pipeline-stage behaviors the frozen identity depends on and that no
 * engine seam is needed to exercise: the declarations sizing must carry forward
 * unchanged in meaning, and the final record-plus-sidecar write order.
 */

test("carryPhaseDeclarations remaps a folded node onto the node that absorbed it", () => {
  const phases = [
    { id: "one", requirementIds: ["R1"], nodeIds: ["a", "b"], deliverable: "One." },
    { id: "two", requirementIds: ["R2"], nodeIds: ["d"], deliverable: "Two." },
  ];
  const transformations = [
    { rule: "contained-write-set-merge", nodes: ["a", "c"], detail: "a into c" },
    { rule: "underfilled-sibling-merge", nodes: ["b", "c"], detail: "b into c" },
    { rule: "no-mechanical-proof-merge", nodes: ["c", "e"], detail: "c into e" },
    { rule: "parallelisable", nodes: ["d"], detail: "d marked" },
  ];

  assert.deepEqual(carryPhaseDeclarations(phases, transformations), [
    { id: "one", requirementIds: ["R1"], nodeIds: ["e"], deliverable: "One." },
    { id: "two", requirementIds: ["R2"], nodeIds: ["d"], deliverable: "Two." },
  ]);

  // Nothing changed, nothing moves.
  assert.deepEqual(carryPhaseDeclarations(phases, []), phases);
  assert.deepEqual(carryPhaseDeclarations(phases, undefined), phases);

  // A legacy declaration with no nodeIds is returned untouched: there is no
  // assignment to remap.
  const legacy = [{ id: "legacy", requirementIds: ["R1"], deliverable: "Legacy." }];
  assert.deepEqual(carryPhaseDeclarations(legacy, transformations), legacy);
});

test("writeFrozenPlan writes the final status and approval before the sidecar over those exact bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-pipeline-seal-"));
  const frozen = freezePlan(fixture({ id: "pipeline-seal", campaignId: "pipeline-seal-campaign" }), {
    outDir: dir,
    provenance: {
      targetGitHead: null,
      planner: { runtimeId: "worker", model: "worker-model" },
      reviewer: { runtimeId: "judge", model: "judge-model" },
      sizing: [],
      findings: [],
    },
  });

  writeFrozenPlan(dir, frozen, { status: "frozen", approved: false });

  const planPath = join(dir, "plan.json");
  const bytes = readFileSync(planPath);
  const plan = JSON.parse(bytes.toString("utf8"));
  assert.equal(plan.status, "frozen");
  assert.equal(plan.approved, false);
  assert.equal(plan.contractDigest, frozen.contractDigest, "the sealed record still carries the contract digest");

  const sidecar = readFileSync(join(dir, "plan.json.sha256"), "utf8").trim();
  assert.equal(sidecar, createHash("sha256").update(bytes).digest("hex"), "the sidecar covers the exact final bytes");
});

// RM-107, measured 2026-09-27 on `safe-to-hand-to-a-friend` phase 1: the phase
// integrated a red tree with no node running test/repo/source-shape.test.mjs,
// because contract-level verification was operator-only. The plan authors the
// suites from the repository facts now, and the operator's flag still wins.
test("the contract carries the plan's own suites, and the operator's --verification wins over them", () => {
  const shared = { argv: ["node", "--test", "test/repo"], timeoutSec: 60, repeat: 1, env: [] };
  const final = { argv: ["npm", "test"], timeoutSec: 1_800, repeat: 1, env: [] };
  const operatorShared = { argv: ["npm", "run", "typecheck"], timeoutSec: 600, repeat: 1, env: [] };
  const ctx = { campaignId: "c", phase: "p", campaignGoal: "g", cwd: ".", plansDir: ".", runtimes: {}, runtimeDefaults: {} };
  /** @param {Record<string, unknown>} suites */
  const planWith = (suites) => /** @type {any} */ ({ nodes: [], ...suites });
  /** @param {Record<string, unknown>} suites */
  const rawOf = (suites) => frozenContractRawOf(/** @type {any} */ ({ sizing: { plan: { nodes: [] } }, nodes: [], suites }), ctx);

  const both = planWith({ sharedVerification: [shared], finalVerification: [final] });
  assert.deepEqual(effectiveVerificationSuites({}, both), { sharedVerification: [shared], finalVerification: [final] });
  const authored = rawOf(effectiveVerificationSuites({}, both));
  assert.deepEqual(authored.sharedVerification, [shared]);
  assert.deepEqual(authored.finalVerification, [final]);

  const overridden = rawOf(effectiveVerificationSuites({ sharedVerification: [operatorShared] }, both));
  assert.deepEqual(overridden.sharedVerification, [operatorShared], "the flag is the one place an operator overrides a plan they did not trust");
  assert.equal(overridden.finalVerification, undefined, "an operator suite replaces the plan's set, it does not merge with it");

  // Neither side declares one: the contract carries neither key, which is what
  // both freeze warnings read.
  assert.deepEqual(effectiveVerificationSuites({}, planWith({})), {});
  assert.equal("sharedVerification" in rawOf(effectiveVerificationSuites({}, planWith({}))), false);
  // An empty array runs nothing and reads the same way.
  assert.deepEqual(effectiveVerificationSuites({}, planWith({ sharedVerification: [] })), {});
});

/**
 * R5's two behaviors, both readable without an engine or a provider: the
 * deterministic check set the pipeline runs before the first review, and the
 * order the round loop runs its own copy of the same set in. `preflight.mjs`
 * and `rounds.mjs` take every seam as an injected function, so neither needs a
 * run to be exercised.
 */

/** A drafted node whose 120s verification is under the bound the measured facts below imply. */
function plannedNode() {
  return /** @type {any} */ ({
    id: "build",
    objective: "Implement the feature",
    taskKind: "implement",
    riskTier: "standard",
    dependsOn: [],
    readFiles: [],
    writeFiles: ["src/index.mjs"],
    scopeAcknowledged: [],
    definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "path", ref: "src/index.mjs" } }],
    verification: [{ argv: ["node", "--test", "test/heavy"], timeoutSec: 120 }],
  });
}

/** What makes that timeout too short: 84.4s measured, so `MEASURED_TIMEOUT_MARGIN` puts the bound at 127s. */
const MEASURED_FACTS = /** @type {any} */ ({
  verificationCandidates: [{ argv: ["node", "--test", "test/heavy"], measuredMs: 84_400 }],
  testFiles: [],
});

/** The contract every fake here freezes into: it validates, and it carries no proof the checks would refuse. */
function frozenFixture(/** @type {string} */ id) {
  return fixture({ id, campaignId: `${id}-campaign`, nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["spec.md"] }), gate: false }] });
}

/**
 * The seams `runReviewRounds` takes, for the ordering the pipeline depends on:
 * a fake freeze check, a temp cwd/plansDir/scratchDir with the read file the
 * fake contract names, and the caller's own `runStage`.
 *
 * @param {{plan: import("../../src/plan/template.mjs").PlanOutput, findings?: any[], reviewRounds?: number, runStage: (kind: string, inputs: any) => Promise<{contract: {id: string}, output: Record<string, unknown>}>}} options
 * @returns {{options: Record<string, unknown>, cwd: string, workingPlanPath: string}}
 */
function roundsHarness({ plan, findings = [], reviewRounds = 1, runStage }) {
  const cwd = mkdtempSync(join(tmpdir(), "plan-rounds-cwd-"));
  const plansDir = mkdtempSync(join(tmpdir(), "plan-rounds-plans-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "plan-rounds-scratch-"));
  const workingPlanPath = join(scratchDir, "plan.working.json");
  writeFileSync(join(plansDir, "spec.md"), "spec\n");
  return {
    cwd,
    workingPlanPath,
    options: {
      reviewRounds,
      plan,
      findings,
      cwd,
      plansDir,
      scratchDir,
      workingPlanPath,
      relativeWorkingPlanPath: relative(cwd, workingPlanPath),
      relativeSpecPath: "spec.md",
      relativeRepoFactsPath: "repo-facts.json",
      relativeCataloguePath: "task-kinds.md",
      packageMode: "implementation",
      repoFacts: { verificationCandidates: [] },
      runStage,
      assembleFrozenNodes: () => ({ sizing: {}, routing: {}, nodes: [] }),
      frozenContractRaw: () => frozenFixture("plan-rounds"),
      contest: async (/** @type {number} */ round, /** @type {any[]} */ contested) => ({ status: "contested", plansDir, planPath: join(plansDir, "plan.json"), findings: contested, round }),
      invalidPlanFinding: (/** @type {string} */ label, /** @type {unknown} */ error) => ({
        id: `plan-shape-${label}`,
        severity: "critical",
        nodeId: "plan",
        text: error instanceof Error ? error.message : String(error),
      }),
      logStage: () => {},
    },
  };
}

test("the deterministic check set repairs what freeze can repair and returns the rest as diagnostics", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plan-preflight-cwd-"));
  const plansDir = mkdtempSync(join(tmpdir(), "plan-preflight-plans-"));
  writeFileSync(join(plansDir, "spec.md"), "spec\n");
  const frozen = frozenFixture("plan-preflight");
  /** @type {any} */
  const ctx = {
    repoFacts: MEASURED_FACTS,
    cwd,
    plansDir,
    assembleFrozenNodes: (/** @type {any} */ candidate) => candidate,
    frozenContractRaw: () => frozen,
  };
  const plan = /** @type {any} */ ({
    nodes: [{
      ...plannedNode(),
      // R15's shape: a name filter no test in the tree carries, on a plan no
      // node declares a test file for.
      definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "command", ref: 'node --test --test-name-pattern="a title nothing carries" test/plan/pipeline.test.mjs' } }],
    }],
  });

  const checks = checkPlanBeforeReview(plan, ctx);

  assert.deepEqual(checks.raised, ["build: node --test test/heavy 120s -> 127s"], "the bound freeze measures is applied, not left to a revise");
  assert.equal(checks.plan.nodes[0].verification[0].timeoutSec, 127, "the plan handed on carries the repaired timeout");
  assert.deepEqual(checks.findings.map((/** @type {any} */ finding) => finding.id), ["proof-unmet-build-works"], "an unsatisfiable proof is a finding, not a throw");
  assert.equal(checks.failure, null, "a plan the checks repaired would freeze");

  // A plan the freeze itself would refuse is a diagnostic too, and the
  // repaired plan comes back beside it: the round loop repairs it inside a
  // budget it has already paid for instead of the pipeline dying on a throw.
  const refused = checkPlanBeforeReview(plan, { ...ctx, frozenContractRaw: () => ({}) });
  assert.notEqual(refused.failure, null);
  assert.equal(refused.plan.nodes[0].verification[0].timeoutSec, 127, "the repair is still reported with the failure");
});

test("the round measures the plan before it dispatches the review, and hands the reviewer the plan that would freeze", async () => {
  /** @type {string[]} */
  const stages = [];
  /** @type {any} */
  let reviewed = null;
  const { options, workingPlanPath } = roundsHarness({
    plan: /** @type {any} */ ({ nodes: [plannedNode()] }),
    runStage: async (/** @type {string} */ kind) => {
      stages.push(kind);
      reviewed = JSON.parse(readFileSync(workingPlanPath, "utf8"));
      return { contract: { id: `${kind}-1` }, output: { findings: [] } };
    },
  });
  options.repoFacts = MEASURED_FACTS;
  const frozen = frozenFixture("plan-order");
  /** @type {string[]} */
  const timing = [];
  options.frozenContractRaw = () => {
    timing.push(reviewed === null ? "before-review" : "after-review");
    return frozen;
  };

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, true);
  assert.deepEqual(stages, ["review"]);
  assert.deepEqual(timing, ["before-review"], "freeze's rules are checked before the review is dispatched");
  assert.equal(reviewed.nodes[0].verification[0].timeoutSec, 127, "the reviewer reads the repaired plan");
  assert.equal(stableJson(reviewed), stableJson(result.plan), "the reviewed artefact and the plan that would freeze are the same plan");
});

test("a diagnostic the pipeline forwards is repaired inside the existing round budget", async () => {
  // What the pipeline hands over when its checks raise something: an ordinary
  // finding. It must reach the reviser in the rounds the budget already pays
  // for — a refusal here would spend the round twice or not at all.
  const forwarded = { id: "proof-unmet-build-works", severity: "critical", nodeId: "build", text: "no test carries the pattern this proof names" };
  const revised = { ...plannedNode(), objective: "Implement the feature behind a test the proof selects" };
  /** @type {any[]} */
  const handed = [];
  let reviewCalls = 0;
  let reviseCalls = 0;
  const { cwd, options } = roundsHarness({
    plan: /** @type {any} */ ({ nodes: [plannedNode()] }),
    findings: [forwarded],
    reviewRounds: 2,
    runStage: async (/** @type {string} */ kind, /** @type {any} */ inputs) => {
      if (kind === "review") {
        reviewCalls += 1;
        return { contract: { id: `review-${reviewCalls}` }, output: { findings: [] } };
      }
      reviseCalls += 1;
      handed.push(JSON.parse(readFileSync(join(cwd, inputs.findingsPath), "utf8")));
      return { contract: { id: `revise-${reviseCalls}` }, output: { patch: { nodes: [revised] } } };
    },
  });

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, true, "the diagnostic was answered inside the budget, so the plan froze");
  assert.equal(reviseCalls, 1, "it drove the same revise a reviewer's objection drives");
  assert.equal(reviewCalls, 2, "and it cost no round of its own");
  assert.deepEqual(handed[0].filter((/** @type {any} */ finding) => finding.id === forwarded.id).length, 1, "handed over once, not once per copy the loop sees");
  assert.deepEqual(result.findings, [], "a revise that moved the node under it answered it");
});
