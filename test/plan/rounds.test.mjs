import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runBoundedRounds, runReviewRounds, reauthorTriggerDecision, REAUTHOR_ROUND_CAP } from "../../src/plan/rounds.mjs";
import { durableQuestion } from "../../src/plan/human-step.mjs";
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
      // An empty patch every time: the revise never touches "build", so the
      // finding against it is never resolved.
      return { contract: { id: `revise-${reviseCalls}` }, output: { patch: { nodes: [] } } };
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
      // Every revise attempt -- the first and its one retry -- patches in a
      // node the validator refuses: riskTier is not one of the catalogue.
      return { contract: { id: `revise-${reviseCalls}` }, output: { patch: { nodes: [{ ...planOutput().nodes[0], riskTier: "extreme" }] } } };
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
  const runStage = async (/** @type {string} */ kind, /** @type {any} */ inputs) => {
    if (kind === "review") {
      const findings = reviewFindings[reviewCalls];
      reviewCalls += 1;
      return { contract: { id: `review-${reviewCalls}` }, output: { findings } };
    }
    if (kind === "revise") {
      reviseCalls += 1;
      // The first round's draft never validated, so there is no plan to patch
      // and its revise returns a whole plan; every round after that one
      // patches the plan it read.
      const node = { ...planOutput({ objective: `Implement the feature, revision ${reviseCalls}` }).nodes[0] };
      return { contract: { id: `revise-${reviseCalls}` }, output: inputs?.revisePatch === true ? { patch: { nodes: [node] } } : { plan: { nodes: [node] } } };
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
      // Each revise changes the node both of the round's criticals name, which
      // is what answers them: the patch carries that node and nothing else.
      return { contract: { id: `revise-${reviseCalls}` }, output: { patch: { nodes: [{ ...planOutput().nodes[0], objective: `Implement the feature, revision ${reviseCalls}` }] } } };
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

test("the revise is handed the nodes its findings name and the dependencies they need, not the whole plan", async () => {
  // Measured 2026-09-25 on the 3a gate: the revise read only the spec, repo
  // facts, catalogue and findings, so every revise redrafted the plan from
  // the findings alone, and its retry fixed one validator error while
  // introducing another. RM-110 gave it a patch; R4, campaign-efficiency
  // phase 4, narrows what it reads to the findings' nodes, their
  // dependencies and the plan's own declarations — never the whole node
  // list, never the repository facts.
  //
  // The retry is handed the narrowed context of the revision the validator
  // refused (RM-110's merge under R4's reading): the first attempt's own
  // changed nodes ride beside the findings' nodes, because a validator
  // message names them by patch index, never by id.
  const rollback = { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" };
  const revisedNode = { ...planOutput().nodes[0], objective: "The drafted plan, with a rollback path" };
  const ghostPhase = { id: "p1", requirementIds: ["R1"], nodeIds: ["build", "ghost"], deliverable: "The feature" };
  /** @type {unknown[]} */
  const handed = [];
  /** @type {boolean[]} */
  const sawNoRepoFacts = [];
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
      sawNoRepoFacts.push(inputs.repoFactsPath === undefined);
      const patch = reviseCalls === 1
        ? { nodes: [revisedNode], phases: [ghostPhase] }
        : { phases: [{ ...ghostPhase, nodeIds: ["build"] }] };
      return { contract: { id: `revise-${reviseCalls}` }, output: { patch } };
    },
  });

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, true);
  assert.ok(sawNoRepoFacts.every(Boolean), "the narrowed reviser receives no repository facts");
  assert.deepEqual(handed[0], {
    changedNodes: [planOutput({ objective: "The drafted plan" }).nodes[0]],
    dependencyNodes: [],
  }, "the first revise's context is the findings' node, which depends on nothing, and nothing else");
  assert.equal(/** @type {any} */ (handed[1]).changedNodes[0].objective, "The drafted plan, with a rollback path", "the retry starts from the revision the validator refused, not from the plan before it");
  assert.deepEqual(/** @type {any} */ (handed[1]).phases, [ghostPhase], "including the part of it the validator refused");
  assert.deepEqual(/** @type {any} */ (handed[1]).dependencyNodes, []);
  assert.deepEqual(/** @type {any} */ (result.plan).phases, [{ ...ghostPhase, nodeIds: ["build"] }]);
  assert.equal(/** @type {any} */ (result.plan).nodes[0].objective, "The drafted plan, with a rollback path");
});

