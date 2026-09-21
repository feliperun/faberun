import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AUTO_RETRY_CODES } from "../../src/engine/lifecycle.mjs";
import { NON_FAILOVER_CODES } from "../../src/engine/backoff.mjs";
import { resilienceCases } from "../../evals/resilience.mjs";

/** @param {Record<string, unknown>} spec */
const injectedCode = (spec) => /** @type {{code: string}} */ (spec.injection).code;

test("one case per declared failure class, enumerated from the tables themselves", () => {
  const cases = resilienceCases();
  const declared = [...AUTO_RETRY_CODES, ...NON_FAILOVER_CODES].sort();
  assert.equal(new Set(declared).size, declared.length, "the engine declares each failure class once");
  assert.deepEqual(
    cases.map((entry) => injectedCode(entry.spec)).sort(),
    declared,
    "the generated cases must track the engine's declarations exactly: none invented, none missing",
  );
  const ids = new Set(cases.map((entry) => /** @type {string} */ (entry.spec.id)));
  assert.equal(ids.size, cases.length, "case ids are unique");
});

test("every resilience case is replay-only with no failover edge, so no recovery path can reach a provider", () => {
  for (const { spec } of resilienceCases()) {
    const contract = /** @type {{runtimes: Record<string, {harness: string, fallback?: string}>}} */ (spec.contract);
    const runtimes = Object.entries(contract.runtimes);
    assert.ok(runtimes.length > 0);
    for (const [id, runtime] of runtimes) {
      assert.equal(runtime.harness, "replay", `runtime ${id} must be replay-only for --assert-no-model to hold`);
      assert.equal(runtime.fallback, undefined, `runtime ${id} must not declare a failover edge: the class proves settlement, not routing`);
    }
  }
});

test("the recording carries one injected failure per expected attempt, all under the case's own code", () => {
  for (const { caseDir, spec, expected } of resilienceCases()) {
    const code = injectedCode(spec);
    const runtimeIds = /** @type {string[]} */ (
      /** @type {Record<string, unknown>} */ (/** @type {Record<string, Record<string, unknown>>} */ (expected.nodes).build).runtimeIds
    );
    const filename = /** @type {Record<string, string>} */ (spec.recordings)["replay-worker"];
    const lines = readFileSync(join(caseDir, filename), "utf8").trim().split("\n");
    assert.equal(lines.length, runtimeIds.length, `${code}: the expected attempt count must equal the recorded failures a retry can re-invoke`);
    for (const line of lines) {
      const envelope = /** @type {{envelope: {error: {code: string}}}} */ (JSON.parse(line));
      assert.equal(envelope.envelope.error.code, code, `${code}: every recorded failure must carry the injected class`);
    }
  }
});

test("each case expects its node to settle under its own code with no routing edge spent", () => {
  for (const { spec, expected } of resilienceCases()) {
    const code = injectedCode(spec);
    const node = /** @type {Record<string, unknown>} */ (/** @type {Record<string, Record<string, unknown>>} */ (expected.nodes).build);
    assert.equal(node.errorCode, code, `a ${code} failure must settle under its own code, not a derived one`);
    assert.equal(node.status, "failed");
    assert.equal(node.revisions, 0);
    assert.equal(node.routingHistoryLength, 0, "no failover or backoff edge may be spent");
    assert.equal(node.integratedHead, false);
  }
});
