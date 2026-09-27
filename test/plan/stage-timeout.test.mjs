import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanningContract, planningStageTimeoutSec } from "../../src/plan/template.mjs";

test("a planning stage's wall clock follows its runtime's reasoning effort", () => {
  assert.equal(planningStageTimeoutSec({ reasoning: "xhigh" }), 7200);
  assert.equal(planningStageTimeoutSec({ reasoning: "max" }), 7200);
  assert.equal(planningStageTimeoutSec({ reasoning: "high" }), 3600);
  assert.equal(planningStageTimeoutSec({ reasoning: "medium" }), 2400);
  assert.equal(planningStageTimeoutSec(undefined), 2400);
});

test("the draft contract carries the planner's effort-sized wall clock", () => {
  const contract = buildPlanningContract("draft", {
    campaignId: "c1",
    phase: "p1",
    n: 1,
    runtimes: { planner: { harness: "claude", model: "claude-opus-5-5", reasoning: "xhigh" } },
    runtimeDefaults: { worker: "planner" },
    specPath: "spec.md",
    repoFactsPath: "repo-facts.json",
    cataloguePath: "catalogue.json",
    packageMode: "implementation",
  });
  assert.equal(contract.timeoutSec, 7200);
});
