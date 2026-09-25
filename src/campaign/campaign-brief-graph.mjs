/**
 * The Campaign Brief's work graph: dependency edges, per-node worker/judge
 * runtimes, per-runtime concurrency caps and the schedule they allow. Split
 * out of `campaign-brief.mjs` (R20), already at this repository's 800-line
 * ceiling, so the same-provider review marking (R20) had a file with room to
 * land in.
 *
 * The frozen contract this reads has already passed `validateContract`, which
 * is the one place that enforces same-vendor mode's tier rule
 * (`contract/judge-independence.mjs`); a node this module marks
 * `sameProviderReview` could only exist here because that check already
 * passed, so the mark is a plain vendor-and-opt-in comparison, not a second
 * enforcement of the rule.
 */
import { asArray } from "./brief-text.mjs";
import { sharesVendorThroughFallback } from "../contract/judge-independence.mjs";

/** @typedef {Record<string, any>} AnyRecord */
/** @typedef {{id: string, runtimeId: string|null, model: string|null, judgeRuntimeId?: string|null, sameProviderReview?: boolean, dependsOn: string[], requirementIds: string[]}} BriefGraphNode */
/** @typedef {{from: string, to: string}} BriefGraphEdge */
/** @typedef {{node: string, prerequisites: string[]}} BriefBlockingNode */
/** @typedef {{nodes: BriefGraphNode[], edges: BriefGraphEdge[], independent: string[], blocking: BriefBlockingNode[], maxParallel: number, maxConcurrent: Record<string, number>, effectiveConcurrency: number, dispatchableTogether: string[], dispatchNote: string, gaps: string[]}} BriefGraph */

/**
 * @param {AnyRecord} contract
 * @param {AnyRecord[]} nodes
 * @returns {BriefGraph}
 */
export function buildGraph(contract, nodes) {
  const runtimes = contract.runtimes && typeof contract.runtimes === "object" && !Array.isArray(contract.runtimes)
    ? /** @type {Record<string, AnyRecord>} */ (contract.runtimes)
    : {};
  const ids = new Set(nodes.map((node) => String(node.id ?? "")));
  /** @type {string[]} */
  const gaps = [];
  /** @type {BriefGraphEdge[]} */
  const edges = [];
  /** @type {BriefGraphNode[]} */
  const graphNodes = nodes.map((node) => {
    const id = String(node.id ?? "");
    const dependsOn = asArray(node.dependsOn).map(String);
    for (const dependency of dependsOn) {
      if (dependency === id) {
        gaps.push(`node ${id} depends on itself`);
      } else if (!ids.has(dependency)) {
        gaps.push(`node ${id} depends on unknown node ${dependency}`);
      } else {
        edges.push({ from: dependency, to: id });
      }
    }
    const runtimeId = typeof node.runtime === "string"
      ? node.runtime
      : typeof contract.runtimeDefaults?.worker === "string" ? contract.runtimeDefaults.worker : null;
    const runtime = runtimeId !== null && typeof runtimes[runtimeId] === "object" ? runtimes[runtimeId] : null;
    return {
      id,
      runtimeId,
      model: runtime && typeof runtime.model === "string" ? runtime.model : null,
      judgeRuntimeId: judgeRuntimeIdOf(contract, node),
      sameProviderReview: sameProviderReviewOf(contract, runtimes, runtimeId, node),
      dependsOn,
      requirementIds: asArray(node.requirementIds).map(String),
    };
  });
  const independent = graphNodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id);
  const blocking = graphNodes.filter((node) => node.dependsOn.length > 0).map((node) => ({ node: node.id, prerequisites: node.dependsOn }));
  /** @type {Record<string, number>} */
  const maxConcurrent = {};
  for (const node of graphNodes) {
    if (node.runtimeId === null) continue;
    const runtime = runtimes[node.runtimeId];
    const limit = runtime && Number.isInteger(runtime.maxConcurrent) && runtime.maxConcurrent > 0 ? runtime.maxConcurrent : 1;
    maxConcurrent[node.runtimeId] = maxConcurrent[node.runtimeId] === undefined ? limit : Math.min(maxConcurrent[node.runtimeId], limit);
  }
  const maxParallel = Number.isInteger(contract.maxParallel) && contract.maxParallel > 0 ? contract.maxParallel : 1;
  // Effective concurrency, and the workers that can actually be in flight
  // together, are properties of the graph and the capacities -- not the size of
  // the dependency-independent set. Two independent nodes still cannot run
  // together when maxParallel is 1 or their shared runtime is at its cap.
  const schedule = scheduleUnderCapacity(
    graphNodes.map((node) => ({ id: node.id, runtimeId: node.runtimeId, dependsOn: node.dependsOn })),
    () => 1,
    maxParallel,
    maxConcurrent,
  );
  const effectiveConcurrency = Math.max(1, schedule.peakConcurrency);
  const dispatchableTogether = schedule.peakNodeIds;
  return {
    nodes: graphNodes,
    edges,
    independent,
    blocking,
    maxParallel,
    maxConcurrent,
    effectiveConcurrency,
    dispatchableTogether,
    dispatchNote: dispatchNoteFor(dispatchableTogether, graphNodes.length, maxParallel),
    gaps,
  };
}

/**
 * @param {AnyRecord} contract
 * @param {AnyRecord} node
 * @returns {string|null}
 */
