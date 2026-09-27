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
