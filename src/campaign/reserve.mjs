/**
 * The enforcement half of the optional campaign balance (ADR 0011): the one
 * mutator that arms `campaign.reserveUsd` on the record, and the reservation
 * store a dispatch gate holds, releases and reconciles against.
 *
 * The balance is one field on `campaign.json`; the reservations against it
 * are runtime state, so they live in their own file under the campaign
 * directory instead of in a record every mutator rewrites whole — a
 * check-and-deduct cannot be atomic under a last-writer-wins whole-file
 * write, and two runs' controllers dispatching under one campaign do race.
 * Every state mutation therefore runs under a lock that reuses the run
 * controller lock's mechanics (`../run/lock.mjs`), which brings pid-liveness
 * takeover: a holder that crashed mid-reservation cannot wedge the gate shut.
 *
 * Known costs hold their amount before dispatch and settle to released or
 * charged. A cost the provider never priced is recorded with `costUsd: null`
 * and holds nothing — the exposure stays unknown instead of reading as free —
 * and its reconciliation charges the real amount with no late difference,
 * because there was no reservation to be late against. A charge above its
 * reservation settles anyway and records the overshoot: the reserve gates new
 * dispatches, it is never an absolute ceiling.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquire, LockBusyError } from "../run/lock.mjs";
import { writeJsonAtomic } from "../run/store.mjs";
import { nonNegativeNumber } from "../contract/assert.mjs";
import { sleepSync } from "../util.mjs";
import { CAMPAIGN_FILE } from "./layout.mjs";
import { round4 } from "./metrics-evals.mjs";
import { readCampaign } from "./record.mjs";

/** @typedef {import("./index.mjs").Campaign} Campaign */

/**
 * The record as the reserve reads it: the shared `Campaign` typedef lives in
 * `index.mjs`, and this module's writes and reads of the balance are typed
 * against the field added here, so a record without the field reads as
 * unconfigured — never as a zero.
 *
 * @typedef {Campaign & {reserveUsd?: number}} CampaignWithReserve
 */

/** The campaign-directory subdirectory holding the reserve's lock and state. */
export const RESERVE_DIR = "reserve";
/** The reservation state file inside `RESERVE_DIR`. */
export const RESERVE_STATE_FILE = "state.json";
const RESERVE_STATE_SCHEMA_VERSION = 1;
// No measurement behind these bounds: a critical section is two atomic file
// writes, so a 5 s wait exceeds it by orders of magnitude on any machine, and
// the budget is what turns a wedged live holder into a loud throw instead of
// an unbounded queue.
const LOCK_WAIT_BUDGET_MS = 5_000;
const LOCK_RETRY_MS = 5;

/**
 * One reservation against the balance. `status` is `held` from admission,
 * then `released` (no charge to reconcile) or `charged` (the real cost
 * arrived). A `costUsd: null` reservation holds nothing and is the unknown
 * exposure ADR 0011 keeps visible until a real charge reconciles it.
 *
 * @typedef {{
 *   id: string,
 *   at: string,
 *   runId?: string,
 *   node?: string,
 *   costUsd: number|null,
 *   status: "held"|"released"|"charged",
 *   chargedUsd?: number,
 *   lateChargeUsd?: number|null,
 *   settledAt?: string,
 * }} Reservation
 */
/** @typedef {{schemaVersion: number, reservations: Reservation[]}} ReserveState */
/**
 * @typedef {{
 *   armed: boolean,
 *   configuredUsd: number|null,
 *   heldUsd: number,
 *   chargedUsd: number,
 *   availableUsd: number|null,
 *   unknownExposureCount: number,
 *   reservations: Reservation[],
 * }} ReserveStatus
 */
/**
 * @typedef {{
 *   admitted: boolean,
 *   armed: boolean,
 *   reservation: Reservation|null,
 *   availableUsd: number|null,
 * }} ReserveDecision
 */

/**
 * The one writer of `campaign.reserveUsd` (docs/FIELD-OWNERSHIP.md): arm the
 * optional balance a campaign gates new known-cost dispatches with. The
 * amount is validated by the same schema that reads the record back; a closed
 * campaign refuses, like every other record mutator.
 *
 * @param {string} campaignPath
 * @param {number} reserveUsd
 * @param {{at?: string}} [options]
 * @returns {Campaign}
 */
