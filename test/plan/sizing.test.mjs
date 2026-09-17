import { test } from "node:test";
import assert from "node:assert/strict";
import { applySizingRules } from "../../src/plan/sizing.mjs";

const BUDGET = 600_000;

test("no-mechanical-proof merge: a node whose Definition of Done has no proof merges into its dependency", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "c1",
        taskPacket: { writeFiles: ["src/x.mjs"], verification: [{ argv: ["node", "--test", "test/x.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "d1", text: "implements x", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "c2",
        dependsOn: ["c1"],
        taskPacket: { writeFiles: ["docs/notes.md"], verification: [] },
        definitionOfDone: [{ id: "d2", text: "a note about x", judgment: true }],
      },
      {
        id: "c3",
        taskPacket: { writeFiles: ["src/y.mjs"], verification: [{ argv: ["node", "--test", "test/y.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "d3", text: "implements y", proof: { kind: "path", ref: "src/y.mjs" } }],
      },
    ],
  };
  const { plan: sized, transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET });
  assert.equal(sized.nodes.length, 2);
  assert.equal(sized.nodes.find((node) => node.id === "c2"), undefined);
  const merged = /** @type {import("../../src/plan/sizing.mjs").PlanNode} */ (sized.nodes.find((node) => node.id === "c1"));
  assert.deepEqual(merged.taskPacket.writeFiles?.sort(), ["docs/notes.md", "src/x.mjs"]);
  assert.deepEqual(merged.definitionOfDone?.map((item) => item.id).sort(), ["d1", "d2"]);
  assert.ok(transformations.some((entry) => entry.rule === "no-mechanical-proof-merge" && entry.nodes[0] === "c2" && entry.nodes[1] === "c1"));
});

test("contained-write-set merge: a node with no verification whose writeFiles sits inside another's merges into it", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "p",
        taskPacket: { writeFiles: ["src/mod.mjs", "test/mod.test.mjs"], verification: [{ argv: ["node", "--test", "test/mod.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "pd", text: "implements mod", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "q",
        taskPacket: { writeFiles: ["src/mod.mjs"], verification: [] },
        definitionOfDone: [{ id: "qd", text: "part of mod", proof: { kind: "path", ref: "src/mod.mjs" } }],
      },
      {
        id: "r",
        taskPacket: { writeFiles: ["src/other.mjs"], verification: [{ argv: ["node", "--test", "test/other.test.mjs"], measuredMs: 50 }] },
        definitionOfDone: [{ id: "rd", text: "implements other", proof: { kind: "command", ref: "0" } }],
      },
    ],
  };
  const { plan: sized, transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET });
  assert.equal(sized.nodes.length, 2);
  assert.equal(sized.nodes.find((node) => node.id === "q"), undefined);
  const merged = /** @type {import("../../src/plan/sizing.mjs").PlanNode} */ (sized.nodes.find((node) => node.id === "p"));
  assert.deepEqual(merged.definitionOfDone?.map((item) => item.id).sort(), ["pd", "qd"]);
  assert.ok(transformations.some((entry) => entry.rule === "contained-write-set-merge" && entry.nodes[0] === "q" && entry.nodes[1] === "p"));
});

test("over-budget verification split: a command past the node budget is replaced by covering test files from repo facts", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "big",
        taskPacket: { writeFiles: ["src/big.mjs"], verification: [{ argv: ["node", "--test", "test/"], measuredMs: 700_000 }] },
        definitionOfDone: [{ id: "bd", text: "implements big", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "other",
        taskPacket: { writeFiles: ["src/other.mjs"], verification: [{ argv: ["node", "--test", "test/other.test.mjs"], measuredMs: 1_000 }] },
        definitionOfDone: [{ id: "od", text: "implements other", proof: { kind: "command", ref: "0" } }],
      },
    ],
  };
  const facts = { testFiles: [{ path: "test/big.test.mjs", covers: "src/big.mjs" }, { path: "test/unrelated.test.mjs", covers: "src/unrelated.mjs" }] };
  const { plan: sized, transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET, facts });
  const big = /** @type {import("../../src/plan/sizing.mjs").PlanNode} */ (sized.nodes.find((node) => node.id === "big"));
  assert.deepEqual(big.taskPacket.verification, [{ argv: ["node", "--test", "test/big.test.mjs"] }]);
  assert.ok(transformations.some((entry) => entry.rule === "over-budget-verification-split" && entry.nodes[0] === "big"));
});

