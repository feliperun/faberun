/**
 * The money half of a metrics projection: priced dollars per class, the
 * retries, and the optional reserve (ADR 0011).
 *
 * `metrics.mjs` projects the section-6 indicators from a campaign's parsed
 * records. Costs are the one part of that projection with its own vocabulary —
 * a class split, a retry subset, and a reserve lifecycle of held, released and
 * late-charged dollars — and it is arithmetic over records rather than a
 * measurement of the campaign's shape, so it lives here. Growing it inside
 * `metrics.mjs` pushed that module past the 800-line ceiling; this is the
 * second job it was carrying, not a new one.
 *
 * Every function takes already-parsed usage records and reads nothing else:
 * no path, no clock, no network. Unmeasured spend stays `null` at every level,
 * because a class with no priced record and a class that cost nothing are
 * different facts.
 */

import { finite } from "../util.mjs";
import { UNKNOWN_COST_REASONS } from "../run/usage.mjs";
import { round4 } from "./metrics-evals.mjs";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {"planning"|"worker"|"judge"} SpendClass */
/**
 * The optional reserve a campaign configured, projected from the same records
 * the spend is. `configuredUsd` is the campaign's own balance
 * (`campaign.reserveUsd`), `heldUsd` is what is still reserved against charges
 * that have not arrived, `releasedUsd` is what those charges released, and
 * `lateChargeUsd` is the part of a released reservation the real charge went
 * past. `cap` is always false: the reserve refuses a new dispatch when the
 * balance is short and cannot bound a call already running, so no surface may
 * read it as an absolute ceiling.
 *
 * @typedef {{
 *   configuredUsd: number|null,
 *   heldUsd: number|null,
 *   heldCount: number,
 *   releasedUsd: number|null,
 *   reconciledCount: number,
 *   chargedUsd: number|null,
 *   lateChargeUsd: number|null,
 *   lateChargeCount: number,
 *   unknownExposureCount: number,
 *   cap: boolean,
 *   missingSources?: string[],
 * }} ReserveProjection
 */
/**
 * @typedef {{
 *   costUsd: number|null,
 *   costCount: number,
 *   unknownCount: number,
 *   unknownCountByReason: Record<string, number>,
 *   unknownFractionByReason: Record<string, number>,
 * }} CostTotals
 */

/** A usage record with no provider-reported cost is `unknown` provenance (`appendUsageRecord`). */
const UNKNOWN_COST_PROVENANCE = "unknown";

/**
 * The priced cost a record carries, or null when the provider's number never
 * arrived. One flag decides both: a cost that is missing and a cost that
 * arrived as zero are different facts everywhere this module reports spend.
 *
 * @param {JsonObject} record
 * @returns {number|null}
 */
export function pricedCostOf(record) {
  const cost = finite(record.costUsd);
  return cost === null || record.costProvenance === UNKNOWN_COST_PROVENANCE ? null : cost;
}

/** @param {JsonObject} record @returns {string} */
function unknownReasonOf(record) {
  return typeof record.unknownReason === "string" && UNKNOWN_COST_REASONS.includes(record.unknownReason)
    ? record.unknownReason
    : "legacy";
}

/**
 * Priced cost and unknown-cost accounting for one set of usage records: the
 * total of the records that carry a provider cost, and the reasons the rest
 * carry none. The sum is never rounded, so a caller that adds nothing to it
 * reports the same dollars the campaign total always reported.
 *
 * @param {JsonObject[]} records
 * @returns {CostTotals}
 */
export function costTotalsOf(records) {
  let costUsd = 0;
  let costCount = 0;
  let unknownCount = 0;
  /** @type {Record<string, number>} */
  const unknownCountByReason = {};
  for (const record of records) {
    const cost = pricedCostOf(record);
    if (cost === null) {
      unknownCount += 1;
      const reason = unknownReasonOf(record);
      unknownCountByReason[reason] = (unknownCountByReason[reason] ?? 0) + 1;
      continue;
    }
    costUsd += cost;
    costCount += 1;
  }
  const totalCount = costCount + unknownCount;
  const unknownFractionByReason = Object.fromEntries(
    Object.entries(unknownCountByReason).map(([reason, count]) => [reason, round4(count / totalCount)]),
  );
  return { costUsd: costCount === 0 ? null : costUsd, costCount, unknownCount, unknownCountByReason, unknownFractionByReason };
}

