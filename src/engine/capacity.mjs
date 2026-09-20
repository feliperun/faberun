/**
 * Per-runtime dispatch capacity: how many attempts one runtime may run at
 * once (`maxConcurrent`; absent means only `maxParallel` bounds it) and which
 * runtimes are on a quota hold -- a node of theirs is waiting out a provider
 * exhaustion backoff on that same runtime, so dispatching a sibling to it
 * would spend the next quota window on a refusal the run already knows
 * about. Separate from the scheduler because it is pure over the running set
 * and the persisted snapshots, and from failover.mjs because that decides one
 * node's route while this decides whether the tick may start another.
 *
 * measured 2026-09-20: `maxParallel` was the one concurrency knob, global to
 * the run; nothing reduced dispatch to a provider that had just refused a
 * sibling on quota, and 14 of 58 stored contracts ran with maxParallel 2.
 */

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */

/**
 * Live attempts per runtime id, from the jobs a tick is holding.
 *
 * @param {Iterable<{runtime: {id: string|null}}>} running
 * @returns {Map<string, number>}
 */
export function runningPerRuntime(running) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const job of running) {
    const id = job.runtime.id;
    if (typeof id !== "string") continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Runtimes some node is waiting to use again after a provider exhaustion:
 * the node's current routing override still has a `backoffUntil` in the
 * future, it points back at the runtime that was exhausted (a reset wait, not
 * a hop to another runtime), and the exhaustion was the last routing event.
 * A network wait or an ordinary provider failure holds nothing.
 *
 * @param {Iterable<NodeSnapshot>} states
 * @param {number} now epoch milliseconds
 * @returns {Set<string>}
 */
export function quotaHeldRuntimes(states, now) {
  /** @type {Set<string>} */
  const held = new Set();
  for (const state of states) {
    const override = state.routing?.currentOverride;
    const last = state.routing?.history?.at(-1);
    if (!override?.backoffUntil || Date.parse(override.backoffUntil) <= now) continue;
    if (!override.runtime || !last || last.runtime !== override.runtime) continue;
    if (last.status !== "exhausted") continue;
    held.add(override.runtime);
  }
  return held;
}

/**
 * Whether one more attempt may start on `runtimeId` right now.
 *
 * @param {string} runtimeId
 * @param {ValidatedContract} contract
 * @param {Map<string, number>} counts live attempts per runtime, `runningPerRuntime`'s shape
 * @param {Set<string>} held `quotaHeldRuntimes`'s result
 * @returns {boolean}
 */
export function runtimeHasCapacity(runtimeId, contract, counts, held) {
  if (held.has(runtimeId)) return false;
  const limit = contract.runtimes[runtimeId]?.maxConcurrent;
  return typeof limit !== "number" || (counts.get(runtimeId) ?? 0) < limit;
}
