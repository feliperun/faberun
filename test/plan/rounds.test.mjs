import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runReviewRounds } from "../../src/plan/rounds.mjs";
import { fixture, packet } from "../helpers.mjs";

/**
 * `runReviewRounds` takes every seam that touches a provider, the filesystem
 * layout outside its own scratch directory, or the deterministic freeze
 * check as an injected function (see its own doc comment), so R14's round
 * bookkeeping is exercised here directly against fakes — no replay recording,
 * no engine, no provider.
 */

/**
 * A minimal, already-normalized PlanOutput: what `validatePlanOutput` returns
 * and what a fake revise's raw output must also satisfy, since both a round's
 * starting plan and a revise's output pass through the same shape here.
 *
 * @param {{objective?: string}} [options]
 * @returns {import("../../src/plan/template.mjs").PlanOutput}
 */
function planOutput({ objective = "Implement the feature" } = {}) {
  return /** @type {any} */ ({
    nodes: [{
      id: "build",
      objective,
      taskKind: "implement",
      riskTier: "standard",
      dependsOn: [],
      readFiles: [],
      writeFiles: ["src/index.mjs"],
      scopeAcknowledged: [],
      definitionOfDone: [{ id: "works", text: "It works", proof: { kind: "path", ref: "src/index.mjs" } }],
      verification: [],
    }],
  });
}

/**
 * The fixed set of options every test here shares: a fake freeze pre-flight
 * that always passes (a fixture contract carries no verification, so
 * `assertTimeoutsCoverMeasured` has nothing to measure against), a `contest`
 * that records its calls instead of writing a campaign journal entry, and an
 * `invalidPlanFinding` shaped exactly like the pipeline's own.
 *
 * @param {{reviewRounds: number, plan: import("../../src/plan/template.mjs").PlanOutput, runStage: (kind: string, inputs?: Record<string, unknown>) => Promise<{contract: {id: string}, output: Record<string, unknown>}>}} options
 * @returns {{options: Record<string, unknown>, logs: Record<string, unknown>[], contestCalls: Record<string, unknown>[]}}
 */
