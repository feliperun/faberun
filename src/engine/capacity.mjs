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
 *
 * measured 2026-09-29: this gate was consulted by the scheduler's own
 * dispatches only, and a run declaring `maxParallel: 1` and `maxConcurrent: 1`
 * on each role's runtime was measured with a judge and a sibling's worker
 * alive at once -- peak 2, one process per role, two on the single runtime
 * (`test/engine/max-parallel.test.mjs`). The slot a node's closed job had
 * freed was spendable while the node was still mid-flight.
 *
 * F5 admission (2026-10-02): the scheduler now counts a node from before its
 * spawn until its settle completes (`admissionHold`, fed by the settle window
 * in `scheduler.mjs`), which closes the freed-slot race for every spawn the
 * scheduler issues. The dispatch pass opens its turn with `admissionPass`,
 * which folds the live jobs, the settle window and the pass's own
 * reservations into one judgment per node. The judge a settlement starts
 * itself, the bounded re-ask
 * (`review.mjs`) and the gate revision (`settle.mjs` `applyRejection`) still
 * spawn with no call here: the node's own settle-window hold keeps the global
 * `maxParallel` true while they run, but their per-runtime ceiling is not
 * re-checked -- wiring those spawns through this gate is the follow-up node's.
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
 * The admission a dispatch pass judges a spawn against: every attempt holding
 * a run slot right now. A live job holds one, and so does a closed job whose
 * settlement has not finished -- a node whose worker exited but whose
 * controller verification, judge round or integration is still running keeps
 * the global slot and the runtime slot its dispatch reserved, because the
 * judge that settlement is about to start is the reason the slot existed.
 * Releasing at close instead is the measured excess (2026-09-29, achado 2 of
 * ACHADOS-PRODUTO.md): two workers alive on one runtime under `maxParallel:
 * 1`, and a sibling dispatched while the first node sat blocked in its
 * verification gate.
 *
 * @param {Map<string, {runtime: {id: string|null}}>} running live jobs the tick is holding
 * @param {Map<string, {runtime: {id: string|null}}>} settling closed jobs whose settlement has not finished
 * @returns {{count: number, perRuntime: Map<string, number>}} the global slot
 *   count and the per-runtime counts; the dispatch pass grows both as it
 *   reserves, exactly as it grew `runningPerRuntime`'s map before
 */
export function admissionHold(running, settling) {
  const holders = [...running.values(), ...settling.values()];
  return { count: holders.length, perRuntime: runningPerRuntime(holders) };
}

/**
 * One dispatch pass's admission: the slots the contract's `maxParallel` still
 * grants, judged against every attempt holding one -- the live jobs plus the
 * closed jobs still inside their settle window -- and the per-runtime
 * reservation the pass takes as it dispatches. `take` is consulted per node
 * and refuses a runtime a sibling is waiting out a quota reset on, a runtime
 * at its `maxConcurrent`, and one already holding its share of this pass's
 * reservations; on success it reserves the slot in the same breath, because a
 * check without its reservation would admit two nodes on one judgment. A
 * spawn the settlement starts itself (the node's judge) runs inside the
 * node's own held slot and never reaches here.
 *
 * @param {ValidatedContract} contract
 * @param {Map<string, {runtime: {id: string|null}}>} running live jobs the tick is holding
 * @param {Map<string, {runtime: {id: string|null}}>} settling closed jobs whose settlement has not finished
 * @param {Map<string, NodeSnapshot>} states
 * @returns {{slots: number, take: (runtimeId: string) => boolean}} the free
 *   slot count, read once per pass, and the per-node gate
 */
export function admissionPass(contract, running, settling, states) {
  const hold = admissionHold(running, settling);
  const held = quotaHeldRuntimes(states.values(), Date.now());
  return {
    slots: contract.maxParallel - hold.count,
    /**
     * @param {string} runtimeId
     * @returns {boolean}
     */
    take: (runtimeId) => {
      if (!runtimeHasCapacity(runtimeId, contract, hold.perRuntime, held)) return false;
      hold.perRuntime.set(runtimeId, (hold.perRuntime.get(runtimeId) ?? 0) + 1);
      return true;
    },
  };
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
