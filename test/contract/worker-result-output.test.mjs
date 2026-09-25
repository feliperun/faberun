import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { discoveryOutput, parseWorkerResult, validateWorkerResult, WorkerResultSizeError } from "../../src/contract/worker-result.mjs";

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
function baseResult(overrides = {}) {
  return { status: "done", summary: "ok", verification: [], artifacts: [], missingContext: [], ...overrides };
}

test("validateWorkerResult accepts an optional output object on any result", () => {
  const result = validateWorkerResult(baseResult({ output: { entrypoint: "src/index.mjs" } }));
  assert.deepEqual(discoveryOutput(result), { entrypoint: "src/index.mjs" });
});

test("discoveryOutput is null when output is absent", () => {
  const result = validateWorkerResult(baseResult());
  assert.equal(discoveryOutput(result), null);
});

test("validateWorkerResult rejects a non-object output", () => {
  assert.throws(() => validateWorkerResult(baseResult({ output: "not an object" })), /worker result\.output must be an object/u);
  assert.throws(() => validateWorkerResult(baseResult({ output: ["array"] })), /worker result\.output must be an object/u);
  assert.throws(() => validateWorkerResult(baseResult({ output: null })), /worker result\.output must be an object/u);
});

test("output is bounded at 65536 bytes independent of the 32 KiB envelope cap", () => {
  const withinOutputCap = { text: "x".repeat(60 * 1024) };
  // Comfortably past the 32 KiB envelope cap that covers only
  // status/summary/verification/artifacts/missingContext, but inside output's own bound.
  assert.doesNotThrow(() => validateWorkerResult(baseResult({ output: withinOutputCap })));
  const overOutputCap = { text: "x".repeat(70 * 1024) };
  assert.throws(
    () => validateWorkerResult(baseResult({ output: overOutputCap })),
    /worker result\.output exceeds 65536 bytes/u,
  );
});

test("parseWorkerResult round-trips a worker result carrying output", () => {
  const text = JSON.stringify(baseResult({ output: { key: "value" } }));
  const parsed = parseWorkerResult(text);
  assert.deepEqual(discoveryOutput(parsed), { key: "value" });
});

test("a result that breaks a byte ceiling throws a typed size error naming the field and the ceiling", () => {
  const plan = "x".repeat(16 * 1024 + 1);
  assert.throws(
    () => validateWorkerResult(baseResult({ artifacts: [plan], output: { plan } })),
    (error) => error instanceof WorkerResultSizeError
      && error.field === "worker result.artifacts[0]"
      && error.limit === 16 * 1024
      && error.message === "worker result.artifacts[0] exceeds 16384 bytes",
  );
});
