/**
 * The R5 expense estimate: turn this target project's durable completed
 * execution nodes into the cost and elapsed-duration ranges the Campaign Brief
 * renders. The module is presentation-adjacent but owns no rendering; it reads
 * a validated contract and one recorded pool, and returns a `BriefEstimateInput`
 * the campaign core normalizes.
 *
 * Two rules shape everything here. First, a measure is only a range when every
 * assigned role has at least five distinct comparable completed nodes that
 * carry the evidence that measure needs — priced `usage.jsonl` cost for cost,
 * recorded actual node and verification elapsed times for duration. Anything
 * less is `insufficient data` with the reason, never zero and never a point
 * estimate. Second, elapsed duration is scheduled through the real `dependsOn`
 * graph under `maxParallel` and each runtime's `maxConcurrent`, so the range
 * reflects capacity, not merely which nodes are dependency-independent.
 *
 * `timeoutSec` is never read. It is a ceiling on a planned command, not a
 * measurement of a completed one; the estimate uses only recorded history and
 * says so in its method and assumptions.
 */
import { collectCompletedExecutionNodes } from "../run/usage.mjs";
import { asArray, unique } from "../campaign/brief-text.mjs";
import { scheduleUnderCapacity } from "../campaign/campaign-brief-graph.mjs";

/** @typedef {import("../run/usage.mjs").CompletedExecutionNode} CompletedExecutionNode */
/** @typedef {import("../run/usage.mjs").CompletedExecutionPool} CompletedExecutionPool */
/** @typedef {import("../campaign/campaign-brief.mjs").BriefEstimateInput} BriefEstimateInput */
/** @typedef {import("../campaign/campaign-brief.mjs").BriefMeasureInput} BriefMeasureInput */
/** @typedef {BriefEstimateInput & {cost: BriefMeasureInput, duration: BriefMeasureInput, method: string[], assumptions: string[]}} BriefExpenseInput */
/** @typedef {Record<string, any>} AnyRecord */
/** @typedef {"worker"|"judge"} ExecutionRole */
/** @typedef {{nodeId: string, role: ExecutionRole, taskKind: string, runtimeId: string|null, model: string|null}} AssignedRole */
/** @typedef {{id: string, runtimeId: string|null, dependsOn: string[]}} ScheduledNode */

/** The comparable-sample floor R5 sets for every assigned role. */
export const SAMPLE_FLOOR = 5;
const DEFAULT_WINDOW_DAYS = 90;
const MINUTE_MS = 60 * 1000;

/**
 * Estimate the contract's expense from its recorded completed execution nodes.
 *
 * When `pool` is supplied it is used as the recorded pool (its samples are
 * still confined to the window); otherwise `runsRoot` and `cutoff` are handed
 * to `collectCompletedExecutionNodes`. A missing cutoff, an unreadable pool,
 * or a role without enough comparable evidence produces `insufficient data`
 * for the affected measure, never a zero.
 *
 * @param {{
 *   contract: AnyRecord,
 *   cutoff?: string|null,
 *   runsRoot?: string,
 *   pool?: CompletedExecutionPool,
 *   windowDays?: number,
 * }} options
 * @returns {BriefExpenseInput}
 */
