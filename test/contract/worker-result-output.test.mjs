import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { discoveryOutput, parseWorkerResult, SANDBOX_BLOCKED_WRITE, validateWorkerResult, WorkerResultSizeError } from "../../src/contract/worker-result.mjs";

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
    /worker result\.output is \d+ bytes, over the 65536-byte ceiling/u,
  );
});

test("parseWorkerResult round-trips a worker result carrying output", () => {
  const text = JSON.stringify(baseResult({ output: { key: "value" } }));
  const parsed = parseWorkerResult(text);
  assert.deepEqual(discoveryOutput(parsed), { key: "value" });
});

// AP18 of safe-to-hand-to-friend, measured 2026-09-28: a GLM worker returned a
// 19,810-byte artifact against the 16,384-byte ceiling and the node failed with
// "worker result.artifacts[0] exceeds 16384 bytes" -- the same message a 1 MiB
// artifact would produce, so the operator could not tell how far over it was.
test("a result that breaks a byte ceiling throws a typed size error naming the field, the size and the ceiling", () => {
  const plan = "x".repeat(16 * 1024 + 1);
  assert.throws(
    () => validateWorkerResult(baseResult({ artifacts: [plan], output: { plan } })),
    (error) => error instanceof WorkerResultSizeError
      && error.field === "worker result.artifacts[0]"
      && error.limit === 16 * 1024
      && error.actual === 16 * 1024 + 1
      && error.message === "worker result.artifacts[0] is 16385 bytes, over the 16384-byte ceiling",
  );

  const overshot = "y".repeat(19_810);
  assert.throws(
    () => validateWorkerResult(baseResult({ artifacts: [overshot] })),
    (error) => error instanceof WorkerResultSizeError
      && error.actual === 19_810
      && /is 19810 bytes, over the 16384-byte ceiling$/u.test(error.message),
  );
});

test("the sandbox-blocked write classification is declared once, in the contract layer", () => {
  assert.equal(SANDBOX_BLOCKED_WRITE, "sandbox_blocked_write");
});
