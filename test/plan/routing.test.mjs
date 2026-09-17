import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimes } from "../../src/plan/routing.mjs";

const AVAILABLE = { available: true, exhaustedUntil: null, reason: "ready" };
const EXHAUSTED = { available: false, exhaustedUntil: "2999-01-01T00:00:00.000Z", reason: "quota" };

const RUNTIMES = {
  "dsh-deepseek": { harness: "dsh", model: "deepseek-flash", vendor: "deepseek", tier: 1, costRank: 1 },
  "zcode-glm": { harness: "zcode", model: "glm-5.3", vendor: "zhipu", tier: 1, costRank: 1 },
  "codex-gpt": { harness: "codex", model: "gpt-5.6", vendor: "openai", tier: 2, costRank: 2, fallback: "dsh-deepseek" },
  "claude-sonnet": { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic", tier: 2, costRank: 2 },
};

test("table resolves from taskKind and riskTier", () => {
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [
    { when: { taskKind: "build", riskTier: "high" }, prefer: ["claude-sonnet"], role: "worker" },
    { when: { taskKind: "build", riskTier: "high" }, prefer: ["codex-gpt"], role: "judge" },
  ];
  const nodes = [{ id: "n1", taskKind: "build", riskTier: "high" }];
  const availability = { "claude-sonnet": AVAILABLE, "codex-gpt": AVAILABLE };
  const { assignments, unmet } = resolveRuntimes(nodes, { table, runtimes: RUNTIMES, availability });
  assert.deepEqual(unmet, []);
  assert.equal(assignments.n1.worker, "claude-sonnet");
  assert.equal(assignments.n1.judge, "codex-gpt");
  assert.equal(assignments.n1.rule.worker, "table:worker:build:high");
});

test("operator runtimeDefaults win over the table", () => {
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [
    { when: { taskKind: "build" }, prefer: ["claude-sonnet"], role: "worker" },
    { when: { taskKind: "build" }, prefer: ["codex-gpt"], role: "judge" },
  ];
  const nodes = [{ id: "n1", taskKind: "build" }];
  const availability = { "claude-sonnet": AVAILABLE, "codex-gpt": AVAILABLE, "dsh-deepseek": AVAILABLE };
  const { assignments } = resolveRuntimes(nodes, {
    table,
    runtimes: RUNTIMES,
    availability,
    runtimeDefaults: { worker: "dsh-deepseek" },
  });
  assert.equal(assignments.n1.worker, "dsh-deepseek");
  assert.equal(assignments.n1.rule.worker, "runtimeDefaults");
  // judge still resolves from the table since no runtimeDefaults.judge was given
  assert.equal(assignments.n1.judge, "codex-gpt");
});

test("an explicit node override wins over both runtimeDefaults and the table", () => {
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [{ when: { taskKind: "build" }, prefer: ["claude-sonnet"], role: "worker" }];
  const nodes = [{ id: "n1", taskKind: "build" }];
  const availability = { "claude-sonnet": AVAILABLE, "zcode-glm": AVAILABLE };
  const { assignments } = resolveRuntimes(nodes, {
    table,
    runtimes: RUNTIMES,
    availability,
    runtimeDefaults: { worker: "claude-sonnet" },
    overrides: { n1: { worker: "zcode-glm" } },
  });
  assert.equal(assignments.n1.worker, "zcode-glm");
  assert.equal(assignments.n1.rule.worker, "override");
});

test("an exhausted runtime is skipped without error", () => {
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [
    { when: { taskKind: "build" }, prefer: ["dsh-deepseek", "zcode-glm"], role: "worker" },
    { when: { taskKind: "build" }, prefer: ["claude-sonnet"], role: "judge" },
  ];
  const nodes = [{ id: "n1", taskKind: "build" }];
  const availability = { "dsh-deepseek": EXHAUSTED, "zcode-glm": AVAILABLE, "claude-sonnet": AVAILABLE };
  const { assignments, unmet } = resolveRuntimes(nodes, { table, runtimes: RUNTIMES, availability });
  assert.equal(assignments.n1.worker, "zcode-glm");
  assert.equal(unmet.length, 0);
});

test("the judge never shares a vendor with the worker or its fallback chain", () => {
  // codex-gpt (openai) falls back to dsh-deepseek (deepseek); a judge row
  // that prefers both of those vendors before zcode (zhipu) must skip them.
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [
    { when: { taskKind: "build" }, prefer: ["codex-gpt"], role: "worker" },
    { when: { taskKind: "build" }, prefer: ["dsh-deepseek", "zcode-glm"], role: "judge" },
  ];
  const nodes = [{ id: "n1", taskKind: "build" }];
  const availability = { "codex-gpt": AVAILABLE, "dsh-deepseek": AVAILABLE, "zcode-glm": AVAILABLE };
  const { assignments, unmet } = resolveRuntimes(nodes, { table, runtimes: RUNTIMES, availability });
  assert.equal(assignments.n1.worker, "codex-gpt");
  assert.equal(assignments.n1.judge, "zcode-glm");
  assert.deepEqual(unmet, []);
});

test("an unmet rule throws naming the rule and the node", () => {
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [{ name: "high-risk-worker", when: { taskKind: "build", riskTier: "high" }, prefer: ["claude-sonnet"], role: "worker" }];
  const nodes = [{ id: "n1", taskKind: "build", riskTier: "high" }];
  const availability = { "claude-sonnet": EXHAUSTED };
  assert.throws(
    () => resolveRuntimes(nodes, { table, runtimes: RUNTIMES, availability }),
    (error) => error instanceof Error
      && error.message.includes("n1")
      && error.message.includes("high-risk-worker"),
  );
});

test("options.partial returns unmet entries instead of throwing", () => {
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [
    { name: "high-risk-worker", when: { taskKind: "build" }, prefer: ["claude-sonnet"], role: "worker" },
    { when: { taskKind: "build" }, prefer: ["dsh-deepseek"], role: "judge" },
  ];
  const nodes = [{ id: "n1", taskKind: "build" }];
  const availability = { "claude-sonnet": EXHAUSTED, "dsh-deepseek": AVAILABLE };
  const { assignments, unmet } = resolveRuntimes(nodes, { table, runtimes: RUNTIMES, availability }, { partial: true });
  assert.equal(assignments.n1.worker, null);
  assert.deepEqual(unmet, [{ nodeId: "n1", role: "worker", rule: "high-risk-worker" }]);
});

test("discovery resolves worker and judge when no table row matches", () => {
  const nodes = [{ id: "n1", taskKind: "unclassified" }];
  const availability = {
    "dsh-deepseek": AVAILABLE,
    "zcode-glm": AVAILABLE,
    "codex-gpt": AVAILABLE,
    "claude-sonnet": AVAILABLE,
  };
  const { assignments, unmet } = resolveRuntimes(nodes, { table: [], runtimes: RUNTIMES, availability });
  assert.deepEqual(unmet, []);
  // cheapest available (tier 1, lowest costRank, declaration order): dsh-deepseek
  assert.equal(assignments.n1.worker, "dsh-deepseek");
  assert.equal(assignments.n1.rule.worker, "discovery");
  // strongest available excluding deepseek vendor: tier 2 codex-gpt (declared before claude-sonnet)
  assert.equal(assignments.n1.judge, "codex-gpt");
  assert.equal(assignments.n1.rule.judge, "discovery");
});
