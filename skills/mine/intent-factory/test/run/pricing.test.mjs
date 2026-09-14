import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { priceUsage } from "../../src/run/usage.mjs";
import { validateRuntime } from "../../src/contract/runtime.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { snapshot, writeFixture } from "../contract/helpers.mjs";

// Phase 4 of the operator-loop spec: the pure pricing rule and the two schema
// additions it needs (runtime.pricing, invocation.costProvenance). Wiring the
// rule into the dispatch and recovery paths is a dependent node, so nothing
// here touches recordInvocationUsage or appendUsageRecord.

const PRICED = { pricing: { inputPerMTok: 1.0, cachedInputPerMTok: 0.1, outputPerMTok: 3.0 } };
const FULL_USAGE = { inputTokens: 1_000_000, cacheReadInputTokens: 500_000, outputTokens: 200_000 };

test("done-when 1: declared rates price the canonical counters exactly", () => {
  assert.deepEqual(priceUsage(PRICED, FULL_USAGE, undefined), { costUsd: 1.65, costProvenance: "priced" });
});

test("done-when 2: a harness-reported cost wins and is never recomputed", () => {
  assert.deepEqual(priceUsage(PRICED, FULL_USAGE, 0.42), { costUsd: 0.42, costProvenance: undefined });
});

test("done-when 3: a harness-reported zero stays zero, not a recomputed price", () => {
  assert.deepEqual(priceUsage(PRICED, FULL_USAGE, 0), { costUsd: 0, costProvenance: undefined });
});

test("done-when 4: no declared pricing is unknown, not zero", () => {
  for (const runtime of [undefined, null, {}, { pricing: undefined }]) {
    assert.deepEqual(priceUsage(runtime, FULL_USAGE, undefined), { costUsd: null, costProvenance: undefined });
  }
});

test("done-when 5: a missing rate for a measured counter is unknown, never a zero contribution", () => {
  // A non-zero output counter with no outputPerMTok is the named case.
  const noOutputRate = { pricing: { inputPerMTok: 1.0, cachedInputPerMTok: 0.1 } };
  assert.deepEqual(priceUsage(noOutputRate, { inputTokens: 10, cacheReadInputTokens: 0, outputTokens: 5 }, undefined), { costUsd: null, costProvenance: undefined });
  // A null counter is a missing measurement and is refused even when the rate
  // it would have used is declared.
  assert.deepEqual(priceUsage(PRICED, { inputTokens: 10, cacheReadInputTokens: 0, outputTokens: null }, undefined), { costUsd: null, costProvenance: undefined });
  // A zero counter with an undeclared rate is still a measurement without a
  // price; only a declared rate of exactly zero is a real free price.
  assert.deepEqual(priceUsage(noOutputRate, { inputTokens: 10, cacheReadInputTokens: 0, outputTokens: 0 }, undefined), { costUsd: null, costProvenance: undefined });
  assert.deepEqual(priceUsage({ pricing: { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 } }, FULL_USAGE, undefined), { costUsd: 0, costProvenance: "priced" });
});

test("done-when 6: empty, negative, non-finite, and unknown-key pricing are each rejected by name", () => {
  /** @param {Record<string, unknown>} pricing */
  function runtimeFixture(pricing) {
    return writeFixture({
      runtimes: { worker: { harness: "codex", model: "priced-model", executable: "/nonexistent/codex", pricing } },
    });
  }
  /** @param {string} path */
  function validate(path) {
    return validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  }
  const empty = runtimeFixture({});
  assert.throws(() => validate(empty.path), /runtime worker\.pricing must declare at least one rate/u);
  const negative = runtimeFixture({ inputPerMTok: -0.1 });
  assert.throws(() => validate(negative.path), /runtime worker\.pricing\.inputPerMTok must not be negative/u);
  const unknownKey = runtimeFixture({ outputPerMTok: 3, cacheReadPerMTok: 0.1 });
  assert.throws(() => validate(unknownKey.path), /runtime worker\.pricing has unexpected field cacheReadPerMTok/u);
  // JSON cannot carry NaN or Infinity: exercise those in memory.
  assert.throws(
    () => validateRuntime("worker", { harness: "codex", model: "priced-model", pricing: { inputPerMTok: Number.NaN } }),
    /runtime worker\.pricing\.inputPerMTok must be a number/u,
  );
  assert.throws(
    () => validateRuntime("worker", { harness: "codex", model: "priced-model", pricing: { outputPerMTok: Number.POSITIVE_INFINITY } }),
    /runtime worker\.pricing\.outputPerMTok must be a finite number/u,
  );
  // A declared rate of exactly zero is a real price, not an empty object.
  assert.doesNotThrow(() => validateRuntime("worker", { harness: "codex", model: "priced-model", pricing: { outputPerMTok: 0 } }));
});

/** @param {Record<string, unknown>} [overrides] */
function invocation(overrides = {}) {
  return {
    id: "pricing-invocation",
    pid: process.pid,
    processGroupId: null,
    processStartToken: null,
    harness: "codex",
    runtimeId: "worker",
    runtimeFingerprint: "pricing-runtime",
    runId: "pricing-run",
    campaignId: "pricing-campaign",
    planPhase: "phase-4",
    role: "worker",
    model: "gpt-5.6-luna",
    reasoning: null,
    sandbox: null,
    continuationId: null,
    continuationMode: "fresh",
    phase: "worker",
    promptPath: null,
    stdoutPath: null,
    stderrPath: null,
    executable: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-01T00:00:10.000Z",
    closedAt: null,
    exitCode: null,
    signal: null,
    status: "closed",
    nodeId: "build",
    attempt: 0,
    ...overrides,
  };
}

test("an invocation accepts costProvenance only as the literal priced", () => {
  assert.doesNotThrow(() => validateNodeSnapshot(snapshot({ invocations: [invocation({ costProvenance: "priced" })] })));
  // Absent is the pre-Phase-4 shape and must keep validating unchanged.
  assert.doesNotThrow(() => validateNodeSnapshot(snapshot({ invocations: [invocation()] })));
  for (const value of ["provider", "unknown", "priced ", true]) {
    assert.throws(
      () => validateNodeSnapshot(snapshot({ invocations: [invocation({ costProvenance: value })] })),
      /costProvenance must be "priced" when present/u,
    );
  }
});
