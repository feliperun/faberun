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
import { liveUsage } from "../harnesses/session-metrics.mjs";

import { priceUsage } from "../engine/process.mjs";
import { readBoundedTail, sessionLedger } from "../engine/transcript.mjs";
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
  // The per-request ledger is read here, with the usage, for the same reason
  // the usage is: after this point the transcript may already be capped.
  const session = sessionLedger(job);
  job.invocation.session = session;
  state.invocations = (state.invocations ?? []).map((invocation) => invocation.id === job.invocation.id
    ? { ...invocation, usage: envelope.usage, costUsd: envelope.costUsd, costProvenance: envelope.costProvenance, session }
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
    session: invocation.session ?? null,
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

// --- R5 expense pool -------------------------------------------------------
//
// The Campaign Brief's cost and duration estimate may only use this target
// project's durable completed execution nodes. Collection is deliberately
// narrow: a node enters the pool only when its persisted snapshot says `done`,
// its run is an execution (not planning/discovery) contract, its completion
// falls inside the recorded window, and the node carries the worker evidence
// the comparability key needs. Nothing here estimates a missing value; a field
// without recorded evidence stays null so the estimate can say
// `insufficient data` instead of inventing a zero.

/** @typedef {{runtimeId: string|null, model: string|null, costUsd: number|null, costProvenance: string|null}} CompletedExecutionRole */
/**
 * One completed execution node, with the worker (and optional judge) role
 * evidence the estimate compares against a planned assignment. `costUsd` is
 * non-null only when every invocation for that role is priced; `durationMs` is
 * non-null only when both the node's actual elapsed time and its verification
 * elapsed time are recorded. `timeoutSec` is never read: it is a ceiling, not a
 * measurement.
 *
 * @typedef {object} CompletedExecutionNode
 * @property {string} runId
 * @property {string} nodeId
 * @property {string} taskKind
 * @property {string|null} completedAt
 * @property {number|null} nodeElapsedMs
 * @property {number|null} verificationElapsedMs
 * @property {number|null} durationMs
 * @property {CompletedExecutionRole} worker
 * @property {CompletedExecutionRole|null} judge
 */
/** @typedef {{runId: string|null, reason: string}} UnreadableRun */
/**
 * @typedef {object} CompletedExecutionPool
 * @property {CompletedExecutionNode[]} nodes
 * @property {string[]} sourceRuns
 * @property {UnreadableRun[]} unreadable
 * @property {number} scannedRuns
 * @property {boolean} readable
 */

/**
 * Collect this project's durable completed execution nodes for the 90 days
 * before `cutoff`. Planning/discovery runs and incomplete nodes are excluded;
 * a run whose contract or node directory cannot be read is named in
 * `unreadable` rather than silently dropped, so the estimate can report
 * `insufficient data` with a reason. Cost evidence comes from the run's
 * `usage.jsonl` records when present, falling back to the persisted invocation
 * records, and is admitted only when priced.
 *
 * @param {{runsRoot: string, cutoff: string, windowDays?: number}} options
 * @returns {CompletedExecutionPool}
 */
export function collectCompletedExecutionNodes(options) {
  const runsRoot = typeof options?.runsRoot === "string" ? options.runsRoot : "";
  const cutoff = typeof options?.cutoff === "string" ? options.cutoff : "";
  const cutoffMs = Date.parse(cutoff);
  const windowDays = typeof options?.windowDays === "number" && Number.isFinite(options.windowDays) && options.windowDays > 0
    ? options.windowDays
    : 90;
  if (!runsRoot) {
    return { nodes: [], sourceRuns: [], unreadable: [{ runId: null, reason: "no runs root was provided" }], scannedRuns: 0, readable: false };
  }
  if (!Number.isFinite(cutoffMs)) {
    return { nodes: [], sourceRuns: [], unreadable: [{ runId: null, reason: `usage cutoff ${cutoff || "(missing)"} is not a valid date` }], scannedRuns: 0, readable: false };
  }
  let runIds;
  try {
    runIds = readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    return { nodes: [], sourceRuns: [], unreadable: [{ runId: null, reason: `runs root ${runsRoot} is unreadable: ${errorMessage(error)}` }], scannedRuns: 0, readable: false };
  }
  const windowStartMs = cutoffMs - windowDays * 24 * 60 * 60 * 1000;
  /** @type {CompletedExecutionNode[]} */
  const nodes = [];
  /** @type {UnreadableRun[]} */
  const unreadable = [];
  const sourceRuns = new Set();
  for (const runId of runIds) {
    const runDir = join(runsRoot, runId);
    // The runs root also holds sibling trees (`campaigns/`, `worktrees/`).
    // Only a directory carrying run metadata or node snapshots is a run; a
    // run-shaped directory whose contract is gone is no longer silently
    // skipped, it is named unreadable.
    const isRun = existsSync(join(runDir, "run.json")) || existsSync(join(runDir, "bootstrap.json")) || existsSync(join(runDir, "nodes"));
    if (!isRun) continue;
    let contract;
    try {
      contract = JSON.parse(readFileSync(join(runDir, "contract.json"), "utf8"));
    } catch (error) {
      unreadable.push({ runId, reason: `contract.json is unreadable: ${errorMessage(error)}` });
      continue;
    }
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
      unreadable.push({ runId, reason: "contract.json is not a JSON object" });
      continue;
    }
    const contractNodes = /** @type {any[]} */ (Array.isArray(contract.nodes) ? contract.nodes : []);
    const contractById = new Map(contractNodes.map((node) => [String(node?.id ?? ""), node]));
    if (contractNodes.length > 0 && contractNodes.every((node) => node?.taskPacket?.mode === "discovery")) continue;
    /** @type {Map<string, Record<string, unknown>[]>} */
    let usageByNode;
    try {
      usageByNode = readUsageByNode(runDir);
    } catch {
      usageByNode = new Map();
    }
    let snapshotNames;
    try {
      snapshotNames = readdirSync(join(runDir, "nodes")).filter((name) => name.endsWith(".json"));
    } catch (error) {
      unreadable.push({ runId, reason: `nodes directory is unreadable: ${errorMessage(error)}` });
      continue;
    }
    for (const name of snapshotNames) {
      let snapshot;
      try {
        snapshot = JSON.parse(readFileSync(join(runDir, "nodes", name), "utf8"));
      } catch {
        // A torn snapshot contributes nothing; a measurement never fails
        // because one run was mid-write.
        continue;
      }
      if (!snapshot || snapshot.status !== "done") continue;
      const nodeId = String(snapshot.id ?? "");
      const contractNode = contractById.get(nodeId);
      if (contractNode?.taskPacket?.mode === "discovery") continue;
      const taskKind = typeof snapshot.type === "string" ? snapshot.type : "";
      if (!taskKind) continue;
      const completedAt = typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : null;
      const completedMs = completedAt ? Date.parse(completedAt) : NaN;
      if (!Number.isFinite(completedMs) || completedMs > cutoffMs || completedMs < windowStartMs) continue;
      const invocations = Array.isArray(snapshot.invocations) ? /** @type {Record<string, unknown>[]} */ (snapshot.invocations) : [];
      const usageRecords = usageByNode.get(nodeId) ?? [];
      const worker = roleEvidence("worker", usageRecords, invocations, contract, contractNode);
      if (worker === null) continue;
      const judge = roleEvidence("judge", usageRecords, invocations, contract, contractNode);
      const nodeElapsedMs = elapsedBetween(snapshot.startedAt, snapshot.updatedAt);
      const verificationElapsedMs = verificationElapsed(snapshot.verification);
      nodes.push({
        runId,
        nodeId,
        taskKind,
        completedAt,
        nodeElapsedMs,
        verificationElapsedMs,
        durationMs: nodeElapsedMs !== null && verificationElapsedMs !== null ? nodeElapsedMs + verificationElapsedMs : null,
        worker,
        judge,
      });
      sourceRuns.add(runId);
    }
  }
  return { nodes, sourceRuns: [...sourceRuns], unreadable, scannedRuns: runIds.length, readable: true };
}

