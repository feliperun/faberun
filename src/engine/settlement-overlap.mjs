/**
 * The settlement overlap: what makes two closed nodes' verification proofs run
 * at the same time through one real run, while everything a concurrent second
 * settlement would corrupt stays serialized.
 *
 * The verify layer's proof gate (`engine/verify.mjs`) already bounds concurrent
 * passes by the contract's `maxParallel` and serializes passes that share a
 * tree; what held the engine back was the caller. `driveRun` chained whole
 * settlements onto one promise queue, so one node's controller verification --
 * minutes of child processes -- held every other node's settlement behind it
 * and two independent worktree proofs never overlapped (phase-5 d4.1). This
 * module replaces that queue: a settlement is a sequence of serialized
 * *sections* separated by *proofs*. A section holds the run's one settlement
 * slot; `parkDuringProof`, called around the controller verification pass,
 * hands the slot back while the proof's child processes run and re-acquires it
 * before the settlement's next decision. Dispatch decisions, the
 * phase-continuation choice in `finalizeClosedJobs`, and ref updates and the
 * whole integration transaction therefore never interleave between two nodes,
 * while the proofs between them do. The integration candidate's own
 * verification is deliberately never parked: it runs inside
 * `repo/integrate.mjs`'s candidate lock, and parking it would deadlock -- its
 * settlement would wait to re-acquire the slot behind a sibling whose section
 * is itself waiting on the candidate lock this settlement holds -- and
 * integration is exactly what phase 5 keeps serialized.
 *
 * Per-node ordering needs no lock here: the scheduler never starts a second
 * settlement for a node whose first is still in `pending`, and the admission
 * settle window (`settling`) holds each node's slot from its job's close until
 * its settlement finishes, parked proof included.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { LockLostError } from "../run/lock.mjs";

/** @typedef {import("./lifecycle.mjs").Job} Job */

/** @typedef {{park: (factory: () => Promise<unknown>) => Promise<unknown>}} SettlementContext */

/** The overlap of the settlement currently running on this controller, if any. @type {AsyncLocalStorage<SettlementContext>} */
const settlementContext = new AsyncLocalStorage();

/**
 * Run a verification proof outside the caller's serialized section: while the
 * proof's child processes run, the settlement's slot is handed back and a
 * sibling's settlement advances. Outside a settlement -- a recovery path, a
 * test driving `executeControllerVerification` directly -- the proof runs
 * exactly inline, unchanged.
 *
 * @template T
 * @param {() => Promise<T>|T} factory
 * @returns {Promise<T>}
 */
export async function parkDuringProof(factory) {
  const overlap = settlementContext.getStore();
  if (!overlap) return /** @type {T} */ (await factory());
  return /** @type {Promise<T>} */ (overlap.park(/** @type {() => Promise<unknown>} */ (factory)));
}

/**
 * @returns {{pending: Map<string, Promise<void>>, settling: Map<string, Pick<Job, "runtime">>, enqueue: (nodeId: string, job: Pick<Job, "runtime">, work: () => Promise<void>) => void, failure: () => unknown}}
 */
export function createSettlementOverlap() {
  /** @type {Map<string, Promise<void>>} */
  const pending = new Map();
  /** @type {Map<string, Pick<Job, "runtime">>} */
  const settling = new Map();
  /** @type {unknown} */
  let failure = null;
  let sectionBusy = false;
  /** @type {(() => void)[]} */
  const sectionWaiters = [];
  /** @returns {Promise<void>} */
  const acquireSection = () => new Promise((satisfy) => {
    if (!sectionBusy) {
      sectionBusy = true;
      satisfy();
      return;
    }
    sectionWaiters.push(satisfy);
  });
  // Hand-off, not vacancy: the next waiter is granted the slot directly, so a
  // caller that acquires between the release and the grant joins the queue
  // behind it instead of slipping past.
  /** @returns {void} */
  const releaseSection = () => {
    const next = sectionWaiters.shift();
    if (next) next();
    else sectionBusy = false;
  };
  /**
   * Hand the slot back while a proof runs and take it again before the next
   * decision. Releasing is safe exactly because the proof holds no shared
   * settlement state: its writes go to its own node's snapshot, its child
   * processes run in their own worktree, and its overlap with sibling proofs
   * is bounded by the verify layer's proof gate.
   *
   * @template T
   * @param {() => Promise<T>} factory
   * @returns {Promise<T>}
   */
  const park = async (factory) => {
    releaseSection();
    try {
      return await factory();
    } finally {
      await acquireSection();
    }
  };
  return {
    pending,
    settling,
    /**
     * Chain one node's settlement onto the overlap. The reservation semantics
     * are the scheduler's old `enqueueSettlement` verbatim: the settle-window
     * slot is reserved before the work starts, released in the same `finally`
     * that retires `pending`, and the first rejection that is not a lost lock
     * is recorded for the top of the next tick to throw.
     *
     * @param {string} nodeId
     * @param {Pick<Job, "runtime">} job
     * @param {() => Promise<void>} work
     */
    enqueue(nodeId, job, work) {
      settling.set(nodeId, job);
      const settlement = settlementContext.run({ park }, async () => {
        await acquireSection();
        try {
          return await work();
        } finally {
          releaseSection();
        }
      }).finally(() => {
        pending.delete(nodeId);
        settling.delete(nodeId);
      });
      settlement.catch((error) => {
        if (!(error instanceof LockLostError) && failure === null) failure = error;
      });
      pending.set(nodeId, settlement);
    },
    /** @returns {unknown} */
    failure: () => failure,
  };
}
