/**
 * Declarative runtime routing: cross a taskKind/riskTier table with live
 * discovery availability to assign a worker and a judge runtime to each of a
 * plan's draft nodes. Separate from runtime-discovery.mjs because that module
 * resolves a *contract's* already-declared runtimes; a plan's draft node
 * never names one (the constitution reserves model choice to runtimes,
 * runtimeDefaults, or an explicit node override) — this module is what turns
 * a taskKind/riskTier classification into one of those three.
 */

import { cheapest, strongest } from "../engine/runtime-discovery.mjs";

/** @typedef {{available: boolean, exhaustedUntil: string|null, [key: string]: unknown}} RoutingAvailability */
/** @typedef {{vendor: string, tier?: number|string, costRank?: number, fallback?: string, [key: string]: unknown}} RoutingRuntime */
/** @typedef {{id: string, taskKind?: string, riskTier?: string}} RoutingNode */
/** @typedef {{taskKind?: string, riskTier?: string}} RoutingWhen */
/** @typedef {{name?: string, when: RoutingWhen, prefer: string[], role: "worker"|"judge"}} RoutingRule */
/** @typedef {{worker?: string, judge?: string}} RoutingRoleMap */
/** @typedef {{table?: RoutingRule[], runtimes: Record<string, RoutingRuntime>, availability?: Record<string, RoutingAvailability>, runtimeDefaults?: RoutingRoleMap, overrides?: Record<string, RoutingRoleMap>}} RoutingConfig */
/** @typedef {{worker: string|null, judge: string|null, rule: {worker: string, judge: string}}} RoutingAssignment */
/** @typedef {{nodeId: string, role: "worker"|"judge", rule: string}} RoutingUnmet */
/** @typedef {{assignments: Record<string, RoutingAssignment>, unmet: RoutingUnmet[]}} RoutingResult */

/**
 * @param {RoutingNode[]} nodes
 * @param {RoutingConfig} config
 * @param {{partial?: boolean}} [options]
 * @returns {RoutingResult}
 */
export function resolveRuntimes(nodes, config, options = {}) {
  const table = config.table ?? [];
  const runtimes = config.runtimes ?? {};
  const availability = config.availability ?? {};
  const runtimeDefaults = config.runtimeDefaults ?? {};
  const overrides = config.overrides ?? {};

  /** @type {Record<string, RoutingAssignment>} */
  const assignments = {};
  /** @type {RoutingUnmet[]} */
  const unmet = [];

  for (const node of nodes) {
    const override = overrides[node.id] ?? {};
    const worker = resolveRole(node, "worker", { runtimes, availability, runtimeDefaults, table, override, forbiddenVendors: EMPTY_VENDORS });
    if (worker.runtimeId === null) unmet.push({ nodeId: node.id, role: "worker", rule: worker.rule });
    // The judge's forbidden vendors follow the worker runtime that was
    // actually chosen, never the row that named it — a worker unmet leaves
    // nothing to conflict with, so the judge resolves without restriction.
    const forbiddenVendors = worker.runtimeId ? forbiddenJudgeVendors(worker.runtimeId, runtimes) : EMPTY_VENDORS;
    const judge = resolveRole(node, "judge", { runtimes, availability, runtimeDefaults, table, override, forbiddenVendors });
    if (judge.runtimeId === null) unmet.push({ nodeId: node.id, role: "judge", rule: judge.rule });
    assignments[node.id] = { worker: worker.runtimeId, judge: judge.runtimeId, rule: { worker: worker.rule, judge: judge.rule } };
  }

  if (unmet.length && options.partial !== true) {
    const detail = unmet.map(({ nodeId, role, rule }) => `${nodeId}.${role} (rule: ${rule})`).join("; ");
    throw new Error(`runtime_routing_unmet: ${detail}`);
  }

  return { assignments, unmet };
}

/** @type {ReadonlySet<string>} */
const EMPTY_VENDORS = Object.freeze(new Set());

/**
 * Precedence for one role on one node: an explicit node override, then the
 * operator's runtimeDefaults, then the first table row whose `when` matches
 * this node's classification, then plain discovery. A row or default that
 * names an unavailable or vendor-forbidden runtime is unmet by that rule —
 * it does not fall through to a lower-precedence source, since falling
 * through would silently discard an explicit declaration; only the
 * candidates *within* a row's `prefer` list, and within discovery, are
 * skipped for exhaustion or vendor conflict.
 *
 * @param {RoutingNode} node
 * @param {"worker"|"judge"} role
 * @param {{runtimes: Record<string, RoutingRuntime>, availability: Record<string, RoutingAvailability>, runtimeDefaults: RoutingRoleMap, table: RoutingRule[], override: RoutingRoleMap, forbiddenVendors: ReadonlySet<string>}} context
 * @returns {{runtimeId: string|null, rule: string}}
 */
