import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateContract } from "../../src/contract/index.mjs";
import { availabilityKey, recordRefusal } from "../../src/run/availability.mjs";
import { getHarness } from "../../src/harnesses/index.mjs";
import { buildPlanningContract } from "../../src/plan/template.mjs";
import { firstEligibleReviewer, resolveReviewerList, reviewerProvenanceOf } from "../../src/plan/reviewer.mjs";
import { resolveRuntimes } from "../../src/plan/routing.mjs";

/** @type {Record<string, {harness: string, model: string, vendor: string}>} */
const RUNTIMES = {
  "anthropic-worker": { harness: "claude", model: "claude-sonnet-5", vendor: "anthropic" },
  "openai-judge": { harness: "codex", model: "gpt-6-sol", vendor: "openai" },
  "zhipu-reviewer": { harness: "zcode", model: "glm-5.3-flash", vendor: "zhipu" },
  "anthropic-reviewer": { harness: "claude", model: "claude-opus-5-5", vendor: "anthropic" },
  "reviewer-a": { harness: "zcode", model: "glm-5.3", vendor: "zhipu" },
  "reviewer-b": { harness: "agy", model: "gemini-3.8-flash-low", vendor: "google" },
};

const RUNTIME_DEFAULTS = { worker: "anthropic-worker", judge: "openai-judge" };

/** @param {string} id */
function keyOf(id) {
  const runtime = RUNTIMES[id];
  return availabilityKey({ harness: runtime.harness, model: runtime.model, executable: getHarness(runtime.harness).executable(runtime) });
}

/** @returns {string} a temp checkout holding the read files a review-stage contract names */
function checkout() {
  const cwd = mkdtempSync(join(tmpdir(), "reviewer-list-"));
  writeFileSync(join(cwd, "spec.md"), "spec\n");
  writeFileSync(join(cwd, "repo-facts.json"), "{}\n");
  writeFileSync(join(cwd, "plan.json"), "{}\n");
  return cwd;
}

test("resolveReviewerList: an explicit list wins over the machine default, which is read only absent one", () => {
  assert.deepEqual(resolveReviewerList({ reviewers: ["a", "b"] }, { reviewers: ["c"] }), ["a", "b"]);
  assert.deepEqual(resolveReviewerList({}, { reviewers: ["c"] }), ["c"]);
  assert.equal(resolveReviewerList({}, null), undefined);
  assert.equal(resolveReviewerList({}, undefined), undefined);
});

test("firstEligibleReviewer skips an undeclared or refused entry and never excludes a shared vendor", () => {
  const list = ["missing-runtime", "reviewer-a", "reviewer-b"];
  assert.equal(firstEligibleReviewer(list, RUNTIMES), "reviewer-a", "the first declared, unrefused entry wins");

  recordRefusal(keyOf("reviewer-a"), { reason: "quota_exhausted", exhaustedUntil: null }, Date.now());
  assert.equal(
    firstEligibleReviewer(list, RUNTIMES),
    "reviewer-b",
    "a refused entry is skipped in favor of the next one",
  );

  assert.equal(firstEligibleReviewer([], RUNTIMES), null);
  assert.equal(firstEligibleReviewer(["missing-runtime"], RUNTIMES), null, "a list exhausted by absence is null, not a refusal to build");
});

test("the plan reviewer comes from its own list and never judges a node", () => {
  const cwd = checkout();
  const contractPath = join(cwd, "contract.json");

  // The reviewer list names a runtime the frozen contract's judge default
  // does not: `zhipu-reviewer` never appears in `runtimeDefaults` at all.
  const reviewers = ["zhipu-reviewer", "openai-judge"];
  const reviewerId = firstEligibleReviewer(reviewers, RUNTIMES);
  assert.equal(reviewerId, "zhipu-reviewer");

  const reviewContract = validateContract(
    buildPlanningContract("review", {
      campaignId: "demo-campaign",
      phase: "demo-phase",
      n: 1,
      runtimes: RUNTIMES,
      runtimeDefaults: RUNTIME_DEFAULTS,
      reviewerId: /** @type {string} */ (reviewerId),
      specPath: "spec.md",
      repoFactsPath: "repo-facts.json",
      planPath: "plan.json",
    }),
    contractPath,
  );
  // The review stage runs under the reviewer list's pick, not the frozen
  // contract's judge default -- the two roles no longer share
  // `runtimeDefaults.judge` (R19).
  assert.equal(reviewContract.nodes[0].runtime, "zhipu-reviewer");
  assert.notEqual(reviewContract.nodes[0].runtime, RUNTIME_DEFAULTS.judge);

  // The frozen contract's own judge assignment (R18's routing, unrelated to
  // this list) is computed independently and never resolves to the reviewer:
  // a plan reviewer never judges a worker's node.
  const availability = Object.fromEntries(Object.keys(RUNTIMES).map((id) => [id, { available: true, exhaustedUntil: null }]));
  const { assignments } = resolveRuntimes(
    [{ id: "build", taskKind: "implement", riskTier: "standard" }],
    { runtimes: /** @type {any} */ (RUNTIMES), availability, runtimeDefaults: RUNTIME_DEFAULTS },
  );
  assert.equal(assignments.build.worker, "anthropic-worker");
  assert.equal(assignments.build.judge, "openai-judge");
  assert.notEqual(assignments.build.judge, reviewerId, "the reviewer picked for the plan's own review stage never judges an implementation node");
});

test("a reviewer of the planner's own vendor no longer makes the frozen contract unroutable", () => {
  // Before R19 the review stage's runtime and the frozen contract's judge
  // default were the same field (`runtimeDefaults.judge`); an operator naming
  // a same-vendor reviewer there would have made every frozen node's judge
  // share the worker's vendor and refuse to route. The two are independent
  // fields now: a reviewer list entry of the worker's own vendor never
  // reaches routing.mjs at all.
  const reviewers = ["anthropic-reviewer"];
  const reviewerId = firstEligibleReviewer(reviewers, RUNTIMES);
  assert.equal(reviewerId, "anthropic-reviewer", "same vendor as the worker, still eligible as a reviewer");

  const availability = Object.fromEntries(Object.keys(RUNTIMES).map((id) => [id, { available: true, exhaustedUntil: null }]));
  const { assignments, unmet } = resolveRuntimes(
    [{ id: "build", taskKind: "implement", riskTier: "standard" }],
    { runtimes: /** @type {any} */ (RUNTIMES), availability, runtimeDefaults: RUNTIME_DEFAULTS },
  );
  assert.deepEqual(unmet, []);
  assert.equal(assignments.build.judge, "openai-judge", "the frozen contract's judge still comes from runtimeDefaults/R18, untouched by the reviewer list");
});

test("reviewerProvenanceOf records the first eligible entry and its model, or an empty fact for no list", () => {
  assert.deepEqual(reviewerProvenanceOf(["zhipu-reviewer"], RUNTIMES), { runtimeId: "zhipu-reviewer", model: "glm-5.3-flash" });
  assert.deepEqual(reviewerProvenanceOf(undefined, RUNTIMES), { runtimeId: "", model: "" });
  assert.deepEqual(reviewerProvenanceOf([], RUNTIMES), { runtimeId: "", model: "" });
});