export function estimateBriefExpense(options) {
  const contract = options?.contract && typeof options.contract === "object" ? options.contract : {};
  const cutoff = typeof options?.cutoff === "string" && options.cutoff.trim() ? options.cutoff : null;
  const cutoffMs = cutoff ? Date.parse(cutoff) : NaN;
  const windowDays = typeof options?.windowDays === "number" && Number.isFinite(options.windowDays) && options.windowDays > 0
    ? options.windowDays
    : DEFAULT_WINDOW_DAYS;
  const assignments = assignedRoles(contract);
  const scheduledNodes = plannedWorkerNodes(contract);
  const runtimes = unique(assignments.map((assignment) => assignment.runtimeId).filter((id) => id !== null).map(String));
  const models = unique(assignments.map((assignment) => assignment.model).filter((model) => model !== null).map(String));
  const nodeCount = Array.isArray(contract.nodes) ? contract.nodes.length : 0;
  const workerCount = assignments.filter((assignment) => assignment.role === "worker").length;
  const maxParallel = Number.isInteger(contract.maxParallel) && contract.maxParallel > 0 ? contract.maxParallel : 1;
  const maxConcurrent = concurrencyLimits(contract);
  const effectiveConcurrency = scheduledNodes.length > 0
    ? Math.max(1, scheduleUnderCapacity(scheduledNodes, () => 1, maxParallel, maxConcurrent).peakConcurrency)
    : 1;

  const method = [
    `Comparable completed nodes share task kind, runtime id, model and worker/judge role; a range needs at least ${SAMPLE_FLOOR} distinct nodes for every assigned role.`,
    "Cost is the sum of each comparable role's priced usage.jsonl invocation costs; duration is each comparable node's actual elapsed time plus its recorded verification elapsed time.",
    "Elapsed duration is scheduled through the dependsOn graph under maxParallel and each runtime's maxConcurrent capacity.",
    "Historical timings are proxies for planned commands that have not run yet; timeoutSec is a ceiling and is never used as a measurement.",
  ];
  const assumptions = [
    `Pool is this target project's durable runs completed in the ${windowDays} days before the recorded usage cutoff.`,
    "Planning/discovery runs and incomplete nodes are excluded.",
    "Ranges are advisory, never spend or time ceilings.",
  ];

  /** @param {string} reason @returns {BriefExpenseInput} */
  const bothInsufficient = (reason) => ({
    cost: measure("insufficient data", reason, { provenance: "priced usage.jsonl invocations" }),
    duration: measure("insufficient data", reason, { provenance: "recorded actual node and verification elapsed times" }),
    runtimes,
    models,
    effectiveConcurrency,
    nodeCount,
    workerCount,
    sampleCutoff: cutoff,
    method,
    assumptions,
  });

  if (!Number.isFinite(cutoffMs)) {
    return bothInsufficient("usage sample cutoff is not recorded, so no history window can be established");
  }
  if (assignments.length === 0) {
    return bothInsufficient("the contract assigns no worker or judge role");
  }

  const pool = resolvePool(options, cutoff, windowDays);
  if (!pool.readable) {
    return bothInsufficient(`history pool is unreadable: ${describeUnreadable(pool)}`);
  }
  const windowStartMs = cutoffMs - windowDays * 24 * 60 * 60 * 1000;
  const samples = pool.nodes.filter((sample) => withinWindow(sample.completedAt, cutoffMs, windowStartMs));
  const unreadableNote = pool.unreadable.length > 0 ? [`Unreadable runs were skipped: ${describeUnreadable(pool)}.`] : [];

  return {
    cost: costMeasure(assignments, samples),
    duration: durationMeasure(assignments, samples, scheduledNodes, maxParallel, maxConcurrent),
    runtimes,
    models,
    effectiveConcurrency,
    nodeCount,
    workerCount,
    sampleCutoff: cutoff,
    method,
    assumptions: [...assumptions, ...unreadableNote],
  };
}

/**
 * @param {{
 *   pool?: CompletedExecutionPool,
 *   runsRoot?: string,
 *   windowDays?: number,
 * }} options
 * @param {string|null} cutoff
 * @param {number} windowDays
 * @returns {CompletedExecutionPool}
 */
function resolvePool(options, cutoff, windowDays) {
  if (options?.pool && Array.isArray(options.pool.nodes)) return options.pool;
  if (typeof options?.runsRoot === "string" && options.runsRoot) {
    return collectCompletedExecutionNodes({ runsRoot: options.runsRoot, cutoff: cutoff ?? "", windowDays });
  }
  return {
    nodes: [],
    sourceRuns: [],
    unreadable: [{ runId: null, reason: "no completed-execution pool or runs root was provided" }],
    scannedRuns: 0,
    readable: false,
  };
}

/**
 * The assigned role keys of the contract: every node has a worker role, and a
 * node whose gate is enabled with a non-`none` review also has a judge role.
 *
 * @param {AnyRecord} contract
 * @returns {AssignedRole[]}
 */
function assignedRoles(contract) {
  const nodes = Array.isArray(contract.nodes) ? contract.nodes : [];
  const defaults = contract.runtimeDefaults && typeof contract.runtimeDefaults === "object" ? contract.runtimeDefaults : {};
  const runtimes = runtimeTable(contract);
  /** @type {AssignedRole[]} */
  const assignments = [];
  for (const node of nodes) {
    const nodeId = String(node?.id ?? "");
    const taskKind = typeof node?.type === "string" ? node.type : "";
    const workerRuntimeId = typeof node?.runtime === "string" && node.runtime
      ? node.runtime
      : typeof defaults.worker === "string" && defaults.worker ? defaults.worker : null;
    assignments.push({
      nodeId,
      role: "worker",
      taskKind,
      runtimeId: workerRuntimeId,
      model: modelFor(runtimes, workerRuntimeId),
    });
    const gate = node?.gate && typeof node.gate === "object" ? node.gate : null;
    const judgeEnabled = gate !== null && gate.enabled === true && (gate.review ?? "blocking") !== "none";
    if (!judgeEnabled) continue;
    const judgeRuntimeId = typeof gate.runtime === "string" && gate.runtime
      ? gate.runtime
      : typeof defaults.judge === "string" && defaults.judge ? defaults.judge : null;
    assignments.push({
      nodeId,
      role: "judge",
      taskKind,
      runtimeId: judgeRuntimeId,
      model: modelFor(runtimes, judgeRuntimeId),
    });
  }
  return assignments;
}

