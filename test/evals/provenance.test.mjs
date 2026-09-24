import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareStochasticResults, isStochasticResult } from "../../evals/compare.mjs";
import { runJudgeCanaryClass } from "../../evals/judge-canary/class.mjs";
import { runPairedClass } from "../../evals/paired.mjs";

/** The tiny corpus the replay arm works over: proofs fail at the base, guards pass there. */
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/paired", import.meta.url));

/** The version probe a replay run reports without spawning a provider. */
const REPLAY_VERSION = "replay 1.0.0";

/** A replay judge that rejects every case, citing the case's own judgment item. */
const REJECT_VERDICT = JSON.stringify({
  verdict: "fail",
  maxSeverity: "major",
  summary: "the change does more than its objective",
  findings: [{ severity: "major", description: "in-scope is not satisfied by this change", evidence: "the sealed diff edits a hunk the objective does not ask for" }],
});

/**
 * Every field R8 requires of a stochastic result, asserted on one file.
 *
 * @param {Record<string, any>} result
 * @param {string} expectedClass
 */
function assertProvenance(result, expectedClass) {
  assert.equal(result.class, expectedClass, "the result names its class");
  const provenance = result.provenance;
  assert.equal(provenance.class, expectedClass, "the provenance names the class too");
  assert.match(String(provenance.commit), /^[0-9a-f]{7,40}$/u, `${expectedClass} records the commit it was produced from`);
  assert.equal(typeof provenance.seed, "number", `${expectedClass} records the seed`);
  assert.equal(typeof provenance.repeat, "number", `${expectedClass} records the repetitions`);
  assert.equal(typeof provenance.budgetUsd, "number", `${expectedClass} records the budget`);
  assert.equal(typeof provenance.pricedSpendUsd, "number", `${expectedClass} records priced spend`);
  assert.equal(typeof provenance.voidedSpendUsd, "number", `${expectedClass} records voided spend`);
  assert.ok(Array.isArray(provenance.runtimes) && provenance.runtimes.length > 0, `${expectedClass} records its runtimes`);
  for (const runtime of provenance.runtimes) {
    assert.ok("harness" in runtime, "a runtime records its harness");
    assert.ok("model" in runtime, "a runtime records its model");
    assert.ok("cliVersion" in runtime, "a runtime records the CLI version when the harness reports one");
  }
}

test("a stochastic result names everything that produced it", async () => {
  const resultDir = mkdtempSync(join(tmpdir(), "provenance-"));
  try {
    const arm = { name: "R", runner: "replay", harness: "replay", model: "replay-model", judge: true, config: { runs: [{ costUsd: 1, requests: 1, wallMs: 1, writes: [] }] } };
    const paired = await runPairedClass(/** @type {any} */ ({
      arms: [arm],
      corpusRoot: FIXTURE_ROOT,
      corpus: "fixture",
      budgetUsd: 100,
      resultDir,
      seed: 7,
      repeat: 2,
      now: () => 0,
      probeVersion: () => REPLAY_VERSION,
    }));
    const canary = await runJudgeCanaryClass({
      runtime: { id: "replay-judge", harness: "replay", model: "replay-model" },
      budgetUsd: 100,
      resultDir,
      seed: 7,
      repeat: 2,
      now: () => 0,
      judge: () => REJECT_VERDICT,
      probeVersion: () => REPLAY_VERSION,
    });

    assertProvenance(paired.report, "paired");
    assertProvenance(canary.report, "judge-canary");
    const pairedProvenance = /** @type {any} */ (paired.report.provenance);
    const canaryProvenance = /** @type {any} */ (canary.report.provenance);
    assert.equal(pairedProvenance.runtimes[0].cliVersion, REPLAY_VERSION, "the reported CLI version is recorded");
    assert.equal(pairedProvenance.seed, 7);
    assert.equal(pairedProvenance.repeat, 2);
    assert.equal(typeof pairedProvenance.dirtyTree, "boolean");
    assert.match(pairedProvenance.armsFileHash, /^[0-9a-f]{64}$/u);
    assert.ok(pairedProvenance.runtimes.some((/** @type {any} */ runtime) => runtime.id === "codex-sol-judge"), "the blocking judge is provenance, not an invisible writer detail");
    assert.equal(canaryProvenance.repeat, 2);

    for (const path of [paired.resultPath, canary.resultPath]) {
      assert.ok(path, "the run wrote its result to the directory it was given");
      const onDisk = JSON.parse(readFileSync(/** @type {string} */ (path), "utf8"));
      assertProvenance(onDisk, onDisk.class);
    }

    // --compare accepts two results of the same class and refuses different
    // classes; the same helper backs the CLI flag.
    assert.equal(isStochasticResult(paired.report), true);
    assert.equal(isStochasticResult({ schemaVersion: 1, indicators: {} }), false);
    assert.equal(compareStochasticResults(paired.report, paired.report).class, "paired");
    assert.throws(
      () => compareStochasticResults(paired.report, canary.report),
      /different classes/u,
      "a paired result and a judge-canary result are not comparable",
    );
    const differentCorpus = /** @type {any} */ (structuredClone(paired.report));
    differentCorpus.provenance.corpusHash = "different";
    assert.throws(() => compareStochasticResults(paired.report, differentCorpus), /different corpusHash/u);
  } finally {
    rmSync(resultDir, { recursive: true, force: true });
  }
});
