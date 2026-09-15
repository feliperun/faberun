/**
 * The usage and cost ledger: `usage.jsonl`, one record per invocation, and the
 * arithmetic that rolls it up onto a node.
 *
 * Reporting only. No control path reads this -- a spent allowance is handled by
 * runtime re-tiering, never by a token or dollar cap -- and that is why a usage
 * the provider did not report stays null instead of becoming a plausible zero.
 */
import { appendJsonl, writeJsonAtomic } from "./store.mjs";
import { basename, join } from "node:path";
import { errorMessage, stableJson } from "../util.mjs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { liveUsage } from "../harnesses/exec-jsonl/index.mjs";

import { priceUsage, readBoundedTail } from "../engine/process.mjs";
import { writeNode } from "../engine/state.mjs";
import { normalizeProviderResult } from "../harnesses/index.mjs";

// `priceUsage` is defined beside `invocationResult`, the second source point,
// and re-exported here so the ledger's public surface is unchanged. This module
// already imports `engine/process.mjs`, so the definition lives there to keep
// the two source points out of a runtime import cycle.
export { priceUsage };

/** @typedef {import("../engine/process.mjs").Invocation} Invocation */
/** @typedef {import("../engine/process.mjs").Job} Job */
/** @typedef {ReturnType<typeof import("../run/lock.mjs").acquire>} LockHandle */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../harnesses/index.mjs").ProviderEnvelope} ProviderEnvelope */
/** @typedef {ProviderEnvelope & {costProvenance?: "priced"}} PricedEnvelope */
/** @typedef {{kind: "adopted"|"rejudge"|"restart"|"reconciled"|"exhausted"|"stalled", phase?: "worker"|"judge", result?: unknown, usage?: Usage, costUsd?: number|null, costProvenance?: "priced", exhaustedUntil?: string|null, error?: {code: string, message: string}|null, invocationId?: string, reason?: string}} RecoveryOutcome */
/** @typedef {import("../contract/index.mjs").Usage} Usage */

/**
 * Extract the invocation's provider envelope from the bounded transcript tail
 * and persist its usage into the matching invocation record. By default the
 * usage is also accumulated into `state.usage` (the caller then transitions or
 * continues); with `accumulate: false` only the invocation record is updated,
 * for jobs whose node already reached a terminal state that already counted
 * this spend.
 *
 * @param {Job} job
 * @param {{accumulate?: boolean}} [options]
 * @returns {PricedEnvelope}
 */
export function recordInvocationUsage(job, options = {}) {
  const { state } = job;
  /** @type {PricedEnvelope} */
  let envelope;
  let boundedStdout = "";
  try {
    boundedStdout = readBoundedTail(job.paths.stdout);
    const boundedStderr = readBoundedTail(job.paths.stderr, 512 * 1024);
    envelope = normalizeProviderResult(job.runtime, boundedStdout, job.exitCode, job.signal, {
      preferStructured: job.phase === "judge",
      stderr: boundedStderr,
    });
  } catch (error) {
    envelope = {
      status: "failed",
      result: null,
      continuationId: null,
      usage: { inputTokens: null, outputTokens: null, cacheReadInputTokens: null },
      costUsd: null,
      error: { code: "invalid_output", message: errorMessage(error) },
    };
  }
  // Failure envelopes carry zeroed usage (a killed provider emits no terminal
  // event), yet its transcript holds real per-turn counters. Backfill the
  // normalized usage components from the live meter so kills, timeouts, and
  // scope failures still report what they spent, cache reads separated.
  if (envelope.usage.inputTokens === null && boundedStdout) {
    const observed = liveUsage(job.runtime.harness, boundedStdout);
    if (observed.inputTokens !== null) {
      envelope = { ...envelope, usage: { ...envelope.usage, inputTokens: observed.inputTokens, cacheReadInputTokens: observed.cacheReadInputTokens } };
    }
  }
  // Price only after the backfill has run: the counters this function persists
  // and returns are the ones the price is derived from, and the envelope becomes
  // the single priced object every later copy spreads from.
  const priced = priceUsage(job.runtime, envelope.usage, envelope.costUsd);
  envelope = { ...envelope, costUsd: priced.costUsd, costProvenance: priced.costProvenance };
  state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === job.invocation.id
    ? { ...invocation, usage: envelope.usage, costUsd: envelope.costUsd, costProvenance: envelope.costProvenance }
    : invocation);
  if (options.accumulate !== false) state.usage = addUsage(state.usage, envelope.usage);
  return envelope;
}
const USAGE_LOG_NAME = "usage.jsonl";
/** @param {Usage|undefined} usage @returns {boolean} */
function hasMeasuredUsage(usage) {
  return Boolean(usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens]
    .some((value) => typeof value === "number" && Number.isFinite(value)));
}
/** @param {NodeSnapshot} state @returns {Usage} */
export function invocationUsage(state) {
  const seen = new Set();
  return (state.invocations ?? []).reduce((total, invocation) => {
    if (invocation.id && seen.has(invocation.id)) return total;
    if (invocation.id) seen.add(invocation.id);
    return addUsage(total, invocation.usage);
  }, /** @type {Usage} */ ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }));
}
/** @param {NodeSnapshot} state @returns {number|undefined} */
export function invocationCost(state) {
  const costs = /** @type {number[]} */ ((state.invocations ?? [])
    .map((invocation) => invocation.costUsd)
    .filter((cost) => typeof cost === "number" && Number.isFinite(cost)));
  return costs.length ? costs.reduce((total, cost) => total + cost, 0) : undefined;
}
/**
 * Invocation ids already present in the run's usage.jsonl. The append path
 * uses this to stay idempotent across resume and replay.
 *
 * @param {string} runDir
 * @returns {Set<string>}
 */
