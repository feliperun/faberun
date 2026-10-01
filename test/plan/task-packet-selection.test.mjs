import "../scoped-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWorkerPrompt } from "../../src/contract/task-packet.mjs";
import { applySizingRules } from "../../src/plan/sizing.mjs";
import { FACT_SELECTION_RULE, buildPlanningContract } from "../../src/plan/template.mjs";

/**
 * The task-packet selection regression (R4, campaign-efficiency phase 4): a
 * worker packet's readFiles are the packet's declared selection from the
 * phase fact set, sizing refuses a selection that leaves the set — by name,
 * so a revise can repair it in-round — and a packet without room for its
 * mandatory content is refused by name instead of truncated to fit. It lives
 * apart from test/plan/template.test.mjs so that file stays under the
 * 800-line ceiling.
 */

const BUDGET = 600_000;

/** @returns {Record<string, unknown>} the inputs every planning kind builds from */
function baseInputs() {
  return {
    campaignId: "demo-campaign",
    phase: "demo-phase",
    n: 1,
    runtimes: {},
    runtimeDefaults: {},
    specPath: "docs/spec.md",
    repoFactsPath: ".runs/repo-facts.json",
    cataloguePath: ".runs/task-kinds.md",
    planPath: ".runs/plan.json",
    findingsPath: ".runs/findings.json",
    notesPath: "docs/notes.md",
  };
}

/**
 * A node that survives every merge rule untouched: it carries a mechanical
 * proof and a write set disjoint from every sibling's.
 *
 * @param {string} id
 * @param {string[]} readFiles
 * @returns {import("../../src/plan/sizing.mjs").PlanNode}
 */
function carryingNode(id, readFiles) {
  return {
    id,
    taskPacket: {
      readFiles,
      writeFiles: [`src/${id}.mjs`],
      verification: [{ argv: ["node", "--test", `test/${id}.test.mjs`], measuredMs: 100 }],
    },
    definitionOfDone: [{ id: `${id}-done`, text: `implements ${id}`, proof: { kind: "command", ref: "0" } }],
  };
}

test("draft and revise are told to select each node's readFiles from the phase fact set", () => {
  for (const kind of /** @type {const} */ (["draft", "revise"])) {
    const instructions = /** @type {any} */ (buildPlanningContract(kind, /** @type {any} */ (baseInputs()))).nodes[0].taskPacket.instructions;
    assert.ok(instructions.includes(FACT_SELECTION_RULE), `${kind} carries the fact-selection rule`);
  }
  assert.match(FACT_SELECTION_RULE, /selection from the phase fact set/);
  assert.match(FACT_SELECTION_RULE, /sizing_read_outside_fact_set/u, "the author is told the refusal the rule carries");

  // The reviewer grades the plan against the rules; it does not author the
  // selection, so the rule stays out of its packet.
  const review = /** @type {any} */ (buildPlanningContract("review", /** @type {any} */ (baseInputs()))).nodes[0].taskPacket.instructions;
  assert.ok(!review.includes(FACT_SELECTION_RULE));
});

test("sizing refuses a worker packet whose declared readFiles leave the phase fact set, naming node and path", () => {
  const plan = { nodes: [carryingNode("build", ["src/build.mjs", "src/ghost.mjs"]), carryingNode("docs", ["docs/notes.md"])] };
  const facts = { paths: ["src/build.mjs", "docs/notes.md", "docs/spec.md"], testFiles: [] };
  assert.throws(
    () => applySizingRules(plan, { nodeBudgetMs: BUDGET, facts }),
    /sizing_read_outside_fact_set: node build declares readFiles entry src\/ghost\.mjs, which the phase fact set does not hold/u,
  );
});

test("a selection drawn from the fact set sizes through untouched", () => {
  const plan = { nodes: [carryingNode("build", ["src/build.mjs"]), carryingNode("docs", ["docs/notes.md"])] };
  const facts = { paths: ["src/build.mjs", "docs/notes.md"], testFiles: [] };
  const { plan: sized } = applySizingRules(plan, { nodeBudgetMs: BUDGET, facts });
  assert.equal(sized.nodes.length, 2);
});

test("a merged packet inherits the union of readFiles and the fact-set check sees the whole union", () => {
  // The child has no mechanical proof and names the parent as its dependency,
  // so the no-mechanical-proof rule folds it in before the selection runs:
  // the outside read must be caught on the folded packet, not slipped through
  // on the node that declared it.
  const child = carryingNode("child", ["src/ghost.mjs"]);
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      carryingNode("parent", ["src/parent.mjs"]),
      {
        ...child,
        dependsOn: ["parent"],
        definitionOfDone: [{ id: "child-done", text: "notes on the parent", judgment: true }],
        taskPacket: { ...child.taskPacket, verification: [] },
      },
    ],
  };
  const facts = { paths: ["src/parent.mjs"], testFiles: [] };
  assert.throws(
    () => applySizingRules(plan, { nodeBudgetMs: BUDGET, facts }),
    /sizing_read_outside_fact_set: node parent declares readFiles entry src\/ghost\.mjs/u,
  );
});

test("a caller that hands no fact set validates no selection: there is nothing to have selected from", () => {
  // Hand-built test fixtures carry no `paths`; `collectRepoFacts` always
  // produces it, so every plan that freezes was checked.
  const plan = { nodes: [carryingNode("build", ["src/ghost.mjs"]), carryingNode("docs", ["docs/notes.md"])] };
  const { plan: sized } = applySizingRules(plan, { nodeBudgetMs: BUDGET, facts: { testFiles: [] } });
  assert.equal(sized.nodes.length, 2);
});

/** @param {"execution"|"discovery"|"autonomous"} mode @returns {Record<string, unknown>} a packet whose instructions alone exceed the budget */
function oversizedPacket(mode) {
  const base = {
    mode,
    objective: "Implement it",
    instructions: [`Read and weigh: ${"x".repeat(70 * 1024)}`],
    readFiles: /** @type {string[]} */ ([]),
    symbols: [],
    decisions: [],
    nonGoals: [],
    verification: [],
  };
  if (mode === "discovery") return base;
  if (mode === "autonomous") return { ...base, writeRoots: ["src"] };
  return { ...base, readFiles: ["README.md"], writeFiles: ["README.md"] };
}

test("a packet without room for its mandatory content is refused by name, in every mode, never truncated", () => {
  for (const mode of /** @type {const} */ (["execution", "discovery", "autonomous"])) {
    assert.throws(
      () => renderWorkerPrompt(/** @type {any} */ (oversizedPacket(mode)), "build"),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /worker_prompt_over_budget: node build \(/u, "the error names the node and the mode");
        assert.match(error.message, new RegExp(`\\(${mode}\\)`), "the error names this mode");
        assert.match(error.message, /is \d+ bytes over the 65536-byte budget at \d+ total/u, "the error sizes the overage");
        assert.match(error.message, /the worker prompt exceeds 65536 bytes/u, "the wording earlier packets were written against stays");
        assert.match(error.message, /never truncated to fit/u);
        return true;
      },
      `${mode} refuses over budget by name`,
    );
  }
});

test("a packet that fits the budget still renders, read files listed", () => {
  const packet = { ...oversizedPacket("execution"), instructions: ["Do the work"], readFiles: ["README.md", "docs/spec.md"], writeFiles: ["README.md"] };
  const prompt = renderWorkerPrompt(/** @type {any} */ (packet), "build");
  assert.match(prompt, /## Read files\n- README\.md\n- docs\/spec\.md/u);
});