test("the revise context closes over the dependencies the named nodes need and carries the plan's declarations", async () => {
  // A finding on the last node of a chain pulls in the whole chain it
  // depends on, transitively, and the plan's own declarations — so a patch
  // that adds or removes a node can keep the phase assignments legal — but
  // nothing the findings never named and no node needs.
  const node = (/** @type {string} */ id, /** @type {string[]} */ dependsOn) => ({
    id,
    objective: `Implement ${id}`,
    taskKind: "implement",
    riskTier: "standard",
    dependsOn,
    readFiles: [],
    writeFiles: [`src/${id}.mjs`],
    scopeAcknowledged: [],
    definitionOfDone: [{ id: `${id}-works`, text: "It works", proof: { kind: "path", ref: `src/${id}.mjs` } }],
    verification: [],
  });
  const basePlan = {
    nodes: [node("build", []), node("layout", ["build"]), node("verify", ["layout"])],
    phases: [{ id: "p1", requirementIds: ["R1"], nodeIds: ["build", "layout", "verify"], deliverable: "The feature" }],
    justification: "the draft's own reason",
  };
  const finding = { id: "F1", severity: "critical", nodeId: "verify", text: "verify measures the wrong window" };
  /** @type {unknown[]} */
  const handed = [];
  let reviewCalls = 0;
  const { options } = harness({
    reviewRounds: 2,
    plan: /** @type {any} */ (basePlan),
    runStage: async (/** @type {string} */ kind, /** @type {any} */ inputs) => {
      if (kind === "review") {
        reviewCalls += 1;
        return { contract: { id: `review-${reviewCalls}` }, output: { findings: reviewCalls === 1 ? [finding] : [] } };
      }
      handed.push(JSON.parse(readFileSync(join(/** @type {string} */ (options.cwd), inputs.planPath), "utf8")));
      return { contract: { id: "revise-1" }, output: { patch: { nodes: [{ ...node("verify", ["layout"]), objective: "measures the right window" }] } } };
    },
  });

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, true);
  assert.deepEqual(handed[0], {
    changedNodes: [node("verify", ["layout"])],
    dependencyNodes: [node("build", []), node("layout", ["build"])],
    phases: basePlan.phases,
    justification: "the draft's own reason",
  });
});