function harness({ reviewRounds, plan, runStage }) {
  const cwd = mkdtempSync(join(tmpdir(), "rounds-test-cwd-"));
  const plansDir = mkdtempSync(join(tmpdir(), "rounds-test-plans-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "rounds-test-scratch-"));
  const workingPlanPath = join(scratchDir, "plan.working.json");
  // An execution packet's readFiles must not be empty, and must resolve
  // inside the contract's cwd (plansDir, since the fake contract below
  // never names one): a real file the freeze pre-flight can find.
  writeFileSync(join(plansDir, "spec.md"), "spec\n");
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  /** @type {Record<string, unknown>[]} */
  const contestCalls = [];
  const invalidPlanFinding = (/** @type {string} */ label, /** @type {unknown} */ error) => ({
    id: `plan-shape-${label}`,
    severity: /** @type {const} */ ("critical"),
    nodeId: "plan",
    text: error instanceof Error ? error.message : String(error),
  });
  return {
    logs,
    contestCalls,
    options: {
      reviewRounds,
      plan,
      findings: [],
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
      // `packet`'s own default readFiles entry ("contract.json") is what
      // `test/helpers.mjs`'s `writeContract` writes next to the contract for
      // its own callers; nothing here writes one, so it is pointed at the
      // real file `spec.md` written above instead — the freeze pre-flight is
      // not what these tests are about.
      frozenContractRaw: () => fixture({
        id: "rounds-test",
        campaignId: "rounds-test-campaign",
        nodes: [{ id: "build", type: "backend", taskPacket: packet({ readFiles: ["spec.md"] }), gate: false }],
      }),
      contest: async (/** @type {number} */ round, /** @type {any[]} */ findings) => {
        contestCalls.push({ round, findings });
        return { status: "contested", plansDir, planPath: join(plansDir, "plan.json"), findings, round };
      },
      invalidPlanFinding,
      logStage: (/** @type {string} */ stage, /** @type {Record<string, unknown>} */ extra = {}) => logs.push({ stage, ...extra }),
    },
  };
}

test("a revise that does not reduce critical findings stops the pipeline", async () => {
  // Round 1's review finds one critical; the revise it drives leaves the
  // node it names untouched, so the finding is still open in round 2 even
  // though round 2's own reviewer says nothing new. Round 2 therefore
  // measures the same critical count as round 1 -- R14's non-convergence
  // stop -- with three review rounds still in budget.
  const rollback = { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" };
  let reviewCalls = 0;
  let reviseCalls = 0;
  const reviewFindings = [[rollback], []];
  const runStage = async (/** @type {string} */ kind) => {
    if (kind === "review") {
      const findings = reviewFindings[reviewCalls];
      reviewCalls += 1;
      return { contract: { id: `review-${reviewCalls}` }, output: { findings } };
    }
    if (kind === "revise") {
      reviseCalls += 1;
      // The same plan every time: the revise never touches "build", so the
      // finding against it is never resolved.
      return { contract: { id: `revise-${reviseCalls}` }, output: { plan: planOutput() } };
    }
    throw new Error(`unexpected stage ${kind}`);
  };
  const { options, logs, contestCalls } = harness({ reviewRounds: 5, plan: planOutput(), runStage });

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, false);
  assert.equal(result.result.round, 2);
  assert.deepEqual(result.result.findings.map((/** @type {any} */ finding) => finding.id), ["F1", "revision-not-converging-r2"]);
  // The round budget had three rounds left; none of them ran.
  assert.equal(reviewCalls, 2);
  assert.equal(reviseCalls, 1);
  assert.equal(contestCalls.length, 1);
  const notConverging = logs.find((entry) => entry.stage === "revision-not-converging");
  assert.deepEqual(notConverging?.criticalHistory, [1, 1]);
});

test("an invalid revise output is retried once without spending a round, and a second invalid output contests", async () => {
  const rollback = { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" };
  let reviewCalls = 0;
  let reviseCalls = 0;
  const runStage = async (/** @type {string} */ kind) => {
    if (kind === "review") {
      reviewCalls += 1;
      // Only round 1 ever reviews: the retry below never resolves, so the
      // round contests before a second review would run.
      return { contract: { id: `review-${reviewCalls}` }, output: { findings: reviewCalls === 1 ? [rollback] : [] } };
    }
    if (kind === "revise") {
      reviseCalls += 1;
      // Every revise attempt -- the first and its one retry -- comes back
      // structurally invalid: riskTier is not one of the catalogue.
      return { contract: { id: `revise-${reviseCalls}` }, output: { plan: { nodes: [{ ...planOutput().nodes[0], riskTier: "extreme" }] } } };
    }
    throw new Error(`unexpected stage ${kind}`);
  };
  const { options, contestCalls } = harness({ reviewRounds: 5, plan: planOutput(), runStage });

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, false);
  assert.equal(result.result.round, 1);
  // Both the round's own revise and its one retry ran, and neither counted
  // as a second review round.
  assert.equal(reviseCalls, 2);
  assert.equal(reviewCalls, 1);
  assert.equal(contestCalls.length, 1);
  const ids = result.result.findings.map((/** @type {any} */ finding) => finding.id);
  assert.ok(ids.includes("F1"), "the round's own finding still drives the contested record");
  assert.ok(ids.includes("plan-shape-revise-r1-attempt2"), "the second attempt's rejection is what actually contests");
});

test("a round whose draft never validated sets no baseline for R14", async () => {
  // The 3a gate's shape: the draft is invalid, so round 1 has no review and
  // its one critical only says the plan did not validate. Round 2's review is
  // the first to grade a plan and finds two; that is a baseline, not a
  // regression, and round 3's revise resolves them.
  const draftInvalid = { id: "plan-shape-draft", severity: "critical", nodeId: "plan", text: "plan.nodes[0].definitionOfDone[0] must declare proof or judgment: true" };
  const reviewFindings = [
    [{ id: "F1", severity: "critical", nodeId: "build", text: "ordered before what it reads" }, { id: "F2", severity: "critical", nodeId: "build", text: "scope does not close" }],
    [],
  ];
  let reviewCalls = 0;
  let reviseCalls = 0;
  const runStage = async (/** @type {string} */ kind) => {
    if (kind === "review") {
      const findings = reviewFindings[reviewCalls];
      reviewCalls += 1;
      return { contract: { id: `review-${reviewCalls}` }, output: { findings } };
    }
    if (kind === "revise") {
      reviseCalls += 1;
      return { contract: { id: `revise-${reviseCalls}` }, output: { plan: planOutput({ objective: `Implement the feature, revision ${reviseCalls}` }) } };
    }
    throw new Error(`unexpected stage ${kind}`);
  };
  const { options, logs } = harness({ reviewRounds: 4, plan: /** @type {any} */ (null), runStage });
  options.findings = [draftInvalid];

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(logs.some((entry) => entry.stage === "revision-not-converging"), false, JSON.stringify(logs));
  assert.equal(result.resolved, true);
  assert.equal(reviewCalls, 2);
});

test("a revise that answers every critical is not stopped by a fresh review that finds as many new ones", async () => {
  // The 3a gate rerun's shape, measured 2026-09-25: round 1 raised two
  // criticals, the revise changed the node both named, and round 2's review
  // raised two different ones. The count did not fall, but nothing the revise
  // was handed stood unanswered, so R14 does not stop the plan; round 3's
  // revise answers those and the plan freezes inside the budget.
  const reviewFindings = [
    [{ id: "F1", severity: "critical", nodeId: "build", text: "ordered before what it reads" }, { id: "F2", severity: "critical", nodeId: "build", text: "probe not rewired" }],
    [{ id: "F3", severity: "critical", nodeId: "build", text: "scan precedes the rewire" }, { id: "F4", severity: "critical", nodeId: "build", text: "usage window unowned" }],
    [],
  ];
  let reviewCalls = 0;
  let reviseCalls = 0;
  const runStage = async (/** @type {string} */ kind) => {
    if (kind === "review") {
      const findings = reviewFindings[reviewCalls];
      reviewCalls += 1;
      return { contract: { id: `review-${reviewCalls}` }, output: { findings } };
    }
    if (kind === "revise") {
      reviseCalls += 1;
      return { contract: { id: `revise-${reviseCalls}` }, output: { plan: planOutput({ objective: `Implement the feature, revision ${reviseCalls}` }) } };
    }
    throw new Error(`unexpected stage ${kind}`);
  };
  const { options, logs } = harness({ reviewRounds: 4, plan: planOutput(), runStage });

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(logs.some((entry) => entry.stage === "revision-not-converging"), false, JSON.stringify(logs));
  assert.equal(result.resolved, true);
  assert.equal(reviewCalls, 3);
  assert.equal(reviseCalls, 2);
});

test("the revise is handed the plan it revises, and its retry the output the validator refused", async () => {
  // Measured 2026-09-25 on the 3a gate: the revise read only the spec, repo
  // facts, catalogue and findings, so every revise redrafted the plan from
  // the findings alone, and its retry fixed one validator error while
  // introducing another.
  const rollback = { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" };
  const rejected = { nodes: [{ ...planOutput().nodes[0], riskTier: "extreme" }] };
  /** @type {unknown[]} */
  const handed = [];
  let reviewCalls = 0;
  let reviseCalls = 0;
  const { options } = harness({
    reviewRounds: 2,
    plan: planOutput({ objective: "The drafted plan" }),
    runStage: async (/** @type {string} */ kind, /** @type {any} */ inputs) => {
      if (kind === "review") {
        reviewCalls += 1;
        return { contract: { id: `review-${reviewCalls}` }, output: { findings: reviewCalls === 1 ? [rollback] : [] } };
      }
      reviseCalls += 1;
      handed.push(JSON.parse(readFileSync(join(/** @type {string} */ (options.cwd), inputs.planPath), "utf8")));
      const plan = reviseCalls === 1 ? rejected : planOutput({ objective: "The drafted plan, with a rollback path" });
      return { contract: { id: `revise-${reviseCalls}` }, output: { plan } };
    },
  });

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, true);
  assert.equal(/** @type {any} */ (handed[0]).nodes[0].objective, "The drafted plan", "the first revise starts from the plan review graded");
  assert.deepEqual(handed[1], rejected, "the retry starts from the output the validator refused");
});