function judgeRuntimeIdOf(contract, node) {
  const gate = node.gate;
  const gateEnabled = gate !== false && gate !== undefined && (gate.enabled === undefined || gate.enabled === true);
  if (!gateEnabled) return null;
  if (typeof gate.runtime === "string") return gate.runtime;
  return typeof contract.runtimeDefaults?.judge === "string" ? contract.runtimeDefaults.judge : null;
}

/**
 * Whether the frozen contract already marked this node's pairing admitted
 * under same-vendor mode (R20): the worker's declared runtime, or its one-hop
 * fallback, shares a vendor with the judge, and only `judgeIndependence:
 * "same-vendor"` on the contract admits that -- `validateContract` refuses
 * every other same-vendor pairing (primary or fallback) before it can reach a
 * frozen `contract.json`. The fallback is included because it is a real way
 * this node lands a same-provider review, not only the primary pairing: a
 * plan-time surface has no run to read, so it reports every reachable
 * pairing rather than only the one dispatch happens to pick.
 *
 * @param {AnyRecord} contract
 * @param {Record<string, AnyRecord>} runtimes
 * @param {string|null} workerRuntimeId
 * @param {AnyRecord} node
 * @returns {boolean}
 */
function sameProviderReviewOf(contract, runtimes, workerRuntimeId, node) {
  if (contract.judgeIndependence !== "same-vendor") return false;
  const judgeRuntimeId = judgeRuntimeIdOf(contract, node);
  if (workerRuntimeId === null || judgeRuntimeId === null) return false;
  const judgeVendor = runtimes[judgeRuntimeId]?.vendor;
  return sharesVendorThroughFallback(runtimes, workerRuntimeId, judgeVendor);
}

/**
 * Why capacity does or does not let two workers run at the same time. The note
 * is the model's honest reading of the limits, so a renderer never has to
 * decide whether an independent pair is "simultaneously dispatchable": with
 * `maxParallel` 1 the answer is always no.
 *
 * @param {string[]} dispatchableTogether
 * @param {number} nodeCount
 * @param {number} maxParallel
 * @returns {string}
 */
function dispatchNoteFor(dispatchableTogether, nodeCount, maxParallel) {
  if (dispatchableTogether.length >= 2) {
    return `up to ${dispatchableTogether.length} workers run together under maxParallel ${maxParallel} and the per-runtime maxConcurrent caps`;
  }
  if (nodeCount < 2) return "fewer than two nodes are planned";
  if (maxParallel <= 1) return "maxParallel is 1, so dependency-independent nodes are not simultaneously dispatchable";
  return "each assigned runtime's maxConcurrent admits only one worker at a time";
}

/**
 * Schedule a dependency graph under a global `maxParallel` ceiling and each
 * runtime's own `maxConcurrent` ceiling, reporting the wall-clock makespan and
 * the peak number of nodes running at once. `durationOf` supplies each node's
 * duration, so scheduling the graph with lower and upper per-node durations
 * turns a per-node range into a plan-level elapsed range. The peak is a
 * property of the graph and the capacities, not of the dependency-independent
 * set.
 *
 * @param {{id: string, runtimeId: string|null, dependsOn: string[]}[]} nodes
 * @param {(node: {id: string}) => number} durationOf
 * @param {number} maxParallel
 * @param {Record<string, number>} maxConcurrent
 * @returns {{makespanMs: number, peakConcurrency: number, peakNodeIds: string[]}}
 */
export function scheduleUnderCapacity(nodes, durationOf, maxParallel, maxConcurrent) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const remaining = new Map();
  const dependents = new Map();
  for (const node of nodes) {
    const dependencies = node.dependsOn.filter((id) => byId.has(id));
    remaining.set(node.id, dependencies.length);
    for (const dependency of dependencies) dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.id]);
  }
  const running = new Map();
  const runtimeRunning = new Map();
  const done = new Set();
  const limit = Number.isInteger(maxParallel) && maxParallel > 0 ? maxParallel : 1;
  let time = 0;
  let peak = 0;
  /** @type {string[]} */
  let peakNodeIds = [];
  while (done.size < nodes.length) {
    for (const node of nodes) {
      if (done.has(node.id) || running.has(node.id) || (remaining.get(node.id) ?? 0) > 0) continue;
      if (running.size >= limit) break;
      const runtimeKey = node.runtimeId ?? "";
      const width = node.runtimeId !== null && Number.isInteger(maxConcurrent[node.runtimeId]) && maxConcurrent[node.runtimeId] > 0 ? maxConcurrent[node.runtimeId] : 1;
      if ((runtimeRunning.get(runtimeKey) ?? 0) >= width) continue;
      const duration = durationOf(node);
      running.set(node.id, time + (Number.isFinite(duration) ? Math.max(0, duration) : 0));
      runtimeRunning.set(runtimeKey, (runtimeRunning.get(runtimeKey) ?? 0) + 1);
      if (running.size > peak) {
        peak = running.size;
        peakNodeIds = [...running.keys()];
      }
    }
    if (running.size === 0) break; // a cycle or nothing dispatchable
    time = Math.min(...running.values());
    for (const [id, finish] of [...running]) {
      if (finish !== time) continue;
      running.delete(id);
      runtimeRunning.set(byId.get(id)?.runtimeId ?? "", Math.max(0, (runtimeRunning.get(byId.get(id)?.runtimeId ?? "") ?? 1) - 1));
      done.add(id);
      for (const dependent of dependents.get(id) ?? []) remaining.set(dependent, Math.max(0, (remaining.get(dependent) ?? 1) - 1));
    }
  }
  return { makespanMs: time, peakConcurrency: peak, peakNodeIds };
}
