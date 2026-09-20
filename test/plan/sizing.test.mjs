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

test("contained-write-set merge: a dependsOn from the parent onto the merged child is dropped, not left dangling", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "a",
        dependsOn: ["b"],
        taskPacket: { writeFiles: ["src/m.mjs", "test/m.test.mjs"], verification: [{ argv: ["node", "--test", "test/m.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "ad", text: "implements m", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "b",
        taskPacket: { writeFiles: ["src/m.mjs"], verification: [] },
        definitionOfDone: [{ id: "bd", text: "scaffolds m", proof: { kind: "path", ref: "src/m.mjs" } }],
      },
    ],
  };
  const { plan: sized } = applySizingRules(plan, { nodeBudgetMs: BUDGET, targetedFix: true });
  assert.equal(sized.nodes.length, 1);
  const merged = /** @type {import("../../src/plan/sizing.mjs").PlanNode} */ (sized.nodes.find((node) => node.id === "a"));
  assert.deepEqual(merged.dependsOn ?? [], []);
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

test("a dependsOn cycle is refused by name instead of overflowing the stack", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      {
        id: "cy1",
        dependsOn: ["cy2"],
        taskPacket: { writeFiles: ["src/cy1.mjs"], verification: [{ argv: ["node", "--test", "test/cy1.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "e1", text: "implements cy1", proof: { kind: "command", ref: "0" } }],
      },
      {
        id: "cy2",
        dependsOn: ["cy1"],
        taskPacket: { writeFiles: ["src/cy2.mjs"], verification: [{ argv: ["node", "--test", "test/cy2.test.mjs"], measuredMs: 100 }] },
        definitionOfDone: [{ id: "e2", text: "implements cy2", proof: { kind: "command", ref: "0" } }],
      },
    ],
  };
  assert.throws(
    () => applySizingRules(plan, { nodeBudgetMs: BUDGET }),
    (error) => error instanceof Error && error.message.includes("sizing_dependency_cycle"),
  );
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
      {
        id: "c4",
        taskPacket: { writeFiles: ["src/z.mjs"], verification: [{ argv: ["node", "--test", "test/"], measuredMs: 700_000 }] },
        definitionOfDone: [{ id: "d4", text: "implements z", proof: { kind: "command", ref: "0" } }],
      },
    ],
  };
  const facts = { testFiles: [{ path: "test/x.test.mjs", covers: "src/x.mjs" }] };
  const first = applySizingRules(plan, { nodeBudgetMs: BUDGET, facts });
  const second = applySizingRules(first.plan, { nodeBudgetMs: BUDGET, facts });
  assert.deepEqual(second.transformations, []);
  assert.deepEqual(second.plan, first.plan);
});

/** @param {string} id @param {string[]} writeFiles @param {Record<string, unknown>} [extra] @returns {import("../../src/plan/sizing.mjs").PlanNode} */
function provenNode(id, writeFiles, extra = {}) {
  return {
    id,
    taskKind: "implement",
    riskTier: "standard",
    objective: `Implement ${id}`,
    taskPacket: { readFiles: [`docs/${id}.md`], writeFiles, verification: [{ argv: ["node", "--test", `test/${id}.test.mjs`], measuredMs: 100 }] },
    definitionOfDone: [{ id: `${id}-done`, text: `implements ${id}`, proof: { kind: "command", ref: "0" } }],
    ...extra,
  };
}

test("underfilled-sibling merge: two small nodes in the same directory with no dependency between them become one; a different directory or a dependency keeps them apart", () => {
  const plan = { nodes: [
    provenNode("a", ["src/engine/a.mjs"]),
    provenNode("b", ["src/engine/b.mjs", "test/engine/b.test.mjs"]),
    provenNode("c", ["src/plan/c.mjs"]),
    provenNode("d", ["src/engine/d.mjs"], { dependsOn: ["a"] }),
  ] };
  const { plan: sized, transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET, minWriteFiles: 4 });
  assert.deepEqual(sized.nodes.map((node) => node.id), ["a", "c", "d"], "b folded into a; c is another directory; d depends on a");
  const merged = /** @type {import("../../src/plan/sizing.mjs").PlanNode} */ (sized.nodes.find((node) => node.id === "a"));
  assert.deepEqual(merged.taskPacket.writeFiles, ["src/engine/a.mjs", "src/engine/b.mjs", "test/engine/b.test.mjs"]);
  assert.deepEqual(merged.taskPacket.readFiles, ["docs/a.md", "docs/b.md"], "the merged node may read what either read");
  assert.equal(merged.objective, "Implement a Also: Implement b");
  assert.deepEqual(merged.definitionOfDone?.map((item) => item.id), ["a-done", "b-done"]);
  assert.ok(transformations.some((entry) => entry.rule === "underfilled-sibling-merge" && entry.nodes[0] === "b" && entry.nodes[1] === "a"));
  assert.deepEqual(applySizingRules(plan, { nodeBudgetMs: BUDGET }).plan.nodes.map((node) => node.id), ["a", "b", "c", "d"], "inactive without minWriteFiles");
});

test("underfilled-sibling merge respects the merged ceiling and stays idempotent", () => {
  const plan = { nodes: [
    provenNode("x", ["src/a/1.mjs", "src/a/2.mjs", "src/a/3.mjs"]),
    provenNode("y", ["src/a/4.mjs", "src/a/5.mjs", "src/a/6.mjs"]),
    provenNode("z", ["src/a/7.mjs", "src/a/8.mjs", "src/a/9.mjs"]),
  ] };
  const first = applySizingRules(plan, { nodeBudgetMs: BUDGET, minWriteFiles: 4, turnCeiling: 150 });
  assert.deepEqual(first.plan.nodes.map((node) => `${node.id}:${node.taskPacket.writeFiles?.length}`), ["x:6", "z:3"], "x took y up to the 6-file ceiling; z would push it past and stays");
  const second = applySizingRules(first.plan, { nodeBudgetMs: BUDGET, minWriteFiles: 4, turnCeiling: 150 });
  assert.deepEqual(second.transformations, []);
  assert.deepEqual(second.plan, first.plan);
});

test("over-turn-ceiling: a node expected past the attempt cap is flagged once, never split behind the drafter's back", () => {
  const plan = { nodes: [
    provenNode("big", ["src/a/1.mjs", "src/a/2.mjs", "src/a/3.mjs", "src/a/4.mjs"], { expectedTurns: 200 }),
    provenNode("fine", ["src/b/1.mjs", "src/b/2.mjs", "src/b/3.mjs", "src/b/4.mjs"], { expectedTurns: 60 }),
  ] };
  const first = applySizingRules(plan, { nodeBudgetMs: BUDGET, turnCeiling: 150 });
  assert.equal(first.plan.nodes.length, 2, "flagging never merges or splits");
  assert.equal(first.plan.nodes.find((node) => node.id === "big")?.flaggedOverTurnCeiling, true);
  assert.equal(first.plan.nodes.find((node) => node.id === "fine")?.flaggedOverTurnCeiling, undefined);
  const flagged = first.transformations.filter((entry) => entry.rule === "over-turn-ceiling");
  assert.deepEqual(flagged.map((entry) => entry.nodes), [["big"]]);
  assert.match(flagged[0].detail, /200 provider requests, above the 150-request attempt cap/u);
  assert.deepEqual(applySizingRules(first.plan, { nodeBudgetMs: BUDGET, turnCeiling: 150 }).transformations, [], "a flagged node is not re-flagged");
  assert.deepEqual(first.estimate, { nodes: 2, overheadMinutes: 29 }, "the plan states what its node count costs before any worker turn");
});