/**
 * @param {string} runDir
 * @returns {Map<string, Record<string, unknown>[]>}
 */
function readUsageByNode(runDir) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byNode = new Map();
  const path = join(runDir, USAGE_LOG_NAME);
  if (!existsSync(path)) return byNode;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const nodeId = typeof record.nodeId === "string" ? record.nodeId : null;
    if (nodeId === null) continue;
    const list = byNode.get(nodeId) ?? [];
    list.push(record);
    byNode.set(nodeId, list);
  }
  return byNode;
}

/**
 * The role evidence for one completed node. `usage.jsonl` records are the
 * priced source; persisted snapshot invocations stand in only when the ledger
 * has no record for the node, so provenance is still the recorded value and
 * never a recomputation. A role whose invocations are not all priced has no
 * cost evidence (null), rather than a partial sum.
 *
 * @param {"worker"|"judge"} role
 * @param {Record<string, unknown>[]} usageRecords
 * @param {Record<string, unknown>[]} invocations
 * @param {Record<string, any>} contract
 * @param {Record<string, any>|undefined} contractNode
 * @returns {CompletedExecutionRole|null}
 */
function roleEvidence(role, usageRecords, invocations, contract, contractNode) {
  const fromUsage = usageRecords.filter((record) => record?.role === role);
  const source = fromUsage.length > 0
    ? fromUsage
    : invocations.filter((invocation) => invocation?.role === role || invocation?.phase === role);
  if (source.length === 0) return null;
  const last = source[source.length - 1];
  const defaultRuntime = role === "worker" ? contract.runtimeDefaults?.worker : contract.runtimeDefaults?.judge;
  const gateRuntime = contractNode?.gate && typeof contractNode.gate === "object" ? contractNode.gate.runtime : null;
  const declaredRuntime = role === "worker" ? contractNode?.runtime : gateRuntime;
  const runtimeId = typeof last.runtimeId === "string" && last.runtimeId
    ? last.runtimeId
    : typeof declaredRuntime === "string" && declaredRuntime
      ? declaredRuntime
      : typeof defaultRuntime === "string" && defaultRuntime ? defaultRuntime : null;
  const runtimes = contract.runtimes && typeof contract.runtimes === "object" && !Array.isArray(contract.runtimes)
    ? /** @type {Record<string, any>} */ (contract.runtimes)
    : {};
  const declaredModel = runtimeId !== null && runtimes[runtimeId] && typeof runtimes[runtimeId].model === "string" ? runtimes[runtimeId].model : null;
  const model = typeof last.model === "string" && last.model ? last.model : declaredModel;
  const priced = source.every((record) => typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costProvenance === "priced");
  const costUsd = priced ? source.reduce((total, record) => total + /** @type {number} */ (record.costUsd), 0) : null;
  return { runtimeId, model, costUsd, costProvenance: costUsd === null ? null : "priced" };
}

