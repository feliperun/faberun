/**
 * Admission for the paid spawns that start outside the scheduler's dispatch
 * pass: the node's own judge after its verification gate, the bounded judge
 * re-ask, and the gate revision. `capacity.mjs`'s `admissionPass` judges the
 * spawns the dispatch pass issues itself and owns the pass's reservations;
 * these three start inside a settlement or a stall handler, take over the
 * slot the node already holds, and need one yes/no judgment against the live
 * running set. On a refusal the node hands back to the scheduler -- the one
 * place that knows when the run stops being full -- and the verdict is
 * recorded on the node's event journal.
 *
 * Measured 2026-09-29 (ACHADOS-PRODUTO achado 2): these spawns ran with no
 * per-runtime check, and two invocations of one runtime were seen alive at
 * once under a contract declaring `maxParallel: 1`. The judgment here is the
 * dispatch pass's own rule (`runtimeHasCapacity`) over the same running set
 * the spawn is about to join, plus the pass's global bound: the settle window
 * keeps `running` under `maxParallel` while a settlement spawns, and the
 * stall-handler re-ask -- the one aux spawn outside any settle window -- takes
 * the same check instead of trusting that.
 */
import { quotaHeldRuntimes, runningPerRuntime, runtimeHasCapacity } from "./capacity.mjs";
import { routeRuntimeForState } from "./failover.mjs";
import { startJudge } from "./dispatch.mjs";
import { appendTransitionEvent, transition } from "./state.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */
/** @typedef {import("../contract/index.mjs").ValidatedNode} ValidatedNode */
/** @typedef {import("../contract/index.mjs").NodeSnapshot} NodeSnapshot */
/** @typedef {import("../run/lock.mjs").LockRecord} LockRecord */
/** @typedef {ReturnType<typeof import("../run/lock.mjs").acquire>} LockHandle */
/** @typedef {import("./dispatch.mjs").JudgeRound} JudgeRound */
/** @typedef {import("./process.mjs").Job} Job */

/**
 * One auxiliary-spawn admission: may this spawn start right now? The spawn
 * joins the caller's `running` map, so that map is what is judged: the
 * contract's global `maxParallel`, and the routed runtime's `maxConcurrent`
 * over the attempts it already holds. A runtime some node is waiting out a
 * quota reset on refuses too, exactly as a dispatch pass would. A closed job
 * still inside its settle window holds no live process and is not counted:
 * the slot it holds is this node's own, and this spawn is the reason the slot
 * existed.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {Map<string, Job>} running the live dispatch map the spawn would join
 * @param {Map<string, NodeSnapshot>} states
 * @param {"worker"|"judge"} role
 * @param {number} [now] epoch milliseconds
 * @returns {{admitted: boolean, runtimeId: string, reason: string|null}}
 */
export function auxSpawnAdmission(contract, node, state, running, states, role, now = Date.now()) {
  const runtime = routeRuntimeForState(contract, node, state, role);
  if (running.size >= contract.maxParallel) {
    return { admitted: false, runtimeId: runtime.id, reason: `run holds ${running.size} of maxParallel ${contract.maxParallel} slots` };
  }
  const held = quotaHeldRuntimes(states.values(), now);
  if (!runtimeHasCapacity(runtime.id, contract, runningPerRuntime(running.values()), held)) {
    return {
      admitted: false,
      runtimeId: runtime.id,
      reason: held.has(runtime.id)
        ? `runtime ${runtime.id} is waiting out a quota reset`
        : `runtime ${runtime.id} holds its maxConcurrent of ${contract.runtimes[runtime.id]?.maxConcurrent}`,
    };
  }
  return { admitted: true, runtimeId: runtime.id, reason: null };
}

/**
 * Record a refused auxiliary spawn on the node's event journal: the verdict
 * the deferral is gated on, read back by the phase proof and by an operator
 * asking why a node went back to pending without a new attempt. The event is
 * written only for a refusal, so its existence is the verdict. Measured
 * 2026-10-02: `appendTransitionEvent` builds the event from the node snapshot
 * and its own fields win every colliding name -- the event's `runtime` and
 * `summary` are the state's, not ours -- so the refusal rides the one field
 * the transition leaves unset: `error`, with the node's own error null
 * (the deferral parks nothing on the node).
 *
 * @param {string} runDir
 * @param {NodeSnapshot} state
 * @param {string} from the node status the refusal found
 * @param {LockHandle|null} lock
 * @param {"worker"|"judge"} role
 * @param {{runtimeId: string, reason: string|null}} admission
 */
export function recordAuxRefusal(runDir, state, from, lock, role, admission) {
  appendTransitionEvent(runDir, state, from, "pending", {
    type: "aux.admission",
    role,
    error: { code: "aux_spawn_refused", message: admission.reason ?? "aux spawn refused" },
  }, lock);
}

/**
 * The judge a settlement starts itself: admit it against the live running
 * set, and on a refusal hand the node back to the scheduler as a pending
 * judge with its accepted result intact -- the drive loop dispatches it
 * through the ordinary admission pass once the runtime frees. Returns what
 * `startJudge` would have, so the caller's `applyJudgeRound` decides nothing
 * new: a refused round is already parked on the node.
 *
 * @param {ValidatedContract} contract
 * @param {ValidatedNode} node
 * @param {NodeSnapshot} state
 * @param {string} runDir
 * @param {Map<string, Job>} running
 * @param {Map<string, NodeSnapshot>} states
 * @param {LockHandle} lock
 * @param {string} campaignPath
 * @returns {Promise<JudgeRound>}
 */
export async function auxJudgeRound(contract, node, state, runDir, running, states, lock, campaignPath) {
  const admission = auxSpawnAdmission(contract, node, state, running, states, "judge");
  if (!admission.admitted) {
    const from = state.status;
    transition(runDir, state, "pending", { phase: "judge", error: null, blockedBy: [] }, lock);
    recordAuxRefusal(runDir, state, from, lock, "judge", admission);
    return { kind: "refused" };
  }
  return startJudge(contract, node, state, runDir, running, state.result, lock, states, campaignPath);
}
