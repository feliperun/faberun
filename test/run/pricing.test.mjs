import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsageRecord, priceUsage } from "../../src/run/usage.mjs";
import { projectMetrics } from "../../src/campaign/metrics.mjs";
import { seedPricing } from "../../src/engine/pricing-seed.mjs";
import { bulkRead } from "../../src/engine/bulk-read.mjs";
import { READ_LINE_LIMIT } from "../../src/harnesses/index.mjs";
import { validateRuntime } from "../../src/contract/runtime.mjs";
import { validateContract } from "../../src/contract/index.mjs";
import { validateNodeSnapshot } from "../../src/contract/snapshot.mjs";
import { snapshot, writeFixture } from "../contract/helpers.mjs";

// Phase 4 of the operator-loop spec: the pure pricing rule and the two schema
// additions it needs (runtime.pricing, invocation.costProvenance). Wiring the
// rule into the dispatch and recovery paths is a dependent node, so nothing
// here keeps the pure pricing checks separate from the ledger's provenance
// explanation checks below.

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

test("done-when 12: a runtime with only a model prices from the vendored seed", () => {
  const rate = seedPricing("claude-opus-5");
  assert.ok(rate, "claude-opus-5 must be vendored");
  assert.equal(typeof rate.inputPerMTok, "number");
  assert.equal(typeof rate.outputPerMTok, "number");
  // The expectation is derived from the vendored rate object itself, so a
  // re-vendor cannot leave a hardcoded USD literal silently wrong.
  const expected = (
    FULL_USAGE.inputTokens * /** @type {number} */ (rate.inputPerMTok)
    + FULL_USAGE.cacheReadInputTokens * (rate.cachedInputPerMTok ?? 0)
    + FULL_USAGE.outputTokens * /** @type {number} */ (rate.outputPerMTok)
  ) / 1_000_000;
  assert.deepEqual(priceUsage({ model: "claude-opus-5" }, FULL_USAGE, undefined), { costUsd: expected, costProvenance: "priced" });
});

test("done-when 13: declared pricing wins over the seed even when the seed knows the model", () => {
  assert.deepEqual(priceUsage({ model: "claude-opus-5", ...PRICED }, FULL_USAGE, undefined), { costUsd: 1.65, costProvenance: "priced" });
});

test("done-when 14: an unmatched model with no declared pricing stays unknown", () => {
  assert.deepEqual(priceUsage({ model: "not-a-vendored-model" }, FULL_USAGE, undefined), { costUsd: null, costProvenance: undefined });
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

test("done-when 10: a priced bulk-read delegation records costProvenance priced in usage.jsonl", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pricing-bulk-read-"));
  const runDir = mkdtempSync(join(tmpdir(), "pricing-bulk-read-ledger-"));
  const recording = join(directory, "answer.jsonl");
  writeFileSync(recording, `${JSON.stringify({
    envelope: {
      status: "done",
      result: "src/engine/bulk-read.mjs:1 — priced delegation",
      continuationId: null,
      usage: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadInputTokens: 500_000 },
      costUsd: null,
      error: null,
    },
  })}\n`);
  const corpus = join(directory, "corpus.txt");
  writeFileSync(corpus, `${Array.from({ length: READ_LINE_LIMIT + 1 }, (_, index) => `corpus line ${index + 1}`).join("\n")}\n`);
  const runtime = {
    harness: "replay",
    model: "replay-bulk-model",
    config: { "replay.recording": recording },
    pricing: { inputPerMTok: 1.0, cachedInputPerMTok: 0.1, outputPerMTok: 3.0 },
  };
  const savedRun = process.env.FABERUN_RUN_DIR;
  const savedNode = process.env.FABERUN_NODE_ID;
  process.env.FABERUN_RUN_DIR = runDir;
  process.env.FABERUN_NODE_ID = "delegating-node";
  try {
    const result = await bulkRead({ question: "where is pricing decided?", paths: [corpus], runtimes: { deleg: runtime } });
    assert.equal(result.status, "done", result.error?.message);
    const records = readFileSync(join(runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].costUsd, 1.65);
    assert.equal(records[0].costProvenance, "priced", "the delegation priced its own envelope");
  } finally {
    if (savedRun === undefined) delete process.env.FABERUN_RUN_DIR;
    else process.env.FABERUN_RUN_DIR = savedRun;
    if (savedNode === undefined) delete process.env.FABERUN_NODE_ID;
    else process.env.FABERUN_NODE_ID = savedNode;
  }
});

test("done-when 11: appendUsageRecord reads a pre-Phase-4 number with no costProvenance as provider", () => {
  const runDir = mkdtempSync(join(tmpdir(), "pricing-legacy-invocation-"));
  appendUsageRecord(runDir, /** @type {any} */ ({
    id: "legacy-invocation",
    runId: "legacy-run",
    nodeId: "build",
    runtimeId: "luna",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0 },
    costUsd: 0.42,
  }));
  const records = readFileSync(join(runDir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].costUsd, 0.42);
  assert.equal(records[0].costProvenance, "provider", "absence of the field keeps the pre-Phase-4 rule");
});

test("an unknown cost names its reason", () => {
  const runDir = mkdtempSync(join(tmpdir(), "pricing-unknown-reasons-"));
  /** @param {Record<string, unknown>} overrides @param {Parameters<typeof appendUsageRecord>[2]} [options] */
  const append = (overrides, options = {}) => appendUsageRecord(runDir, /** @type {any} */ (invocation(overrides)), options);
  append({ id: "no-stream", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null } }, { runtime: { capabilities: { usage: false } } });
  append({ id: "not-priced", model: "not-a-vendored-model", usage: { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 0 } });
  append({ id: "nothing", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null } });
  append({ id: "killed", signal: "SIGTERM", usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null } });
  appendUsageRecord(runDir, /** @type {any} */ (invocation({ id: "legacy", costUsd: null, costProvenance: "unknown" })));

  const path = join(runDir, "usage.jsonl");
  const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.unknownReason), [
    "no-usage-stream",
    "model-not-priced",
    "provider-reported-nothing",
    "invocation-killed",
    "provider-reported-nothing",
  ]);
  // A record from before R4 has no reason and is read as legacy, while every
  // record written by the new append path has one of the four closed reasons.
  delete records[4].unknownReason;
  const metrics = projectMetrics({ usageRecords: records });
  assert.deepEqual(metrics.usageCostUsd.unknownCountByReason, {
    "invocation-killed": 1,
    "legacy": 1,
    "model-not-priced": 1,
    "no-usage-stream": 1,
    "provider-reported-nothing": 1,
  });
  assert.deepEqual(metrics.usageCostUsd.unknownFractionByReason, {
    "invocation-killed": 0.2,
    "legacy": 0.2,
    "model-not-priced": 0.2,
    "no-usage-stream": 0.2,
    "provider-reported-nothing": 0.2,
  });
});

test("a priced model with partial usage cannot be mislabeled provider-reported-nothing", () => {
  const runDir = mkdtempSync(join(tmpdir(), "pricing-partial-usage-"));
  appendUsageRecord(runDir, /** @type {any} */ (invocation({
    model: "claude-opus-5",
    usage: { inputTokens: 4, outputTokens: null, cacheReadInputTokens: null },
  })));
  const record = JSON.parse(readFileSync(join(runDir, "usage.jsonl"), "utf8"));
  assert.equal(record.unknownReason, "model-not-priced");
  assert.notEqual(record.unknownReason, "provider-reported-nothing");
});