/**
 * @param {AnyRecord} contract
 * @returns {ScheduledNode[]}
 */
function plannedWorkerNodes(contract) {
  const nodes = Array.isArray(contract.nodes) ? contract.nodes : [];
  const defaults = contract.runtimeDefaults && typeof contract.runtimeDefaults === "object" ? contract.runtimeDefaults : {};
  return nodes.map((node) => ({
    id: String(node?.id ?? ""),
    runtimeId: typeof node?.runtime === "string" && node.runtime
      ? node.runtime
      : typeof defaults.worker === "string" && defaults.worker ? defaults.worker : null,
    dependsOn: asArray(node?.dependsOn).map(String),
  }));
}

/**
 * @param {AnyRecord} contract
 * @returns {Record<string, number>}
 */
function concurrencyLimits(contract) {
  const runtimes = runtimeTable(contract);
  /** @type {Record<string, number>} */
  const limits = {};
  for (const [id, runtime] of Object.entries(runtimes)) {
    limits[id] = Number.isInteger(runtime?.maxConcurrent) && runtime.maxConcurrent > 0 ? runtime.maxConcurrent : 1;
  }
  return limits;
}

/**
 * @param {AnyRecord} contract
 * @returns {Record<string, AnyRecord>}
 */
function runtimeTable(contract) {
  return contract.runtimes && typeof contract.runtimes === "object" && !Array.isArray(contract.runtimes)
    ? contract.runtimes
    : {};
}

/**
 * @param {Record<string, AnyRecord>} runtimes
 * @param {string|null} runtimeId
 * @returns {string|null}
 */
function modelFor(runtimes, runtimeId) {
  if (runtimeId === null) return null;
  const model = runtimes[runtimeId]?.model;
  return typeof model === "string" && model ? model : null;
}

/**
 * The distinct comparable completed nodes for one assigned role and measure.
 * The comparability key is the full tuple of task kind, runtime id, model and
 * role; the measure adds its own evidence requirement.
 *
 * @param {AssignedRole} key
 * @param {CompletedExecutionNode[]} samples
 * @param {"cost"|"duration"} measureName
 * @returns {CompletedExecutionNode[]}
 */
