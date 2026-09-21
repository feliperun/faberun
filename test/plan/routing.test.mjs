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

test("runtime observability catalogue", () => {
  // The catalogue records only what a harness de facto reports: when each
  // datum was observed, and what it exposes. An observation older than its
  // own window reads as unknown -- it must not look rested, so the row yields
  // to the next candidate instead of failing.
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [{ when: { taskKind: "build" }, prefer: ["claude-sonnet", "zcode-glm"], role: "worker" }];
  const nodes = [{ id: "n1", taskKind: "build" }];
  const observed = {
    available: true,
    exhaustedUntil: null,
    reason: "ready",
    observedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
    window: "seven_day",
    remaining: 0.77,
  };
  const { assignments, unmet } = resolveRuntimes(nodes, {
    table,
    runtimes: RUNTIMES,
    availability: { "claude-sonnet": observed, "zcode-glm": AVAILABLE, "codex-gpt": AVAILABLE },
  });
  assert.equal(assignments.n1.worker, "zcode-glm");
  assert.deepEqual(unmet, []);

  // The same window observed inside its span is admitted as reported.
  const fresh = resolveRuntimes(nodes, {
    table,
    runtimes: RUNTIMES,
    availability: { "claude-sonnet": { ...observed, observedAt: new Date().toISOString() }, "zcode-glm": AVAILABLE, "codex-gpt": AVAILABLE },
  });
  assert.equal(fresh.assignments.n1.worker, "claude-sonnet");

  // A window the catalogue cannot span cannot prove staleness.
  const unlabeled = resolveRuntimes(nodes, {
    table,
    runtimes: RUNTIMES,
    availability: { "claude-sonnet": { ...observed, window: "fortnight" }, "zcode-glm": EXHAUSTED, "codex-gpt": AVAILABLE },
  });
  assert.equal(unlabeled.assignments.n1.worker, "claude-sonnet");

  // Absent data reads as null and is decided on exactly like an exposed
  // value: recording is not deciding, so remaining 0 -- a genuinely spent
  // window -- and remaining null -- nothing was exposed -- are both admitted
  // here, and neither is ever fabricated from the other.
  for (const remaining of [0, null]) {
    const decided = resolveRuntimes(nodes, {
      table,
      runtimes: RUNTIMES,
      availability: { "claude-sonnet": { available: true, exhaustedUntil: null, reason: "ready", remaining }, "zcode-glm": EXHAUSTED, "codex-gpt": AVAILABLE },
    }, { partial: true });
    assert.equal(decided.assignments.n1.worker, "claude-sonnet");
    assert.deepEqual(decided.unmet, []);
  }
});

