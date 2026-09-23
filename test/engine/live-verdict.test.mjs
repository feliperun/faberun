import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeProviderAvailability, probeRuntime } from "../../src/harnesses/index.mjs";

// The availability verdict must name the cause the provider actually gave.
// Every case here is a recorded envelope or a recorded stderr -- none of these
// tests talk to a real provider.

const codex = { harness: "codex" };

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function envelope(overrides = {}) {
  return {
    status: "failed",
    result: null,
    continuationId: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: null,
    error: { code: "provider_error", message: "" },
    ...overrides,
  };
}

/**
 * @param {string} body
 * @returns {string}
 */
function fixtureExecutable(body) {
  const path = join(mkdtempSync(join(tmpdir(), "live-verdict-fixture-")), "fixture.mjs");
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("each recorded cause names its own verdict", () => {
  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({ status: "done", result: "FABERUN_PREFLIGHT_OK", error: null })),
    { available: true, exhaustedUntil: null, reason: "ready" },
  );

  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({
      status: "exhausted",
      error: { code: "quota_exhausted", message: "You've hit your usage limit. Please try again at 12:58 PM", resetAt: "2026-09-10T12:00:00.000Z" },
    })),
    { available: false, exhaustedUntil: "2026-09-10T12:00:00.000Z", reason: "quota_exhausted" },
  );

  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({ error: { code: "payment_required", message: "Error: Insufficient Balance" } })),
    { available: false, exhaustedUntil: null, reason: "insufficient_balance" },
  );

  // measured 2026-09-22, a Codex account asked for a model it may not use.
  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({
      error: { code: "bad_request", message: "The gpt-5.6-codex model is not supported when using Codex with a ChatGPT account" },
    })),
    { available: false, exhaustedUntil: null, reason: "model_not_supported" },
  );

  // measured 2026-09-22: agy had no configuration directory at all.
  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({
      error: { code: "error", message: "The configuration directory /home/u/.agy does not exist" },
    })),
    { available: false, exhaustedUntil: null, reason: "credentials_missing" },
  );

  // A harness that reports the authentication itself failing or timing out
  // names a credential cause too -- and a timed-out authentication is not
  // `unknown`, because here the provider did say something.
  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({ error: { code: "unauthorized", message: "Authentication failed: token expired" } })),
    { available: false, exhaustedUntil: null, reason: "authentication_failed" },
  );
  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({ error: { code: "error", message: "Login timed out" } })),
    { available: false, exhaustedUntil: null, reason: "authentication_failed" },
  );
});

test("a probe that timed out naming nothing is unknown, never one of the four", () => {
  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({ error: { code: "preflight_timeout", message: "live generation timed out after 15s" } })),
    { available: false, exhaustedUntil: null, reason: "unknown" },
  );
});

test("a failure the provider did not name keeps its own code, so unknown stays reserved for timeouts", () => {
  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({ error: null })),
    { available: false, exhaustedUntil: null, reason: "provider_unavailable" },
  );
  assert.deepEqual(
    normalizeProviderAvailability(codex, envelope({ error: { code: "invalid_output", message: "replay exited with code 1" } })),
    { available: false, exhaustedUntil: null, reason: "invalid_output" },
  );
});

test("the same measured refusals classify identically from a probe's raw stderr", async () => {
  const cases = [
    { stderr: "Error: The gpt-5.6-codex model is not supported when using Codex with a ChatGPT account", reason: "model_not_supported" },
    { stderr: "error: Could not find configuration directory /home/u/.codex", reason: "credentials_missing" },
    { stderr: "Error: Insufficient Balance", reason: "insufficient_balance" },
  ];
  for (const { stderr, reason } of cases) {
    const executable = fixtureExecutable(
      `if (process.argv.includes("--version")) { process.stderr.write(${JSON.stringify(stderr)}); process.exit(1); }\nsetTimeout(() => {}, 60_000);`,
    );
    const probe = await probeRuntime({ harness: "replay", model: "m", executable });
    assert.deepEqual(probe.availability, { available: false, exhaustedUntil: null, reason }, stderr);
  }
});

test("a probe whose version check hangs past its timeout is unknown", async () => {
  const executable = fixtureExecutable("setTimeout(() => {}, 60_000);");
  const started = Date.now();
  const probe = await probeRuntime({ harness: "replay", model: "m", executable }, { timeoutSec: 0.5 });
  assert.ok(Date.now() - started >= 500, "the timeout must actually elapse");
  assert.deepEqual(probe.availability, { available: false, exhaustedUntil: null, reason: "unknown" });
  assert.match(probe.detail ?? "", /no response within 0\.5s/u);
});
