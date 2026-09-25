/**
 * Declarative runtime routing: cross a taskKind/riskTier table with live
 * discovery availability to assign a worker and a judge runtime to each of a
 * plan's draft nodes. Separate from runtime-discovery.mjs because that module
 * resolves a *contract's* already-declared runtimes; a plan's draft node
 * never names one (the constitution reserves model choice to runtimes,
 * runtimeDefaults, or an explicit node override) — this module is what turns
 * a taskKind/riskTier classification into one of those three. Each rule names
 * the strategy that consumes its `prefer` list, and every assignment records
 * the strategy that was applied and the reason for the choice — `declared`
 * when an operator instruction prevailed, since that outranks every strategy.
 */

import { ROUTING_STRATEGIES } from "../contract/runtime.mjs";
import { cheapest, isRuntimeAvailable, strongest } from "../engine/runtime-discovery.mjs";
import { effectiveProvider } from "../contract/provider.mjs";

/** @typedef {import("../contract/runtime.mjs").RoutingStrategy} RoutingStrategy */
/** @typedef {RoutingStrategy|"declared"} AppliedStrategy */

/**
 * The plan's copy of the discovery catalogue record: only what the harness de
 * facto reports, with the moment each datum was observed. The observables are
 * null where the harness exposes nothing -- never zero and never full
 * allowance, so a runtime that reports nothing cannot look rested -- and an
 * observation older than its own window reads as unknown at the one shared
 * reader, `isRuntimeAvailable` in runtime-discovery.mjs.
 * @typedef {{available: boolean, exhaustedUntil: string|null, observedAt?: string|null, window?: string|null, remaining?: number|null, [key: string]: unknown}} RoutingAvailability
 */
/** @typedef {{vendor: string, tier?: number|string, costRank?: number, fallback?: string, [key: string]: unknown}} RoutingRuntime */
/** @typedef {{id: string, taskKind?: string, riskTier?: string}} RoutingNode */
/** @typedef {{taskKind?: string, riskTier?: string}} RoutingWhen */
/** @typedef {{name?: string, when: RoutingWhen, prefer: string[], role: "worker"|"judge", strategy?: RoutingStrategy}} RoutingRule */
/** @typedef {{worker?: string, judge?: string}} RoutingRoleMap */
/** @typedef {{table?: RoutingRule[], runtimes: Record<string, RoutingRuntime>, availability?: Record<string, RoutingAvailability>, runtimeDefaults?: RoutingRoleMap, overrides?: Record<string, RoutingRoleMap>}} RoutingConfig */
/** @typedef {{worker: string|null, judge: string|null, rule: {worker: string, judge: string}, strategy: {worker: AppliedStrategy|null, judge: AppliedStrategy|null}, reason: {worker: string, judge: string}}} RoutingAssignment */
/** @typedef {{nodeId: string, role: "worker"|"judge", rule: string}} RoutingUnmet */
/** @typedef {{assignments: Record<string, RoutingAssignment>, unmet: RoutingUnmet[]}} RoutingResult */

/**
 * @param {RoutingNode[]} nodes
 * @param {RoutingConfig} config
 * @param {{partial?: boolean, previous?: Record<string, RoutingRoleMap>}} [options]
 *   `previous` carries the per-node role assignment the last routing pass made,
 *   the datum the `attempt-affinity` strategy prefers; absent, that strategy is
 *   inert and the remaining rules decide.
 * @returns {RoutingResult}
 */
