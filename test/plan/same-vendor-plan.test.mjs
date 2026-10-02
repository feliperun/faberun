import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { refuseUnplannableRuntimes } from "../../src/plan/preflight.mjs";
import { resolveRuntimes } from "../../src/plan/routing.mjs";
import { frozenContractRawOf } from "../../src/plan/pipeline.mjs";

// Measured 2026-09-27: a single-provider catalogue (Sonnet worker, Opus planner
// and judge) could not plan at all, though its frozen contract validates under
// `judgeIndependence: "same-vendor"`.
const RUNTIMES = {
  "claude-sonnet": { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic", permissionMode: "bypassPermissions", tier: 2, costRank: 2 },
  "claude-opus": { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic", tier: 3, costRank: 3 },
  "claude-opus-planner": { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic", permissionMode: "bypassPermissions", tier: 3, costRank: 3 },
  "claude-fable": { harness: "claude", model: "claude-fable-5-1", vendor: "anthropic", permissionMode: "bypassPermissions", tier: 4, costRank: 4 },
  "claude-unlisted": { harness: "claude", model: "claude-haiku-4-5", vendor: "anthropic", tier: 1, costRank: 1 },
};
const AVAILABLE = { available: true, exhaustedUntil: null, reason: "ready" };
const AVAILABILITY = Object.fromEntries(Object.keys(RUNTIMES).map((id) => [id, AVAILABLE]));

test("plan's pre-flight admits a same-vendor judge only in same-vendor mode, and only by tier", () => {
  const defaults = { worker: "claude-opus-planner", judge: "claude-opus" };
  assert.throws(
    () => refuseUnplannableRuntimes(RUNTIMES, defaults, "implementation"),
    /shares vendor anthropic.*--judge-independence same-vendor/u,
    "without the mode a shared vendor is refused, and the refusal names the way out",
  );
  assert.doesNotThrow(() => refuseUnplannableRuntimes(RUNTIMES, defaults, "implementation", "same-vendor"), "an Opus judge may judge an Opus planner");
  assert.doesNotThrow(() => refuseUnplannableRuntimes(RUNTIMES, { worker: "claude-sonnet", judge: "claude-opus" }, "implementation", "same-vendor"));
  assert.throws(
    () => refuseUnplannableRuntimes(RUNTIMES, { worker: "claude-fable", judge: "claude-opus" }, "implementation", "same-vendor"),
    /judge tier 3 \(claude-opus-5-5\) is below worker tier 4/u,
    "a judge below the worker's tier is refused in the mode",
  );
  assert.throws(
    () => refuseUnplannableRuntimes(RUNTIMES, { worker: "claude-sonnet", judge: "claude-unlisted" }, "implementation", "same-vendor"),
    /declares no tier/u,
    "a judge with no declared tier cannot judge in the mode",
  );
  const withFallback = { ...RUNTIMES, "claude-sonnet": { ...RUNTIMES["claude-sonnet"], fallback: "claude-fable" } };
  assert.throws(
    () => refuseUnplannableRuntimes(withFallback, { worker: "claude-sonnet", judge: "claude-opus" }, "implementation", "same-vendor"),
    /worker fallback claude-fable.*below worker tier 4/u,
    "the tier rule covers every same-vendor fallback of the worker",
  );
});

test("the vendor rule is the contract's own, so exploratory planning is refused exactly as implementation planning is", () => {
  // `packageMode` decides only whether the worker's permission mode is checked
  // (an exploratory packet carries no verification of its own); the judge's
  // vendor is a property of every frozen node regardless of the node's kind,
  // so the refusal cannot be conditional on the mode.
  assert.throws(
    () => refuseUnplannableRuntimes(RUNTIMES, { worker: "claude-sonnet", judge: "claude-opus" }, "exploratory"),
    /shares vendor anthropic/u,
  );
});

test("routing honours same-vendor mode the way contract validation does", () => {
  const nodes = [{ id: "n1", taskKind: "build" }];
  const runtimeDefaults = { worker: "claude-sonnet", judge: "claude-opus" };
  const refused = resolveRuntimes(nodes, { runtimes: RUNTIMES, availability: AVAILABILITY, runtimeDefaults }, { partial: true });
  assert.deepEqual(refused.unmet, [{ nodeId: "n1", role: "judge", rule: "runtimeDefaults" }], "outside the mode the declared judge is barred by vendor");

  const admitted = resolveRuntimes(nodes, { runtimes: RUNTIMES, availability: AVAILABILITY, runtimeDefaults, judgeIndependence: "same-vendor" });
  assert.deepEqual(admitted.unmet, []);
  assert.equal(admitted.assignments.n1.judge, "claude-opus");

  const tooLow = resolveRuntimes(nodes, { runtimes: RUNTIMES, availability: AVAILABILITY, runtimeDefaults: { worker: "claude-fable", judge: "claude-opus" }, judgeIndependence: "same-vendor" }, { partial: true });
  assert.deepEqual(tooLow.unmet, [{ nodeId: "n1", role: "judge", rule: "runtimeDefaults" }], "a judge below the worker's tier stays unmet in the mode");

  /** @type {import("../../src/plan/routing.mjs").RoutingRule[]} */
  const table = [
    { when: { taskKind: "build" }, prefer: ["claude-sonnet"], role: "worker" },
    { when: { taskKind: "build" }, prefer: ["claude-sonnet", "claude-unlisted", "claude-opus"], role: "judge" },
  ];
  const skipped = resolveRuntimes(nodes, { table, runtimes: RUNTIMES, availability: AVAILABILITY, judgeIndependence: "same-vendor" });
  assert.equal(skipped.assignments.n1.judge, "claude-opus", "the worker itself and a tierless model are skipped within a prefer list");

  const discovered = resolveRuntimes(nodes, { runtimes: { "claude-sonnet": RUNTIMES["claude-sonnet"], "claude-opus": RUNTIMES["claude-opus"] }, availability: AVAILABILITY, judgeIndependence: "same-vendor" });
  assert.equal(discovered.assignments.n1.worker, "claude-sonnet");
  assert.equal(discovered.assignments.n1.judge, "claude-opus", "discovery finds a same-vendor judge in the mode");
});

test("the frozen contract carries the operator's judge-independence opt-in", () => {
  const ctx = {
    campaignId: "c", phase: "p", campaignGoal: "g", cwd: ".", plansDir: ".", runtimes: RUNTIMES,
    runtimeDefaults: { worker: "claude-sonnet", judge: "claude-opus" },
  };
  const assembly = /** @type {any} */ ({ sizing: { plan: { nodes: [] } }, nodes: [], suites: {} });
  assert.equal(frozenContractRawOf(assembly, { ...ctx, judgeIndependence: "same-vendor" }).judgeIndependence, "same-vendor");
  assert.equal("judgeIndependence" in frozenContractRawOf(assembly, ctx), false, "absent unless the operator opts in");
});