test("a revise context that does not fit the packet ceiling is refused by name and contests the round", async () => {
  // R4's explicit overflow error, reviser side: the context is the revise
  // packet's mandatory fact, so a context over the 65,536-byte budget is a
  // named refusal — never a truncation, never a silent fall back to the
  // whole plan — and the refusal is the finding the round contests on.
  const finding = { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" };
  const base = planOutput();
  const huge = /** @type {any} */ ({ ...base, nodes: [{ ...base.nodes[0], objective: `Load: ${"x".repeat(70 * 1024)}` }] });
  let reviseCalls = 0;
  const { options, contestCalls } = harness({
    reviewRounds: 3,
    plan: huge,
    runStage: async (/** @type {string} */ kind) => {
      if (kind === "review") {
        return { contract: { id: "review-1" }, output: { findings: [finding] } };
      }
      reviseCalls += 1;
      return { contract: { id: `revise-${reviseCalls}` }, output: { patch: { nodes: [] } } };
    },
  });

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(reviseCalls, 0, "the revise stage never runs on a context that cannot be built");
  assert.equal(result.resolved, false);
  assert.equal(contestCalls.length, 1);
  const contest = /** @type {{findings: {id: string, text: string}[]}} */ (contestCalls[0]);
  const overflow = contest.findings.find((item) => item.id === "plan-shape-revise-r1-context");
  assert.ok(overflow, JSON.stringify(contest.findings.map((item) => item.id)));
  assert.match(overflow.text, /revise_context_over_budget/u);
  assert.match(overflow.text, /never truncated to fit/u);
});

test("a verification timeout under its measured bound is raised before review, not contested", async () => {
  // Measured 2026-09-26 on the 3a gate: four rounds left a plan with no
  // critical from review, contested only because `node --test test/harnesses`
  // had 120s against a measured 84.4s. The bound (127s) is the one repair.
  const base = planOutput();
  const plan = /** @type {any} */ ({ ...base, nodes: [{ ...base.nodes[0], verification: [{ argv: ["node", "--test", "test/harnesses"], timeoutSec: 120 }, { argv: ["node", "--test", "test/huge"], timeoutSec: 120 }] }] });
  /** @type {any[]} */
  const reviewed = [];
  const { options, logs } = harness({
    reviewRounds: 1,
    plan,
    runStage: async (/** @type {string} */ kind) => {
      reviewed.push(JSON.parse(readFileSync(/** @type {string} */ (options.workingPlanPath), "utf8")));
      return { contract: { id: `${kind}-1` }, output: { findings: [] } };
    },
  });
  options.repoFacts = { verificationCandidates: [
    { argv: ["node", "--test", "test/harnesses"], measuredMs: 84_400, eligible: true },
    { argv: ["node", "--test", "test/huge"], measuredMs: 3_000_000, eligible: true },
  ] };

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, true);
  const [harnesses, huge] = reviewed[0].nodes[0].verification;
  assert.equal(harnesses.timeoutSec, 127, "the reviewer grades the repaired plan");
  assert.equal(huge.timeoutSec, 120, "a command no legal timeout covers is left for the check to contest");
  assert.deepEqual(logs.find((entry) => entry.stage === "timeouts-raised")?.raised, ["build: node --test test/harnesses 120s -> 127s"]);
});

test("a revise whose output would not freeze is sent back once before review spends a round on it", async () => {
  // Measured 2026-09-26 on the 3a gate: four rounds with no critical from
  // review each contested on a scope-closure gap the revise had just opened,
  // and learned of it only a whole review round later.
  const rollback = { id: "F1", severity: "critical", nodeId: "build", text: "the plan is missing a rollback path" };
  /** @type {any[]} */
  const reviseFindings = [];
  let reviewCalls = 0;
  let reviseCalls = 0;
  const { options, logs } = harness({
    reviewRounds: 2,
    plan: planOutput(),
    runStage: async (/** @type {string} */ kind, /** @type {any} */ inputs) => {
      if (kind === "review") {
        reviewCalls += 1;
        return { contract: { id: `review-${reviewCalls}` }, output: { findings: reviewCalls === 1 ? [rollback] : [] } };
      }
      reviseCalls += 1;
      reviseFindings.push(JSON.parse(readFileSync(join(/** @type {string} */ (options.cwd), inputs.findingsPath), "utf8")));
      // The first patch opens the gap the pre-flight refuses, and the retry
      // patches the same node again to close it: the merged plan is what both
      // the pre-flight and the retry's own base read.
      return { contract: { id: `revise-${reviseCalls}` }, output: { patch: { nodes: [{ ...planOutput().nodes[0], objective: reviseCalls === 1 ? "opens a scope gap" : "closes it" }] } } };
    },
  });
  const frozen = /** @type {() => unknown} */ (options.frozenContractRaw)();
  options.assembleFrozenNodes = (/** @type {any} */ plan) => plan;
  options.frozenContractRaw = (/** @type {any} */ plan) => (plan.nodes[0].objective === "opens a scope gap" ? {} : frozen);

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, true);
  assert.equal(reviseCalls, 2, "the output that would not freeze went back to the revise");
  assert.equal(reviewCalls, 2, "and the retry did not spend a review round");
  assert.ok(reviseFindings[1].some((/** @type {any} */ finding) => finding.id === "plan-shape-revise-r1-attempt1"), "the retry is handed the pre-flight's message");
  assert.equal(logs.some((entry) => entry.stage === "contested"), false);
});