export function configureCampaignReserve(campaignPath, reserveUsd, { at = new Date().toISOString() } = {}) {
  nonNegativeNumber(reserveUsd, "reserveUsd");
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign is closed: ${campaign.id}`);
  /** @type {CampaignWithReserve} */
  const updated = { ...campaign, reserveUsd, updatedAt: at };
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), updated);
  return updated;
}

/**
 * Reserve a dispatch's cost against the campaign balance before the dispatch
 * happens. A campaign with no configured balance admits without writing any
 * state — the reserve is only applied where it was armed. A cost with no
 * provider price (`costUsd` null) is admitted without holding anything and
 * recorded as an unknown exposure, never as a zero. Atomic: the
 * check-and-deduct runs under the campaign's reserve lock, so two competing
 * reservations cannot both be admitted when their combined cost passes the
 * available balance.
 *
 * @param {string} campaignPath
 * @param {{runId?: string, node?: string, costUsd?: number|null, at?: string}} request
 *   an absent `costUsd` is an unknown cost, the same as an explicit null
 * @returns {ReserveDecision}
 */
export function reserveCampaignCost(campaignPath, { runId, node, costUsd, at = new Date().toISOString() } = {}) {
  if (costUsd !== null && costUsd !== undefined) nonNegativeNumber(costUsd, "costUsd");
  return withReserveLock(campaignPath, () => {
    const configured = reserveUsdOf(readCampaign(campaignPath));
    if (configured === undefined) {
      return { admitted: true, armed: false, reservation: null, availableUsd: null };
    }
    const state = readStateFile(campaignPath);
    const available = availableUsdOf(configured, state);
    // Rounded on both sides so float dust cannot refuse a reservation that
    // exactly empties the balance (measured shape of the failure: 100 - 30 -
    // 70 lands 4.5e-15 above zero).
    if (costUsd !== null && costUsd !== undefined && round4(costUsd) > round4(available)) {
      return { admitted: false, armed: true, reservation: null, availableUsd: available };
    }
    /** @type {Reservation} */
    const reservation = { id: randomUUID(), at, costUsd: costUsd ?? null, status: "held" };
    if (runId !== undefined) reservation.runId = runId;
    if (node !== undefined) reservation.node = node;
    state.reservations.push(reservation);
    writeStateFile(campaignPath, state);
    const spent = reservation.costUsd === null ? 0 : reservation.costUsd;
    return { admitted: true, armed: true, reservation, availableUsd: round4(available - spent) };
  });
}

/**
 * Give a reservation's hold back without a charge: the gated call never
 * launched, or ended with no provider cost to reconcile. Idempotent: an
 * already settled reservation is returned unchanged.
 *
 * @param {string} campaignPath
 * @param {string} reservationId
 * @param {{at?: string}} [options]
 * @returns {Reservation}
 */
export function releaseCampaignReservation(campaignPath, reservationId, { at = new Date().toISOString() } = {}) {
  return withReserveLock(campaignPath, () => {
    const state = readStateFile(campaignPath);
    const reservation = findReservation(state, reservationId);
    if (reservation.status === "held") {
      reservation.status = "released";
      reservation.settledAt = at;
      writeStateFile(campaignPath, state);
    }
    return reservation;
  });
}

/**
 * Reconcile a reservation against the charge that actually arrived. A charge
 * above the reservation settles anyway and records the difference as the
 * late charge; a reservation of an unmeasured cost charges the real amount
 * with `lateChargeUsd: null`, because there was no reservation to be late
 * against. Idempotent by amount: reconciling the same charge twice returns
 * the settled reservation instead of charging twice, and a different amount
 * for an already charged reservation refuses.
 *
 * @param {string} campaignPath
 * @param {string} reservationId
 * @param {number|null} costUsd a null charge is refused by the same validation
 *   that reads the record: reconciling must carry a real number, never another
 *   unknown
 * @param {{at?: string}} [options]
 * @returns {Reservation}
 */
export function reconcileCampaignReservation(campaignPath, reservationId, costUsd, { at = new Date().toISOString() } = {}) {
  const charge = nonNegativeNumber(costUsd, "costUsd");
  return withReserveLock(campaignPath, () => {
    const state = readStateFile(campaignPath);
    const reservation = findReservation(state, reservationId);
    if (reservation.status === "charged") {
      if (reservation.chargedUsd === charge) return reservation;
      throw new Error(`reservation ${reservationId} already charged ${reservation.chargedUsd} USD, refusing to recharge at ${charge} USD`);
    }
    if (reservation.status === "released") {
      throw new Error(`reservation ${reservationId} was released without a charge; it cannot take one afterwards`);
    }
    reservation.status = "charged";
    reservation.chargedUsd = charge;
    reservation.lateChargeUsd = reservation.costUsd === null ? null : round4(Math.max(0, charge - reservation.costUsd));
    reservation.settledAt = at;
    writeStateFile(campaignPath, state);
    return reservation;
  });
}

/**
 * Read the reserve's current state beside the record that armed it. The
 * numbers are derived from the reservation list on every read, so a state
 * file written by an older admission carries no migration.
 *
 * @param {string} campaignPath
 * @returns {ReserveStatus}
 */
export function readCampaignReserve(campaignPath) {
  const configured = reserveUsdOf(readCampaign(campaignPath));
  const state = readStateFile(campaignPath);
  let heldUsd = 0;
  let chargedUsd = 0;
  let unknownExposureCount = 0;
  for (const reservation of state.reservations) {
    if (reservation.status === "held") {
      if (reservation.costUsd === null) unknownExposureCount += 1;
      else heldUsd += reservation.costUsd;
    } else if (reservation.status === "charged") {
      chargedUsd += reservation.chargedUsd ?? 0;
    }
  }
  return {
    armed: configured !== undefined,
    configuredUsd: configured ?? null,
    heldUsd: round4(heldUsd),
    chargedUsd: round4(chargedUsd),
    availableUsd: configured === undefined ? null : availableUsdOf(configured, state),
    unknownExposureCount,
    reservations: state.reservations,
  };
}

/**
 * The balance off the record. Read through one cast instead of spreading
 * `any` over the module: the schema validates the field, and an unconfigured
 * record must reach readers as `undefined`, not as a zero.
 *
 * @param {Campaign} campaign
 * @returns {number|undefined}
 */
function reserveUsdOf(campaign) {
  return /** @type {number|undefined} */ (/** @type {CampaignWithReserve} */ (campaign).reserveUsd);
}

/**
 * @param {number} configured
 * @param {ReserveState} state
 * @returns {number}
 */
function availableUsdOf(configured, state) {
  let held = 0;
  let charged = 0;
  for (const reservation of state.reservations) {
    if (reservation.status === "held") {
      if (reservation.costUsd !== null) held += reservation.costUsd;
    } else if (reservation.status === "charged") {
      charged += reservation.chargedUsd ?? 0;
    }
  }
  return round4(configured - held - charged);
}

/**
 * @template T
 * @param {string} campaignPath
 * @param {() => T} body
 * @returns {T}
 */
function withReserveLock(campaignPath, body) {
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  for (;;) {
    let lock;
    try {
      lock = acquire(join(campaignPath, RESERVE_DIR));
    } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= deadline) {
        throw error instanceof LockBusyError
          ? new Error(`campaign reserve lock still held after ${LOCK_WAIT_BUDGET_MS} ms: ${error.message}`)
          : error;
      }
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    try {
      return body();
    } finally {
      lock.release();
    }
  }
}

/**
 * @param {string} campaignPath
 * @returns {ReserveState}
 */
function readStateFile(campaignPath) {
  const path = join(campaignPath, RESERVE_DIR, RESERVE_STATE_FILE);
  if (!existsSync(path)) return { schemaVersion: RESERVE_STATE_SCHEMA_VERSION, reservations: [] };
  const state = /** @type {ReserveState} */ (JSON.parse(readFileSync(path, "utf8")));
  if (!Array.isArray(state.reservations)) throw new TypeError(`reserve state ${path} has no reservations array`);
  return state;
}

/**
 * @param {string} campaignPath
 * @param {ReserveState} state
 */
function writeStateFile(campaignPath, state) {
  writeJsonAtomic(join(campaignPath, RESERVE_DIR, RESERVE_STATE_FILE), state);
}

/**
 * @param {ReserveState} state
 * @param {string} reservationId
 * @returns {Reservation}
 */
function findReservation(state, reservationId) {
  const reservation = state.reservations.find((entry) => entry.id === reservationId);
  if (reservation === undefined) throw new Error(`no reservation ${reservationId} in the campaign's reserve`);
  return reservation;
}
