import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runPairedClass } from "../../evals/paired.mjs";
import { armReport } from "../../evals/paired/analyse.mjs";
import { loadCorpusSet } from "../../evals/paired/corpus.mjs";
import { runReplayArm } from "../../evals/paired/replay.mjs";
import { seededShuffle } from "../../evals/paired/lib.mjs";

/** The small fixture corpus whose proofs fail at the base and whose guards pass there. */
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/paired", import.meta.url));

/** What a delivering replay arm leaves: the proof file in scope, and one file outside the write scope. */
const WORKING_WRITES = [
  { path: "src/status.txt", content: "done\n" },
  { path: "notes/extra.txt", content: "scratch\n" },
];

/**
 * Run the whole paired class over the fixture corpus with replay arms and a
 * throwaway result directory, so no test ever writes a stochastic result into
 * the tree.
 *
 * @param {Record<string, unknown>} options
 * @returns {Promise<{report: any, resultPath: string|null, resultDir: string}>}
 */
async function runFixture(options) {
  const resultDir = mkdtempSync(join(tmpdir(), "paired-result-"));
  const { report, resultPath } = await runPairedClass(/** @type {any} */ ({
    corpusRoot: FIXTURE_ROOT,
    corpus: "fixture",
    budgetUsd: 100,
    resultDir,
    now: () => 0,
    ...options,
  }));
  return { report, resultPath, resultDir };
}

test("the paired class reports a band per arm", async () => {
  const arm = {
    name: "R",
    runner: "replay",
    model: "replay-model",
    harness: "replay",
    config: {
      runs: [
        { costUsd: 1, requests: 10, wallMs: 100, writes: WORKING_WRITES },
        { costUsd: 2, requests: 20, wallMs: 200, writes: WORKING_WRITES },
        { costUsd: 3, requests: 30, wallMs: 300, writes: WORKING_WRITES },
      ],
    },
  };
  const { report, resultPath, resultDir } = await runFixture({ arms: [arm], repeat: 3, seed: 7 });
  try {
    const entry = /** @type {any} */ (report).arms[0];
    assert.equal(entry.arm, "R");
    assert.equal(entry.runs, 3);
    assert.equal(entry.proofsDelivered, 1);
    assert.equal(entry.costPerDeliveredProof, 2);
    assert.equal(entry.wallClockMs, 200);
    assert.equal(entry.requests, 20);
    assert.equal(entry.outOfScopeFiles, 1);
    assert.equal(entry.guardsPassed, true);

    const proofBand = entry.band.proofsDelivered;
    assert.equal(proofBand.min, 1);
    assert.equal(proofBand.max, 1);
    assert.ok(proofBand.interval95, "three or more readings give a 95% interval");
    assert.ok(proofBand.interval95.lower <= 1 && proofBand.interval95.upper >= 1);

    const costBand = entry.band.costUsd;
    assert.equal(costBand.min, 1);
    assert.equal(costBand.max, 3);
    assert.equal(costBand.median, 2);
    assert.ok(costBand.interval95, "cost gets a 95% interval too");

    assert.ok(resultPath && resultPath.endsWith(".json"), "the run writes its result to the directory it was given");
    const onDisk = JSON.parse(readFileSync(/** @type {string} */ (resultPath), "utf8"));
    assert.equal(onDisk.class, "paired");
    assert.equal(onDisk.provenance.seed, 7);
    assert.equal(onDisk.provenance.repeat, 3);
    assert.deepEqual(onDisk.arms[0].band.costUsd, costBand);
  } finally {
    rmSync(resultDir, { recursive: true, force: true });
  }
});

test("a paired arm that changes nothing delivers zero", async () => {
  const arm = {
    name: "N",
    runner: "replay",
    model: "replay-model",
    harness: "replay",
    config: { runs: [{ costUsd: 0, requests: 5, wallMs: 50, writes: [] }] },
  };
  const { report, resultDir } = await runFixture({ arms: [arm], repeat: 1, seed: 11 });
  try {
    const entry = /** @type {any} */ (report).arms[0];
    assert.equal(entry.proofsDelivered, 0, "an arm that changes nothing delivers no proof");
    assert.equal(entry.band.proofsDelivered.min, 0);
    assert.equal(entry.band.proofsDelivered.max, 0);
    assert.equal(entry.proofsTotal, 1);
    assert.equal(entry.guardsPassed, true, "the guards pass at the base; only the proof fails");
    assert.equal(entry.outOfScopeFiles, 0);
  } finally {
    rmSync(resultDir, { recursive: true, force: true });
  }
});

test("the paired proof exercises seeded two-arm order and leaves n<3 without interval95", async () => {
  const arms = [
    { name: "R", runner: "replay", model: "replay-model", harness: "replay", config: { runs: [{ costUsd: 1, writes: WORKING_WRITES }] } },
    { name: "S", runner: "replay", model: "replay-model", harness: "replay", config: { runs: [{ costUsd: 2, writes: WORKING_WRITES }] } },
  ];
  const { report, resultDir } = await runFixture({ arms, repeat: 2, seed: 19 });
  try {
    assert.deepEqual(
      (/** @type {any[]} */ (report.runs)).map((/** @type {any} */ run) => run.arm),
      [...seededShuffle(arms, 20), ...seededShuffle(arms, 21)].map((arm) => arm.name),
      "both arms are measured in the recorded seeded order",
    );
    for (const entry of report.arms) assert.equal(entry.band.costUsd.interval95, null, "two readings do not get a fabricated 95% interval");
  } finally {
    rmSync(resultDir, { recursive: true, force: true });
  }
});

test("the paired acceptance runs tree guards before restoring accepted files", () => {
  const corpus = loadCorpusSet(FIXTURE_ROOT, "fixture");
  const run = runReplayArm({
    arm: { name: "R", runner: "replay", model: "replay-model", harness: "replay", config: { writes: WORKING_WRITES } },
    repetition: 1,
    corpus,
  });
  const acceptance = /** @type {any[]} */ (run.acceptance);
  assert.deepEqual(acceptance.map((check) => check.id), ["guard-base", "proof-status", "guard-restored"]);
  assert.equal(acceptance[0].passed, true, "the pre-restore guard saw the accepted file absent");
  assert.equal(acceptance[2].passed, true, "the restore guard saw the accepted file after restoration");
});

test("paired bands count zero-delivery spend and show errored runs separately", () => {
  const report = /** @type {any} */ (armReport("R", [
    { arm: "R", repetition: 1, proofsPassed: 0, costUsd: 5, wallMs: 1, scope: { outOfScope: [] }, guardsPassed: true },
    { arm: "R", repetition: 2, error: "provider failed" },
    { arm: "R", repetition: 3, proofsPassed: 2, costUsd: 5, wallMs: 3, scope: { outOfScope: [] }, guardsPassed: true },
  ], 1));
  assert.equal(report.runs, 3);
  assert.equal(report.measuredRuns, 2);
  assert.equal(report.erroredRuns, 1);
  assert.equal(report.costPerDeliveredProof, 5, "arm cost is total measured spend over total delivered proofs");
  assert.equal(report.band.costUsd.n, 2, "the errored run is outside measured bands");
  assert.equal(report.band.proofsDelivered.min, 0, "zero delivery remains in the band");
  assert.equal(report.perRun[0].costPerDeliveredProof, null, "the zero-delivery per-run value stays explicit");
});