test("routing strategy declared per rule is applied and recorded with its reason", () => {
  const nodes = [{ id: "n1", taskKind: "build" }];
  const availability = {
    "dsh-deepseek": AVAILABLE,
    "zcode-glm": AVAILABLE,
    "codex-gpt": AVAILABLE,
    "claude-sonnet": AVAILABLE,
  };

  // cost: the lowest costRank wins, wherever it sits in the prefer list.
  const cost = resolveRuntimes(nodes, {
    table: [{ when: { taskKind: "build" }, prefer: ["claude-sonnet", "dsh-deepseek"], role: "worker", strategy: "cost" }],
    runtimes: RUNTIMES,
    availability,
  });
  assert.equal(cost.assignments.n1.worker, "dsh-deepseek");
  assert.equal(cost.assignments.n1.strategy.worker, "cost");
  assert.equal(cost.assignments.n1.reason.worker, "cost: lowest costRank 1 among ranked candidates");

  // reset-proximity: the least observed remaining allowance wins -- the
  // window nearest its reset is spent first.
  const proximity = resolveRuntimes(nodes, {
    table: [{ when: { taskKind: "build" }, prefer: ["claude-sonnet", "zcode-glm"], role: "worker", strategy: "reset-proximity" }],
    runtimes: RUNTIMES,
    availability: {
      "claude-sonnet": { ...AVAILABLE, remaining: 0.77 },
      "zcode-glm": { ...AVAILABLE, remaining: 0.1 },
    },
  });
  assert.equal(proximity.assignments.n1.worker, "zcode-glm");
  assert.equal(proximity.assignments.n1.strategy.worker, "reset-proximity");
  assert.equal(proximity.assignments.n1.reason.worker, "reset-proximity: least remaining allowance (0.1)");

  // Inert, not failed: no candidate exposes the datum the strategy needs, so
  // the strategy stands aside and the prefer order decides -- recorded as
  // exactly that, never an error.
  const inert = resolveRuntimes(nodes, {
    table: [{ when: { taskKind: "build" }, prefer: ["zcode-glm", "dsh-deepseek"], role: "worker", strategy: "reset-proximity" }],
    runtimes: RUNTIMES,
    availability,
  });
  assert.equal(inert.assignments.n1.worker, "zcode-glm");
  assert.equal(inert.assignments.n1.reason.worker, "reset-proximity inert: no admissible candidate exposes remaining; prefer order decided");

  // attempt-affinity: the previous attempt's runtime for the same node is
  // preferred while it admits.
  const affinity = resolveRuntimes(nodes, {
    table: [{ when: { taskKind: "build" }, prefer: ["dsh-deepseek", "zcode-glm"], role: "worker", strategy: "attempt-affinity" }],
    runtimes: RUNTIMES,
    availability,
  }, { previous: { n1: { worker: "zcode-glm" } } });
  assert.equal(affinity.assignments.n1.worker, "zcode-glm");
  assert.equal(affinity.assignments.n1.reason.worker, "attempt-affinity: previous attempt's runtime zcode-glm still admissible");

  // Affinity is the weakest signal: it yields by name when the previous
  // runtime is exhausted...
  const yielded = resolveRuntimes(nodes, {
    table: [{ when: { taskKind: "build" }, prefer: ["dsh-deepseek", "zcode-glm"], role: "worker", strategy: "attempt-affinity" }],
    runtimes: RUNTIMES,
    availability: { "dsh-deepseek": AVAILABLE, "zcode-glm": EXHAUSTED, "codex-gpt": AVAILABLE },
  }, { previous: { n1: { worker: "zcode-glm" } } });
  assert.equal(yielded.assignments.n1.worker, "dsh-deepseek");
  assert.equal(yielded.assignments.n1.reason.worker, "attempt-affinity yielded: zcode-glm is unavailable; prefer order decided");

  // ...and when it would violate the judge's vendor distinction.
  const vendorYield = resolveRuntimes(nodes, {
    table: [
      { when: { taskKind: "build" }, prefer: ["codex-gpt"], role: "worker" },
      { when: { taskKind: "build" }, prefer: ["codex-gpt", "zcode-glm"], role: "judge", strategy: "attempt-affinity" },
    ],
    runtimes: RUNTIMES,
    availability,
  }, { previous: { n1: { judge: "codex-gpt" } } });
  assert.equal(vendorYield.assignments.n1.judge, "zcode-glm");
  assert.equal(vendorYield.assignments.n1.reason.judge, "attempt-affinity yielded: codex-gpt carries forbidden vendor openai; prefer order decided");

  // No previous attempt recorded: the strategy is inert, not a failure.
  const affinityInert = resolveRuntimes(nodes, {
    table: [{ when: { taskKind: "build" }, prefer: ["dsh-deepseek"], role: "worker", strategy: "attempt-affinity" }],
    runtimes: RUNTIMES,
    availability,
  });
  assert.equal(affinityInert.assignments.n1.worker, "dsh-deepseek");
  assert.equal(affinityInert.assignments.n1.reason.worker, "attempt-affinity inert: no previous attempt recorded; prefer order decided");

  // A rule naming no strategy stays priority, and the record says so.
  const priority = resolveRuntimes(nodes, {
    table: [{ when: { taskKind: "build" }, prefer: ["zcode-glm", "dsh-deepseek"], role: "worker" }],
    runtimes: RUNTIMES,
    availability,
  });
  assert.equal(priority.assignments.n1.worker, "zcode-glm");
  assert.equal(priority.assignments.n1.strategy.worker, "priority");
  assert.equal(priority.assignments.n1.reason.worker, "priority: first admissible of the prefer list");

  // A strategy name outside the vocabulary is a rejected rule, not an inert
  // one: it is an authored-table defect, not an unobservable datum.
  assert.throws(
    () => resolveRuntimes(nodes, {
      table: [{ when: { taskKind: "build" }, prefer: ["zcode-glm"], role: "worker", strategy: /** @type {any} */ ("cheapest") }],
      runtimes: RUNTIMES,
      availability,
    }),
    /names unknown strategy cheapest/u,
  );
});

test("operator override wins over the table and every strategy", () => {
  const nodes = [{ id: "n1", taskKind: "build" }];
  const availability = {
    "dsh-deepseek": AVAILABLE,
    "zcode-glm": AVAILABLE,
    "codex-gpt": AVAILABLE,
    "claude-sonnet": AVAILABLE,
  };
  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [
    { when: { taskKind: "build" }, prefer: ["claude-sonnet"], role: "worker", strategy: "cost" },
    { when: { taskKind: "build" }, prefer: ["codex-gpt"], role: "judge", strategy: "attempt-affinity" },
  ];

  // The node's override beats the table row and the strategy it names; the
  // record says `declared`, because no strategy chose this runtime. Roles the
  // override does not name are still routed -- by strategy, if one applies.
  const override = resolveRuntimes(nodes, {
    table,
    runtimes: RUNTIMES,
    availability,
    overrides: { n1: { worker: "zcode-glm" } },
  }, { previous: { n1: { judge: "dsh-deepseek" } } });
  assert.equal(override.assignments.n1.worker, "zcode-glm");
  assert.equal(override.assignments.n1.strategy.worker, "declared");
  assert.equal(override.assignments.n1.reason.worker, "operator override on node n1");
  assert.equal(override.assignments.n1.judge, "dsh-deepseek");
  assert.equal(override.assignments.n1.strategy.judge, "attempt-affinity");

  // runtimeDefaults outrank the table the same way, for every role.
  const defaults = resolveRuntimes(nodes, {
    table,
    runtimes: RUNTIMES,
    availability,
    runtimeDefaults: { worker: "dsh-deepseek", judge: "claude-sonnet" },
  }, { previous: { n1: { judge: "codex-gpt" } } });
  assert.equal(defaults.assignments.n1.worker, "dsh-deepseek");
  assert.equal(defaults.assignments.n1.strategy.worker, "declared");
  assert.equal(defaults.assignments.n1.reason.worker, "operator runtimeDefaults");
  assert.equal(defaults.assignments.n1.judge, "claude-sonnet");
  assert.equal(defaults.assignments.n1.strategy.judge, "declared");
  assert.equal(defaults.assignments.n1.reason.judge, "operator runtimeDefaults");
});