function resolveRole(node, role, context) {
  const { runtimes, availability, runtimeDefaults, table, override, forbiddenVendors } = context;

  if (override[role] !== undefined) {
    const id = override[role];
    return { runtimeId: admits(id, runtimes, availability, forbiddenVendors) ? id : null, rule: "override" };
  }

  if (runtimeDefaults[role] !== undefined) {
    const id = runtimeDefaults[role];
    return { runtimeId: admits(id, runtimes, availability, forbiddenVendors) ? id : null, rule: "runtimeDefaults" };
  }

  const row = table.find((candidate) => candidate.role === role
    && (candidate.when.taskKind === undefined || candidate.when.taskKind === node.taskKind)
    && (candidate.when.riskTier === undefined || candidate.when.riskTier === node.riskTier));
  if (row) {
    const rule = ruleLabel(row);
    const id = row.prefer.find((candidate) => admits(candidate, runtimes, availability, forbiddenVendors)) ?? null;
    return { runtimeId: id, rule };
  }

  const discovered = role === "worker"
    ? cheapestAvailable(runtimes, availability, forbiddenVendors)
    : strongestAvailable(runtimes, availability, forbiddenVendors);
  return { runtimeId: discovered, rule: "discovery" };
}

/**
 * @param {string} id
 * @param {Record<string, RoutingRuntime>} runtimes
 * @param {Record<string, RoutingAvailability>} availability
 * @param {ReadonlySet<string>} forbiddenVendors
 * @returns {boolean}
 */
function admits(id, runtimes, availability, forbiddenVendors) {
  const runtime = runtimes[id];
  if (!runtime) return false;
  if (forbiddenVendors.has(runtime.vendor)) return false;
  return isAvailable(availability[id]);
}

/** @param {RoutingAvailability|undefined} entry @returns {boolean} */
function isAvailable(entry) {
  if (!entry) return false;
  if (entry.available === true) return !entry.exhaustedUntil || Date.parse(entry.exhaustedUntil) <= Date.now();
  return Boolean(entry.exhaustedUntil && Date.parse(entry.exhaustedUntil) <= Date.now());
}

/**
 * Every vendor a judge may not carry: the worker's own vendor, plus the
 * vendor of each runtime reachable through the worker's declared `fallback`
 * chain — the same independence the contract validator enforces statically
 * once a worker is actually chosen dynamically here.
 *
 * @param {string} workerId
 * @param {Record<string, RoutingRuntime>} runtimes
 * @returns {Set<string>}
 */
function forbiddenJudgeVendors(workerId, runtimes) {
  const vendors = new Set();
  const seen = new Set();
  /** @type {string|undefined} */
  let id = workerId;
  while (id !== undefined && runtimes[id] && !seen.has(id)) {
    seen.add(id);
    vendors.add(runtimes[id].vendor);
    id = runtimes[id].fallback;
  }
  return vendors;
}

/** @param {RoutingRule} row @returns {string} */
function ruleLabel(row) {
  if (row.name) return row.name;
  return `table:${row.role}:${row.when.taskKind ?? "*"}:${row.when.riskTier ?? "*"}`;
}

/**
 * @param {Record<string, RoutingRuntime>} runtimes
 * @param {Record<string, RoutingAvailability>} availability
 * @param {ReadonlySet<string>} forbiddenVendors
 * @returns {{id: string, runtime: RoutingRuntime, order: number}[]}
 */
function candidateEntries(runtimes, availability, forbiddenVendors) {
  return Object.entries(runtimes)
    .map(([id, runtime], order) => ({ id, runtime, order }))
    .filter(({ id, runtime }) => !forbiddenVendors.has(runtime.vendor) && isAvailable(availability[id]));
}

/**
 * The plain discovery default for a worker: `runtime-discovery.mjs`'s own
 * cheapest-first ranking, over candidates already filtered to what's
 * available and vendor-permitted here. The ranking lives there, not here, so
 * a contract's default and a plan's routed default never drift apart.
 *
 * @param {Record<string, RoutingRuntime>} runtimes
 * @param {Record<string, RoutingAvailability>} availability
 * @param {ReadonlySet<string>} forbiddenVendors
 * @returns {string|null}
 */
function cheapestAvailable(runtimes, availability, forbiddenVendors) {
  return cheapest(candidateEntries(runtimes, availability, forbiddenVendors))?.id ?? null;
}

/**
 * The plain discovery default for a judge: `runtime-discovery.mjs`'s own
 * strongest-first ranking, over candidates already filtered to exclude the
 * worker's vendor and fallback-chain vendors — `strongest`'s own single-vendor
 * exclusion is passed the empty string, no runtime's actual vendor label, so
 * it is a no-op on top of the filtering already done here.
 *
 * @param {Record<string, RoutingRuntime>} runtimes
 * @param {Record<string, RoutingAvailability>} availability
 * @param {ReadonlySet<string>} forbiddenVendors
 * @returns {string|null}
 */
function strongestAvailable(runtimes, availability, forbiddenVendors) {
  return strongest(candidateEntries(runtimes, availability, forbiddenVendors), "")?.id ?? null;
}