export function usageRecordIds(runDir) {
  const ids = new Set();
  const path = join(runDir, USAGE_LOG_NAME);
  if (!existsSync(path)) return ids;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const value = record && typeof record === "object" && !Array.isArray(record)
        ? /** @type {Record<string, unknown>} */ (record)
        : null;
      if (value && typeof value.invocationId === "string") ids.add(value.invocationId);
    } catch {
      // A truncated tail line is repaired by appendJsonl on the next write.
    }
  }
  return ids;
}
/**
 * Append one usage.jsonl record for a worker or judge invocation. Usage is a
 * reporting record only: no control path reads this file to gate work.
 *
 * @param {string} runDir
 * @param {Invocation|undefined|null} invocation
 */
export function appendUsageRecord(runDir, invocation) {
  if (!invocation?.id || usageRecordIds(runDir).has(invocation.id)) return;
  const usage = /** @type {Usage} */ (invocation.usage ?? { inputTokens: null, outputTokens: null, cacheReadInputTokens: null });
  appendJsonl(join(runDir, USAGE_LOG_NAME), {
    invocationId: invocation.id,
    runId: invocation.runId ?? basename(runDir),
    nodeId: invocation.nodeId ?? null,
    attempt: invocation.attempt ?? null,
    role: invocation.role ?? null,
    runtimeId: invocation.runtimeId ?? null,
    model: invocation.model ?? null,
    inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
    cacheReadInputTokens: typeof usage.cacheReadInputTokens === "number" ? usage.cacheReadInputTokens : null,
    outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
    costUsd: typeof invocation.costUsd === "number" ? invocation.costUsd : null,
    // A persisted `priced` marker wins; otherwise the pre-Phase-4 rule applies
    // unchanged: a reported number is `provider`, absence is `unknown`.
    costProvenance: invocation.costProvenance ?? (typeof invocation.costUsd === "number" ? "provider" : "unknown"),
    startedAt: invocation.startedAt ?? null,
    finishedAt: invocation.closedAt ?? null,
  });
}
/**
 * Recovery can discover usage after the run synchronized its records. Attach
 * it to the authoritative invocation first, then write the updated usage
 * record. The invocation id makes repeated resumes idempotent.
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {RecoveryOutcome|null|undefined} recovery
 * @param {LockHandle} lock
 * @returns {Promise<void>}
 */
export async function persistRecoveryUsage(runDir, state, recovery, lock) {
  if (!recovery?.invocationId) return;
  const current = state.invocations?.find((invocation) => invocation.id === recovery.invocationId);
  if (!current) return;
  const usage = hasMeasuredUsage(current.usage) ? current.usage : recovery.usage;
  // Cost and provenance are selected together from whichever source wins the
  // numeric-cost predicate: an independent fallback could attach a stray
  // recovery provenance to an already-settled cost that was never priced.
  const priced = typeof current.costUsd === "number"
    ? { costUsd: current.costUsd, costProvenance: current.costProvenance }
    : { costUsd: recovery.costUsd ?? null, costProvenance: recovery.costProvenance };
  const changed = stableJson(current.usage) !== stableJson(usage)
    || current.costUsd !== priced.costUsd
    || (current.costProvenance ?? null) !== (priced.costProvenance ?? null);
  if (changed) {
    state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === current.id
      ? { ...invocation, usage, costUsd: priced.costUsd, costProvenance: priced.costProvenance }
      : invocation);
    state.usage = invocationUsage(state);
    writeNode(runDir, state, lock);
  }
  const updated = state.invocations?.find((invocation) => invocation.id === current.id);
  if (updated) appendUsageRecord(runDir, updated);
}
/**
 * @param {Usage|undefined} left
 * @param {Usage|undefined} right
 * @returns {Usage}
 */
