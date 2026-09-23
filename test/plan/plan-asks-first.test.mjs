/**
 * R4: planning asks before its first stage.
 *
 * The gap this closes is a timing one, not a coverage one. Every planning
 * stage already launches through `runContract`, so the dispatch gate does ask
 * — but it asks that stage's own contract, and `plan/template.mjs` builds
 * planning contracts with `gate: false`, so `reachableRuntimes` never counts
 * the judge role. The reviewer is reached only as the *worker* of the review
 * stage's contract, which is built after the draft has already been bought.
 */
import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { askPlanningRuntimes, refusePlanningSilence } from "../../src/plan/preflight.mjs";

/** @param {string} id @param {Partial<{ok: boolean, detail: string}>} [over] */
function probe(id, over = {}) {
  return /** @type {import("../../src/harnesses/index.mjs").ProbeResult} */ (/** @type {unknown} */ ({
    id, harness: "claude", ok: true, detail: "claude 1.0.0 · live done · usage - · cost -", ...over,
  }));
}

test("a runtime that said nothing at all refuses planning before any stage", () => {
  assert.throws(
    () => refusePlanningSilence([
      probe("planner"),
      probe("reviewer", { ok: false, detail: "claude 1.0.0 · live failed · preflight_timeout: no answer" }),
    ], "/repo"),
    (error) => {
      assert.equal(/** @type {{code?: string}} */ (error).code, "env_preflight_failed");
      assert.match(String(error), /runtime reviewer did not answer: preflight_timeout/u);
      assert.match(String(error), /planning stays resumable/u, "the refusal carries its own remedy");
      return true;
    },
  );
});

test("a refusal verdict is an answer: planning proceeds and lets the stage route around it", () => {
  // The rule is the dispatch gate's own. A provider that answered "I am out of
  // quota" answered, and the contract declares where to go instead.
  assert.doesNotThrow(() => refusePlanningSilence([
    probe("planner"),
    probe("reviewer", { ok: false, detail: "claude 1.0.0 · live failed · quota_exhausted: rate limit" }),
  ], "/repo"));
});

test("a spawn that never started is silence too, and names the runtime", () => {
  assert.throws(
    () => refusePlanningSilence([probe("planner", { ok: false, detail: "claude 1.0.0 · live failed · spawn_error: ENOENT" })], "/repo"),
    /runtime planner did not answer: spawn_error/u,
  );
});

test("a runtime default the catalogue does not carry is not this function's refusal to make", async () => {
  const checks = await askPlanningRuntimes({}, { worker: "absent", judge: "also-absent" }, "/repo");
  assert.deepEqual(checks, [], "the catalogue loader already refuses an unknown id; asking nothing is correct here");
});