/**
 * The elapsed time between two ISO timestamps, or null when either is missing
 * or the pair is not ordered.
 *
 * @param {unknown} start
 * @param {unknown} end
 * @returns {number|null}
 */
function elapsedBetween(start, end) {
  const startMs = typeof start === "string" ? Date.parse(start) : NaN;
  const endMs = typeof end === "string" ? Date.parse(end) : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

/**
 * The recorded verification elapsed time: the sum of each attempt's reported
 * `durationMs`, or its start/completed pair when the duration is absent. A
 * verification object with no `attempts` array is not recorded and returns
 * null; an empty attempts array is a recorded zero.
 *
 * @param {unknown} verification
 * @returns {number|null}
 */
function verificationElapsed(verification) {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) return null;
  const record = /** @type {Record<string, unknown>} */ (verification);
  if (!Array.isArray(record.attempts)) return null;
  let total = 0;
  for (const attempt of record.attempts) {
    if (!attempt || typeof attempt !== "object") return null;
    const entry = /** @type {Record<string, unknown>} */ (attempt);
    const result = entry.result && typeof entry.result === "object" ? /** @type {Record<string, unknown>} */ (entry.result) : null;
    const duration = result && typeof result.durationMs === "number" && Number.isFinite(result.durationMs) ? result.durationMs : null;
    const measured = duration !== null ? duration : elapsedBetween(entry.startedAt, entry.completedAt);
    if (measured === null) return null;
    total += measured;
  }
  return total;
}