function addUsage(left, right) {
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
    cacheReadInputTokens: (left?.cacheReadInputTokens ?? 0) + (right?.cacheReadInputTokens ?? 0),
  };
}
/** @returns {{inputTokens: number|null, outputTokens: number|null, cacheReadInputTokens: number|null}} */
export function emptyUsage() {
  return { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
}

/**
 * The named artifact the fresh-session hypothesis is recorded to. The
 * measurement is the acceptance, not a threshold met: a cohort with no gate
 * revision is recorded as absent rather than compared against an empty set.
 */
export const CACHE_READ_PER_REVISION_ARTIFACT = "cacheReadPerRevision.json";

/** @typedef {{runCount: number, runsWithGateRevision: number, gateRevisions: number, retryWorkerInvocations: number, cacheReadTokens: number, cacheReadPerRevision: number|null}} CacheReadCohort */
/** @typedef {{before: CacheReadCohort, after: CacheReadCohort}} CacheReadCohorts */

/**
 * `cacheReadPerRevision` over one cohort of run directories:
 *
 *   cacheReadPerRevision =
 *     cache-read tokens attributable to gate revisions
 *     / number of gate revisions
 *
 * A gate revision is one `state.revisions` increment — a judge or mechanical
 * rejection that re-dispatched the worker. The persisted ledger does not link
 * an invocation to the rejection that caused it, so the attribution is the
 * declared approximation: the cache-read tokens recorded on worker invocations
 * after the first attempt of their node, which are the retries that include
 * those gate revisions. A cohort with no gate revision reports
 * `cacheReadPerRevision: null`, never a divide-by-zero.
 *
 * @param {string[]} runDirs
 * @returns {CacheReadCohort}
 */
export function measureCacheReadPerRevision(runDirs) {
  let gateRevisions = 0;
  let retryWorkerInvocations = 0;
  let cacheReadTokens = 0;
  let runsWithGateRevision = 0;
  for (const runDir of runDirs) {
    let runRevisions = 0;
    for (const name of listNodeSnapshotFiles(runDir)) {
      let state;
      try {
        state = JSON.parse(readFileSync(join(runDir, "nodes", name), "utf8"));
      } catch {
        // A torn or unreadable snapshot contributes nothing; a measurement
        // never fails because one run was mid-write.
        continue;
      }
      if (typeof state.revisions === "number" && Number.isFinite(state.revisions)) runRevisions += state.revisions;
      for (const invocation of Array.isArray(state.invocations) ? state.invocations : []) {
        if (invocation?.role !== "worker") continue;
        if (!(typeof invocation.attempt === "number" && invocation.attempt > 1)) continue;
        retryWorkerInvocations += 1;
        const cacheRead = invocation.usage?.cacheReadInputTokens;
        if (typeof cacheRead === "number" && Number.isFinite(cacheRead)) cacheReadTokens += cacheRead;
      }
    }
    if (runRevisions > 0) {
      gateRevisions += runRevisions;
      runsWithGateRevision += 1;
    }
  }
  return {
    runCount: runDirs.length,
    runsWithGateRevision,
    gateRevisions,
    retryWorkerInvocations,
    cacheReadTokens,
    cacheReadPerRevision: gateRevisions > 0 ? cacheReadTokens / gateRevisions : null,
  };
}

/**
 * The two declared cohorts and the recorded comparison. `before` is the runs
 * preceding the change commit and `after` those following it; when the after
 * cohort records no gate revision the artifact says so explicitly rather than
 * presenting an empty comparison. `changeCommit` is recorded so the cohort
 * boundary is auditable.
 *
 * @param {CacheReadCohort} before
 * @param {CacheReadCohort} after
 * @param {{changeCommit?: string|null, generatedAt?: string, runDirs?: {before: string[], after: string[]}}} [context]
 * @returns {Record<string, unknown>}
 */
export function cacheReadPerRevisionArtifact(before, after, context = {}) {
  const measured = after.gateRevisions > 0;
  return {
    schemaVersion: 1,
    metric: "cacheReadPerRevision",
    definition: "cache-read tokens attributable to gate revisions divided by the number of gate revisions",
    attribution: "gateRevisions is the sum of persisted node revisions; cacheReadTokens is the cache-read tokens on worker invocations after the first attempt, the retries that include those gate revisions",
    changeCommit: context.changeCommit ?? null,
    generatedAt: context.generatedAt ?? new Date().toISOString(),
    status: measured ? "measured" : "no_post_change_revision",
    note: measured
      ? "the after cohort records at least one gate revision; before and after are compared below"
      : "no post-change gate revision exists: the after cohort records zero gate revisions, so no comparison is fabricated",
    before,
    after,
    ...(context.runDirs ? { runDirs: context.runDirs } : {}),
  };
}

/**
 * Write the measurement to its named artifact path.
 *
 * @param {string} artifactPath
 * @param {CacheReadCohort} before
 * @param {CacheReadCohort} after
 * @param {{changeCommit?: string|null, generatedAt?: string, runDirs?: {before: string[], after: string[]}}} [context]
 * @returns {string} the artifact path
 */
export function writeCacheReadPerRevisionArtifact(artifactPath, before, after, context = {}) {
  writeJsonAtomic(artifactPath, cacheReadPerRevisionArtifact(before, after, context));
  return artifactPath;
}

/** @param {string} runDir @returns {string[]} */
function listNodeSnapshotFiles(runDir) {
  try {
    return readdirSync(join(runDir, "nodes")).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}
