import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLivePreflightTimeout } from "../../src/engine/live-preflight.mjs";

test("the default live preflight budget follows the runtime's reasoning effort", () => {
  /** @param {string|undefined} reasoning */
  const runtime = (reasoning) => /** @type {any} */ ({ harness: "claude", model: "claude-opus-5-5", ...(reasoning ? { reasoning } : {}) });
  assert.equal(defaultLivePreflightTimeout(runtime("xhigh")), 180);
  assert.equal(defaultLivePreflightTimeout(runtime("max")), 180);
  assert.equal(defaultLivePreflightTimeout(runtime("high")), 60);
  assert.equal(defaultLivePreflightTimeout(runtime("medium")), 15);
  assert.equal(defaultLivePreflightTimeout(runtime(undefined)), 15);
});

test("a detached launcher waits for the longest live preflight the gate may run", async () => {
  const { LIVE_PREFLIGHT_CEILING_SEC, livePreflightCeilingSec } = await import("../../src/engine/live-preflight.mjs");
  const { bootstrapReadyTimeoutMs } = await import("../../src/cli/launch.mjs");
  for (const reasoning of ["xhigh", "max", "high", "medium"]) {
    assert.ok(defaultLivePreflightTimeout(/** @type {any} */ ({ harness: "claude", reasoning })) <= LIVE_PREFLIGHT_CEILING_SEC);
  }
  const key = "FABERUN_PREFLIGHT_TIMEOUT_SEC";
  const previous = process.env[key];
  try {
    delete process.env[key];
    assert.equal(livePreflightCeilingSec(), LIVE_PREFLIGHT_CEILING_SEC);
    assert.equal(bootstrapReadyTimeoutMs(), 30_000 + LIVE_PREFLIGHT_CEILING_SEC * 1000);
    process.env[key] = "300";
    assert.equal(bootstrapReadyTimeoutMs(), 330_000);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