test("a node creating a file in a directory a test lists by name is given that test to edit, with the reason logged", async () => {
  // AP2 of safe-to-hand-to-a-friend, measured 2026-09-26: the node adding
  // skills/faberun/references/local-env.md failed on
  // test/docs/docs-diet.test.mjs, which lists references/ exactly, because the
  // plan never declared that test and the gate refuses an undeclared edit to
  // a file a proof cites.
  const base = planOutput();
  const plan = /** @type {any} */ ({ ...base, nodes: [{ ...base.nodes[0], writeFiles: ["skills/faberun/references/local-env.md"] }] });
  /** @type {any[]} */
  const reviewed = [];
  const { options, logs } = harness({
    reviewRounds: 1,
    plan,
    runStage: async (/** @type {string} */ kind) => {
      reviewed.push(JSON.parse(readFileSync(/** @type {string} */ (options.workingPlanPath), "utf8")));
      return { contract: { id: `${kind}-1` }, output: { findings: [] } };
    },
  });
  const cwd = /** @type {string} */ (options.cwd);
  mkdirSync(join(cwd, "skills/faberun/references"), { recursive: true });
  mkdirSync(join(cwd, "test/docs"), { recursive: true });
  writeFileSync(join(cwd, "skills/faberun/references/contract.md"), "c\n");
  writeFileSync(join(cwd, "skills/faberun/references/operations.md"), "o\n");
  writeFileSync(join(cwd, "test/docs/docs-diet.test.mjs"), "const dir = '../../skills/faberun/references';\nassert.deepEqual(entries, ['contract.md', 'operations.md']);\n");
  writeFileSync(join(cwd, "test/docs/mentions-one.test.mjs"), "const dir = '../../skills/faberun/references';\nread('contract.md');\n");
  options.repoFacts = { verificationCandidates: [], testFiles: [{ path: "test/docs/docs-diet.test.mjs" }, { path: "test/docs/mentions-one.test.mjs" }] };

  const result = await runReviewRounds(/** @type {any} */ (options));

  assert.equal(result.resolved, true);
  assert.deepEqual(reviewed[0].nodes[0].writeFiles, ["skills/faberun/references/local-env.md", "test/docs/docs-diet.test.mjs"], "only the test that lists every entry is declared");
  const logged = /** @type {string[]} */ (logs.find((entry) => entry.stage === "guards-declared")?.declared);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /lists every entry of skills\/faberun\/references\/ by name, and this node creates skills\/faberun\/references\/local-env\.md there/u);
});