/**
 * Which class a usage record belongs to. A planning stage run is the class the
 * run was launched as (R5: the ledger separates planning from execution), so
 * its stages count as planning whatever role the harness recorded; every other
 * record is a judge's call or the worker call that remains.
 *
 * @param {JsonObject} record
 * @param {Set<string>} planningRunIds
 * @returns {SpendClass}
 */
export function spendClassOf(record, planningRunIds) {
  if (typeof record.runId === "string" && planningRunIds.has(record.runId)) return "planning";
  return record.role === "judge" ? "judge" : "worker";
}

/**
 * Priced spend split by class, with the unpriced records counted per class.
 * A class with no priced record is absent from the map rather than zero, and
 * `unknownCountByClass` is what says the class was seen and could not be
 * priced: a planning stage that reported no cost must not read as a free one.
 *
 * @param {JsonObject[]} records
 * @param {string[]} planningRunIds
 * @returns {{value: Record<string, number>, count: number, unknownCount: number, unknownCountByClass: Record<string, number>}}
 */
export function costByClassOf(records, planningRunIds) {
  const planning = new Set(planningRunIds);
  /** @type {Record<string, number>} */
  const value = {};
  /** @type {Record<string, number>} */
  const unknownCountByClass = {};
  let count = 0;
  let unknownCount = 0;
  for (const record of records) {
    const spendClass = spendClassOf(record, planning);
    const cost = pricedCostOf(record);
    if (cost === null) {
      unknownCountByClass[spendClass] = (unknownCountByClass[spendClass] ?? 0) + 1;
      unknownCount += 1;
      continue;
    }
    value[spendClass] = (value[spendClass] ?? 0) + cost;
    count += 1;
  }
  return { value, count, unknownCount, unknownCountByClass };
}

/** Records of a second or later attempt: the retries reported beside the classes. @param {JsonObject[]} records @returns {JsonObject[]} */
export function retryRecordsOf(records) {
  return records.filter((record) => typeof record.attempt === "number"
    && Number.isFinite(record.attempt)
    && record.attempt > 1);
}

/**
 * The optional reserve, projected from the same usage records the spend is. A
 * record that carries `reservedUsd` had that value reserved before its
 * dispatch: while its provider cost is still unknown the reservation is
 * *held*, and once the real charge arrives the reservation is *released*
 * against it. A charge that landed above its reservation is the late-charge
 * difference, and a record with neither a reservation nor a cost is an
 * exposure with no number at all.
 *
 * @param {JsonObject[]} records
 * @param {JsonObject|undefined} campaign
 * @param {string[]} missingSources
 * @returns {ReserveProjection}
 */
export function reserveOf(records, campaign, missingSources) {
  let heldUsd = 0;
  let heldCount = 0;
  let releasedUsd = 0;
  let reconciledCount = 0;
  let chargedUsd = 0;
  let lateChargeUsd = 0;
  let lateChargeCount = 0;
  let unknownExposureCount = 0;
  for (const record of records) {
    const reserved = finite(record.reservedUsd);
    const charged = pricedCostOf(record);
    if (reserved === null) {
      if (charged === null) unknownExposureCount += 1;
      continue;
    }
    if (charged === null) {
      heldUsd += reserved;
      heldCount += 1;
      continue;
    }
    releasedUsd += reserved;
    chargedUsd += charged;
    reconciledCount += 1;
    if (charged > reserved) {
      lateChargeUsd += charged - reserved;
      lateChargeCount += 1;
    }
  }
  // A usage source that was not preserved leaves these dollars unknown rather
  // than absent: zero reservations read is not zero reservations made.
  const incomplete = missingSources.length > 0;
  const amount = (/** @type {number} */ total, /** @type {number} */ count) => count === 0 || incomplete ? null : total;
  return {
    configuredUsd: finite(campaign?.reserveUsd),
    heldUsd: amount(heldUsd, heldCount),
    heldCount,
    releasedUsd: amount(releasedUsd, reconciledCount),
    reconciledCount,
    chargedUsd: amount(chargedUsd, reconciledCount),
    lateChargeUsd: amount(lateChargeUsd, lateChargeCount),
    lateChargeCount,
    unknownExposureCount,
    cap: false,
    ...(incomplete ? { missingSources: [...new Set(missingSources)].sort() } : {}),
  };
}
