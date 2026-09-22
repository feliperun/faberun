import { test } from "node:test";
import assert from "node:assert/strict";
import { applySizingRules, provenParallelism } from "../../src/plan/sizing.mjs";

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

/**
 * A node nothing depends on, depending on nothing, writing only its own file:
 * the exact shape `markParallelisable` marks.
 *
 * @param {string} id
 * @returns {import("../../src/plan/sizing.mjs").PlanNode}
 */
function independentNode(id) {
  return {
    id,
    taskPacket: { writeFiles: [`src/${id}.mjs`], verification: [{ argv: ["node", "--test", `test/${id}.test.mjs`], measuredMs: 100 }] },
    definitionOfDone: [{ id: `${id}-done`, text: `implements ${id}`, proof: { kind: "command", ref: "0" } }],
  };
}

test("proven parallelism: the marked nodes are the concurrency a plan may declare, floored at 1 and capped", () => {
  const two = applySizingRules({ nodes: [independentNode("m1"), independentNode("m2")] }, { nodeBudgetMs: BUDGET });
  assert.equal(provenParallelism(two.plan), 2);

  // Every node here is marked, and the count is still capped: the ceiling is
  // a judgement about what a host survives, not a measurement, so a wider
  // plan does not license wider concurrency.
  const four = applySizingRules({ nodes: ["w1", "w2", "w3", "w4"].map(independentNode) }, { nodeBudgetMs: BUDGET });
  assert.equal(four.plan.nodes.filter((node) => node.parallel === true).length, 4);
  assert.equal(provenParallelism(four.plan), 2);

  // A chain marks nothing, and a plan sizing proved nothing about is serial.
  const chained = applySizingRules(
    { nodes: [independentNode("c1"), { ...independentNode("c2"), dependsOn: ["c1"] }] },
    { nodeBudgetMs: BUDGET },
  );
  assert.equal(chained.plan.nodes.filter((node) => node.parallel === true).length, 0);
  assert.equal(provenParallelism(chained.plan), 1);
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
  const a = provenNode("a", ["src/engine/a.mjs"], { expectedTurns: 30 });
  a.taskPacket.scopeAcknowledged = ["test/engine/a.test.mjs"];
  const b = provenNode("b", ["src/engine/b.mjs", "test/engine/b.test.mjs"], { expectedTurns: 45 });
  b.taskPacket.scopeAcknowledged = ["test/engine/b.test.mjs", "test/engine/a.test.mjs"];
  const plan = { nodes: [
    a,
    b,
    provenNode("c", ["src/plan/c.mjs"]),
    provenNode("d", ["src/engine/d.mjs"], { dependsOn: ["a"] }),
  ] };
  const { plan: sized, transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET, minWriteFiles: 4 });
  assert.deepEqual(sized.nodes.map((node) => node.id), ["a", "c", "d"], "b folded into a; c is another directory; d depends on a");
  const merged = /** @type {import("../../src/plan/sizing.mjs").PlanNode} */ (sized.nodes.find((node) => node.id === "a"));
  assert.deepEqual(merged.taskPacket.writeFiles, ["src/engine/a.mjs", "src/engine/b.mjs", "test/engine/b.test.mjs"]);
  assert.deepEqual(merged.taskPacket.readFiles, ["docs/a.md", "docs/b.md"], "the merged node may read what either read");
  assert.deepEqual(merged.taskPacket.scopeAcknowledged, ["test/engine/a.test.mjs", "test/engine/b.test.mjs"], "the merged node keeps the importers either node had acknowledged, so it does not fail scope closure for the fold");
  assert.equal(merged.expectedTurns, 75, "the merged node expects both nodes' turns, so the over-cap flag reads two nodes' worth of work");
  assert.equal(sized.nodes.find((node) => node.id === "c")?.taskPacket.scopeAcknowledged, undefined, "a node that was not folded gains no acknowledgement field");
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

// The audit of 2026-09-22 was rejected by `plan` and written by hand as 50 KB
// of JSON instead: its rules aim at implementation nodes, and an audit node
// writes one findings file whatever surface it covers. Sizing by the write
// set either merges audits that have nothing to do with each other or refuses
// the plan. Exploratory work is paid for by what it reads.
/** @param {string} id @param {string[]} readFiles @returns {import("../../src/plan/sizing.mjs").PlanNode} */
function auditNode(id, readFiles) {
  return {
    id,
    taskPacket: { readFiles, writeFiles: [`findings/${id}.md`], verification: [] },
    definitionOfDone: [{ id: `${id}-d`, text: "findings recorded", judgment: true }],
  };
}

test("exploratory mode leaves one-file audit nodes alone where implementation mode merges them away", () => {
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = { nodes: [auditNode("audit-a", ["src/a.mjs"]), auditNode("audit-b", ["src/b.mjs"]), auditNode("audit-c", ["src/c.mjs"])] };

  // Implementation sizing merges all three into one -- none carries a
  // mechanical proof and each writes a single file -- and then refuses the
  // plan for having become a single node. This is the refusal that sent the
  // audit to be written by hand.
  assert.throws(
    () => applySizingRules(structuredClone(plan), { nodeBudgetMs: BUDGET, minWriteFiles: 4 }),
    /sizing_single_node_plan/u,
  );

  const exploratory = applySizingRules(structuredClone(plan), { nodeBudgetMs: BUDGET, minWriteFiles: 4, packageMode: "exploratory" });
  assert.equal(exploratory.plan.nodes.length, 3, "a one-file write set is the normal shape of a finding, not an underfilled node");
  assert.deepEqual(exploratory.plan.nodes.map((node) => node.id), ["audit-a", "audit-b", "audit-c"]);
});

test("exploratory mode reports the node whose read surface dwarfs its siblings'", () => {
  /** @type {Record<string, number>} */
  const lines = { "src/huge.mjs": 3_970, "src/small-a.mjs": 300, "src/small-b.mjs": 400, "src/small-c.mjs": 350 };
  const readVolume = (/** @type {string} */ path) => lines[path] ?? null;
  /** @type {import("../../src/plan/sizing.mjs").Plan} */
  const plan = {
    nodes: [
      auditNode("wide", ["src/huge.mjs"]),
      auditNode("narrow-a", ["src/small-a.mjs"]),
      auditNode("narrow-b", ["src/small-b.mjs"]),
      auditNode("narrow-c", ["src/small-c.mjs"]),
    ],
  };

  const { transformations } = applySizingRules(plan, { nodeBudgetMs: BUDGET, packageMode: "exploratory", readVolume });
  const imbalance = transformations.filter((entry) => entry.rule === "read-volume-imbalance");
  assert.equal(imbalance.length, 1, JSON.stringify(transformations));
  assert.deepEqual(imbalance[0].nodes, ["wide"]);
  assert.match(imbalance[0].detail, /reads 3970 lines against a median of 375/u);

  // Implementation mode asks a different question and stays silent on this one.
  const { transformations: implementation } = applySizingRules(structuredClone(plan), { nodeBudgetMs: BUDGET, readVolume });
  assert.deepEqual(implementation.filter((entry) => entry.rule === "read-volume-imbalance"), []);
});

test("a balanced exploratory package reports no imbalance at all", () => {
  /** @type {Record<string, number>} */
  const lines = { "src/a.mjs": 300, "src/b.mjs": 400, "src/c.mjs": 350 };
  const readVolume = (/** @type {string} */ path) => lines[path] ?? null;
  const { transformations } = applySizingRules(
    { nodes: [auditNode("a", ["src/a.mjs"]), auditNode("b", ["src/b.mjs"]), auditNode("c", ["src/c.mjs"])] },
    { nodeBudgetMs: BUDGET, packageMode: "exploratory", readVolume },
  );
  assert.deepEqual(transformations.filter((entry) => entry.rule === "read-volume-imbalance"), []);
});

test("an unmeasurable read volume is left out rather than counted as zero", () => {
  const { transformations } = applySizingRules(
    { nodes: [auditNode("a", ["src/gone.mjs"]), auditNode("b", ["src/also-gone.mjs"])] },
    { nodeBudgetMs: BUDGET, packageMode: "exploratory", readVolume: () => null },
  );
  assert.deepEqual(transformations.filter((entry) => entry.rule === "read-volume-imbalance"), []);
});