test("the bounded round budget stops at the first accepted round and never exceeds its budget", async () => {
  /** @type {number[]} */
  const seen = [];
  const accepted = await runBoundedRounds(3, async (round) => {
    seen.push(round);
    return { accepted: round === 2 };
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.roundsUsed, 2);
  assert.deepEqual(seen, [1, 2], "the round after the accepted one never runs");

  /** @type {number[]} */
  const attempts = [];
  const exhausted = await runBoundedRounds(2, async (round) => {
    attempts.push(round);
    return { accepted: false, round };
  });
  assert.equal(exhausted.accepted, false);
  assert.equal(exhausted.roundsUsed, 2);
  assert.equal(exhausted.history.length, 2);
  assert.deepEqual(attempts, [1, 2], "the hard budget is exactly two calls");

  await assert.rejects(() => runBoundedRounds(0, async () => ({ accepted: true })), /positive integer/u);
});

// R5, campaign-efficiency phase 4: the durable gate a reauthor trigger passes
// before the flow makes a single widening call. `durableQuestion` is
// human-step.mjs's export, but its behaviour is exercised here because this
// file is the behaviour test the packet proves the gate with — the directory
// is the rule, not the file name.

test("an ambiguous requirement refusal becomes a durable question, never a widening round", async () => {
  const trigger = { cause: "ambiguous_requirement", node: "build", artifactVersion: "packet-hash-1" };
  const decision = /** @type {any} */ (reauthorTriggerDecision([], trigger));
  assert.equal(decision.action, "ask");
  assert.deepEqual(decision.question, {
    node: "build",
    artifactVersion: "packet-hash-1",
    question: `Node build refused its packet at packet-hash-1 with cause ambiguous_requirement: the requirement can be read more than one way, and no widening of the packet can answer it. Decide what the requirement means, then resume with --answer build; no reauthor round and no further attempt runs on this packet version until then.`,
  });

  // The ask survives a journal that already carries the same ambiguity: it
  // makes no provider call, so asking again is the same durable question,
  // not an indefinite widening loop.
  const again = /** @type {any} */ (reauthorTriggerDecision([{ ...trigger, outcome: "asked" }], trigger));
  assert.equal(again.action, "ask");

  // Every other cause is the packet's own defect and stays widen-eligible:
  // durableQuestion answers null for it.
  assert.equal(durableQuestion({ cause: "missing_read_scope", node: "build", artifactVersion: "packet-hash-1" }), null);
});

test("the same cause on the same node and packet version never triggers a second reauthor", async () => {
  const trigger = { cause: "missing_read_scope", node: "build", artifactVersion: "packet-hash-1" };
  const journaled = [{ ...trigger, outcome: "rounds_exhausted" }];
  const decision = /** @type {any} */ (reauthorTriggerDecision(journaled, trigger));
  assert.equal(decision.action, "refuse");
  assert.match(decision.reason, /already triggered a reauthor/u);
  assert.match(decision.reason, /does not widen again/u);

  // The refusal is keyed to the whole triple, so a different cause on the
  // same version, the same cause on a widened packet, or the same refusal on
  // another node all still widen.
  assert.deepEqual(reauthorTriggerDecision(journaled, { cause: "missing_write_scope", node: "build", artifactVersion: "packet-hash-1" }), { action: "widen" });
  assert.deepEqual(reauthorTriggerDecision(journaled, { cause: "missing_read_scope", node: "build", artifactVersion: "packet-hash-2" }), { action: "widen" });
  assert.deepEqual(reauthorTriggerDecision(journaled, { cause: "missing_read_scope", node: "elsewhere", artifactVersion: "packet-hash-1" }), { action: "widen" });
});

test("the round cap refuses a further trigger on a packet version, and progress resets the budget", async () => {
  const version = "packet-hash-1";
  const journal = [
    { cause: "missing_read_scope", node: "build", artifactVersion: version, outcome: "rounds_exhausted" },
    { cause: "missing_write_scope", node: "build", artifactVersion: version, outcome: "approval_required" },
  ];
  const decision = /** @type {any} */ (reauthorTriggerDecision(journal, { cause: "unclassified", node: "build", artifactVersion: version }));
  assert.equal(decision.action, "refuse", "the cap counts every outcome: both spent their calls without the packet changing");
  assert.match(decision.reason, new RegExp(`round cap ${REAUTHOR_ROUND_CAP}`, "u"));
  assert.equal(REAUTHOR_ROUND_CAP, journal.length, "the journal above is exactly one trigger past the cap");

  // An applied widening is progress: the widened packet changes the hash, so
  // the records under the old version stop counting and the budget is fresh.
  const progressed = reauthorTriggerDecision([
    { cause: "missing_read_scope", node: "build", artifactVersion: "packet-hash-0", outcome: "applied" },
    { cause: "missing_write_scope", node: "build", artifactVersion: "packet-hash-0", outcome: "applied" },
  ], { cause: "unclassified", node: "build", artifactVersion: "packet-hash-1" });
  assert.deepEqual(progressed, { action: "widen" });

  // The ask is not capped: ambiguity never reaches the count rules, because
  // it never makes a call the cap could bound.
  const capped = /** @type {any} */ (reauthorTriggerDecision(journal, { cause: "ambiguous_requirement", node: "build", artifactVersion: version }));
  assert.equal(capped.action, "ask");
});

test("a trigger with no classified cause is refused before any widening call", async () => {
  const decision = /** @type {any} */ (reauthorTriggerDecision([], { cause: "", node: "build", artifactVersion: "packet-hash-1" }));
  assert.equal(decision.action, "refuse");
  assert.match(decision.reason, /no classified cause/u);
});

