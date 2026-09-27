import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fixture, packet, withFakeCodex, writeContract } from "../helpers.mjs";
import { nodeState } from "../runner-helpers.mjs";
import { parseSpec } from "../../src/plan/spec.mjs";
import { collectHumanSteps, detectHumanStep } from "../../src/plan/human-step.mjs";
import { contentDigest, freezePlan, writeFrozenPlanRecord } from "../../src/plan/freeze.mjs";
import { buildBriefModel } from "../../src/campaign/campaign-brief.mjs";
import { runContract } from "../../src/engine/scheduler.mjs";
import { resumeRun } from "../../src/engine/resume.mjs";

const SPEC_TEXT = `# Human step campaign

## Intent

Ship a feature whose last mile only the operator can complete.

## Requirements

### R16. A plan represents a human step the spec declares

- **statement:** the frozen plan carries the operator's step as an explicit stop.
- **proof:** command: node --test --test-name-pattern="a human step declared in the spec becomes a stop the plan carries"
- **constraints:** the operator runs \`node scripts/publish.mjs\` on the real home and commits the result.

## Non-goals

- Scheduling or conditions on the declared step.
`;

/** @returns {string} */
function outDir() {
  return mkdtempSync(join(tmpdir(), "human-step-"));
}

/** @returns {import("../../src/plan/freeze.mjs").PlanProvenanceInput} */
function provenance() {
  return {
    targetGitHead: null,
    planner: { runtimeId: "luna", model: "gpt-5.6-luna" },
    reviewer: { runtimeId: "sol", model: "gpt-5.6-sol" },
    sizing: [],
    findings: [],
  };
}

/**
 * @param {import("../../src/plan/spec.mjs").SpecRequirement["constraints"]} constraints
 * @returns {import("../../src/plan/spec.mjs").SpecRequirement}
 */
function requirement(constraints) {
  return { id: "R99", title: "unrelated", statement: null, proof: null, measure: null, constraints, line: 1 };
}

test("a requirement's constraints declaring an operator step is detected with its command", () => {
  const parsed = parseSpec(SPEC_TEXT);
  const r16 = parsed.requirements.find((item) => item.id === "R16");
  assert.ok(r16);
  assert.deepEqual(detectHumanStep(/** @type {import("../../src/plan/spec.mjs").SpecRequirement} */ (r16)), {
    requirementId: "R16",
    step: r16?.constraints,
    command: "node scripts/publish.mjs",
  });
});

test("a requirement is not a human step without both the operator keyword and a quoted command", () => {
  assert.equal(detectHumanStep(requirement(null)), null);
  assert.equal(detectHumanStep(requirement("no special actor is named here.")), null);
  assert.equal(detectHumanStep(requirement("the operator must stay alert, but no command is named.")), null);
  assert.equal(detectHumanStep(requirement("run `node scripts/publish.mjs` — no actor named, so a worker could do it.")), null);
});