export function resolveRuntimes(nodes, config, options = {}) {
  const table = config.table ?? [];
  const runtimes = config.runtimes ?? {};
  const availability = config.availability ?? {};
  const runtimeDefaults = config.runtimeDefaults ?? {};
  const overrides = config.overrides ?? {};
  const previous = options.previous ?? {};

  // A strategy name outside the vocabulary is an authored-table defect, not an
  // unobservable datum: it fails fast, before any node is resolved.
  for (const row of table) {
    if (row.strategy !== undefined && !ROUTING_STRATEGIES.has(row.strategy)) {
      throw new TypeError(`routing rule ${ruleLabel(row)} names unknown strategy ${row.strategy}`);
    }
  }

  /** @type {Record<string, RoutingAssignment>} */
  const assignments = {};
  /** @type {RoutingUnmet[]} */
  const unmet = [];

  for (const node of nodes) {
    const override = overrides[node.id] ?? {};
    const worker = resolveRole(node, "worker", { runtimes, availability, runtimeDefaults, table, override, forbiddenVendors: EMPTY_VENDORS, previousId: previous[node.id]?.worker });
    if (worker.runtimeId === null) unmet.push({ nodeId: node.id, role: "worker", rule: worker.rule });
    // The judge's forbidden vendors follow the worker runtime that was
    // actually chosen, never the row that named it — a worker unmet leaves
    // nothing to conflict with, so the judge resolves without restriction.
    const forbiddenVendors = worker.runtimeId ? forbiddenJudgeVendors(worker.runtimeId, runtimes) : EMPTY_VENDORS;
    const judge = resolveRole(node, "judge", { runtimes, availability, runtimeDefaults, table, override, forbiddenVendors, previousId: previous[node.id]?.judge });
    if (judge.runtimeId === null) unmet.push({ nodeId: node.id, role: "judge", rule: judge.rule });
    assignments[node.id] = {
      worker: worker.runtimeId,
      judge: judge.runtimeId,
      rule: { worker: worker.rule, judge: judge.rule },
      strategy: { worker: worker.strategy, judge: judge.strategy },
      reason: { worker: worker.reason, judge: judge.reason },
    };
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
 * this node's classification, then plain discovery. A declaration outranks
 * every strategy — it is recorded as `declared`, never as a strategy outcome —
 * and a row or default that names an unavailable or vendor-forbidden runtime
 * is unmet by that rule — it does not fall through to a lower-precedence
 * source, since falling through would silently discard an explicit
 * declaration; only the candidates *within* a row's `prefer` list, and within
 * discovery, are skipped for exhaustion or vendor conflict.
 *
 * @param {RoutingNode} node
 * @param {"worker"|"judge"} role
 * @param {{runtimes: Record<string, RoutingRuntime>, availability: Record<string, RoutingAvailability>, runtimeDefaults: RoutingRoleMap, table: RoutingRule[], override: RoutingRoleMap, forbiddenVendors: ReadonlySet<string>, previousId: string|undefined}} context
 * @returns {{runtimeId: string|null, rule: string, strategy: AppliedStrategy|null, reason: string}}
 */
function resolveRole(node, role, context) {
  const { runtimes, availability, runtimeDefaults, table, override, forbiddenVendors, previousId } = context;

  if (override[role] !== undefined) {
    const id = override[role];
    return {
      runtimeId: admits(id, runtimes, availability, forbiddenVendors) ? id : null,
      rule: "override",
      strategy: "declared",
      reason: `operator override on node ${node.id}`,
    };
  }

  if (runtimeDefaults[role] !== undefined) {
    const id = runtimeDefaults[role];
    return {
      runtimeId: admits(id, runtimes, availability, forbiddenVendors) ? id : null,
      rule: "runtimeDefaults",
      strategy: "declared",
      reason: "operator runtimeDefaults",
    };
  }

  const row = table.find((candidate) => candidate.role === role
    && (candidate.when.taskKind === undefined || candidate.when.taskKind === node.taskKind)
    && (candidate.when.riskTier === undefined || candidate.when.riskTier === node.riskTier));
  if (row) {
    const strategy = row.strategy ?? "priority";
    const decision = chooseByStrategy(strategy, row.prefer, { runtimes, availability, forbiddenVendors, previousId });
    return { runtimeId: decision.runtimeId, rule: ruleLabel(row), strategy, reason: decision.reason };
  }

  const discovered = role === "worker"
    ? cheapestAvailable(runtimes, availability, forbiddenVendors)
    : strongestAvailable(runtimes, availability, forbiddenVendors);
  return {
    runtimeId: discovered,
    rule: "discovery",
    strategy: role === "worker" ? "cost" : "priority",
    reason: role === "worker" ? "discovery: cheapest available runtime" : "discovery: strongest available runtime",
  };
}

/**
 * One strategy's choice over a row's `prefer` list -- attempt-affinity's
 * candidate is the previous attempt's runtime, which the list need not name.
 * A strategy whose datum a
 * candidate does not expose is inert for that candidate — it cannot choose it,
 * and it never raises; inert for the whole row when no candidate exposes it,
 * at which point the prefer list's own order decides. The reason says which
 * of the two happened, because a recorded strategy that fell back must read
 * differently from one that decided.
 *
 * @param {RoutingStrategy} strategy
 * @param {string[]} prefer
 * @param {{runtimes: Record<string, RoutingRuntime>, availability: Record<string, RoutingAvailability>, forbiddenVendors: ReadonlySet<string>, previousId: string|undefined}} context
 * @returns {{runtimeId: string|null, reason: string}}
 */
function chooseByStrategy(strategy, prefer, context) {
  const { runtimes, availability, forbiddenVendors, previousId } = context;
  const candidates = prefer.map((id) => ({ id, admissible: admits(id, runtimes, availability, forbiddenVendors) }));
  const admissible = candidates.filter((candidate) => candidate.admissible);
  if (admissible.length === 0) return { runtimeId: null, reason: "no admissible candidate in the prefer list" };

  if (strategy === "attempt-affinity") {
    if (previousId === undefined) {
      return { runtimeId: admissible[0].id, reason: "attempt-affinity inert: no previous attempt recorded; prefer order decided" };
    }
    // Affinity's candidate is the previous attempt's runtime itself, even
    // where the prefer list does not name it -- reusing it is the strategy's
    // whole point. It yields by name whenever it would violate availability
    // or vendor distinction, the yields `admits` already speaks.
    if (admits(previousId, runtimes, availability, forbiddenVendors)) {
      return { runtimeId: previousId, reason: `attempt-affinity: previous attempt's runtime ${previousId} still admissible` };
    }
    return { runtimeId: admissible[0].id, reason: `attempt-affinity yielded: ${previousId} ${blockedWhy(previousId, runtimes, availability, forbiddenVendors)}; prefer order decided` };
  }

  if (strategy === "cost") {
    const ranked = admissible.filter((candidate) => typeof runtimes[candidate.id]?.costRank === "number");
    if (ranked.length === 0) {
      return { runtimeId: admissible[0].id, reason: "cost inert: no admissible candidate exposes costRank; prefer order decided" };
    }
    /** @param {{id: string, admissible: boolean}} candidate */
    const costRank = (candidate) => /** @type {number} */ (runtimes[candidate.id]?.costRank);
    const winner = ranked.reduce((best, candidate) => (costRank(candidate) < costRank(best) ? candidate : best));
    return { runtimeId: winner.id, reason: `cost: lowest costRank ${costRank(winner)} among ranked candidates` };
  }

  if (strategy === "reset-proximity") {
    const measured = admissible.filter((candidate) => typeof availability[candidate.id]?.remaining === "number");
    if (measured.length === 0) {
      return { runtimeId: admissible[0].id, reason: "reset-proximity inert: no admissible candidate exposes remaining; prefer order decided" };
    }
    // The window nearest its reset is spent first, so a reset never wastes
    // allowance; a runtime exposing nothing is unrankable, not free.
    const winner = measured.reduce((best, candidate) => (/** @type {number} */ (availability[candidate.id].remaining) < /** @type {number} */ (availability[best.id].remaining) ? candidate : best));
    return { runtimeId: winner.id, reason: `reset-proximity: least remaining allowance (${/** @type {number} */ (availability[winner.id].remaining)})` };
  }

  return { runtimeId: admissible[0].id, reason: "priority: first admissible of the prefer list" };
}

/**
 * Why one runtime fails `admits`, in words a recorded reason can quote.
 *
 * @param {string} id
 * @param {Record<string, RoutingRuntime>} runtimes
 * @param {Record<string, RoutingAvailability>} availability
 * @param {ReadonlySet<string>} forbiddenVendors
 * @returns {string}
 */
function blockedWhy(id, runtimes, availability, forbiddenVendors) {
  const runtime = runtimes[id];
  if (!runtime) return "is not declared in runtimes";
  const provider = effectiveProvider(runtime);
  if (provider !== undefined && forbiddenVendors.has(provider)) return `carries forbidden vendor ${provider}`;
  return "is unavailable";
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
  const provider = effectiveProvider(runtime);
  if (provider !== undefined && forbiddenVendors.has(provider)) return false;
  return isRuntimeAvailable(availability[id]);
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
    const provider = effectiveProvider(runtimes[id]);
    if (provider !== undefined) vendors.add(provider);
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
    .filter(({ id, runtime }) => {
      const provider = effectiveProvider(runtime);
      return (provider === undefined || !forbiddenVendors.has(provider)) && isRuntimeAvailable(availability[id]);
    });
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
