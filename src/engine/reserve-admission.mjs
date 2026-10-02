/**
 * Admission of one new paid dispatch through the campaign's optional reserve
 * (ADR 0011): read the campaign record, and either admit the dispatch with a
 * hold, admit it as unconfigured, or refuse it before any provider starts.
 * Split from `dispatch.mjs` because the decision is one gate the worker and
 * the judge paths must apply identically, and because its fail-closed rule
 * needs the record read in exactly one place: a record that is present but
 * cannot be read or validated refuses the dispatch, it is not waved through
 * on the validation the launch performed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../util.mjs";
import { CAMPAIGN_FILE } from "../campaign/layout.mjs";
import { readCampaign } from "../campaign/record.mjs";
import { releaseCampaignReservation, reserveCampaignCost } from "../campaign/reserve.mjs";

/**
 * The error code a node is parked blocked with when the campaign's reserve
 * refuses its new dispatch. Deliberately outside every auto-retry set: the
 * balance does not recover by re-dispatching, only by an operator topping it
 * up (or the in-flight holds settling) and resuming.
 */
const RESERVE_INSUFFICIENT_CODE = "reserve_insufficient";

/**
 * The error code a node is parked blocked with when the campaign record is
 * present but cannot be read or validated. Distinct from
 * `reserve_insufficient` because the operator responses differ -- a balance
 * needs a top-up, a broken record needs a repair -- and like it, deliberately
 * outside every auto-retry set: re-dispatching does not make a record
 * readable.
 */
const CAMPAIGN_RECORD_UNREADABLE_CODE = "campaign_record_unreadable";

/**
 * Admit one new paid dispatch through the campaign's optional reserve
 * (ADR 0011), before the provider starts. The only measured predictor of
 * what the call will cost is what this node's most recent invocation actually
 * charged; a first dispatch has no measurement, so it is reserved as unknown
 * exposure and holds nothing -- the reserve never invents a number to gate
 * with. A refusal takes no hold and carries the error the caller parks the
 * node blocked with. Calls already running are never touched: the reserve
 * gates only the admission of a new one.
 *
 * A missing campaign path or record file is the unconfigured path the reserve
 * never touched, and a readable record without `reserveUsd` is the same. A
 * record that is present but cannot be read or validated is the opposite of
 * unconfigured: it may have changed since the launch validated it, so the
 * dispatch is refused before the provider starts instead of being assumed
 * safe.
 *
 * @param {string} campaignPath
 * @param {import("../contract/index.mjs").NodeSnapshot} state
 * @param {string} runId
 * @param {string} nodeId
 * @param {"worker"|"judge"} role
 * @returns {{refused: false, reservation: import("../campaign/reserve.mjs").Reservation|null}|{refused: true, error: {code: string, message: string}}}
 */
export function reserveAdmission(campaignPath, state, runId, nodeId, role) {
  if (!campaignPath || !existsSync(join(campaignPath, CAMPAIGN_FILE))) return { refused: false, reservation: null };
  try {
    const campaign = /** @type {{reserveUsd?: number}} */ (/** @type {unknown} */ (readCampaign(campaignPath)));
    if (campaign.reserveUsd === undefined) return { refused: false, reservation: null };
  } catch (error) {
    return { refused: true, error: {
      code: CAMPAIGN_RECORD_UNREADABLE_CODE,
      message: `campaign record at ${campaignPath} cannot be read or validated, refusing the new ${role} dispatch: ${errorMessage(error)}`,
    } };
  }
  const last = state.invocations?.at(-1);
  const estimateUsd = typeof last?.costUsd === "number" && Number.isFinite(last.costUsd) ? last.costUsd : null;
  const decision = reserveCampaignCost(campaignPath, { runId, node: nodeId, costUsd: estimateUsd });
  if (!decision.admitted) return { refused: true, error: {
    code: RESERVE_INSUFFICIENT_CODE,
    message: `reserve refused the new ${role} dispatch: estimated ${estimateUsd} USD cannot be held against ${decision.availableUsd ?? 0} USD available`,
  } };
  return { refused: false, reservation: decision.reservation };
}

/**
 * Give a reservation back when the gated call never started (the provider
 * could not be spawned). Never throws: a hold that cannot be released stays
 * visible as held in `readCampaignReserve`, and the dispatch failure it rode
 * on still settles the node.
 *
 * @param {string} campaignPath
 * @param {import("../campaign/reserve.mjs").Reservation|null} reservation
 * @returns {void}
 */
export function releaseReservation(campaignPath, reservation) {
  if (!campaignPath || !reservation) return;
  try {
    releaseCampaignReservation(campaignPath, reservation.id);
  } catch {
    // The hold remains recorded; it is visible in the reserve status and no
    // other reservation can consume it.
  }
}