test("a human step declared in the spec becomes a stop the plan carries", async () => {
  const dir = outDir();
  const parsed = parseSpec(SPEC_TEXT);
  const humanSteps = collectHumanSteps(parsed.requirements);
  assert.equal(humanSteps.length, 1);
  assert.equal(humanSteps[0].requirementId, "R16");
  assert.equal(humanSteps[0].command, "node scripts/publish.mjs");

  const specPath = join(dir, "SPEC.md");
  writeFileSync(specPath, SPEC_TEXT, "utf8");
  const specDigest = contentDigest(SPEC_TEXT);

  const plan = fixture({
    id: "human-step-plan",
    campaignId: "human-step-campaign",
    nodes: [
      { id: "n1", type: "implement", requirementIds: ["R16"], taskPacket: packet(), gate: false },
      { id: "n2", type: "implement", dependsOn: ["n1"], taskPacket: packet({ objective: "After" }), gate: false },
    ],
  });

  const frozen = freezePlan(plan, {
    outDir: dir,
    provenance: provenance(),
    phases: [
      { id: "fixture-phase-0", requirementIds: ["R16"], nodeIds: ["n1"], deliverable: "The feature ships." },
      { id: "fixture-phase-1", requirementIds: ["R17"], nodeIds: ["n2"], deliverable: "What follows it." },
    ],
    spec: { path: specPath, digest: specDigest },
    humanSteps,
  });

  // The frozen plan record itself is the stop: it is on disk, not only held by
  // the caller, so a later reader (a resumed run, the Campaign Brief) sees it
  // without recomputing it from the spec.
  assert.deepEqual(frozen.humanSteps, humanSteps);
  const onDiskPlan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.deepEqual(onDiskPlan.humanSteps, humanSteps);

  // The frozen contract carries the stop as its own node: n1 keeps its
  // provider work, the human node waits for n1, and n2 (which depended on
  // n1) now waits for the human node too.
  const frozenContract = JSON.parse(readFileSync(join(dir, "contract.json"), "utf8"));
  const frozenHuman = frozenContract.nodes.find((/** @type {{humanStep?: unknown}} */ node) => node.humanStep);
  assert.equal(frozenHuman.id, "human-step-r16");
  assert.deepEqual(frozenHuman.dependsOn, ["n1"]);
  assert.deepEqual(frozenHuman.humanStep, { step: humanSteps[0].step, command: humanSteps[0].command });
  const frozenN1 = frozenContract.nodes.find((/** @type {{id: string}} */ node) => node.id === "n1");
  assert.equal(frozenN1.humanStep, undefined);
  assert.deepEqual(frozenN1.taskPacket, packet());
  assert.deepEqual(frozenContract.nodes.find((/** @type {{id: string}} */ node) => node.id === "n2").dependsOn, ["n1", "human-step-r16"]);

  // The Campaign Brief only reads a plan.json its sidecar covers; freezePlan
  // itself leaves the "frozen"/"approved" verdict to the pipeline, so this
  // test writes it the same way runPipeline does before reading it back.
  writeFrozenPlanRecord(dir, /** @type {any} */ ({ ...frozen, status: "frozen", approved: true }));

  const model = buildBriefModel({ campaignId: "human-step-campaign", planPath: join(dir, "plan.json") });
  const listed = model.decisions.human.find((line) => line.includes("R16"));
  assert.ok(listed, `expected a human decision naming R16, got ${JSON.stringify(model.decisions.human)}`);
  assert.match(/** @type {string} */ (listed), /node scripts\/publish\.mjs/u);

  // The runtime half of R16: a fixture provider runs the frozen contract
  // (the human node exactly as the freeze above wrote it) and the human node never
  // reaches it -- the run stops with an attention naming the step and its
  // command while the dependent waits, and `resume --answer` completes the
  // dependent without ever dispatching the human node to a provider.
  const engineDirectory = mkdtempSync(join(tmpdir(), "human-step-engine-"));
  const humanStepDeclaration = { step: humanSteps[0].step, command: humanSteps[0].command };
  const contractPath = writeContract(engineDirectory, fixture({
    id: "human-step-engine-run",
    campaignId: "human-step-engine-campaign",
    pollIntervalMs: 10,
    nodes: [
      { id: "human-step", type: "human", taskPacket: frozenHuman.taskPacket, gate: false, humanStep: frozenHuman.humanStep },
      { id: "downstream", type: "backend", taskPacket: packet({ objective: "Downstream" }), dependsOn: ["human-step"], gate: false },
    ],
  }));
  const firstRun = await withFakeCodex(engineDirectory, "pass", () => runContract(contractPath));
  const humanState = nodeState(firstRun, "human-step");
  assert.equal(humanState.status, "blocked");
  assert.equal(humanState.error?.code, "human_step_pending");
  assert.ok(humanState.error?.message?.includes(humanStepDeclaration.step), humanState.error?.message);
  assert.ok(humanState.error?.message?.includes(humanStepDeclaration.command), humanState.error?.message);
  const downstream = nodeState(firstRun, "downstream");
  assert.notEqual(downstream.status, "done");
  assert.match(downstream.error?.message ?? "", /waiting for human step human-step/u);
  const receipts = readFileSync(join(firstRun.runDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(receipts.some((receipt) => receipt.dedupeKey === `attention:${basename(firstRun.runDir)}:human-step:human_step_pending`), JSON.stringify(receipts));

  const answerPath = join(engineDirectory, "answer.txt");
  writeFileSync(answerPath, "Ran it on the real home and committed.");
  const resumed = await withFakeCodex(engineDirectory, "pass", () => resumeRun(firstRun.runDir, { answer: { node: "human-step", path: answerPath } }));
  assert.equal(nodeState(resumed, "human-step").status, "done");
  assert.equal(nodeState(resumed, "downstream").status, "done");
});

test("a plan with no declared human step carries no humanSteps field", () => {
  const dir = outDir();
  const frozen = freezePlan(fixture({ id: "no-human-step-plan", campaignId: "no-human-step-campaign" }), {
    outDir: dir,
    provenance: provenance(),
    humanSteps: [],
  });
  assert.equal(frozen.humanSteps, undefined);
  const onDiskPlan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  assert.equal("humanSteps" in onDiskPlan, false);
});
