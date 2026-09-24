import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { combinePairedResults, parseVoids } from "../../evals/paired/combine.mjs";

/** @param {string} label @param {string} corpusHash @param {Array<[string, number, number]>} runs arm, proofs, cost */
function result(label, corpusHash, runs) {
  return {
    class: "paired",
    provenance: { corpusHash, seed: 7, spendUsd: runs.reduce((total, [, , cost]) => total + cost, 0) },
    runs: runs.map(([arm, proofsPassed, costUsd]) => ({ arm, label, repetition: 1, proofsPassed, proofsTotal: 4, guardsPassed: true, costUsd, wallMs: 1000, requests: 10, scope: { outOfScope: [] } })),
  };
}

// R11 ran its repetitions as parallel processes (2026-09-24); one of them
// counted arms A and H as delivering nothing because the provider's quota was
// spent. Combining pools the runs, and a voided run is named, not dropped.
test("paired results from parallel processes combine, and a voided run is named", () => {
  const sources = [
    { path: "r1.json", result: result("r1", "h", [["B", 2, 2], ["E", 2, 0.1]]) },
    { path: "r2.json", result: result("r2", "h", [["B", 2, 2.2], ["E", 2, 0.1], ["H", 0, 0.01]]) },
  ];
  const combined = combinePairedResults(sources, parseVoids(["r2:H=quota_exhausted, not a measurement"]));
  const byArm = Object.fromEntries(combined.arms.map((/** @type {any} */ arm) => [arm.arm, arm]));
  assert.equal(byArm.B.runs, 2, "B pools both repetitions");
  assert.equal(byArm.H, undefined, "the voided H run is not in any arm");
  assert.deepEqual(combined.provenance.voided, [{ label: "r2", arm: "H", reason: "quota_exhausted, not a measurement", runs: 1 }]);
  assert.equal(combined.provenance.sources.length, 2);
  assert.throws(() => combinePairedResults([sources[0], { path: "x.json", result: result("x", "other", [["B", 2, 2]]) }]), /different corpora/u);
});
