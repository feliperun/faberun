/**
 * The campaign's operator-level stop state: the pause it carries, and the way
 * back from a park.
 *
 * The chain parks by writing `campaign.attention`, and `parkCampaign` in
 * `index.mjs` is its only writer. Clearing it needs both the campaign record
 * (`record.mjs`) and the chain's run classification (`chain.mjs`), and
 * `chain.mjs` already imports `index.mjs`. Putting the clearing in either would
 * close a runtime import cycle, so it lives here, where both directions of that
 * dependency are already acyclic.
 *
 * `pauseCampaign` writes the same field for the other kind of stop: the durable
 * pause an operator asks for, which the chain already honours (`attention` is
 * consulted before it dispatches, recovers or advances) and which only an
 * explicit resume clears. It may import `index.mjs`: that dependency runs one
 * way, unlike the clearing path, which needs `chain.mjs`'s classification.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../run/store.mjs";
import { requireTimestamp } from "../contract/assert.mjs";
import { CAMPAIGN_FILE } from "./layout.mjs";
import { readCampaign } from "./record.mjs";
import { appendJournal } from "./journal.mjs";
import { classifyRunProgress } from "./chain.mjs";
import { parkCampaign } from "./index.mjs";
import { runProgress } from "../engine/supervise.mjs";

/** @typedef {import("./index.mjs").Campaign} Campaign */
/** @typedef {import("./index.mjs").CampaignAttention} CampaignAttention */

/**
 * The attention code an operator's pause writes, so a pause the dashboard
 * recorded can be told from the chain's own reasons for stopping.
 */
export const PAUSE_ATTENTION_CODE = "operator_paused";

/**
 * Park a campaign on an operator's pause. The campaign stays active and the
 * chain stops dispatching until the pause is cleared, exactly as it does for
 * its own park; the paused runs are named in the message.
 *
 * A campaign already carrying this pause is left untouched and reports
 * `recorded: false`, so a repeated pause is safe. A campaign parked on anything
 * else is refused: overwriting the chain's reason would hide the failure the
 * operator has to act on.
 *
 * @param {string} campaignPath
 * @param {{at?: string, eventId?: string, runIds?: string[], reason?: string, sessionId?: string}} [options]
 * @returns {{campaign: Campaign, attention: CampaignAttention, recorded: boolean}}
 */
export function pauseCampaign(campaignPath, options = {}) {
  const at = options.at ?? new Date().toISOString();
  requireTimestamp(at, "at");
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign is closed: ${campaign.id}`);
  const existing = campaign.attention;
  if (existing?.code === PAUSE_ATTENTION_CODE) return { campaign, attention: existing, recorded: false };
  if (existing) throw new Error(`campaign is parked on ${existing.code}: ${existing.message}`);
  const runIds = options.runIds ?? [];
  const attention = /** @type {CampaignAttention} */ ({
    code: PAUSE_ATTENTION_CODE,
    message: `${options.reason ?? "paused from the dashboard"}${runIds.length > 0 ? `: ${runIds.join(", ")}` : ""}`,
    at,
  });
  const paused = parkCampaign(campaignPath, attention);
  appendJournal(campaignPath, {
    type: "operator.command",
    at,
    eventId: options.eventId ?? randomUUID(),
    command: `campaign pause${runIds.length > 0 ? ` ${runIds.join(" ")}` : ""}`,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });
  return { campaign: paused, attention, recorded: true };
}

/**
 * Clear a campaign's attention once the run it names is no longer parked, and
 * append the `campaign.unparked` journal event. A closed campaign and a
 * campaign without attention are refused before anything is written. A run
 * that is still parked or canceled is refused unless `force` overrides it;
 * a run directory that no longer exists has nothing left to resume, so the
 * attention is cleared.
 *
 * @param {string} campaignPath
 * @param {{runsDir: string, force?: boolean, at?: string, eventId?: string}} options
 * @returns {{campaign: Campaign, cleared: CampaignAttention}}
 */
export function unparkCampaign(campaignPath, { runsDir, force = false, at = new Date().toISOString(), eventId = randomUUID() }) {
  requireTimestamp(at, "at");
  const campaign = readCampaign(campaignPath);
  if (campaign.status === "closed") throw new Error(`campaign is closed: ${campaign.id}`);
  const attention = campaign.attention;
  if (!attention) throw new Error(`campaign is not parked: ${campaign.id}`);
  const runId = attention.runId;
  const runDir = typeof runId === "string" && runId ? join(runsDir, runId) : null;
  if (runDir !== null && existsSync(runDir)) {
    const state = classifyRunProgress(runProgress(runDir, Date.parse(at)));
    if (!force && (state === "parked" || state === "canceled")) {
      throw new Error(`run ${runId} is still ${state}; resume it first or pass --force`);
    }
  }
  const unparked = /** @type {Campaign} */ ({ ...campaign, updatedAt: at });
  delete unparked.attention;
  writeJsonAtomic(join(campaignPath, CAMPAIGN_FILE), unparked);
  appendJournal(campaignPath, { type: "campaign.unparked", at, eventId, code: attention.code, runId: runId ?? null });
  return { campaign: unparked, cleared: attention };
}