test("over-budget verification flagged: a command with no covering test file is flagged in place", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "big",
        taskPacket: { writeFiles: ["src/big.mjs"], verification: [{ argv: ["node", "--test", "test/"], measuredMs: 700_000 }] },
        definitionOfDone: [{ id: "bd", text: "implements big", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "other",
        taskPacket: { writeFiles: ["src/other.mjs"], verification: [{ argv: ["node", "--test", "test/other.test.mjs"], measuredMs: 1_000 }] },
        definitionOfDone: [{ id: "od", text: "implements other", proof: { kind: "command", ref: "0" } }],
      },
    ],
  };
  const { plan: sized, transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET });
  const big = /** @type {import("../../src/plan/sizing.mjs").PlanNode} */ (sized.nodes.find((node) => node.id === "big"));
  assert.equal(big.taskPacket.verification[0].flaggedOverBudget, true);
  assert.ok(transformations.some((entry) => entry.rule === "over-budget-verification-flagged" && entry.nodes[0] === "big"));
});

test("parallelisable marking: dependency-free nodes with disjoint writeFiles are marked parallel", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "m1",
        taskPacket: { writeFiles: ["src/m1.mjs"], verification: [{ argv: ["node", "--test", "test/m1.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "x1", text: "implements m1", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "m2",
        taskPacket: { writeFiles: ["src/m2.mjs"], verification: [{ argv: ["node", "--test", "test/m2.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "x2", text: "implements m2", proof: { kind: "command", ref: "0" } }],
      },
    ],
  };
  const { plan: sized, transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET });
  assert.equal(sized.nodes.find((node) => node.id === "m1")?.parallel, true);
  assert.equal(sized.nodes.find((node) => node.id === "m2")?.parallel, true);
  assert.equal(transformations.filter((entry) => entry.rule === "parallelisable").length, 2);
});

test("single-node refusal unless targetedFix", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "solo",
        taskPacket: { writeFiles: ["src/solo.mjs"], verification: [{ argv: ["node", "--test", "test/solo.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "sd", text: "implements solo", proof: { kind: "command", ref: "0" } }],
      },
    ],
  };
  assert.throws(
    () => applySizingRules(plan, { nodeBudgetMs: BUDGET }),
    (error) => error instanceof Error && error.message.includes("solo"),
  );
  const { plan: sized } = applySizingRules(plan, { nodeBudgetMs: BUDGET, targetedFix: true });
  assert.equal(sized.nodes.length, 1);
});

test("a dependency chain deeper than 8 requires plan.justification", () => {
  /** @type {import("../../src/plan/sizing.mjs").PlanNode[]} */
  const nodes = [];
  for (let index = 1; index <= 9; index += 1) {
    nodes.push({
      id: `n${index}`,
      ...(index === 1 ? {} : { dependsOn: [`n${index - 1}`] }),
      taskPacket: { writeFiles: [`src/n${index}.mjs`], verification: [] },
      definitionOfDone: [{ id: `d${index}`, text: `implements n${index}`, proof: { kind: "path", ref: `src/n${index}.mjs` } }],
    });
  }
  assert.throws(
    () => applySizingRules({ nodes }, { nodeBudgetMs: BUDGET }),
    (error) => error instanceof Error && error.message.includes("9"),
  );
  const { plan: sized } = applySizingRules({ nodes, justification: "a nine-node migration with no safe earlier cut point" }, { nodeBudgetMs: BUDGET });
  assert.equal(sized.nodes.length, 9);
});

test("sizing records rule provenance: every transformation names the rule that caused it", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "c1",
        taskPacket: { writeFiles: ["src/x.mjs"], verification: [{ argv: ["node", "--test", "test/x.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "d1", text: "implements x", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "c2",
        dependsOn: ["c1"],
        taskPacket: { writeFiles: ["docs/notes.md"], verification: [] },
        definitionOfDone: [{ id: "d2", text: "a note about x", judgment: true }],
      },
    ],
  };
  const { transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET, targetedFix: true });
  assert.ok(transformations.length > 0);
  for (const entry of transformations) {
    assert.equal(typeof entry.rule, "string");
    assert.ok(Array.isArray(entry.nodes) && entry.nodes.length > 0);
    assert.equal(typeof entry.detail, "string");
  }
});

test("sizing is idempotent: applying it to its own output yields the same plan and no transformations", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "c1",
        taskPacket: { writeFiles: ["src/x.mjs"], verification: [{ argv: ["node", "--test", "test/"], measuredMs: 700_000 }] },
        definitionOfDone: [{ id: "d1", text: "implements x", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "c2",
        dependsOn: ["c1"],
        taskPacket: { writeFiles: ["docs/notes.md"], verification: [] },
        definitionOfDone: [{ id: "d2", text: "a note about x", judgment: true }],
      },
      {
        id: "c3",
        taskPacket: { writeFiles: ["src/y.mjs"], verification: [{ argv: ["node", "--test", "test/y.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "d3", text: "implements y", proof: { kind: "path", ref: "src/y.mjs" } }],
      },
    ],
  };
  const facts = { testFiles: [{ path: "test/x.test.mjs", covers: "src/x.mjs" }] };
  const first = applySizingRules(plan, { nodeBudgetMs: BUDGET, facts });
  const second = applySizingRules(first.plan, { nodeBudgetMs: BUDGET, facts });
  assert.deepEqual(second.transformations, []);
  assert.deepEqual(second.plan, first.plan);
});
