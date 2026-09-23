import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryPhaseDeclarations, writeFrozenPlan } from "../../src/plan/pipeline.mjs";
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
