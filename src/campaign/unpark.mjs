/**
 * The way back from a parked campaign.
 *
 * The chain parks by writing `campaign.attention`, and `parkCampaign` in
 * `index.mjs` is its only writer. Clearing it needs both the campaign record
 * (`record.mjs`) and the chain's run classification (`chain.mjs`), and
 * `chain.mjs` already imports `index.mjs`. Putting the clearing in either would
 * close a runtime import cycle, so it lives here, where both directions of that
 * dependency are already acyclic.
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
import { runProgress } from "../engine/supervise.mjs";

/** @typedef {import("./index.mjs").Campaign} Campaign */
/** @typedef {import("./index.mjs").CampaignAttention} CampaignAttention */

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
