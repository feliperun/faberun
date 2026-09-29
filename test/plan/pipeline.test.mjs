import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryPhaseDeclarations, effectiveVerificationSuites, frozenContractRawOf, writeFrozenPlan } from "../../src/plan/pipeline.mjs";
import { freezePlan } from "../../src/plan/freeze.mjs";
import { fixture } from "../helpers.mjs";

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