function comparable(key, samples, measureName) {
  const seen = new Set();
  /** @type {CompletedExecutionNode[]} */
  const result = [];
  for (const sample of samples) {
    if (sample.taskKind !== key.taskKind) continue;
    const role = key.role === "worker" ? sample.worker : sample.judge;
    if (!role || role.runtimeId !== key.runtimeId || role.model !== key.model) continue;
    if (measureName === "cost" && !(typeof role.costUsd === "number" && Number.isFinite(role.costUsd) && role.costProvenance === "priced")) continue;
    if (measureName === "duration" && !(typeof sample.durationMs === "number" && Number.isFinite(sample.durationMs))) continue;
    const identity = `${sample.runId}\u0000${sample.nodeId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(sample);
  }
  return result;
}

/**
 * @param {AssignedRole[]} assignments
 * @param {CompletedExecutionNode[]} samples
 * @returns {BriefMeasureInput}
 */
function costMeasure(assignments, samples) {
  const byNode = groupByNode(assignments);
  let min = 0;
  let max = 0;
  let minSamples = Infinity;
  const contributors = new Set();
  for (const [nodeId, roles] of byNode) {
    for (const key of roles) {
      const eligible = comparable(key, samples, "cost");
      if (eligible.length < SAMPLE_FLOOR) {
        return measure("insufficient data", `${describeRole(key)} for node ${nodeId} has ${eligible.length} priced comparable completed node(s), fewer than ${SAMPLE_FLOOR}`, {
          samples: eligible.length,
          provenance: "priced usage.jsonl invocations",
        });
      }
      const costs = eligible.map((sample) => /** @type {number} */ (key.role === "worker" ? sample.worker.costUsd : sample.judge?.costUsd));
      min += Math.min(...costs);
      max += Math.max(...costs);
      minSamples = Math.min(minSamples, eligible.length);
      for (const sample of eligible) contributors.add(`${sample.runId}\u0000${sample.nodeId}`);
    }
  }
  return measure("range", null, {
    min: round(min, 4),
    max: round(max, 4),
    samples: Number.isFinite(minSamples) ? minSamples : 0,
    sourceRuns: sourceRuns(contributors),
    method: "sum of each comparable role's priced usage.jsonl invocation costs, bounded by the least and most expensive comparable node per role",
    provenance: "priced usage.jsonl invocations",
  });
}

/**
 * @param {AssignedRole[]} assignments
 * @param {CompletedExecutionNode[]} samples
 * @param {ScheduledNode[]} scheduledNodes
 * @param {number} maxParallel
 * @param {Record<string, number>} maxConcurrent
 * @returns {BriefMeasureInput}
 */
function durationMeasure(assignments, samples, scheduledNodes, maxParallel, maxConcurrent) {
  const byNode = groupByNode(assignments);
  /** @type {Map<string, number>} */
  const minByNode = new Map();
  /** @type {Map<string, number>} */
  const maxByNode = new Map();
  let minSamples = Infinity;
  const contributors = new Set();
  for (const [nodeId, roles] of byNode) {
    for (const key of roles) {
      const eligible = comparable(key, samples, "duration");
      if (eligible.length < SAMPLE_FLOOR) {
        return measure("insufficient data", `${describeRole(key)} for node ${nodeId} has ${eligible.length} comparable completed node(s) with recorded node and verification elapsed times, fewer than ${SAMPLE_FLOOR}`, {
          samples: eligible.length,
          provenance: "recorded actual node and verification elapsed times",
        });
      }
      minSamples = Math.min(minSamples, eligible.length);
      for (const sample of eligible) contributors.add(`${sample.runId}\u0000${sample.nodeId}`);
      // The worker role carries the planned node's elapsed cost; the judge
      // role is separate evidence and is counted, but its node is the same
      // node, so adding it again would double-count the elapsed time.
      if (key.role !== "worker") continue;
      const durations = eligible.map((sample) => /** @type {number} */ (sample.durationMs));
      minByNode.set(nodeId, Math.min(...durations));
      maxByNode.set(nodeId, Math.max(...durations));
    }
  }
  const lower = scheduleUnderCapacity(scheduledNodes, (node) => minByNode.get(node.id) ?? 0, maxParallel, maxConcurrent);
  const upper = scheduleUnderCapacity(scheduledNodes, (node) => maxByNode.get(node.id) ?? 0, maxParallel, maxConcurrent);
  return measure("range", null, {
    min: round(lower.makespanMs / MINUTE_MS, 1),
    max: round(upper.makespanMs / MINUTE_MS, 1),
    samples: Number.isFinite(minSamples) ? minSamples : 0,
    sourceRuns: sourceRuns(contributors),
    method: "dependency-graph schedule under maxParallel and each runtime's maxConcurrent, using each comparable node's actual elapsed time plus recorded verification elapsed time",
    provenance: "recorded actual node and verification elapsed times",
  });
}

/**
 * @param {AssignedRole[]} assignments
 * @returns {Map<string, AssignedRole[]>}
 */
function groupByNode(assignments) {
  /** @type {Map<string, AssignedRole[]>} */
  const grouped = new Map();
  for (const assignment of assignments) {
    const list = grouped.get(assignment.nodeId) ?? [];
    list.push(assignment);
    grouped.set(assignment.nodeId, list);
  }
  return grouped;
}

/**
 * @param {AssignedRole} key
 * @returns {string}
 */
function describeRole(key) {
  return `${key.role} ${key.taskKind || "(no task kind)"}/${key.runtimeId ?? "(no runtime)"}/${key.model ?? "(no model)"}`;
}

/**
 * @param {CompletedExecutionPool} pool
 * @returns {string}
 */
function describeUnreadable(pool) {
  const reasons = pool.unreadable.map((entry) => entry.runId ? `${entry.runId}: ${entry.reason}` : entry.reason);
  return reasons.length > 0 ? reasons.join("; ") : "no readable runs";
}

/**
 * @param {Set<string>} identities
 * @returns {string[]}
 */
function sourceRuns(identities) {
  const runs = new Set();
  for (const identity of identities) {
    const runId = identity.split("\u0000")[0];
    if (runId) runs.add(runId);
  }
  return [...runs].sort();
}

/**
 * @param {string|null} completedAt
 * @param {number} cutoffMs
 * @param {number} windowStartMs
 * @returns {boolean}
 */
function withinWindow(completedAt, cutoffMs, windowStartMs) {
  if (typeof completedAt !== "string") return false;
  const completedMs = Date.parse(completedAt);
  return Number.isFinite(completedMs) && completedMs <= cutoffMs && completedMs >= windowStartMs;
}

/**
 * Build a measure object. A `range` carries finite bounds; `insufficient data`
 * carries the reason and never a zero bound.
 *
 * @param {"range"|"insufficient data"} status
 * @param {string|null} reason
 * @param {{min?: number, max?: number, samples?: number, sourceRuns?: string[], method?: string, provenance?: string}} [values]
 * @returns {BriefMeasureInput}
 */
function measure(status, reason, values = {}) {
  return {
    status,
    min: status === "range" ? values.min ?? null : null,
    max: status === "range" ? values.max ?? null : null,
    samples: typeof values.samples === "number" ? values.samples : null,
    reason: status === "range" ? null : reason,
    sourceRuns: values.sourceRuns ?? [],
    method: values.method ?? null,
    provenance: values.provenance ?? null,
  };
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
